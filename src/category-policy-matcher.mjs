// Coupang-keyword sourcing (coupang-keyword-sourcing.mjs) lets a human pick
// an arbitrary keyword off a live Coupang listing -- unlike the 3-day
// discovery cycle, which only ever searches the hand-curated safe segments
// in category_policy (see schema.sql's comment on that table: food,
// medical-device, electrical/battery, certification-needed categories are
// deliberately never seeded there). To keep that same safety boundary, a
// keyword only proceeds if it matches one of an active policy's
// search_keywords -- otherwise it's held for manual review instead of
// reaching Domeggook/processing_queue at all.
function normalize(text) {
  return String(text || '').replace(/\s+/g, '').toLowerCase();
}

// Bidirectional substring match: a policy keyword like "책꽂이" matches a
// human-typed "미니 책꽂이 수납장", and a human-typed "정리함" matches a
// policy keyword like "수납정리함" -- either containment counts, since both
// directions represent "the same product type".
export function matchCategoryPolicyForKeyword(policies, keyword) {
  const normalizedKeyword = normalize(keyword);
  if (!normalizedKeyword) return null;
  for (const policy of policies || []) {
    const matches = (policy.searchKeywords || []).some((entry) => {
      const normalizedEntry = normalize(entry);
      if (!normalizedEntry) return false;
      return normalizedKeyword.includes(normalizedEntry) || normalizedEntry.includes(normalizedKeyword);
    });
    if (matches) return policy;
  }
  return null;
}
