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
