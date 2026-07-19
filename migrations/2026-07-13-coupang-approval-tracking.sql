begin;

alter table coupang_product_registrations add column if not exists approval_response_message text;
alter table coupang_product_registrations add column if not exists approval_requested_at timestamptz;

commit;
