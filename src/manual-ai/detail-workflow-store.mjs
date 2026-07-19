const EXPECTED_IMAGE_COUNT = 10;
const MAX_NORMALIZED_IMAGE_BYTES = 1_500_000;
const MAX_NORMALIZED_SET_BYTES = 10_000_000;

export async function reserveDetailSetVersion(client, draftId) {
  const draft = await client.query(
    'select id from product_drafts where id = $1 for update',
    [draftId],
  );
  if (!draft.rows[0]) {
    throw detailStoreError('PRODUCT_DRAFT_NOT_FOUND', 'Product draft not found');
  }

  const { rows } = await client.query(
    `select coalesce(max(set_version), 0) + 1 as set_version
       from generated_ai_detail_sets
      where product_draft_id = $1 and task_type = 'detail_page'`,
    [draftId],
  );
  return Number(rows[0]?.set_version || 1);
}

export async function insertDetailSet(client, input) {
  const images = normalizeInsertImages(input.images, input.sections);
  const sections = normalizeSections(input.sections);
  if (sections.length !== EXPECTED_IMAGE_COUNT) {
    throw detailStoreError(
      'DETAIL_SECTION_COUNT_INVALID',
      `Detail set requires exactly ${EXPECTED_IMAGE_COUNT} section snapshots`,
      { expectedCount: EXPECTED_IMAGE_COUNT, actualCount: sections.length },
    );
  }

  const { rows } = await client.query(
    `insert into generated_ai_detail_sets (
       product_draft_id, prompt_request_id, prompt_revision, task_type, workflow_mode,
       provider_code, provider_display_name, set_version, expected_image_count,
       image_count, sections_json, status, notes
     ) values (
       $1, $2, $3, 'detail_page', 'manual_external_ai', $4, $5, $6, 10, 10,
       $7::jsonb, 'uploaded', $8
     ) returning *`,
    [
      input.productDraftId,
      input.promptRequestId,
      input.promptRevision,
      input.providerCode,
      input.providerDisplayName || null,
      input.setVersion,
      JSON.stringify(sections),
      input.notes || null,
    ],
  );
  const parent = rows[0];
  if (!parent) throw detailStoreError('DETAIL_SET_INSERT_FAILED', 'Detail set insert returned no row');

  const insertedImages = [];
  for (const image of images) {
    const result = await client.query(
      `insert into generated_ai_detail_images (
         detail_set_id, image_index, section_key, section_label,
         original_stored_url, normalized_stored_url,
         original_width, original_height, normalized_width, normalized_height,
         original_file_size, normalized_file_size,
         original_mime_type, normalized_mime_type, jpeg_quality, sha256, status
       ) values (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         'image/jpeg', $14, $15, 'uploaded'
       ) returning *`,
      [
        parent.id,
        image.imageIndex,
        image.sectionKey,
        image.sectionLabel,
        image.originalStoredUrl,
        image.normalizedStoredUrl,
        image.originalWidth,
        image.originalHeight,
        image.normalizedWidth,
        image.normalizedHeight,
        image.originalFileSize,
        image.normalizedFileSize,
        image.originalMimeType,
        image.jpegQuality,
        image.sha256,
      ],
    );
    if (!result.rows[0]) {
      throw detailStoreError('DETAIL_IMAGE_INSERT_FAILED', `Detail image ${image.imageIndex} insert returned no row`);
    }
    insertedImages.push(result.rows[0]);
  }

  return toPublicSet(parent, insertedImages);
}

export async function listManualDetailSets(db, draftId) {
  const { rows } = await db.query(
    `select * from generated_ai_detail_sets
      where product_draft_id = $1 and task_type = 'detail_page'
      order by set_version desc`,
    [draftId],
  );
  if (rows.length === 0) return [];

  const images = await loadImagesForSets(db, rows.map((row) => row.id));
  return rows.map((row) => toPublicSet(row, images.filter((image) => sameId(image.detail_set_id, row.id))));
}

