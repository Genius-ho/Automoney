alter table coupang_product_registrations
  add column if not exists telegram_notified_at timestamptz;

alter table coupang_product_registrations
  add column if not exists telegram_message_id bigint;
