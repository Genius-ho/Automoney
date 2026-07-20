begin;

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

commit;
