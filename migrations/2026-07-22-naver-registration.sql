begin;

-- Mirrors coupang_product_registrations' shape/dedup approach (unique per
-- draft, on-conflict-do-nothing on the direct-registration insert) for the
-- new Naver Commerce API raw-registration flow.
create table if not exists naver_product_registrations (
  id bigserial primary key,
  product_draft_id bigint not null references product_drafts(id) on delete cascade,
  origin_product_no text,
  channel_product_no text,
  request_hash text not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_draft_id)
);

commit;
