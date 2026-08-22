import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  approveManualDetailSet,
  getApprovedManualDetailSet,
  insertDetailSet,
  listManualDetailSets,
  rejectManualDetailSet,
  reserveDetailSetVersion,
} from '../src/manual-ai/detail-workflow-store.mjs';

const SECTION_KEYS = [
  'hero',
  'review',
  'core_values',
  'point_01',
  'point_02',
  'point_03',
  'comparison',
  'detail',
  'color_size',
  'product_info',
];

function detailSetRow(id, overrides = {}) {
  return {
    id,
    product_draft_id: 64,
    prompt_request_id: 8,
    prompt_revision: 1,
    task_type: 'detail_page',
    workflow_mode: 'manual_external_ai',
    provider_code: 'chatgpt',
    provider_display_name: 'ChatGPT',
    set_version: id - 19,
    expected_image_count: 10,
    image_count: 10,
    sections_json: SECTION_KEYS.map((key, index) => ({ index: index + 1, key, label: key })),
    status: 'uploaded',
    notes: null,
    approval_note: null,
    created_at: '2026-07-12T00:00:00.000Z',
    approved_at: null,
    rejected_at: null,
    superseded_at: null,
    superseded_by_set_id: null,
    ...overrides,
  };
}

function detailImageRows(setId, count = 10, status = 'uploaded', overrides = {}) {
  return Array.from({ length: count }, (_, offset) => {
    const imageIndex = offset + 1;
    return {
      id: setId * 100 + imageIndex,
      detail_set_id: setId,
      image_index: imageIndex,
      section_key: SECTION_KEYS[offset] || `extra_${imageIndex}`,
      section_label: `Section ${imageIndex}`,
      original_stored_url: `/generated-ai-images/drafts/64/detail/manual/r1-v${setId}/detail-${imageIndex}-original.webp`,
      normalized_stored_url: `/generated-ai-images/drafts/64/detail/manual/r1-v${setId}/detail-${imageIndex}-registered.jpg`,
      original_width: 1000,
      original_height: 1400,
      normalized_width: 1000,
      normalized_height: 1400,
      original_file_size: 900_000,
      normalized_file_size: 700_000,
      original_mime_type: 'image/webp',
      normalized_mime_type: 'image/jpeg',
      jpeg_quality: 92,
      sha256: String(imageIndex).padStart(64, '0'),
      status,
      created_at: '2026-07-12T00:00:00.000Z',
      approved_at: status === 'approved' ? '2026-07-12T01:00:00.000Z' : null,
      rejected_at: null,
      superseded_at: null,
      ...overrides,
    };
  });
}

