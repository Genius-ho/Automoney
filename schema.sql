create table if not exists supplier_products (
  id bigserial primary key,
  supplier text not null default 'domeme',
  supplier_product_no text not null unique,
  source_market text not null default 'unknown',
  raw_json jsonb not null,
  original_detail_html text,
  fetched_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists product_drafts (
  id bigserial primary key,
  supplier_product_id bigint not null references supplier_products(id) on delete cascade,
  supplier_product_no text not null unique,
  raw_name text,
  cleaned_name text,
  selling_title text,
  cost integer,
  shipping_fee integer,
  raw_price_field_name text,
  raw_price_value text,
  price_parse_status text,
  shipping_raw_field_name text,
  shipping_raw_value text,
  shipping_parse_status text,
  price_tiers jsonb not null default '[]'::jsonb,
  shipping_tiers jsonb not null default '[]'::jsonb,
  min_order_qty integer,
  order_unit integer,
  supplier_product_url text,
  sell_unit_type text not null default 'single',
  bundle_quantity integer not null default 1,
  unit_cost_price integer,
  bundle_cost_price integer,
  bundle_reason text,
  image_count integer not null default 0,
  option_count integer not null default 0,
  filter_status text not null,
  block_reasons jsonb not null default '[]'::jsonb,
  review_reasons jsonb not null default '[]'::jsonb,
  coupang_sale_price integer,
  coupang_expected_profit integer,
  coupang_margin_rate numeric,
  naver_sale_price integer,
  naver_expected_profit integer,
  naver_margin_rate numeric,
  status text not null,
  draft_html text,
  generated_detail_html text,
  review_memo text,
  import_batch_id text,
  collected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table product_drafts add column if not exists selling_title text;
alter table product_drafts add column if not exists generated_detail_html text;
alter table product_drafts add column if not exists review_memo text;
alter table product_drafts add column if not exists import_batch_id text;
alter table product_drafts add column if not exists collected_at timestamptz;
alter table product_drafts add column if not exists order_unit integer;
alter table product_drafts add column if not exists supplier_product_url text;
alter table product_drafts add column if not exists sell_unit_type text not null default 'single';
alter table product_drafts add column if not exists bundle_quantity integer not null default 1;
alter table product_drafts add column if not exists unit_cost_price integer;
alter table product_drafts add column if not exists bundle_cost_price integer;
alter table product_drafts add column if not exists bundle_reason text;
alter table supplier_products add column if not exists source_market text not null default 'unknown';
alter table supplier_products add column if not exists supplier_page_fetch_status text;
alter table supplier_products add column if not exists supplier_page_fetch_error text;
alter table supplier_products add column if not exists supplier_page_fetched_at timestamptz;

create table if not exists product_options (
  id bigserial primary key,
  product_draft_id bigint not null references product_drafts(id) on delete cascade,
  supplier_product_no text not null,
  option_index integer not null,
  name text,
  value text,
  additional_price integer not null default 0,
  raw_json jsonb,
  unique (product_draft_id, option_index)
);

create table if not exists product_images (
  id bigserial primary key,
  product_draft_id bigint not null references product_drafts(id) on delete cascade,
  supplier_product_no text not null,
  image_index integer not null,
  url text not null,
  unique (product_draft_id, image_index)
);

alter table product_images add column if not exists image_type text not null default 'unknown';
alter table product_images add column if not exists sort_order integer;
alter table product_images add column if not exists original_url text;
alter table product_images add column if not exists stored_url text;
alter table product_images add column if not exists width integer;
alter table product_images add column if not exists height integer;
alter table product_images add column if not exists aspect_ratio numeric;
alter table product_images add column if not exists is_long_image boolean not null default false;
alter table product_images add column if not exists parent_image_id bigint references product_images(id) on delete cascade;
alter table product_images add column if not exists slice_index integer;
alter table product_images add column if not exists source_method text not null default 'api';
alter table product_images add column if not exists source_page_url text;
alter table product_images add column if not exists dom_selector text;
alter table product_images add column if not exists dom_index integer;
alter table product_images add column if not exists rendered_x numeric;
alter table product_images add column if not exists rendered_y numeric;
alter table product_images add column if not exists rendered_width numeric;
alter table product_images add column if not exists rendered_height numeric;
alter table product_images add column if not exists natural_width integer;
alter table product_images add column if not exists natural_height integer;
alter table product_images add column if not exists content_hash text;
alter table product_images add column if not exists crawl_status text;
alter table product_images add column if not exists crawl_error text;
alter table product_images add column if not exists selected_for_detail boolean not null default false;
alter table product_images add column if not exists quality_status text;
alter table product_images add column if not exists source_section text not null default 'unknown';
alter table product_images add column if not exists reject_reason text;

create table if not exists supplier_page_crawl_results (
  id bigserial primary key,
  product_draft_id bigint not null references product_drafts(id) on delete cascade,
  supplier_product_url text not null,
  status text not null,
  status_code integer,
  image_count integer not null default 0,
  detail_image_count integer not null default 0,
  screenshot_path text,
  error_message text,
  crawled_at timestamptz not null default now(),
  raw_summary_json jsonb not null default '{}'::jsonb
);

create table if not exists market_research_results (
  id bigserial primary key,
  product_draft_id bigint not null references product_drafts(id) on delete cascade,
  marketplace text not null,
  keyword text,
  my_sale_price integer,
  lowest_price integer,
  top_price_avg integer,
  competitor_count integer,
  rocket_exists boolean not null default false,
  max_review_count integer,
  avg_rating numeric,
  price_gap_rate numeric,
  winner_score integer not null,
  winner_status text not null,
  reasons jsonb not null default '[]'::jsonb,
  raw_json jsonb,
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_draft_id, marketplace)
);

create table if not exists seo_keyword_analysis (
  id bigserial primary key,
  product_draft_id bigint not null references product_drafts(id) on delete cascade,
  marketplace text not null,
  base_keyword text,
  extracted_keywords jsonb not null default '[]'::jsonb,
  generated_keywords jsonb not null default '[]'::jsonb,
  selected_keywords jsonb not null default '[]'::jsonb,
  forbidden_keywords jsonb not null default '[]'::jsonb,
  naver_total_results integer,
  naver_lowest_price integer,
  naver_top_titles jsonb not null default '[]'::jsonb,
  datalab_score numeric,
  datalab_trend_direction text,
  reasons jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_draft_id, marketplace)
);

