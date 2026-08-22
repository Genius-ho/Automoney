begin;

-- Stage 3: separates the light 3-day discovery cycle (pick categories,
-- score candidates, enqueue winners -- no Codex usage) from a daily
-- heavy-processing cycle (pop exactly one queue item, run it through
-- analysis + image generation) so Codex usage is capped at one product/day
-- regardless of how many candidates discovery finds. The two cycles share
-- the single is_running lock (still "전체 동시 실행 수 1"); each has its own
-- interval/next-run-at pair.
alter table batch_schedule_state add column if not exists processing_interval_days integer not null default 1;
alter table batch_schedule_state add column if not exists processing_next_run_at timestamptz not null default now();
alter table batch_schedule_state add column if not exists processing_last_run_at timestamptz;

create table if not exists processing_queue (
  id bigserial primary key,
  batch_run_candidate_id bigint not null references batch_run_candidates(id),
  category_policy_id bigint not null references category_policy(id),
  supplier_product_no text not null,
  name text,
  score numeric,
  status text not null default 'queued' check (status in ('queued', 'analyzing', 'generating_images', 'awaiting_approval', 'ready_for_registration', 'failed')),
  draft_id bigint references product_drafts(id),
  failure_stage text,
  failure_message text,
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists idx_processing_queue_status on processing_queue(status, score desc nulls last);

commit;
