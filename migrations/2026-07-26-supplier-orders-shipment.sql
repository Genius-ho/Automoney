begin;

-- Phase 9 (section 14.2/14.3/14.4): 송장 수집 + 택배사 코드 정규화 + 채널 발송 처리.
-- Kept on supplier_orders rather than a separate table -- 1:1 with an
-- already-placed order, same lifecycle, no reason to join.
alter table supplier_orders add column if not exists carrier_code text;
alter table supplier_orders add column if not exists carrier_name text;
alter table supplier_orders add column if not exists tracking_number text;
alter table supplier_orders add column if not exists shipped_at timestamptz;
alter table supplier_orders add column if not exists channel_carrier_code text;
alter table supplier_orders add column if not exists channel_ship_status text not null default 'not_shipped';
alter table supplier_orders add column if not exists channel_ship_error text;
alter table supplier_orders add column if not exists channel_shipped_at timestamptz;
create index if not exists idx_supplier_orders_channel_ship_status on supplier_orders(channel_ship_status);

commit;
