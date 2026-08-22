begin;

-- Stage 2: links a batch-created draft back to the run/candidate it came
-- from (null for every manually-created draft, including 27/46/64).
alter table product_drafts add column if not exists batch_run_id bigint references batch_runs(id);
alter table product_drafts add column if not exists batch_candidate_id bigint references batch_run_candidates(id);

-- Per-candidate Stage 2 pipeline progress (draft creation -> analysis ->
-- image generation -> awaiting_image_approval/failed). Only ever set on the
-- one candidate per category marked is_winner=true; every other stored
-- candidate keeps these null.
alter table batch_run_candidates add column if not exists processing_status text;
alter table batch_run_candidates add column if not exists draft_id bigint references product_drafts(id);
alter table batch_run_candidates add column if not exists failure_stage text;
alter table batch_run_candidates add column if not exists failure_message text;
alter table batch_run_candidates add column if not exists last_processed_at timestamptz;
alter table batch_run_candidates add column if not exists python_ran boolean;
alter table batch_run_candidates add column if not exists codex_ran boolean;
alter table batch_run_candidates add column if not exists main_image_generated boolean;
alter table batch_run_candidates add column if not exists detail_images_generated_count integer;
alter table batch_run_candidates add column if not exists unresolved_fields_count integer;

commit;
