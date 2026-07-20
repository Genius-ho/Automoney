function toCategoryPolicy(row) {
  return {
    id: Number(row.id),
    segmentName: row.segment_name,
    categoryName: row.category_name,
    searchKeywords: row.search_keywords || [],
    domeggookCategoryCode: row.domeggook_category_code,
    isActive: row.is_active,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

export async function listActiveCategoryPolicies(db) {
  const result = await db.query('select * from category_policy where is_active = true order by id');
  return result.rows.map(toCategoryPolicy);
}

// "최근 30일 동안 선택한 카테고리는 가능하면 다시 선택하지 않는다" -- the set
// of category_policy ids this function returns is what selectRandomCategories
// (auto-discovery-batch.mjs) tries to avoid first, falling back to allowing a
// repeat only when too few categories remain outside this set.
export async function getRecentlySelectedCategoryIds(db, { withinDays = 30 } = {}) {
  const result = await db.query(
    `select distinct category_policy_id from batch_category_selections
     where selected_at >= now() - ($1 || ' days')::interval`,
    [String(withinDays)],
  );
  return result.rows.map((row) => Number(row.category_policy_id));
}

export async function recordCategorySelections(db, batchRunId, categoryPolicyIds) {
  for (const categoryPolicyId of categoryPolicyIds) {
    await db.query(
      'insert into batch_category_selections (batch_run_id, category_policy_id) values ($1, $2)',
      [batchRunId, categoryPolicyId],
    );
  }
}
