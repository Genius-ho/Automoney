import assert from 'node:assert/strict';
import test from 'node:test';

import { getDashboardSummary } from '../src/dashboard-store.mjs';

test('getDashboardSummary queries all seven metrics and returns them as numbers', async () => {
  let processingQueueSql = '';
  const responses = {
    'coupang_product_registrations': { count: '2' },
    'processing_queue': { count: '1' },
    'channel_orders': { count: '5' },
    "supplier_orders where status = 'awaiting_purchase_approval'": { count: '3' },
    "status = 'supplier_ordered' and tracking_number is null": { count: '4' },
    'supplier_alerts': { count: '7' },
    'order_exceptions': { count: '6' },
  };
  const db = {
    async query(sql) {
      if (sql.includes('processing_queue')) processingQueueSql = sql;
      for (const [needle, row] of Object.entries(responses)) {
        if (sql.includes(needle)) return { rows: [row] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };

  const summary = await getDashboardSummary(db);
  assert.deepEqual(summary, {
    todayRegistrations: 2,
    todayImprovements: 1,
    newOrders: 5,
    awaitingApproval: 3,
    awaitingInvoice: 4,
    supplierAlerts: 7,
    automationErrors: 6,
  });
  assert.match(processingQueueSql, /status in \('awaiting_image_approval', 'registering', 'awaiting_sale_approval', 'completed'\)/);
  assert.ok(!processingQueueSql.includes('ready_for_registration'));
});
