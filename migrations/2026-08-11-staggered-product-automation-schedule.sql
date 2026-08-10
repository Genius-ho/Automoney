alter table batch_schedule_state add column if not exists draft_next_run_at timestamptz;
alter table batch_schedule_state add column if not exists draft_last_run_at timestamptz;
alter table batch_schedule_state add column if not exists draft_last_service_date date;
alter table batch_schedule_state add column if not exists draft_last_outcome text;
alter table batch_schedule_state add column if not exists analysis_next_run_at timestamptz;
alter table batch_schedule_state add column if not exists analysis_last_run_at timestamptz;
alter table batch_schedule_state add column if not exists analysis_last_service_date date;
alter table batch_schedule_state add column if not exists analysis_last_outcome text;
alter table batch_schedule_state add column if not exists images_next_run_at timestamptz;
alter table batch_schedule_state add column if not exists images_last_run_at timestamptz;
alter table batch_schedule_state add column if not exists images_last_service_date date;
alter table batch_schedule_state add column if not exists images_last_outcome text;
alter table batch_schedule_state add column if not exists discovery_last_service_date date;
alter table batch_schedule_state add column if not exists discovery_last_outcome text;
alter table batch_schedule_state add column if not exists fixed_schedule_initialized boolean not null default false;

update batch_schedule_state set
  draft_next_run_at = coalesce(draft_next_run_at,
    (((now() at time zone 'Asia/Seoul')::date
      + case when (now() at time zone 'Asia/Seoul')::time >= time '07:00' then 1 else 0 end) + time '07:00') at time zone 'Asia/Seoul'),
  analysis_next_run_at = coalesce(analysis_next_run_at,
    (((now() at time zone 'Asia/Seoul')::date
      + case when (now() at time zone 'Asia/Seoul')::time >= time '08:00' then 1 else 0 end) + time '08:00') at time zone 'Asia/Seoul'),
  images_next_run_at = coalesce(images_next_run_at,
    (((now() at time zone 'Asia/Seoul')::date
      + case when (now() at time zone 'Asia/Seoul')::time >= time '09:00' then 1 else 0 end) + time '09:00') at time zone 'Asia/Seoul'),
  next_run_at = (((now() at time zone 'Asia/Seoul')::date
      + case when (now() at time zone 'Asia/Seoul')::time >= time '10:00' then interval_days else 0 end) + time '10:00') at time zone 'Asia/Seoul',
  fixed_schedule_initialized = true
where id = 1 and fixed_schedule_initialized = false;

alter table processing_queue drop constraint if exists processing_queue_status_check;
alter table processing_queue add constraint processing_queue_status_check
  check (status in ('queued', 'analyzing', 'analysis_completed', 'generating_images', 'awaiting_approval', 'ready_for_registration', 'failed'));