alter table seo_keyword_analysis add column if not exists extracted_keywords jsonb not null default '[]'::jsonb;
alter table seo_keyword_analysis add column if not exists keyword_scores jsonb not null default '[]'::jsonb;
alter table seo_keyword_analysis add column if not exists removed_supplier_labels jsonb not null default '[]'::jsonb;

create table if not exists category_mapping (
  id bigserial primary key,
  product_draft_id bigint references product_drafts(id) on delete cascade,
  domeme_category text,
  naver_category text,
  coupang_display_category_code text,
  coupang_category_name text,
  confidence_score numeric,
  confirmed_by_user boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_draft_id)
);

create table if not exists product_notice_info (
  id bigserial primary key,
  product_draft_id bigint not null references product_drafts(id) on delete cascade,
  marketplace text not null,
  notice_category text,
  notice_items jsonb not null default '{}'::jsonb,
  missing_items jsonb not null default '[]'::jsonb,
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_draft_id, marketplace)
);

create table if not exists shipping_policy_templates (
  id bigserial primary key,
  name text not null unique,
  shipping_fee integer,
  return_shipping_fee integer,
  exchange_shipping_fee integer,
  island_remote_required_review boolean not null default true,
  policy_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists product_shipping_policies (
  id bigserial primary key,
  product_draft_id bigint not null references product_drafts(id) on delete cascade,
  template_id bigint references shipping_policy_templates(id),
  marketplace text not null,
  shipping_fee integer,
  return_shipping_fee integer,
  exchange_shipping_fee integer,
  island_remote_required_review boolean not null default true,
  status text not null default 'needs_review',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_draft_id, marketplace)
);

create table if not exists product_registration_checks (
  id bigserial primary key,
  product_draft_id bigint not null references product_drafts(id) on delete cascade,
  supplier_link_checked boolean not null default false,
  naver_lowest_same_item_checked boolean not null default false,
  title_checked boolean not null default false,
  detail_checked boolean not null default false,
  category_checked boolean not null default false,
  notice_checked boolean not null default false,
  shipping_policy_checked boolean not null default false,
  export_json_checked boolean not null default false,
  override_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_draft_id)
);

