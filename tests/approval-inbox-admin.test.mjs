import test from 'node:test';
import assert from 'node:assert/strict';

import {
  adminHtml,
  approveInboxImagesResponse,
  dismissApprovalInboxResponse,
  getApprovalInboxResponse,
  retryApprovalInboxResponse,
} from '../src/admin-server.mjs';

test('getApprovalInboxResponse returns the server-composed counts and cards', async () => {
  const expected = {
    counts: { image: 1, sale: 0, purchase: 0, failed: 0 },
    cards: [{ key: 'image:118' }],
  };

  const response = await getApprovalInboxResponse({}, {
    listApprovalInboxImpl: async () => expected,
  });

  assert.deepEqual(response, { status: 200, body: expected });
});

test('approveInboxImagesResponse maps a stale approval card to HTTP 409', async () => {
  const error = Object.assign(new Error('images missing'), { code: 'IMAGES_NOT_READY' });

  const response = await approveInboxImagesResponse({}, '.', 118, {
    approveInboxImagesImpl: async () => { throw error; },
  });

  assert.deepEqual(response, { status: 409, body: { error: 'images missing', code: 'IMAGES_NOT_READY' } });
});

test('approveInboxImagesResponse preserves a successful post-processing result', async () => {
  const result = { autoRegistration: { outcome: 'awaiting_sale_approval' } };

  const response = await approveInboxImagesResponse({}, '.', 118, {
    approveInboxImagesImpl: async () => result,
  });

  assert.deepEqual(response, { status: 200, body: result });
});

test('retryApprovalInboxResponse rejects unsafe external retries with HTTP 409', async () => {
  const error = Object.assign(new Error('external reconciliation required'), { code: 'RETRY_NOT_SAFE' });

  const response = await retryApprovalInboxResponse({}, 9, {
    retryFailedInboxItemImpl: async () => { throw error; },
  });

  assert.deepEqual(response, { status: 409, body: { error: 'external reconciliation required', code: 'RETRY_NOT_SAFE' } });
});

test('dismissApprovalInboxResponse rejects a queue item that is not failed with HTTP 409', async () => {
  const error = Object.assign(new Error('Failed queue item not found'), { code: 'QUEUE_NOT_APPROVABLE' });

  const response = await dismissApprovalInboxResponse({}, 9, {
    dismissFailedInboxItemImpl: async () => { throw error; },
  });

  assert.deepEqual(response, { status: 409, body: { error: 'Failed queue item not found', code: 'QUEUE_NOT_APPROVABLE' } });
});

test('dismissApprovalInboxResponse returns the dismissed queue item on success', async () => {
  const result = { queueItem: { id: 3, status: 'completed' } };

  const response = await dismissApprovalInboxResponse({}, 3, {
    dismissFailedInboxItemImpl: async () => result,
  });

  assert.deepEqual(response, { status: 200, body: result });
});

test('admin HTML opens a one-click approval inbox by default', () => {
  const html = adminHtml();

  assert.match(html, /id="viewApprovalInboxButton" class="primary"/);
  assert.match(html, /let currentView='approvalInbox'/);
  assert.match(html, /이미지 승인/);
  assert.match(html, /판매 승인/);
  assert.match(html, /발주 승인/);
  assert.match(html, /처리 실패/);
  assert.match(html, /data-approve-images-draft-id/);
  assert.match(html, /전체 이미지 승인/);
  assert.match(html, /data-request-sale-approval-draft-id/);
  assert.match(html, /data-approve-purchase-order-id/);
  assert.match(html, /data-retry-queue-id/);
  assert.match(html, /data-dismiss-queue-id/);
  assert.match(html, /loadApprovalInbox\(\)/);
});
