const SAFE_COUPANG_BYTES = 3_000_000;

export async function listManualMainImages(db, draftId) {
  const { rows } = await db.query(`select * from generated_ai_images where product_draft_id = $1 and task_type = 'main_image' order by version desc`, [draftId]);
  return rows.map(toPublicRow);
}

export async function getNextManualMainImageVersion(db, draftId) {
  const { rows } = await db.query(`select coalesce(max(version),0)+1 as version from generated_ai_images where product_draft_id=$1 and task_type='main_image'`, [draftId]);
  return Number(rows[0]?.version || 1);
}

export async function insertManualMainImage(db, input) {
  const { rows } = await db.query(`insert into generated_ai_images(product_draft_id,prompt_request_id,prompt_revision,task_type,workflow_mode,provider_code,provider_display_name,version,original_stored_url,coupang_stored_url,original_file_size,coupang_file_size,original_mime_type,coupang_mime_type,original_width,original_height,width,height,sha256,status,notes) values($1,$2,$3,'main_image','manual_external_ai',$4,$5,$6,$7,$8,$9,$10,$11,'image/jpeg',$12,$13,1000,1000,$14,'uploaded',$15) returning *`, [input.productDraftId,input.promptRequestId,input.promptRevision,input.providerCode,input.providerDisplayName||null,input.version,input.originalStoredUrl,input.coupangStoredUrl,input.originalFileSize,input.coupangFileSize,input.originalMimeType,input.originalWidth,input.originalHeight,input.sha256,input.notes||null]);
  return toPublicRow(rows[0]);
}

export async function approveManualMainImage(db, draftId, imageId, approvalNote = null) {
  const client = db.connect ? await db.connect() : db;
  try {
    await client.query('BEGIN');
    const current = (await client.query(`select * from generated_ai_images where product_draft_id=$1 and task_type='main_image' and status = 'approved' for update`, [draftId])).rows[0] || null;
    const target = (await client.query(`select * from generated_ai_images where product_draft_id=$1 and id = $2 and task_type='main_image' for update`, [draftId, imageId])).rows[0];
    if (!target || Number(target.product_draft_id) !== Number(draftId)) throw workflowError('MANUAL_IMAGE_NOT_FOUND', 'Manual AI image not found for this draft');
    if (!['uploaded','rejected','superseded','approved'].includes(target.status)) throw workflowError('INVALID_MANUAL_IMAGE_STATE', `Cannot approve image in ${target.status} state`);
    let superseded = null;
    if (current && Number(current.id) !== Number(imageId)) {
      superseded = (await client.query(`update generated_ai_images set status = 'superseded', superseded_at = now(), superseded_by_image_id = $2 where id = $1 returning *`, [current.id, imageId])).rows[0];
    }
    const approved = (await client.query(`update generated_ai_images set status = 'approved', approved_at = now(), rejected_at = null, superseded_at = null, superseded_by_image_id = null, approval_note = $3 where product_draft_id = $1 and id = $2 returning *`, [draftId, imageId, approvalNote])).rows[0];
    await client.query('COMMIT');
    return { approved: toPublicRow(approved), superseded: superseded ? toPublicRow(superseded) : null };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release?.();
  }
}

export async function rejectManualMainImage(db, draftId, imageId, note = null) {
  const client = db.connect ? await db.connect() : db;
  try {
    await client.query('BEGIN');
    const target = (await client.query(`select * from generated_ai_images where product_draft_id=$1 and id = $2 and task_type='main_image' for update`, [draftId, imageId])).rows[0];
    if (!target || Number(target.product_draft_id) !== Number(draftId)) throw workflowError('MANUAL_IMAGE_NOT_FOUND', 'Manual AI image not found for this draft');
    const rejected = (await client.query(`update generated_ai_images set status = 'rejected', rejected_at = now(), notes = coalesce($3,notes) where product_draft_id = $1 and id = $2 returning *`, [draftId, imageId, note])).rows[0];
    await client.query('COMMIT');
    return toPublicRow(rejected);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release?.();
  }
}

export async function getApprovedManualMainImage(db, draftId) {
  const { rows } = await db.query(`select * from generated_ai_images where product_draft_id=$1 and task_type='main_image' and status='approved' order by approved_at desc limit 1`, [draftId]);
  const row = rows[0];
  if (!row || row.coupang_mime_type !== 'image/jpeg' || Number(row.width) !== 1000 || Number(row.height) !== 1000 || Number(row.coupang_file_size) >= SAFE_COUPANG_BYTES || !row.coupang_stored_url) return null;
  return toPublicRow(row);
}

function toPublicRow(row) {
  if (!row) return null;
  return {
    id:Number(row.id), productDraftId:Number(row.product_draft_id), promptRequestId:Number(row.prompt_request_id), promptRevision:Number(row.prompt_revision), taskType:row.task_type, workflowMode:row.workflow_mode,
    providerCode:row.provider_code, providerDisplayName:row.provider_display_name, version:Number(row.version), originalStoredUrl:row.original_stored_url, coupangStoredUrl:row.coupang_stored_url,
    originalFileSize:Number(row.original_file_size), coupangFileSize:Number(row.coupang_file_size), originalMimeType:row.original_mime_type, coupangMimeType:row.coupang_mime_type,
    originalWidth:Number(row.original_width), originalHeight:Number(row.original_height), width:Number(row.width), height:Number(row.height), sha256:row.sha256, status:row.status, notes:row.notes,
    approvalNote:row.approval_note, createdAt:row.created_at, approvedAt:row.approved_at, rejectedAt:row.rejected_at, supersededAt:row.superseded_at, supersededByImageId:row.superseded_by_image_id==null?null:Number(row.superseded_by_image_id),
  };
}

function workflowError(code, message) { const error = new Error(message); error.code = code; return error; }
