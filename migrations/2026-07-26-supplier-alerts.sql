begin;

-- section 16.1/16.5 대시보드/공급처 감시: Phase 6's runSupplierMonitorSweep
-- alerts (SUPPLIER_OUT_OF_STOCK/PRICE_INCREASED/PRICE_DECREASED/MOQ_CHANGED/
-- DATA_ERROR) were purely ephemeral before this -- computed by diffSnapshots
-- on every sweep, returned to the caller, and never persisted (only ever
-- console.logged by scripts/monitor-supplier-products.mjs). This is what
-- lets the admin dashboard show a running count instead of only whatever
-- happened to be on screen during the last CLI run.
create table if not exists supplier_alerts (
  id bigserial primary key,
  supplier_product_id bigint not null references supplier_products(id) on delete cascade,
  code text not null,
  message text not null,
  status text not null default 'open',
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  acknowledged_at timestamptz
);
create index if not exists idx_supplier_alerts_status on supplier_alerts(status);

commit;
