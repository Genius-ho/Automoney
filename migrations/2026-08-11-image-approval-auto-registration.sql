alter table processing_queue drop constraint if exists processing_queue_status_check;

update processing_queue pq set
  status = 'draft_created',
  failure_stage = null,
  failure_message = null,
  updated_at = now()
where pq.status = 'ready_for_registration'
  and not exists (
    select 1 from coupang_product_registrations cpr
    where cpr.product_draft_id = pq.draft_id
  );

update processing_queue set
  status = 'awaiting_image_approval',
  updated_at = now()
where status = 'awaiting_approval';

update processing_queue pq set
  status = 'awaiting_sale_approval',
  failure_stage = null,
  failure_message = null,
  updated_at = now()
where pq.status not in ('completed', 'failed')
  and exists (
    select 1 from coupang_product_registrations cpr
    where cpr.product_draft_id = pq.draft_id
  );

alter table processing_queue add constraint processing_queue_status_check
  check (status in ('queued', 'draft_created', 'analyzing', 'analysis_completed', 'generating_images', 'awaiting_image_approval', 'registering', 'awaiting_sale_approval', 'completed', 'failed'));
