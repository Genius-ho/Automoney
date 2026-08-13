import test from 'node:test';
import assert from 'node:assert/strict';

import { listApprovalInbox } from '../src/approval-inbox-store.mjs';

function sequentialDb(rowSets) {
  const calls = [];
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      return { rows: rowSets[calls.length - 1] || [] };
    },
  };
}

test('listApprovalInbox exposes one bulk action for a complete uploaded image pair', async () => {
  const db = sequentialDb([[
    {
      queue_id: 2,
      draft_id: 118,
      product_name: '시스맥스 뉴트로 소품박스 3단',
      queue_status: 'awaiting_image_approval',
      main_image_id: 21,
      main_image_url: '/generated/main.jpg',
      detail_set_id: 31,
      detail_image_count: 10,
      detail_image_urls: ['/generated/01.jpg', '/generated/02.jpg'],
      unit_cost_price: '12000',
      coupang_sale_price: '29900',
      coupang_expected_profit: '5000',
      updated_at: '2026-08-11T08:00:00.000Z',
    },
  ], [], [], []]);

  const result = await listApprovalInbox(db);

  assert.deepEqual(result.counts, { image: 1, sale: 0, purchase: 0, failed: 0 });
  assert.deepEqual(result.cards[0], {
    key: 'image:118',
    type: 'image',
    title: '시스맥스 뉴트로 소품박스 3단',
    draftId: 118,
    queueId: 2,
    status: 'awaiting_image_approval',
    availableActions: ['approve_images'],
    pricing: { unitCostPrice: 12000, salePrice: 29900, expectedProfit: 5000 },
    mainImage: { id: 21, url: '/generated/main.jpg' },
    detailImages: ['/generated/01.jpg', '/generated/02.jpg'],
    error: null,
    updatedAt: '2026-08-11T08:00:00.000Z',
  });
  assert.match(db.calls[0], /awaiting_image_approval/);
  assert.match(db.calls[0], /image_count\s*=\s*10/i);
});

test('listApprovalInbox separates sale, purchase, and failed cards with safe actions', async () => {
  const db = sequentialDb([
    [],
    [{ queue_id: 3, draft_id: 119, product_name: '판매 상품', queue_status: 'awaiting_sale_approval', seller_product_id: '16341358344', coupang_sale_price: '19900', updated_at: '2026-08-11T09:00:00Z' }],
    [{ supplier_order_id: 7, draft_id: 119, product_name: '발주 상품', status: 'awaiting_purchase_approval', sale_price: '19900', supplier_unit_price: '9000', estimated_profit: '4000', updated_at: '2026-08-11T10:00:00Z' }],
    [{ queue_id: 4, draft_id: 120, product_name: '실패 상품', queue_status: 'failed', failure_stage: 'image_generation_main', failure_message: 'quota', updated_at: '2026-08-11T11:00:00Z' }],
  ]);

  const result = await listApprovalInbox(db);

  assert.deepEqual(result.counts, { image: 0, sale: 1, purchase: 1, failed: 1 });
  assert.deepEqual(result.cards.map((card) => card.type), ['sale', 'purchase', 'failed']);
  assert.deepEqual(result.cards.map((card) => card.availableActions), [
    ['request_sale_approval'],
    ['approve_purchase_order'],
    ['retry'],
  ]);
  assert.equal(result.cards[2].error.message, 'quota');
  assert.match(db.calls[1], /cpr\.requested\s*=\s*false/i);
});

test('listApprovalInbox does not offer retry for an external registration failure', async () => {
  const db = sequentialDb([[], [], [], [{
    queue_id: 9,
    draft_id: 121,
    product_name: '등록 실패 상품',
    queue_status: 'failed',
    failure_stage: 'coupang_registration',
    failure_message: 'unknown create result',
    updated_at: '2026-08-11T12:00:00Z',
  }]]);

  const result = await listApprovalInbox(db);

  assert.deepEqual(result.cards[0].availableActions, []);
});
