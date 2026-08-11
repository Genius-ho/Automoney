import test from 'node:test';
import assert from 'node:assert/strict';

import {
  approveInboxImagesResponse,
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
