begin;

create table if not exists product_analysis_runs (
  id bigserial primary key,
  product_draft_id bigint not null references product_drafts(id) on delete cascade,
  run_number integer not null,
  status text not null default 'running' check (status in ('running', 'success', 'failed')),
  python_status text not null default 'skipped' check (python_status in ('skipped', 'success', 'failed')),
  python_error_code text,
  python_error_message text,
  codex_status text not null default 'pending' check (codex_status in ('pending', 'success', 'failed')),
  codex_error_code text,
  codex_error_message text,
  error_code text,
  error_message text,
  python_analysis_json jsonb,
  codex_analysis_json jsonb,
  merged_analysis_json jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (product_draft_id, run_number)
);
create index if not exists idx_product_analysis_runs_draft on product_analysis_runs(product_draft_id, run_number desc);

create table if not exists product_analysis_applied (
  product_draft_id bigint primary key references product_drafts(id) on delete cascade,
  analysis_run_id bigint not null references product_analysis_runs(id),
  material text,
  dimensions text,
  manufacturer text,
  country_of_origin text,
  handling_precautions text,
  sale_colors jsonb not null default '[]'::jsonb,
  appearance_traits jsonb not null default '[]'::jsonb,
  search_tags jsonb not null default '[]'::jsonb,
  applied_fields jsonb not null default '[]'::jsonb,
  applied_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

commit;
