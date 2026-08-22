begin;

-- Mirrors coupang_product_registrations.images_swapped_at -- tracks the
-- image-swap-on-an-already-registered-listing step for Naver, same as
-- Coupang's existing recordImagesSwapped.
alter table naver_product_registrations add column if not exists images_swapped_at timestamptz;

commit;
