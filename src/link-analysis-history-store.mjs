// 2026-08-22 사용자 요청: "링크 입력"/텔레그램 링크 분석 점수를 계속 쌓아두고
// 과거 히스토리(키워드/링크/점수)를 볼 수 있게 저장 -- schema.sql의
// link_analysis_history 테이블. 자세한 배경은 그 테이블의 헤더 코멘트 참고.
function toLinkAnalysisHistoryRow(row) {
  return {
    id: Number(row.id),
    supplierProductNo: row.supplier_product_no,
    name: row.name,
    score: row.score == null ? null : Number(row.score),
    scoreBreakdown: row.score_breakdown || {},
    filterStatus: row.filter_status,
    sourceMarket: row.source_market,
    coupangSalePrice: row.coupang_sale_price == null ? null : Number(row.coupang_sale_price),
    coupangExpectedProfit: row.coupang_expected_profit == null ? null : Number(row.coupang_expected_profit),
    keyword: row.keyword,
    source: row.source,
    analyzedAt: row.analyzed_at,
  };
}

// One insert per analyzed result -- called best-effort (failures logged, not
// thrown) by product-link-analysis.mjs right after scoring, so a history-
// write hiccup never breaks the analysis response itself.
export async function insertLinkAnalysisHistory(db, rows) {
  if (!rows || rows.length === 0) return [];
  const inserted = [];
  for (const row of rows) {
    const result = await db.query(
      `insert into link_analysis_history
         (supplier_product_no, name, score, score_breakdown, filter_status, source_market,
          coupang_sale_price, coupang_expected_profit, keyword, source)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10)
       returning *`,
      [
        row.supplierProductNo,
        row.name ?? null,
        row.score ?? null,
        JSON.stringify(row.scoreBreakdown || {}),
        row.filterStatus ?? null,
        row.sourceMarket ?? null,
        row.coupangSalePrice ?? null,
        row.coupangExpectedProfit ?? null,
        row.keyword ?? null,
        row.source || 'link_input',
      ],
    );
    inserted.push(toLinkAnalysisHistoryRow(result.rows[0]));
  }
  return inserted;
}

export async function listLinkAnalysisHistory(db, { limit = 50, offset = 0 } = {}) {
  const result = await db.query(
    `select * from link_analysis_history order by analyzed_at desc limit $1 offset $2`,
    [limit, offset],
  );
  return result.rows.map(toLinkAnalysisHistoryRow);
}
