begin;

-- 2.3.5/2.3.6 (주문서 생성 API 연동 가이드): item[]'s market segment ("dome" or
-- "supply") -- NOT derivable from product_drafts.raw_price_field_name at
-- read time (confirmed stale for some already-collected drafts, priced
-- under an older candidate-priority order than processing.mjs's current
-- one). Set from the FRESH live re-fetch's own priceFieldName every time
-- buildSupplierOrderDraft runs, same as every other 13.2 revalidated value.
alter table supplier_orders add column if not exists supplier_market text;

commit;
