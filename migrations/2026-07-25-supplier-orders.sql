begin;

-- Phase 8 (section 13): one row per channel_orders line this app has
-- attempted to build a 발주안 for. Separate from channel_orders.
-- supplier_mapping_status (Phase 7's simpler mapped/unmapped flag) -- this
-- carries the full 13.5 state machine plus every value the 13.4 발주안
-- screen needs to show a human before they approve real money leaving.
-- status never advances to supplier_ordering/supplier_ordered except from
-- an explicit admin approval action (never automatic -- section 3.4 금전
-- 단계 승인 게이트).
create table if not exists supplier_orders (
  id bigserial primary key,
  channel_order_id bigint not null references channel_orders(id) on delete cascade,
  product_draft_id bigint not null references product_drafts(id),
  supplier_product_id bigint not null references supplier_products(id),
  status text not null default 'validating_supplier',
  block_reasons jsonb not null default '[]'::jsonb,
  supplier_option_code text,
  supplier_order_qty integer,
  sale_qty integer,
  sale_price integer,
  supplier_unit_price integer,
  supplier_shipping_fee integer,
  estimated_profit integer,
  supplier_checked_at timestamptz,
  domeme_order_no text,
  domeme_order_uid text,
  approved_at timestamptz,
  ordered_at timestamptz,
  failure_message text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (channel_order_id)
);
create index if not exists idx_supplier_orders_status on supplier_orders(status);

commit;
