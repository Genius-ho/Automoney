const SUPPLIER_NOISE_PATTERNS = [
  /\((당일출고|특가|추천|인기)[^)]+\)/gi,
  // \b only anchors on ASCII word characters, so it never matches around Korean
  // text; use a Unicode letter/number boundary instead so bare noise words are
  // actually stripped, not just excluded later as stopwords during scoring.
  /(?<![\p{L}\p{N}])(당일출고|특가|추천|인기|무료배송|국내배송)(?![\p{L}\p{N}])/gu,
];

const FORBIDDEN_KEYWORDS = [
  '정품',
  '명품',
  '의료기기',
  '다이어트',
  'KC인증',
  '효과보장',
  '1위',
  '최저가',
];

const STOPWORDS = new Set([
  '및',
  '겸용',
  '상품',
  '도매',
  '국내',
  '무료배송',
  '당일출고',
  '특가',
  '추천',
  '인기',
]);

const LEADING_BRACKET_LABEL = /^\s*\[([^\]]+)\]\s*/;

export function buildRegistrationOptimization({ draft, naverResearch }) {
  const searchRaw = naverResearch?.raw?.searchRaw || {};
  const naverItems = Array.isArray(searchRaw.items) ? searchRaw.items : [];
  const topTitles = naverItems.slice(0, 20).map((item) => stripHtml(item.title || '')).filter(Boolean);
  const rawTitle = draft.sellingTitle || draft.cleanedName || draft.rawName || draft.originalProductName || '';
  const { labels: removedSupplierLabels, remainder } = extractLeadingSupplierLabels(rawTitle);
  const baseKeyword = cleanSourceTitle(remainder, removedSupplierLabels);

  const scoredKeywords = scoreKeywords([baseKeyword, ...topTitles], removedSupplierLabels);
  const generatedKeywords = scoredKeywords.map((entry) => entry.keyword);
  const forbiddenKeywords = generatedKeywords.filter((keyword) =>
    FORBIDDEN_KEYWORDS.some((forbidden) => keyword.toLowerCase().includes(forbidden.toLowerCase())),
  );
  const selectedKeywords = generatedKeywords.filter((keyword) => !forbiddenKeywords.includes(keyword)).slice(0, 12);
  const titleResult = buildOptimizedTitles({ draft, selectedKeywords, baseKeyword, removedSupplierLabels });
  const detailHtml = buildOptimizedDetailHtml({ draft, title: titleResult.naverTitle || titleResult.coupangTitle });
  const imagePrompts = buildImagePrompts({ draft, title: titleResult.naverTitle || titleResult.coupangTitle });
  const category = inferCategory({ draft, naverItems });
  const notice = buildNoticeInfo({ draft, category });
  const shippingPolicy = buildShippingPolicy({ draft });

  return {
    seo: {
      marketplace: 'naver',
      baseKeyword,
      removedSupplierLabels,
      generatedKeywords,
      keywordScores: scoredKeywords,
      selectedKeywords,
      forbiddenKeywords,
      naverTotalResults: Number(searchRaw.total || naverResearch?.competitorCount || 0),
      naverLowestPrice: naverResearch?.lowestPrice ?? null,
      naverTopTitles: topTitles,
      datalabScore: null,
      datalabTrendDirection: 'skipped_no_category',
      reasons: ['naver_search_titles_used', 'datalab_skipped_no_category'],
    },
    titles: titleResult,
    detailHtml,
    imagePrompts,
    category,
    notice,
    shippingPolicy,
  };
}

// Domeme/Domeggook raw titles conventionally lead with "[공급처명]" or "[이벤트명]".
// Deriving the label from the product's own title (instead of a hardcoded brand
// whitelist) removes any past seller's brand mark, not just previously seen ones.
export function extractLeadingSupplierLabels(value) {
  let remainder = String(value || '');
  const labels = [];
  let match = remainder.match(LEADING_BRACKET_LABEL);
  while (match) {
    const label = match[1].trim();
    if (label) labels.push(label);
    remainder = remainder.slice(match[0].length);
    match = remainder.match(LEADING_BRACKET_LABEL);
  }
  return { labels, remainder: remainder.trim() };
}

export function cleanSourceTitle(value, supplierLabels = []) {
  let text = String(value || '');
  for (const pattern of SUPPLIER_NOISE_PATTERNS) text = text.replace(pattern, ' ');
  for (const label of supplierLabels) {
    if (!label) continue;
    text = text.split(`[${label}]`).join(' ').split(label).join(' ');
  }
  return text.replace(/\s+/g, ' ').trim();
}

