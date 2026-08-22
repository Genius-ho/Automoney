begin;

-- Phase 10 (section 15): 관리자 예외 큐. Shared across 15.1's "이미 출고"/
-- "미출고, 공급처 취소 가능 여부 확인" cancellation cases and 15.3's 반품/교환
-- (explicitly never auto-processed -- "모든 반품·교환은 관리자 예외 큐로 보낸다").
-- One open exception per channel order at a time (the unique index) -- a
-- second detection of the same condition just refreshes detail/updated_at
-- on the still-open row rather than creating a duplicate.
create table if not exists order_exceptions (
  id bigserial primary key,
  channel_order_id bigint not null references channel_orders(id) on delete cascade,
  supplier_order_id bigint references supplier_orders(id) on delete cascade,
  exception_type text not null,
  status text not null default 'open',
  detail jsonb not null default '{}'::jsonb,
  resolution_note text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists idx_order_exceptions_open_per_channel_order
  on order_exceptions(channel_order_id) where status = 'open';
create index if not exists idx_order_exceptions_status on order_exceptions(status);

commit;
