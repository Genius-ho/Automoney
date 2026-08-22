begin;

create table if not exists coupang_seller_settings (
  id integer primary key default 1 check (id = 1),
  outbound_shipping_place_code text,
  outbound_shipping_place_name text,
  return_center_code text,
  return_center_name text,
  confirmed_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into coupang_seller_settings (id) values (1) on conflict (id) do nothing;

commit;
