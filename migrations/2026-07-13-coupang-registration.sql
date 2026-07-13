begin;

alter table product_options add column if not exists stock_quantity integer;

create table if not exists coupang_product_registrations (
  id bigserial primary key,
  product_draft_id bigint not null references product_drafts(id) on delete cascade,
  seller_product_id text,
  request_hash text not null,
  status text not null default 'pending',
  requested boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_draft_id)
);

commit;
