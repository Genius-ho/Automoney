begin;
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
create index if not exists product_image_generation_request_revisions_request_id_idx on product_image_generation_request_revisions(request_id,revision);
commit;
