import assert from 'node:assert/strict';
import test from 'node:test';

import {
  approveManualMainImage,
  getApprovedManualMainImage,
  rejectManualMainImage,
} from '../src/manual-ai/workflow-store.mjs';

function transactionDb({ approved = null, target = null } = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (/select \* from generated_ai_images[\s\S]*status = 'approved'/i.test(sql)) return { rows: approved ? [approved] : [] };
      if (/select \* from generated_ai_images[\s\S]*id = \$2/i.test(sql)) return { rows: target ? [target] : [] };
      if (/status = 'superseded'/i.test(sql)) return { rows: [{ ...approved, status: 'superseded', superseded_by_image_id: params[1] }] };
      if (/status = 'approved'/i.test(sql)) return { rows: [{ ...target, status: 'approved', approval_note: params[2] }] };
      if (/status = 'rejected'/i.test(sql)) return { rows: [{ ...target, status: 'rejected' }] };
      return { rows: [] };
    },
    release() { calls.push({ sql: 'RELEASE', params: [] }); },
  };
  return { calls, connect: async () => client };
}

test('first approval marks the uploaded image approved', async () => {
  const target = { id: 11, product_draft_id: 64, task_type: 'main_image', status: 'uploaded' };
  const db = transactionDb({ target });
  const result = await approveManualMainImage(db, 64, 11, 'selected');
  assert.equal(result.approved.status, 'approved');
  assert.equal(result.superseded, null);
  assert.ok(db.calls.some((call) => call.sql === 'COMMIT'));
});

test('second approval supersedes the first and records replacement history', async () => {
  const approved = { id: 10, product_draft_id: 64, task_type: 'main_image', status: 'approved', approved_at: 'past' };
  const target = { id: 11, product_draft_id: 64, task_type: 'main_image', status: 'uploaded' };
  const db = transactionDb({ approved, target });
  const result = await approveManualMainImage(db, 64, 11, 'better image');
  assert.equal(result.superseded.status, 'superseded');
  assert.equal(result.superseded.supersededByImageId, 11);
  assert.equal(result.approved.status, 'approved');
  assert.ok(db.calls.some((call) => /superseded_at = now\(\)/i.test(call.sql)));
  assert.ok(db.calls.some((call) => /superseded_by_image_id = \$2/i.test(call.sql)));
});

test('approval rejects an image belonging to another draft', async () => {
  const db = transactionDb({ target: { id: 11, product_draft_id: 65, task_type: 'main_image', status: 'uploaded' } });
  await assert.rejects(() => approveManualMainImage(db, 64, 11), { code: 'MANUAL_IMAGE_NOT_FOUND' });
  assert.ok(db.calls.some((call) => call.sql === 'ROLLBACK'));
});

test('rejection records rejected state without restoring superseded versions', async () => {
  const target = { id: 11, product_draft_id: 64, task_type: 'main_image', status: 'uploaded' };
  const db = transactionDb({ target });
  const result = await rejectManualMainImage(db, 64, 11, 'wrong color');
  assert.equal(result.status, 'rejected');
  assert.ok(!db.calls.some((call) => /status = 'approved'/i.test(call.sql)));
});

test('approved export lookup only accepts a safe Coupang derivative', async () => {
  const safe = { id: 11, status: 'approved', coupang_mime_type: 'image/jpeg', coupang_file_size: 2_000_000, width: 1000, height: 1000, coupang_stored_url: '/generated-ai-images/drafts/64/main/manual/a.jpg' };
  const db = { query: async () => ({ rows: [safe] }) };
  assert.equal((await getApprovedManualMainImage(db, 64)).id, 11);
  const unsafeDb = { query: async () => ({ rows: [{ ...safe, coupang_file_size: 3_000_000 }] }) };
  assert.equal(await getApprovedManualMainImage(unsafeDb, 64), null);
});