alter table product_drafts add column if not exists optimized_coupang_title text;
alter table product_drafts add column if not exists optimized_naver_title text;
alter table product_drafts add column if not exists title_keywords jsonb not null default '[]'::jsonb;
alter table product_drafts add column if not exists title_warnings jsonb not null default '[]'::jsonb;
alter table product_drafts add column if not exists title_generated_at timestamptz;
alter table product_drafts add column if not exists hero_image_prompt text;
alter table product_drafts add column if not exists detail_banner_prompt text;
alter table product_drafts add column if not exists usage_scene_prompt text;
alter table product_drafts add column if not exists spec_card_prompt text;

create table if not exists image_prompt_templates (
  id bigserial primary key,
  template_type text not null unique check (template_type in ('main_image', 'detail_page')),
  template_name text not null,
  source_file_name text not null,
  template_body text not null,
  version integer not null default 1,
  is_active boolean not null default true,
  imported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists product_image_generation_requests (
  id bigserial primary key,
  product_draft_id bigint not null references product_drafts(id) on delete cascade,
  request_type text not null check (request_type in ('main_image', 'detail_page')),
  template_id bigint not null references image_prompt_templates(id),
  prompt_original text not null,
  prompt_rendered text not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'generated', 'rejected')),
  source_image_urls_json jsonb not null default '[]'::jsonb,
  competitor_image_urls_json jsonb not null default '[]'::jsonb,
  warnings_json jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_draft_id, request_type)
);
alter table product_image_generation_requests add column if not exists template_version integer;
alter table product_image_generation_requests add column if not exists template_hash text;
alter table product_image_generation_requests add column if not exists source_file_name text;
alter table product_image_generation_requests add column if not exists revision integer not null default 1;
alter table product_image_generation_requests add column if not exists regenerated_at timestamptz;
alter table product_image_generation_requests add column if not exists approved_at timestamptz;
alter table product_image_generation_requests add column if not exists rejected_at timestamptz;
create table if not exists product_image_generation_request_revisions (
 id bigserial primary key, request_id bigint not null references product_image_generation_requests(id) on delete cascade, revision integer not null, template_id bigint, template_version integer, template_hash text, source_file_name text, prompt_original text not null, prompt_rendered text not null, warnings_json jsonb not null default '[]'::jsonb, status text not null, archived_at timestamptz not null default now()
);

