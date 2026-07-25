// automoney_complete_automation_implementation_plan.md section 16.1
// 대시보드. Each metric maps onto data this app already tracks -- see the
// comment on each query for exactly which table/status it counts.
export async function getDashboardSummary(db) {
  const [
    todayRegistrations,
    todayImprovements,
    newOrders,
    awaitingApproval,
    awaitingInvoice,
    supplierAlerts,
    automationErrors,
  ] = await Promise.all([
    // 오늘 등록 수: a draft counts once even if registered on both channels
    // today.
    db.query(`
      select count(distinct product_draft_id) as count from (
        select product_draft_id from coupang_product_registrations where created_at::date = current_date
        union
        select product_draft_id from naver_product_registrations where created_at::date = current_date
      ) t
    `),
    // 오늘 개선 수: Phase 5's daily-improvement queue (processing_queue,
    // section 10.2's own status vocabulary: queued/analyzing/
    // generating_images/awaiting_approval/ready_for_registration/failed)
    // reaching ready_for_registration today.
    db.query(`select count(*) as count from processing_queue where status = 'ready_for_registration' and updated_at::date = current_date`),
    // 신규 주문 수: channel orders this app collected today (Phase 7).
    db.query(`select count(*) as count from channel_orders where created_at::date = current_date`),
    // 발주 승인 대기 수 (Phase 8, 13.5).
    db.query(`select count(*) as count from supplier_orders where status = 'awaiting_purchase_approval'`),
    // 송장 대기 수: placed with the supplier but no tracking number
    // collected yet (Phase 9, 14.2).
    db.query(`select count(*) as count from supplier_orders where status = 'supplier_ordered' and tracking_number is null`),
    // 품절/가격변동 수 (Phase 6, via channel-suspension.mjs's alert
    // persistence).
    db.query(`select count(*) as count from supplier_alerts where status = 'open'`),
    // 자동화 오류 수: open 관리자 예외 큐 items (Phase 10, 15.1/15.3).
    db.query(`select count(*) as count from order_exceptions where status = 'open'`),
  ]);

  return {
    todayRegistrations: Number(todayRegistrations.rows[0].count),
    todayImprovements: Number(todayImprovements.rows[0].count),
    newOrders: Number(newOrders.rows[0].count),
    awaitingApproval: Number(awaitingApproval.rows[0].count),
    awaitingInvoice: Number(awaitingInvoice.rows[0].count),
    supplierAlerts: Number(supplierAlerts.rows[0].count),
    automationErrors: Number(automationErrors.rows[0].count),
  };
}