function detailApprovalDb({ currentId = null, targetId = 21, targetDraftId = 64, targetCount = 10, targetStatus = 'uploaded' } = {}) {
  const current = currentId == null
    ? null
    : detailSetRow(currentId, { status: 'approved', approved_at: '2026-07-12T01:00:00.000Z' });
  const target = targetId == null ? null : detailSetRow(targetId, { product_draft_id: targetDraftId, status: targetStatus });
  const images = new Map();
  if (current) images.set(current.id, detailImageRows(current.id, 10, 'approved'));
  if (target) images.set(target.id, detailImageRows(target.id, targetCount, target.status));

  const sql = [];
  const calls = [];
  const client = {
    async query(statement, params = []) {
      const text = String(statement);
      sql.push(text);
      calls.push({ sql: text, params });

      if (/^\s*(begin|commit|rollback)\s*$/i.test(text)) return { rows: [] };
      if (/from generated_ai_detail_sets[\s\S]*status\s*=\s*'approved'[\s\S]*for update/i.test(text)) {
        return { rows: current ? [current] : [] };
      }
      if (/from generated_ai_detail_sets[\s\S]*id\s*=\s*\$2[\s\S]*for update/i.test(text)) {
        return { rows: target ? [target] : [] };
      }
      if (/select \*[\s\S]*from generated_ai_detail_images[\s\S]*for update/i.test(text)) {
        return { rows: images.get(Number(params[0])) || [] };
      }
      if (/update generated_ai_detail_sets[\s\S]*status\s*=\s*'superseded'/i.test(text)) {
        return { rows: [{ ...current, status: 'superseded', superseded_by_set_id: params[1], superseded_at: 'now' }] };
      }
      if (/update generated_ai_detail_images[\s\S]*status\s*=\s*'superseded'/i.test(text)) {
        return { rows: (images.get(Number(params[0])) || []).map((row) => ({ ...row, status: 'superseded', superseded_at: 'now' })) };
      }
      if (/update generated_ai_detail_sets[\s\S]*status\s*=\s*'approved'/i.test(text)) {
        return { rows: [{ ...target, status: 'approved', approval_note: params[2], approved_at: 'now' }] };
      }
      if (/update generated_ai_detail_images[\s\S]*status\s*=\s*'approved'/i.test(text)) {
        return { rows: (images.get(Number(params[0])) || []).map((row) => ({ ...row, status: 'approved', approved_at: 'now' })) };
      }
      if (/update generated_ai_detail_sets[\s\S]*status\s*=\s*'rejected'/i.test(text)) {
        return { rows: [{ ...target, status: 'rejected', notes: params[2], rejected_at: 'now' }] };
      }
      if (/update generated_ai_detail_images[\s\S]*status\s*=\s*'rejected'/i.test(text)) {
        return { rows: (images.get(Number(params[0])) || []).map((row) => ({ ...row, status: 'rejected', rejected_at: 'now' })) };
      }
      return { rows: [] };
    },
    release() {
      calls.push({ sql: 'RELEASE', params: [] });
    },
  };

  return { calls, client, connect: async () => client, sql };
}

test('version reservation locks the draft before allocating the next detail set version', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (/from product_drafts/i.test(sql)) return { rows: [{ id: 64 }] };
      return { rows: [{ set_version: '3' }] };
    },
  };

  assert.equal(await reserveDetailSetVersion(client, 64), 3);
  assert.match(calls[0].sql, /from product_drafts[\s\S]*for update/i);
  assert.match(calls[1].sql, /max\(set_version\)/i);
});