create table if not exists ai_provider_configs (
  id bigserial primary key,
  provider_code text not null unique check (provider_code in ('openai','google','anthropic','custom')),
  display_name text not null,
  enabled boolean not null default false,
  api_key_ciphertext text,
  api_key_iv text,
  api_key_auth_tag text,
  base_url text,
  organization_id text,
  project_id text,
  default_text_model text,
  default_vision_model text,
  default_image_model text,
  capabilities jsonb not null default '[]'::jsonb,
  extra_config jsonb not null default '{}'::jsonb,
  last_test_status text not null default 'not_tested',
  last_test_message text,
  last_tested_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ai_task_routing (
  task_type text primary key,
  provider_code text not null check (provider_code in ('openai','google','anthropic','custom')),
  model text,
  enabled boolean not null default false,
  quality text,
  size text,
  max_images_per_request integer not null default 1,
  max_retries integer not null default 0,
  fallback_provider_code text,
  fallback_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists ai_cost_safety_settings (
  id integer primary key default 1 check (id=1),
  monthly_budget_krw integer,
  daily_budget_krw integer,
  max_cost_per_product_krw integer,
  max_main_image_versions integer not null default 1,
  max_detail_images integer not null default 10,
  automatic_retry_enabled boolean not null default false,
  require_human_approval boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into ai_cost_safety_settings(id) values(1) on conflict(id) do nothing;

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

insert into shipping_policy_templates (
  name,
  shipping_fee,
  return_shipping_fee,
  exchange_shipping_fee,
  island_remote_required_review,
  policy_json
)
values (
  'default_domeme_policy',
  null,
  6000,
  6000,
  true,
  '{"source":"domeme","notes":["use supplier shipping fee when present","review Jeju/island remote fees"]}'::jsonb
)
on conflict (name) do nothing;

alter table product_options add column if not exists stock_quantity integer;

create table if not exists coupang_product_registrations (
  id bigserial primary key,
  product_draft_id bigint not null references product_drafts(id) on delete cascade,
  seller_product_id text,
  request_hash text not null,
  status text not null default 'pending',
  requested boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_draft_id)
);

alter table coupang_product_registrations add column if not exists approval_response_message text;
alter table coupang_product_registrations add column if not exists approval_requested_at timestamptz;

alter table coupang_product_registrations add column if not exists linked_via text not null default 'direct_api';
alter table coupang_product_registrations add column if not exists seller_product_name text;
alter table coupang_product_registrations add column if not exists images_swapped_at timestamptz;
alter table coupang_product_registrations add column if not exists last_synced_at timestamptz;
alter table coupang_product_registrations add column if not exists live_status_name text;
alter table coupang_product_registrations add column if not exists live_item_snapshot_json jsonb;
alter table coupang_product_registrations add column if not exists live_total_stock_quantity integer;
alter table coupang_product_registrations add column if not exists live_sale_price integer;

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

create table if not exists coupang_seller_settings (
  id integer primary key default 1 check (id = 1),
  outbound_shipping_place_code text,
  outbound_shipping_place_name text,
  return_center_code text,
  return_center_name text,
  confirmed_at timestamptz,
  updated_at timestamptz not null default now()
);
insert into coupang_seller_settings (id) values (1) on conflict (id) do nothing;

-- Category "whitelist" for the 3-day auto-discovery batch. Keyed by curated
-- search keywords (not a numeric category code) because candidate collection
-- (src/candidate-collector.mjs) is keyword-driven -- the existing
-- data/seed-keywords.json convention -- and no full Domeggook/Coupang
-- category taxonomy is available anywhere in this codebase to validate a
-- code against. Every row here is a hand-picked *safe* segment; categories
-- requiring food/health-supplement, medical-device, pharmaceutical,
-- certification-needed cosmetics, KC-certified children's products,
-- electrical/battery/charging, household-chemical, brand-authenticity-risk,
-- adult, hazardous/flammable, install-or-professional-setup, or
-- unconfirmed origin/certification are deliberately never seeded here.
create table if not exists category_policy (
  id bigserial primary key,
  segment_name text not null,
  category_name text not null unique,
  search_keywords jsonb not null default '[]'::jsonb,
  domeggook_category_code text,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now()
);

insert into category_policy (segment_name, category_name, search_keywords, notes) values
  ('생활/수납', '정리함/수납함', '["수납정리함","다용도정리함","수납박스"]', null),
  ('생활/수납', '옷걸이/행거', '["행거","옷걸이"]', null),
  ('주방', '주방정리용품', '["주방정리대","조리도구거치대","주방수납선반"]', '식품 접촉/보관 용기류는 제외, 정리 거치대류만'),
  ('문구/사무', '데스크정리용품', '["데스크정리함","문구수납함"]', null),
  ('인테리어소품', '벽선반/벽걸이수납', '["벽선반","벽걸이수납장","벽걸이선반"]', null),
  ('반려용품', '반려동물 하우스/방석', '["강아지방석","애견하우스","고양이스크래처"]', '사료/간식 등 식품류 제외'),
  ('패션잡화', '가방/신발 정리용품', '["가방정리함","신발정리함"]', '인증 필요 의류/신발 본품 제외, 정리용품만'),
  ('욕실용품', '욕실수납/샤워용품', '["욕실수납선반","샤워커튼"]', '전동/설치형 제품 제외'),
  ('청소용품', '청소도구 정리', '["청소도구걸이","대걸레거치대"]', '세제 등 화학제품 제외, 거치대류만'),
  ('캠핑/아웃도어', '캠핑정리용품', '["캠핑정리함","캠핑수납박스"]', '버너/가스 등 위험물 제외'),
  ('자동차용품', '차량 정리용품', '["차량정리함","트렁크정리함"]', '전동/설치형 제품 제외'),
  ('원예', '화분/원예소품', '["화분받침대","화분걸이"]', '비료/살충제 등 제외, 용기·거치대류만'),
  ('서재/도서', '책정리용품', '["책꽂이","북엔드"]', null),
  ('세탁용품', '세탁 정리용품', '["빨래바구니","빨래건조대"]', '세제 등 화학제품 제외'),
  ('신발정리', '신발장/신발정리대', '["신발장","신발정리대"]', null),
  ('커튼/블라인드', '커튼 부자재', '["커튼봉","커튼링"]', '전동/설치필요 블라인드 제외, 단순 부자재만'),
  ('파티/이벤트', '파티장식용품', '["파티장식","풍선용품"]', '식품류 제외'),
  ('사무용품', '서류/파일 정리', '["서류정리함","파일꽂이"]', null)
on conflict (category_name) do nothing;

create table if not exists batch_schedule_state (
  id integer primary key default 1 check (id = 1),
  interval_days integer not null default 3,
  next_run_at timestamptz not null default now(),
  last_run_at timestamptz,
  is_running boolean not null default false,
  min_passing_score integer not null default 60,
  updated_at timestamptz not null default now()
);
insert into batch_schedule_state (id) values (1) on conflict (id) do nothing;

create table if not exists batch_runs (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  stage_reached text,
  error_code text,
  error_message text,
  created_at timestamptz not null default now()
);

create table if not exists batch_category_selections (
  id bigserial primary key,
  batch_run_id bigint not null references batch_runs(id) on delete cascade,
  category_policy_id bigint not null references category_policy(id),
  selected_at timestamptz not null default now()
);
create index if not exists idx_batch_category_selections_recent on batch_category_selections(category_policy_id, selected_at desc);

create table if not exists batch_run_candidates (
  id bigserial primary key,
  batch_run_id bigint not null references batch_runs(id) on delete cascade,
  category_policy_id bigint not null references category_policy(id),
  supplier_product_no text not null,
  name text,
  score numeric,
  score_breakdown jsonb not null default '{}'::jsonb,
  is_winner boolean not null default false,
  raw_candidate_json jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_batch_run_candidates_run on batch_run_candidates(batch_run_id);

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

-- Mirrors coupang_product_registrations' shape/dedup approach for the Naver
-- Commerce API raw-registration flow (naver-registration-flow.mjs).
create table if not exists naver_product_registrations (
  id bigserial primary key,
  product_draft_id bigint not null references product_drafts(id) on delete cascade,
  origin_product_no text,
  channel_product_no text,
  request_hash text not null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_draft_id)
);

-- Phase 6 (automoney_complete_automation_implementation_plan.md section 11):
-- 공급처 가격·재고·판매상태 감시. One row per check, so the monitor can
-- always compare "now" against the most recent prior row for that supplier
-- product -- mirrors coupang_product_registrations' one-row-per-event shape
-- rather than a single mutable "current state" row, so the check history
-- itself is never lost.
create table if not exists supplier_snapshots (
  id bigserial primary key,
  supplier_product_id bigint not null references supplier_products(id) on delete cascade,
  supplier_product_no text not null,
  unit_cost_price integer,
  shipping_fee integer,
  min_order_qty integer,
  is_sold_out boolean not null default false,
  price_parse_status text,
  checked_at timestamptz not null default now()
);
create index if not exists idx_supplier_snapshots_product_checked on supplier_snapshots(supplier_product_id, checked_at desc);

-- Phase 7 (automoney_complete_automation_implementation_plan.md section 12):
-- 쿠팡·네이버 주문 자동 수집. One row per channel order LINE (not per order
-- sheet/product-order as a whole) since a single Coupang shipment box can
-- bundle several vendorItemIds, each needing its own supplier mapping and
-- (eventually, Phase 8) its own purchase order. Dedup key is
-- (channel, channel_order_item_id) -- for Coupang that's
-- `${shipmentBoxId}:${vendorItemId}` (the real schema has no single
-- "orderItemId" field the way the plan assumed -- confirmed live against
-- Coupang's documented v5 ordersheets schema, 2026-07-25); for Naver it's
-- productOrderId (Naver's per-line order unit already).
create table if not exists channel_orders (
  id bigserial primary key,
  channel text not null,
  channel_order_id text not null,
  channel_order_item_id text not null,
  channel_product_id text,
  option_info text,
  quantity integer,
  sale_price integer,
  order_status text,
  recipient_name text,
  address text,
  postal_code text,
  phone text,
  delivery_memo text,
  ordered_at timestamptz,
  cancelled_at timestamptz,
  supplier_mapping_status text not null default 'mapping_required',
  supplier_product_id bigint references supplier_products(id),
  raw_json jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel, channel_order_item_id)
);
create index if not exists idx_channel_orders_mapping_status on channel_orders(supplier_mapping_status);
create index if not exists idx_channel_orders_ordered_at on channel_orders(ordered_at desc);

-- 마지막 성공 조회시각 저장 (12.1: "동시 실행 금지", "마지막 성공 조회시각 저장").
-- Single row, mirrors batch_schedule_state's shape for the same reason: one
-- authoritative "when did this last actually run" value per channel.
create table if not exists order_collection_state (
  channel text primary key,
  last_success_at timestamptz,
  is_running boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into order_collection_state (channel) values ('coupang'), ('naver') on conflict (channel) do nothing;
