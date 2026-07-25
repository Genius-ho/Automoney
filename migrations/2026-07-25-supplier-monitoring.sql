begin;

-- Phase 6 (automoney_complete_automation_implementation_plan.md section 11):
-- 공급처 가격·재고·판매상태 감시. One row per check, so the monitor can
-- always compare "now" against the most recent prior row for that supplier
-- product -- mirrors coupang_product_registrations' one-row-per-event shape
-- rather than a single mutable "current state" row, so the check history
-- itself is never lost.
create table if not exists supplier_snapshots (
  id bigserial primary key,
  supplier_product_id bigint not null references supplier_products(id) on delete cascade,
  supplier_product_no text not null,
  unit_cost_price integer,
  shipping_fee integer,
  min_order_qty integer,
  is_sold_out boolean not null default false,
  price_parse_status text,
  checked_at timestamptz not null default now()
);
create index if not exists idx_supplier_snapshots_product_checked on supplier_snapshots(supplier_product_id, checked_at desc);

commit;
