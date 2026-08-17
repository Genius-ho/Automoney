-- Same staggered-schedule pattern as
-- 2026-08-11-staggered-product-automation-schedule.sql's draft/analysis/images
-- columns -- a new daily stage (imageQa, slot hour 11, after images at 9) that
-- reviews whatever the images stage produced earlier the same day.
alter table batch_schedule_state add column if not exists qa_next_run_at timestamptz;
alter table batch_schedule_state add column if not exists qa_last_run_at timestamptz;
alter table batch_schedule_state add column if not exists qa_last_service_date date;
alter table batch_schedule_state add column if not exists qa_last_outcome text;

update batch_schedule_state set
  qa_next_run_at = coalesce(qa_next_run_at,
    (((now() at time zone 'Asia/Seoul')::date
      + case when (now() at time zone 'Asia/Seoul')::time >= time '11:00' then 1 else 0 end) + time '11:00') at time zone 'Asia/Seoul')
where id = 1;
