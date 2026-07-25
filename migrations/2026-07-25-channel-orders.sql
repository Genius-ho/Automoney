begin;

-- Phase 7 (automoney_complete_automation_implementation_plan.md section 12):
-- 쿠팡·네이버 주문 자동 수집. One row per channel order LINE (not per order
-- sheet/product-order as a whole) since a single Coupang shipment box can
-- bundle several vendorItemIds, each needing its own supplier mapping and
-- (eventually, Phase 8) its own purchase order. Dedup key is
-- (channel, channel_order_item_id) -- for Coupang that's
-- `${shipmentBoxId}:${vendorItemId}` (the real schema has no single
-- "orderItemId" field the way the plan assumed -- confirmed live against
-- Coupang's documented v5 ordersheets schema, 2026-07-25); for Naver it's
-- productOrderId (Naver's per-line order unit already).
create table if not exists channel_orders (
  id bigserial primary key,
  channel text not null,
  channel_order_id text not null,
  channel_order_item_id text not null,
  channel_product_id text,
  option_info text,
  quantity integer,
  sale_price integer,
  order_status text,
  recipient_name text,
  address text,
  postal_code text,
  phone text,
  delivery_memo text,
  ordered_at timestamptz,
  cancelled_at timestamptz,
  supplier_mapping_status text not null default 'mapping_required',
  supplier_product_id bigint references supplier_products(id),
  raw_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel, channel_order_item_id)
);
create index if not exists idx_channel_orders_mapping_status on channel_orders(supplier_mapping_status);
create index if not exists idx_channel_orders_ordered_at on channel_orders(ordered_at desc);

-- 마지막 성공 조회시각 저장 (12.1: "동시 실행 금지", "마지막 성공 조회시각 저장").
-- Single row, mirrors batch_schedule_state's shape for the same reason: one
-- authoritative "when did this last actually run" value per channel.
create table if not exists order_collection_state (
  channel text primary key,
  last_success_at timestamptz,
  is_running boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into order_collection_state (channel) values ('coupang'), ('naver') on conflict (channel) do nothing;

commit;
