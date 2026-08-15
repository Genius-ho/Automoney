begin;

-- Coupang's receiver and Naver's shippingAddress both already split
-- addr1/addr2 (baseAddress/detailedAddress) -- order-collector.mjs used to
-- join them into channel_orders.address and discard the split, which meant
-- purchase-order-approval.mjs's deliInfo had no way to supply Domeme's
-- required address2 without guessing a split back out of free text later.
-- Storing both halves as collected removes that guesswork entirely.
alter table channel_orders add column if not exists address1 text;
alter table channel_orders add column if not exists address2 text;

commit;