// Popularity score = share of today's top Naver listings (plus the product's own
// cleaned title) that contain the keyword at least once, so a word repeated many
// times inside a single title can no longer outrank a word that many different
// competitors actually use.
export function scoreKeywords(documents, supplierLabels = []) {
  const excluded = new Set(supplierLabels.filter(Boolean));
  const docs = (Array.isArray(documents) ? documents : [])
    .map((value) => cleanSourceTitle(stripHtml(value), supplierLabels))
    .filter(Boolean);
  const documentCount = docs.length || 1;
  const documentFrequency = new Map();
  for (const doc of docs) {
    const seenInDoc = new Set();
    for (const token of doc.split(/[\s,/|+_-]+/)) {
      const keyword = token.trim();
      if (!keyword || keyword.length < 2 || /^\d+$/.test(keyword) || STOPWORDS.has(keyword) || excluded.has(keyword)) continue;
      seenInDoc.add(keyword);
    }
    for (const keyword of seenInDoc) documentFrequency.set(keyword, (documentFrequency.get(keyword) || 0) + 1);
  }
  return [...documentFrequency.entries()]
    .map(([keyword, frequency]) => ({
      keyword,
      documentFrequency: frequency,
      score: roundToTwoDecimals(frequency / documentCount),
    }))
    .sort((a, b) => b.score - a.score
      || b.documentFrequency - a.documentFrequency
      || b.keyword.length - a.keyword.length
      || a.keyword.localeCompare(b.keyword, 'ko'))
    .slice(0, 30);
}

export function buildOptimizedTitles({ draft, selectedKeywords, baseKeyword, removedSupplierLabels = [] }) {
  const warnings = [];
  const source = cleanSourceTitle(baseKeyword, removedSupplierLabels);
  const titleParts = unique([
    ...selectedKeywords.slice(0, 6),
    ...source.split(/\s+/).filter(Boolean).slice(0, 4),
  ]).filter((keyword) => !FORBIDDEN_KEYWORDS.includes(keyword));
  if (draft.sellUnitType === 'bundle') titleParts.push(`${draft.bundleQuantity}개 세트`);
  const naverTitle = compactTitle(titleParts.join(' '), 80);
  const coupangTitle = compactTitle(titleParts.join(' '), 100);
  if (naverTitle !== titleParts.join(' ')) warnings.push('title_trimmed');
  return {
    coupangTitle,
    naverTitle,
    titleKeywords: selectedKeywords.slice(0, 10),
    titleWarnings: warnings,
  };
}

export function buildOptimizedDetailHtml({ draft, title }) {
  const specs = [
    ['상품명', title],
    ['공급마켓', labelMarket(draft.supplierMarket)],
    ['공급 상품번호', draft.supplierProductNo],
    ['판매단위', draft.sellUnitType === 'bundle' ? `${draft.bundleQuantity}개 묶음` : '단품'],
    ['구성', draft.sellUnitType === 'bundle' ? `동일 상품 ${draft.bundleQuantity}개 세트` : '동일 상품 1개'],
    ['공급 원가', formatMoney(draft.cost)],
    ['배송비', formatMoney(draft.shippingFee)],
  ].filter(([, value]) => value !== null && value !== undefined && value !== '');
  const optionRows = (draft.options || [])
    .slice(0, 20)
    .map((option) => `<tr><td>${escapeHtml(option.name || '-')}</td><td>${escapeHtml(option.value || '-')}</td><td>${formatMoney(option.additionalPrice || 0)}</td></tr>`)
    .join('');
  const imageHtml = (draft.images || [])
    .slice(0, 8)
    .map((image) => `<img src="${escapeHtml(image.url)}" alt="${escapeHtml(title)}" loading="lazy">`)
    .join('');
  return [
    '<section class="product-draft-detail">',
    '<style>.product-draft-detail{font-family:Arial,sans-serif;line-height:1.6;color:#1f2933;max-width:860px;margin:0 auto}.product-draft-detail .am-section{padding:24px 0;border-bottom:1px solid #e5e7eb}.product-draft-detail table{width:100%;border-collapse:collapse}.product-draft-detail th,.product-draft-detail td{border:1px solid #e5e7eb;padding:8px;text-align:left}.product-draft-detail img{max-width:100%;height:auto;border:1px solid #e5e7eb;margin:4px}</style>',
    `<section class="am-section"><h1>${escapeHtml(title)}</h1>${imageHtml}</section>`,
    '<section class="am-section"><h2>사용 추천 대상</h2><ul><li>원본 상품명과 옵션을 확인하고 구매하려는 분</li><li>배송비와 구성 수량을 함께 확인하려는 분</li></ul></section>',
    `<section class="am-section"><h2>구성/스펙표</h2><table><tbody>${specs.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('')}</tbody></table></section>`,
    '<section class="am-section"><h2>핵심 포인트</h2><ul><li>도매매 원본 상품명, 이미지, 옵션, 가격 정보에서 확인 가능한 내용만 정리했습니다.</li><li>등록 전 관리자 검수 화면에서 원본 링크와 네이버 최저가를 확인하세요.</li></ul></section>',
    `<section class="am-section"><h2>옵션/구성 안내</h2>${optionRows ? `<table><tbody>${optionRows}</tbody></table>` : '<p>확인된 옵션 정보가 없습니다.</p>'}</section>`,
    '<section class="am-section"><h2>배송/교환/반품 안내</h2><ul><li>배송비는 공급처 원본 배송비 기준으로 설정합니다.</li><li>제주/도서산간, 반품배송비, 교환배송비는 등록 전 최종 확인이 필요합니다.</li></ul></section>',
    '</section>',
  ].join('');
}

