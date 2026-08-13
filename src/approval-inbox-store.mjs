function numberOrNull(value) {
  return value == null ? null : Number(value);
}

function pricing(row, { saleField = 'coupang_sale_price', costField = 'unit_cost_price', profitField = 'coupang_expected_profit' } = {}) {
  return {
    unitCostPrice: numberOrNull(row[costField]),
    salePrice: numberOrNull(row[saleField]),
    expectedProfit: numberOrNull(row[profitField]),
  };
}

function imageCard(row) {
  return {
    key: `image:${row.draft_id}`,
    type: 'image',
    title: row.product_name || `드래프트 ${row.draft_id}`,
    draftId: Number(row.draft_id),
    queueId: Number(row.queue_id),
    status: row.queue_status,
    availableActions: ['approve_images'],
    pricing: pricing(row),
    mainImage: { id: Number(row.main_image_id), url: row.main_image_url },
    detailImages: row.detail_image_urls || [],
    error: null,
    updatedAt: row.updated_at,
  };
}

function saleCard(row) {
  return {
    key: `sale:${row.draft_id}`,
    type: 'sale',
    title: row.product_name || `드래프트 ${row.draft_id}`,
    draftId: Number(row.draft_id),
    queueId: Number(row.queue_id),
    status: row.queue_status,
    sellerProductId: row.seller_product_id,
    availableActions: ['request_sale_approval'],
    pricing: pricing(row),
    mainImage: null,
    detailImages: [],
    error: null,
    updatedAt: row.updated_at,
  };
}

function purchaseCard(row) {
  return {
    key: `purchase:${row.supplier_order_id}`,
    type: 'purchase',
    title: row.product_name || `드래프트 ${row.draft_id}`,
    draftId: Number(row.draft_id),
    supplierOrderId: Number(row.supplier_order_id),
    status: row.status,
    availableActions: ['approve_purchase_order'],
    pricing: pricing(row, { saleField: 'sale_price', costField: 'supplier_unit_price', profitField: 'estimated_profit' }),
    mainImage: null,
    detailImages: [],
    error: null,
    updatedAt: row.updated_at,
  };
}

function isSafeRetryStage(stage) {
  const value = String(stage || '').toLowerCase();
  return value === 'draft_creation' || value.includes('analysis') || value.includes('image_generation');
}

function failureCard(row) {
  return {
    key: `failed:${row.queue_id}`,
    type: 'failed',
    title: row.product_name || `드래프트 ${row.draft_id}`,
    draftId: numberOrNull(row.draft_id),
    queueId: Number(row.queue_id),
    status: row.queue_status,
    availableActions: isSafeRetryStage(row.failure_stage) ? ['retry'] : [],
    pricing: pricing(row),
    mainImage: null,
    detailImages: [],
    error: { stage: row.failure_stage, message: row.failure_message },
    updatedAt: row.updated_at,
  };
}

async function listImageApprovals(db) {
  const { rows } = await db.query(`
    select pq.id as queue_id, pq.draft_id, coalesce(d.selling_title, pq.name) as product_name,
           pq.status as queue_status, pq.updated_at, d.unit_cost_price, d.coupang_sale_price,
           d.coupang_expected_profit, main.id as main_image_id,
           main.coupang_stored_url as main_image_url, details.id as detail_set_id,
           details.image_count as detail_image_count, detail_files.detail_image_urls
      from processing_queue pq
      join product_drafts d on d.id = pq.draft_id
      join lateral (
        select id, coupang_stored_url from generated_ai_images
         where product_draft_id = pq.draft_id and task_type = 'main_image' and status = 'uploaded'
         order by version desc limit 1
      ) main on true
      join lateral (
        select id, image_count from generated_ai_detail_sets
         where product_draft_id = pq.draft_id and task_type = 'detail_page'
           and status = 'uploaded' and image_count = 10
         order by set_version desc limit 1
      ) details on true
      join lateral (
        select array_agg(normalized_stored_url order by image_index) as detail_image_urls
          from generated_ai_detail_images where detail_set_id = details.id
      ) detail_files on true
     where pq.status = 'awaiting_image_approval'
     order by pq.updated_at asc`);
  return rows;
}

async function listSaleApprovals(db) {
  const { rows } = await db.query(`
    select pq.id as queue_id, pq.draft_id, coalesce(d.selling_title, pq.name) as product_name,
           pq.status as queue_status, pq.updated_at, d.unit_cost_price, d.coupang_sale_price,
           d.coupang_expected_profit, cpr.seller_product_id
      from processing_queue pq
      join product_drafts d on d.id = pq.draft_id
      join coupang_product_registrations cpr on cpr.product_draft_id = pq.draft_id
     where pq.status = 'awaiting_sale_approval' and cpr.requested = false
     order by pq.updated_at asc`);
  return rows;
}

async function listPurchaseApprovals(db) {
  const { rows } = await db.query(`
    select so.id as supplier_order_id, so.product_draft_id as draft_id,
           coalesce(d.selling_title, pq.name) as product_name, so.status, so.updated_at,
           so.sale_price, so.supplier_unit_price, so.estimated_profit
      from supplier_orders so
      join product_drafts d on d.id = so.product_draft_id
      left join processing_queue pq on pq.draft_id = so.product_draft_id
     where so.status = 'awaiting_purchase_approval'
     order by so.updated_at asc`);
  return rows;
}

async function listFailures(db) {
  const { rows } = await db.query(`
    select pq.id as queue_id, pq.draft_id, coalesce(d.selling_title, pq.name) as product_name,
           pq.status as queue_status, pq.failure_stage, pq.failure_message, pq.updated_at,
           d.unit_cost_price, d.coupang_sale_price, d.coupang_expected_profit
      from processing_queue pq
      left join product_drafts d on d.id = pq.draft_id
     where pq.status = 'failed'
     order by pq.updated_at asc`);
  return rows;
}

export async function listApprovalInbox(db) {
  const [images, sales, purchases, failures] = await Promise.all([
    listImageApprovals(db),
    listSaleApprovals(db),
    listPurchaseApprovals(db),
    listFailures(db),
  ]);
  return {
    counts: { image: images.length, sale: sales.length, purchase: purchases.length, failed: failures.length },
    cards: [
      ...images.map(imageCard),
      ...sales.map(saleCard),
      ...purchases.map(purchaseCard),
      ...failures.map(failureCard),
    ],
  };
}
