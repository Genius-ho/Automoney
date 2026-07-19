begin;

alter table seo_keyword_analysis add column if not exists keyword_scores jsonb not null default '[]'::jsonb;
alter table seo_keyword_analysis add column if not exists removed_supplier_labels jsonb not null default '[]'::jsonb;

commit;
