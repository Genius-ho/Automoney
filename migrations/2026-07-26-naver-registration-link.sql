begin;

-- Mirrors coupang_product_registrations' linked_via distinction: a draft can
-- now be tied to a Naver originProductNo that was registered externally via
-- 스피드등록 (linked_via = 'speedgo_link'), not just via this app's own
-- createOriginProduct() call (linked_via = 'direct_api', backfilled below).
-- There's no confirmed Naver "search products by name" endpoint in this
-- codebase (unlike Coupang's listSellerProducts), so linking is by
-- originProductNo entered directly rather than a name-search lookup.
alter table naver_product_registrations add column if not exists linked_via text not null default 'direct_api';

commit;
