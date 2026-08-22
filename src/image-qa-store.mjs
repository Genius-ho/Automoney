// Pure audit trail for generated-image-qa.mjs -- never drives
// processing_queue/generated_ai_images status itself (see that module's
// header comment). One row per review attempt, newest first.
export async function insertImageQaReview(db, { productDraftId, verdict, issues = [], providerCode, model = null, rawResponse = null }) {
  const { rows } = await db.query(
    `insert into image_qa_reviews (product_draft_id, verdict, issues_json, provider_code, model, raw_response_json)
     values ($1, $2, $3::jsonb, $4, $5, $6::jsonb)
     returning *`,
    [productDraftId, verdict, JSON.stringify(issues), providerCode, model, rawResponse == null ? null : JSON.stringify(rawResponse)],
  );
  return toPublicRow(rows[0]);
}

export async function getLatestImageQaReview(db, productDraftId) {
  const { rows } = await db.query(
    `select * from image_qa_reviews where product_draft_id = $1 order by reviewed_at desc limit 1`,
    [productDraftId],
  );
  return rows[0] ? toPublicRow(rows[0]) : null;
}

function toPublicRow(row) {
  return {
    id: Number(row.id),
    productDraftId: Number(row.product_draft_id),
    verdict: row.verdict,
    issues: row.issues_json || [],
    providerCode: row.provider_code,
    model: row.model,
    rawResponse: row.raw_response_json,
    reviewedAt: row.reviewed_at,
  };
}
