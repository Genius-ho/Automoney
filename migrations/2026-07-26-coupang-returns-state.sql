begin;

-- Phase 10 (section 15.1/15.3): 'coupang_returns' reuses order_collection_state
-- for return-request-collector.mjs's lock/overlap bookkeeping -- distinct
-- channel key, identical concurrency semantics, no reason for a second table.
insert into order_collection_state (channel) values ('coupang_returns') on conflict (channel) do nothing;

commit;
