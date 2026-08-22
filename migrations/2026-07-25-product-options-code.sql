begin;

-- Phase 8 (section 12.4/13.4): 도매매's own per-option order code (e.g. "00",
-- "01_03") -- required verbatim as the `item[상품번호]` option-code segment
-- when placing a real 주문서 생성 (setOrder) call. Previously discarded:
-- normalizeDomeggookOptions only read selectOpt.set[].opts[] by array
-- position, never selectOpt.data (keyed by this exact code). Without it,
-- Phase 8 cannot construct a valid order for any multi-option product.
alter table product_options add column if not exists option_code text;

commit;
