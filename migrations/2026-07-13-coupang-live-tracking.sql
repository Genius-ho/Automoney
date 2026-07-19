begin;

alter table coupang_product_registrations add column if not exists linked_via text not null default 'direct_api';
alter table coupang_product_registrations add column if not exists seller_product_name text;
alter table coupang_product_registrations add column if not exists images_swapped_at timestamptz;
alter table coupang_product_registrations add column if not exists last_synced_at timestamptz;
alter table coupang_product_registrations add column if not exists live_status_name text;
alter table coupang_product_registrations add column if not exists live_item_snapshot_json jsonb;
alter table coupang_product_registrations add column if not exists live_total_stock_quantity integer;
alter table coupang_product_registrations add column if not exists live_sale_price integer;

commit;