test('insert persists one uploaded set and ten ordered children', async () => {
  const parent = detailSetRow(21);
  const insertedImages = [];
  const client = {
    async query(sql, params) {
      if (/insert into generated_ai_detail_sets/i.test(sql)) return { rows: [parent] };
      if (/insert into generated_ai_detail_images/i.test(sql)) {
        const row = detailImageRows(21)[insertedImages.length];
        insertedImages.push({ sql: String(sql), params });
        return { rows: [row] };
      }
      return { rows: [] };
    },
  };
  const images = detailImageRows(21).map((row) => ({
    imageIndex: row.image_index,
    sectionKey: row.section_key,
    sectionLabel: row.section_label,
    originalStoredUrl: row.original_stored_url,
    normalizedStoredUrl: row.normalized_stored_url,
    originalWidth: row.original_width,
    originalHeight: row.original_height,
    normalizedWidth: row.normalized_width,
    normalizedHeight: row.normalized_height,
    originalFileSize: row.original_file_size,
    normalizedFileSize: row.normalized_file_size,
    originalMimeType: row.original_mime_type,
    normalizedMimeType: row.normalized_mime_type,
    jpegQuality: row.jpeg_quality,
    sha256: row.sha256,
  }));

  const result = await insertDetailSet(client, {
    productDraftId: 64,
    promptRequestId: 8,
    promptRevision: 1,
    providerCode: 'chatgpt',
    providerDisplayName: 'ChatGPT',
    setVersion: 2,
    sections: SECTION_KEYS.map((key, index) => ({ index: index + 1, key, label: key })),
    images,
    notes: 'external result',
  });

  assert.equal(insertedImages.length, 10);
  assert.deepEqual(insertedImages.map((entry) => entry.params[1]), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(result.setVersion, 2);
  assert.equal(result.images.length, 10);
  assert.equal(result.images[0].normalizedStoredUrl, images[0].normalizedStoredUrl);
  assert.equal(result.images[9].imageIndex, 10);
});

test('first complete set approval updates the set and every child', async () => {
  const db = detailApprovalDb({ targetId: 21, targetCount: 10 });
  const result = await approveManualDetailSet(db, 64, 21, 'selected');

  assert.equal(result.superseded, null);
  assert.equal(result.approved.status, 'approved');
  assert.equal(result.approved.approvalNote, 'selected');
  assert.equal(result.approved.images.length, 10);
  assert.ok(result.approved.images.every((image) => image.status === 'approved'));
  assert.ok(db.calls.some((call) => call.sql === 'COMMIT'));
});

test('second complete set approval supersedes the previous set and all children', async () => {
  const db = detailApprovalDb({ currentId: 20, targetId: 21, targetCount: 10 });
  const result = await approveManualDetailSet(db, 64, 21, 'approved');

  assert.equal(result.superseded.status, 'superseded');
  assert.equal(result.superseded.supersededBySetId, 21);
  assert.ok(result.superseded.images.every((image) => image.status === 'superseded'));
  assert.equal(result.approved.status, 'approved');
  assert.equal(result.approved.images.length, 10);
  assert.ok(db.sql.some((sql) => /generated_ai_detail_images[\s\S]*superseded/.test(sql)));
});

test('approval rejects a target belonging to another draft and rolls back', async () => {
  const db = detailApprovalDb({ targetId: 21, targetDraftId: 65 });

  await assert.rejects(
    () => approveManualDetailSet(db, 64, 21),
    { code: 'MANUAL_DETAIL_SET_NOT_FOUND' },
  );
  assert.ok(db.calls.some((call) => call.sql === 'ROLLBACK'));
  assert.ok(!db.sql.some((sql) => /update generated_ai_detail_sets[\s\S]*status\s*=\s*'approved'/i.test(sql)));
});

test('approval requires exactly ten persisted child images', async () => {
  const db = detailApprovalDb({ targetId: 21, targetCount: 9 });

  await assert.rejects(
    () => approveManualDetailSet(db, 64, 21),
    (error) => error.code === 'MANUAL_DETAIL_SET_INCOMPLETE' && error.expectedCount === 10 && error.actualCount === 9,
  );
  assert.ok(db.calls.some((call) => call.sql === 'ROLLBACK'));
  assert.ok(!db.sql.some((sql) => /update generated_ai_detail_sets[\s\S]*status\s*=\s*'approved'/i.test(sql)));
});

test('approval cannot rewrite approved, rejected, or superseded set history', async () => {
  for (const targetStatus of ['approved', 'rejected', 'superseded']) {
    const db = detailApprovalDb({ targetId: 21, targetStatus });
    await assert.rejects(
      () => approveManualDetailSet(db, 64, 21),
      (error) => error.code === 'INVALID_MANUAL_DETAIL_SET_STATE' && error.status === targetStatus,
    );
    assert.ok(db.calls.some((call) => call.sql === 'ROLLBACK'));
    assert.ok(!db.sql.some((sql) => /^\s*update generated_ai_detail_/i.test(sql)));
  }
});

test('rejection updates the set and all children without restoring old versions', async () => {
  const db = detailApprovalDb({ targetId: 21, targetCount: 10 });
  const result = await rejectManualDetailSet(db, 64, 21, 'wrong color');

  assert.equal(result.status, 'rejected');
  assert.equal(result.notes, 'wrong color');
  assert.ok(result.images.every((image) => image.status === 'rejected'));
  assert.ok(db.sql.some((sql) => /update generated_ai_detail_images[\s\S]*rejected/.test(sql)));
  assert.ok(!db.sql.some((sql) => /status\s*=\s*'approved'/i.test(sql)));
});

test('rejection cannot rewrite approved, rejected, or superseded set history', async () => {
  for (const targetStatus of ['approved', 'rejected', 'superseded']) {
    const db = detailApprovalDb({ targetId: 21, targetStatus });
    await assert.rejects(
      () => rejectManualDetailSet(db, 64, 21),
      (error) => error.code === 'INVALID_MANUAL_DETAIL_SET_STATE' && error.status === targetStatus,
    );
    assert.ok(db.calls.some((call) => call.sql === 'ROLLBACK'));
    assert.ok(!db.sql.some((sql) => /^\s*update generated_ai_detail_/i.test(sql)));
  }
});

test('history is newest first with ordered camelCase image metadata', async () => {
  const rows = [detailSetRow(21, { set_version: 2 }), detailSetRow(20, { set_version: 1, status: 'rejected' })];
  const childRows = [
    ...detailImageRows(20).reverse(),
    ...detailImageRows(21).reverse(),
  ];
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (/from generated_ai_detail_sets/i.test(sql)) return { rows };
      return { rows: childRows };
    },
  };

  const result = await listManualDetailSets(db, 64);
  assert.deepEqual(result.map((set) => set.setVersion), [2, 1]);
  assert.deepEqual(result[0].images.map((image) => image.imageIndex), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(result[0].images[0].normalizedMimeType, 'image/jpeg');
  assert.equal(result[0].images[0].detailSetId, 21);
  assert.match(calls[0].sql, /order by set_version desc/i);
});

