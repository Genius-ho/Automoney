begin;

-- Phase 7 follow-up (automoney_complete_automation_implementation_plan.md
-- section 12.4/12.5): "공급처 상품 자동 매핑" and "매핑 실패 관리자 표시" were left
-- unimplemented in 2026-07-25-channel-orders.sql (every row landed and stayed
-- at supplier_mapping_status='mapping_required'). This adds the breadcrumb
-- the resolver (src/order-supplier-mapper.mjs) needs back to the draft it
-- matched, alongside the already-existing supplier_product_id column.
alter table channel_orders add column if not exists product_draft_id bigint references product_drafts(id);

commit;
