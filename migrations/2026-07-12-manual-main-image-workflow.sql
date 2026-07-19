begin;
create table if not exists generated_ai_images (
  id bigserial primary key,
  product_draft_id bigint not null references product_drafts(id) on delete cascade,
  prompt_request_id bigint not null references product_image_generation_requests(id) on delete restrict,
  prompt_revision integer not null,
  task_type text not null check (task_type = 'main_image'),
  workflow_mode text not null check (workflow_mode = 'manual_external_ai'),
  provider_code text not null check (provider_code in ('chatgpt','google_gemini','anthropic_claude','custom')),
  provider_display_name text,
  version integer not null,
  original_stored_url text not null,
  coupang_stored_url text not null,
  original_file_size integer not null,
  coupang_file_size integer not null check (coupang_file_size < 3000000),
  original_mime_type text not null check (original_mime_type in ('image/png','image/jpeg','image/webp')),
  coupang_mime_type text not null default 'image/jpeg' check (coupang_mime_type = 'image/jpeg'),
  original_width integer not null,
  original_height integer not null,
  width integer not null default 1000 check (width = 1000),
  height integer not null default 1000 check (height = 1000),
  sha256 text not null,
  status text not null default 'uploaded' check (status in ('uploaded','approved','rejected','superseded')),
  notes text,
  approval_note text,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  rejected_at timestamptz,
  superseded_at timestamptz,
  superseded_by_image_id bigint references generated_ai_images(id) on delete set null,
  unique(product_draft_id, task_type, version)
);
create unique index if not exists uq_generated_ai_images_one_approved_main on generated_ai_images(product_draft_id, task_type) where status = 'approved';
commit;