test('approved lookup returns only a complete safe ordered JPEG set', async () => {
  const approved = detailSetRow(21, { status: 'approved', approved_at: 'now' });
  const safeImages = detailImageRows(21, 10, 'approved');
  const lookupDb = (images) => ({
    async query(sql) {
      return /from generated_ai_detail_sets/i.test(sql) ? { rows: [approved] } : { rows: images };
    },
  });

  const safe = await getApprovedManualDetailSet(lookupDb(safeImages), 64);
  assert.equal(safe.id, 21);
  assert.equal(safe.images.length, 10);
  assert.deepEqual(safe.images.map((image) => image.imageIndex), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  assert.equal(await getApprovedManualDetailSet(lookupDb(safeImages.slice(0, 9)), 64), null);
  assert.equal(await getApprovedManualDetailSet(lookupDb(safeImages.map((row, index) => index === 3 ? { ...row, normalized_mime_type: 'image/png' } : row)), 64), null);
  assert.equal(await getApprovedManualDetailSet(lookupDb(safeImages.map((row, index) => index === 3 ? { ...row, normalized_file_size: 1_500_001 } : row)), 64), null);
  assert.equal(await getApprovedManualDetailSet(lookupDb(safeImages.map((row, index) => index === 3 ? { ...row, normalized_stored_url: '../outside.jpg' } : row)), 64), null);
  assert.equal(await getApprovedManualDetailSet(lookupDb(safeImages.map((row) => ({ ...row, normalized_file_size: 1_100_000 }))), 64), null);
});

test('schema and migration define detail parents, children, and one-approved index', async () => {
  const [schema, migration] = await Promise.all([
    readFile(new URL('../schema.sql', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/2026-07-12-manual-detail-page-workflow.sql', import.meta.url), 'utf8'),
  ]);

  for (const sql of [schema, migration]) {
    assert.match(sql, /create table if not exists generated_ai_detail_sets/i);
    assert.match(sql, /expected_image_count[^,]+check\s*\(expected_image_count\s*=\s*10\)/i);
    assert.match(sql, /image_count[^,]+check\s*\(image_count\s*=\s*10\)/i);
    assert.match(sql, /create table if not exists generated_ai_detail_images/i);
    assert.match(sql, /image_index[^,]+check\s*\(image_index between 1 and 10\)/i);
    assert.match(sql, /unique\s*\(detail_set_id,\s*image_index\)/i);
    assert.match(sql, /uq_generated_ai_detail_sets_one_approved[\s\S]*where status\s*=\s*'approved'/i);
  }
});