export async function approveManualDetailSet(db, draftId, setId, approvalNote = null) {
  const client = db.connect ? await db.connect() : db;
  try {
    await client.query('BEGIN');
    const current = (await client.query(
      `select * from generated_ai_detail_sets
        where product_draft_id = $1 and task_type = 'detail_page' and status = 'approved'
        for update`,
      [draftId],
    )).rows[0] || null;
    const target = (await client.query(
      `select * from generated_ai_detail_sets
        where product_draft_id = $1 and id = $2 and task_type = 'detail_page'
        for update`,
      [draftId, setId],
    )).rows[0];

    assertOwnedSet(target, draftId);
    assertUploadedState(target, 'approve');
    const targetImages = await loadLockedImages(client, target.id);
    assertCompleteSet(target, targetImages);

    let superseded = null;
    if (current && !sameId(current.id, target.id)) {
      const currentImages = await loadLockedImages(client, current.id);
      const supersededParent = (await client.query(
        `update generated_ai_detail_sets
            set status = 'superseded', superseded_at = now(), superseded_by_set_id = $2
          where id = $1
          returning *`,
        [current.id, target.id],
      )).rows[0];
      const supersededImages = (await client.query(
        `update generated_ai_detail_images
            set status = 'superseded', superseded_at = now()
          where detail_set_id = $1
          returning *`,
        [current.id],
      )).rows;
      if (!supersededParent || supersededImages.length !== currentImages.length) {
        throw detailStoreError('DETAIL_SET_SUPERSEDE_FAILED', 'Failed to supersede the current detail set atomically');
      }
      superseded = toPublicSet(supersededParent, supersededImages);
    }

    const approvedParent = (await client.query(
      `update generated_ai_detail_sets
          set status = 'approved', approved_at = now(), rejected_at = null,
              superseded_at = null, superseded_by_set_id = null, approval_note = $3
        where product_draft_id = $1 and id = $2
        returning *`,
      [draftId, setId, approvalNote],
    )).rows[0];
    const approvedImages = (await client.query(
      `update generated_ai_detail_images
          set status = 'approved', approved_at = now(), rejected_at = null, superseded_at = null
        where detail_set_id = $1
        returning *`,
      [setId],
    )).rows;
    if (!approvedParent || approvedImages.length !== EXPECTED_IMAGE_COUNT) {
      throw detailStoreError('DETAIL_SET_APPROVAL_FAILED', 'Failed to approve the complete detail set atomically');
    }

    await client.query('COMMIT');
    return { approved: toPublicSet(approvedParent, approvedImages), superseded };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release?.();
  }
}

export async function rejectManualDetailSet(db, draftId, setId, note = null) {
  const client = db.connect ? await db.connect() : db;
  try {
    await client.query('BEGIN');
    const target = (await client.query(
      `select * from generated_ai_detail_sets
        where product_draft_id = $1 and id = $2 and task_type = 'detail_page'
        for update`,
      [draftId, setId],
    )).rows[0];
    assertOwnedSet(target, draftId);
    assertUploadedState(target, 'reject');
    const targetImages = await loadLockedImages(client, target.id);

    const rejectedParent = (await client.query(
      `update generated_ai_detail_sets
          set status = 'rejected', rejected_at = now(), notes = coalesce($3, notes)
        where product_draft_id = $1 and id = $2
        returning *`,
      [draftId, setId, note],
    )).rows[0];
    const rejectedImages = (await client.query(
      `update generated_ai_detail_images
          set status = 'rejected', rejected_at = now()
        where detail_set_id = $1
        returning *`,
      [setId],
    )).rows;
    if (!rejectedParent || rejectedImages.length !== targetImages.length) {
      throw detailStoreError('DETAIL_SET_REJECTION_FAILED', 'Failed to reject the detail set atomically');
    }

    await client.query('COMMIT');
    return toPublicSet(rejectedParent, rejectedImages);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release?.();
  }
}

