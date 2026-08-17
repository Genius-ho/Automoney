begin;

-- Automated image quality check (generated-image-qa.mjs / task-routing.mjs's
-- generated_image_review) -- an independent model (Claude, not the one that
-- generated the images) reviews the approved-pending main+detail image set
-- before it's auto-approved. Purely additive audit trail: this table never
-- drives processing_queue/generated_ai_images status directly -- a 'pass'
-- verdict just triggers the existing approveInboxImages() call (the same
-- path a human clicking approve already uses), so nothing about the
-- existing approval state machine changes.
create table if not exists image_qa_reviews (
  id bigserial primary key,
  product_draft_id bigint not null references product_drafts(id) on delete cascade,
  verdict text not null check (verdict in ('pass','fail','error')),
  issues_json jsonb not null default '[]'::jsonb,
  provider_code text not null,
  model text,
  raw_response_json jsonb,
  reviewed_at timestamptz not null default now()
);
create index if not exists idx_image_qa_reviews_draft on image_qa_reviews(product_draft_id, reviewed_at desc);

commit;