export function buildImagePrompts({ draft, title }) {
  const unit = draft.sellUnitType === 'bundle' ? `${draft.bundleQuantity}개 세트` : '단품';
  const base = `${title}, ${unit}, 실제 상품 이미지와 일치해야 함, 과장된 브랜드/인증/효능 표현 금지`;
  return {
    heroImagePrompt: `${base}, 깨끗한 흰 배경의 대표 이미지 보조 배경`,
    detailBannerPrompt: `${base}, 상세페이지 상단 배너용, 핵심 구성과 배송비 안내 중심`,
    usageScenePrompt: `${base}, 실제 사용 상황을 보여주는 배경 중심 이미지, 상품 형태 왜곡 금지`,
    specCardPrompt: `${base}, 구성 수량과 스펙을 정리한 정보 카드`,
  };
}

export function inferCategory({ draft, naverItems }) {
  const first = naverItems.find((item) => item.category1 || item.category2 || item.category3 || item.category4) || {};
  const naverCategory = [first.category1, first.category2, first.category3, first.category4].filter(Boolean).join(' > ');
  return {
    domemeCategory: draft.categoryText || '',
    naverCategory,
    coupangDisplayCategoryCode: null,
    coupangCategoryName: null,
    confidenceScore: naverCategory ? 0.6 : 0.2,
    confirmedByUser: false,
  };
}

export function buildNoticeInfo({ draft, category }) {
  const noticeItems = {
    품명: draft.sellingTitle || draft.originalProductName || null,
    모델명: null,
    법에의한인증허가: null,
    제조국: null,
    제조자: null,
    소비자상담관련전화번호: null,
  };
  const missingItems = Object.entries(noticeItems)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  const requiredDocuments = /의료|KC|전기|어린이|식품/.test(`${category.naverCategory || ''} ${draft.originalProductName || ''}`);
  return {
    marketplace: 'common',
    noticeCategory: category.naverCategory || '생활용품',
    noticeItems,
    missingItems,
    status: requiredDocuments || missingItems.length ? 'needs_review' : 'complete',
    requiredDocuments,
    certifications: requiredDocuments ? ['category_requires_document_review'] : [],
  };
}

export function buildShippingPolicy({ draft }) {
  const shippingFee = Number(draft.shippingFee || 0);
  return {
    marketplace: 'common',
    name: 'default_domeme_policy',
    shippingFee,
    returnShippingFee: 6000,
    exchangeShippingFee: 6000,
    islandRemoteRequiredReview: true,
    status: 'needs_review',
  };
}

function compactTitle(title, limit) {
  return unique(String(title || '').split(/\s+/).filter(Boolean)).join(' ').slice(0, limit).trim();
}

function unique(values) {
  return [...new Set(values)];
}

function stripHtml(value) {
  return String(value || '').replace(/<[^>]*>/g, '').trim();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function formatMoney(value) {
  if (value == null || value === '') return '-';
  return `${Number(value).toLocaleString('ko-KR')}원`;
}

function labelMarket(value) {
  return { domeme: '도매매', domeggook: '도매꾹', unknown: 'unknown' }[value] || value || 'unknown';
}

function roundToTwoDecimals(value) {
  return Math.round(value * 100) / 100;
}
