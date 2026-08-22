begin;

-- Telegram 인라인 버튼 발주 승인 (22.9): tracks whether an
-- awaiting_purchase_approval row has already had its Telegram approval
-- prompt sent, so the 30-minute purchaseOrderValidation sweep (which
-- re-upserts every mapped order's row every tick) doesn't re-notify the
-- same pending order on every subsequent tick.
alter table supplier_orders add column if not exists telegram_notified_at timestamptz;

commit;