export async function getApprovedManualDetailSet(db, draftId) {
  const { rows } = await db.query(
    `select * from generated_ai_detail_sets
      where product_draft_id = $1 and task_type = 'detail_page' and status = 'approved'
      order by approved_at desc
      limit 1`,
    [draftId],
  );
  const parent = rows[0];
  if (!parent) return null;

  const images = await loadImagesForSets(db, [parent.id]);
  const result = toPublicSet(parent, images.filter((image) => sameId(image.detail_set_id, parent.id)));
  return isSafeApprovedSet(result, draftId) ? result : null;
}

async function loadImagesForSets(db, setIds) {
  if (setIds.length === 0) return [];
  const { rows } = await db.query(
    `select * from generated_ai_detail_images
      where detail_set_id = any($1::bigint[])
      order by detail_set_id, image_index`,
    [setIds],
  );
  return rows;
}

async function loadLockedImages(client, setId) {
  const { rows } = await client.query(
    `select * from generated_ai_detail_images
      where detail_set_id = $1
      order by image_index
      for update`,
    [setId],
  );
  return rows;
}

function normalizeInsertImages(value, sectionsValue) {
  const images = Array.isArray(value) ? value : [];
  if (images.length !== EXPECTED_IMAGE_COUNT) {
    throw detailStoreError(
      'DETAIL_IMAGE_COUNT_INVALID',
      `Detail set requires exactly ${EXPECTED_IMAGE_COUNT} images`,
      { expectedCount: EXPECTED_IMAGE_COUNT, actualCount: images.length },
    );
  }
  const sections = normalizeSections(sectionsValue);
  const normalized = images.map((image, offset) => {
    const imageIndex = Number(image.imageIndex ?? offset + 1);
    const section = sections[imageIndex - 1] || {};
    if (image.normalizedMimeType && image.normalizedMimeType !== 'image/jpeg') {
      throw detailStoreError('DETAIL_NORMALIZED_MIME_INVALID', `Detail image ${imageIndex} must be image/jpeg`);
    }
    return {
      ...image,
      imageIndex,
      sectionKey: image.sectionKey || section.key,
      sectionLabel: image.sectionLabel || section.label,
    };
  });
  const indices = normalized.map((image) => image.imageIndex).sort((a, b) => a - b);
  if (!indices.every((imageIndex, offset) => imageIndex === offset + 1)) {
    throw detailStoreError('DETAIL_IMAGE_ORDER_INVALID', 'Detail image indices must be unique values from 1 through 10');
  }
  return normalized.sort((a, b) => a.imageIndex - b.imageIndex);
}

function assertOwnedSet(target, draftId) {
  if (!target || !sameId(target.product_draft_id, draftId) || target.task_type !== 'detail_page') {
    throw detailStoreError('MANUAL_DETAIL_SET_NOT_FOUND', 'Manual detail set not found for this draft');
  }
}

function assertUploadedState(target, action) {
  if (target.status !== 'uploaded') {
    throw detailStoreError(
      'INVALID_MANUAL_DETAIL_SET_STATE',
      `Cannot ${action} detail set in ${target.status} state`,
      { action, status: target.status },
    );
  }
}

function assertCompleteSet(target, images) {
  const imageIndices = images.map((image) => Number(image.image_index)).sort((a, b) => a - b);
  const completeIndices = imageIndices.every((imageIndex, offset) => imageIndex === offset + 1);
  if (
    Number(target.expected_image_count) !== EXPECTED_IMAGE_COUNT
    || Number(target.image_count) !== EXPECTED_IMAGE_COUNT
    || images.length !== EXPECTED_IMAGE_COUNT
    || !completeIndices
  ) {
    throw detailStoreError(
      'MANUAL_DETAIL_SET_INCOMPLETE',
      `Manual detail set must contain exactly ${EXPECTED_IMAGE_COUNT} ordered images`,
      {
        expectedCount: EXPECTED_IMAGE_COUNT,
        actualCount: images.length,
      },
    );
  }
}

