begin;

create table if not exists generated_ai_detail_sets (
  id bigserial primary key,
  product_draft_id bigint not null references product_drafts(id) on delete cascade,
  prompt_request_id bigint not null references product_image_generation_requests(id) on delete restrict,
  prompt_revision integer not null check (prompt_revision > 0),
  task_type text not null check (task_type = 'detail_page'),
  workflow_mode text not null check (workflow_mode = 'manual_external_ai'),
  provider_code text not null check (provider_code in ('chatgpt','google_gemini','anthropic_claude','custom')),
  provider_display_name text,
  set_version integer not null check (set_version > 0),
  expected_image_count integer not null default 10 check (expected_image_count = 10),
  image_count integer not null default 10 check (image_count = 10),
  sections_json jsonb not null check (jsonb_typeof(sections_json) = 'array' and jsonb_array_length(sections_json) = 10),
  status text not null default 'uploaded' check (status in ('uploaded','approved','rejected','superseded')),
  notes text,
  approval_note text,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  rejected_at timestamptz,
  superseded_at timestamptz,
  superseded_by_set_id bigint references generated_ai_detail_sets(id) on delete set null,
  unique(product_draft_id, task_type, set_version)
);

create table if not exists generated_ai_detail_images (
  id bigserial primary key,
  detail_set_id bigint not null references generated_ai_detail_sets(id) on delete cascade,
  image_index integer not null check (image_index between 1 and 10),
  section_key text not null,
  section_label text not null,
  original_stored_url text not null,
  normalized_stored_url text not null,
  original_width integer not null check (original_width between 860 and 5000),
  original_height integer not null check (original_height between 1100 and 5000),
  normalized_width integer not null check (normalized_width between 1 and 1000),
  normalized_height integer not null check (normalized_height > 0),
  original_file_size integer not null check (original_file_size between 1 and 10000000),
  normalized_file_size integer not null check (normalized_file_size between 1 and 1500000),
  original_mime_type text not null check (original_mime_type in ('image/png','image/jpeg','image/webp')),
  normalized_mime_type text not null default 'image/jpeg' check (normalized_mime_type = 'image/jpeg'),
  jpeg_quality integer not null check (jpeg_quality in (92,88,84,80)),
  sha256 text not null,
  status text not null default 'uploaded' check (status in ('uploaded','approved','rejected','superseded')),
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  rejected_at timestamptz,
  superseded_at timestamptz,
  check (original_width::bigint * original_height::bigint <= 25000000),
  check (original_width::bigint * 100 >= original_height::bigint * 45),
  check (original_width::bigint * 100 <= original_height::bigint * 90),
  unique(detail_set_id, image_index)
);

create unique index if not exists uq_generated_ai_detail_sets_one_approved
on generated_ai_detail_sets(product_draft_id, task_type)
where status='approved';

commit;
