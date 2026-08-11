import test from 'node:test';
import assert from 'node:assert/strict';

import { approveInboxImages, retryFailedInboxItem } from '../src/approval-inbox-service.mjs';

function approvalDb({ queue = { id: 2, status: 'awaiting_image_approval' }, main = { id: 21, product_draft_id: 118 }, detail = { id: 31, product_draft_id: 118, image_count: 10 }, detailImages = 10 } = {}) {
  const events = [];
  const client = {
    async query(sql) {
      if (sql === 'BEGIN') { events.push('begin'); return { rows: [] }; }
      if (sql === 'COMMIT') { events.push('commit'); return { rows: [] }; }
      if (sql === 'ROLLBACK') { events.push('rollback'); return { rows: [] }; }
      if (/from processing_queue[\s\S]*for update/i.test(sql)) return { rows: queue ? [queue] : [] };
      if (/from generated_ai_images[\s\S]*status = 'approved'/i.test(sql)) return { rows: [] };
      if (/from generated_ai_images[\s\S]*status = 'uploaded'/i.test(sql)) return { rows: main ? [main] : [] };
      if (/from generated_ai_detail_sets[\s\S]*status = 'approved'/i.test(sql)) return { rows: [] };
      if (/from generated_ai_detail_sets[\s\S]*status = 'uploaded'/i.test(sql)) return { rows: detail ? [detail] : [] };
      if (/from generated_ai_detail_images[\s\S]*for update/i.test(sql)) return { rows: Array.from({ length: detailImages }, (_, index) => ({ id: index + 1 })) };
      if (/update generated_ai_images[\s\S]*status = 'approved'/i.test(sql)) { events.push('approve-main'); return { rows: [{ ...main, status: 'approved' }] }; }
      if (/update generated_ai_detail_sets[\s\S]*status = 'approved'/i.test(sql)) { events.push('approve-detail'); return { rows: [{ ...detail, status: 'approved' }] }; }
      if (/update generated_ai_detail_images[\s\S]*status = 'approved'/i.test(sql)) return { rows: Array.from({ length: 10 }, (_, index) => ({ id: index + 1, status: 'approved' })) };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    release() { events.push('release'); },
  };
  return { events, db: { async connect() { return client; } } };
}

test('approveInboxImages commits both uploaded image records before post-processing', async () => {
  const { db, events } = approvalDb();
  const result = await approveInboxImages(db, '.', 118, {
    loadCoupangConfigImpl: async () => ({ accessKey: 'x' }),
    loadTelegramConfigImpl: async () => ({ botToken: 'y' }),
    createCoupangClientImpl: () => ({ client: true }),
    handleApprovedImagesImpl: async () => {
      events.push('post-process');
      return { outcome: 'awaiting_sale_approval' };
    },
  });

  assert.deepEqual(events, ['begin', 'approve-main', 'approve-detail', 'commit', 'release', 'post-process']);
  assert.equal(result.mainImage.status, 'approved');
  assert.equal(result.detailSet.status, 'approved');
  assert.equal(result.autoRegistration.outcome, 'awaiting_sale_approval');
});

test('approveInboxImages rolls back without partial approval when detail set is missing', async () => {
  const { db, events } = approvalDb({ detail: null });

  await assert.rejects(() => approveInboxImages(db, '.', 118), { code: 'IMAGES_NOT_READY' });

  assert.deepEqual(events, ['begin', 'rollback', 'release']);
});

test('approveInboxImages rejects an incomplete detail set before updating either record', async () => {
  const { db, events } = approvalDb({ detailImages: 9 });

  await assert.rejects(() => approveInboxImages(db, '.', 118), { code: 'IMAGES_NOT_READY' });

  assert.deepEqual(events, ['begin', 'rollback', 'release']);
});

test('retryFailedInboxItem restores only pre-registration failures to their resumable stage', async () => {
  const calls = [];
  const db = { async query(sql, params) {
    calls.push({ sql, params });
    if (/^select/i.test(sql.trim())) return { rows: [{ id: 4, status: 'failed', failure_stage: 'image_generation_main' }] };
    return { rows: [{ id: 4, status: 'analysis_completed', draft_id: 118 }] };
  } };

  const result = await retryFailedInboxItem(db, 4);

  assert.equal(result.queueItem.status, 'analysis_completed');
  assert.deepEqual(calls[1].params, [4, 'analysis_completed']);
  assert.match(calls[1].sql, /where id = \$1 and status = 'failed'/i);
});

test('retryFailedInboxItem refuses external registration failures', async () => {
  let queryCount = 0;
  await assert.rejects(
    () => retryFailedInboxItem({ query: async () => { queryCount += 1; return { rows: [{ id: 9, status: 'failed', failure_stage: 'coupang_registration' }] }; } }, 9),
    { code: 'RETRY_NOT_SAFE' },
  );
  assert.equal(queryCount, 1);
});