function isSafeApprovedSet(set, draftId) {
  if (
    set.status !== 'approved'
    || set.expectedImageCount !== EXPECTED_IMAGE_COUNT
    || set.imageCount !== EXPECTED_IMAGE_COUNT
    || set.images.length !== EXPECTED_IMAGE_COUNT
  ) return false;

  let aggregateBytes = 0;
  for (const [offset, image] of set.images.entries()) {
    if (
      image.imageIndex !== offset + 1
      || image.status !== 'approved'
      || image.normalizedMimeType !== 'image/jpeg'
      || image.normalizedFileSize <= 0
      || image.normalizedFileSize > MAX_NORMALIZED_IMAGE_BYTES
      || image.normalizedWidth <= 0
      || image.normalizedHeight <= 0
      || !isSafeStoredUrl(image.normalizedStoredUrl, draftId)
    ) return false;
    aggregateBytes += image.normalizedFileSize;
  }
  return aggregateBytes <= MAX_NORMALIZED_SET_BYTES;
}

function isSafeStoredUrl(value, draftId) {
  if (typeof value !== 'string' || value.includes('\\') || value.includes('..') || value.includes('?') || value.includes('#')) return false;
  const prefix = `/generated-ai-images/drafts/${Number(draftId)}/detail/manual/`;
  if (!value.startsWith(prefix) || !value.endsWith('.jpg')) return false;
  const relative = value.slice(prefix.length);
  return relative.length > 4 && !relative.includes('//') && /^[A-Za-z0-9._/-]+$/.test(relative);
}

function toPublicSet(row, imageRows = []) {
  return {
    id: Number(row.id),
    productDraftId: Number(row.product_draft_id),
    promptRequestId: Number(row.prompt_request_id),
    promptRevision: Number(row.prompt_revision),
    taskType: row.task_type,
    workflowMode: row.workflow_mode,
    providerCode: row.provider_code,
    providerDisplayName: row.provider_display_name,
    setVersion: Number(row.set_version),
    expectedImageCount: Number(row.expected_image_count),
    imageCount: Number(row.image_count),
    sections: normalizeSections(row.sections_json),
    status: row.status,
    notes: row.notes,
    approvalNote: row.approval_note,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    rejectedAt: row.rejected_at,
    supersededAt: row.superseded_at,
    supersededBySetId: row.superseded_by_set_id == null ? null : Number(row.superseded_by_set_id),
    images: imageRows.map(toPublicImage).sort((a, b) => a.imageIndex - b.imageIndex),
  };
}

function toPublicImage(row) {
  return {
    id: Number(row.id),
    detailSetId: Number(row.detail_set_id),
    imageIndex: Number(row.image_index),
    sectionKey: row.section_key,
    sectionLabel: row.section_label,
    originalStoredUrl: row.original_stored_url,
    normalizedStoredUrl: row.normalized_stored_url,
    originalWidth: Number(row.original_width),
    originalHeight: Number(row.original_height),
    normalizedWidth: Number(row.normalized_width),
    normalizedHeight: Number(row.normalized_height),
    originalFileSize: Number(row.original_file_size),
    normalizedFileSize: Number(row.normalized_file_size),
    originalMimeType: row.original_mime_type,
    normalizedMimeType: row.normalized_mime_type,
    jpegQuality: Number(row.jpeg_quality),
    sha256: row.sha256,
    status: row.status,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    rejectedAt: row.rejected_at,
    supersededAt: row.superseded_at,
  };
}

function normalizeSections(value) {
  if (Array.isArray(value)) return value.map((section) => ({ ...section }));
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((section) => ({ ...section })) : [];
  } catch {
    return [];
  }
}

function sameId(left, right) {
  return String(left) === String(right);
}

function detailStoreError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}
