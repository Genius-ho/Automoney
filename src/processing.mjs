export function normalizeProduct(productNo, raw, context = {}) {
  const source = unwrapRaw(raw);
  const price = parseProductPrice(source);
  const shipping = parseShippingFee(source);
  const sourceMarket = inferSourceMarket({ source, raw, context });
  const detailHtml = extractDetailHtml(source, raw);
  const imageEntries = normalizeProductImageEntries({
    mainSource: firstValue(source, ['images', 'imageUrls', 'imageList', 'mainImage', 'imgUrl']) ?? source.thumb,
    detailHtml,
  });
  const minOrderQty = firstPositiveInteger([
    price.minOrderQty,
    firstDeepValue([source, raw, context.candidateSource], ['minOrderQty', 'min_order_qty', 'minimumOrderQuantity', 'orderMinQty', 'order_min_qty', 'moq', 'domeMoq']),
  ]) ?? 1;
  const orderUnit = firstPositiveInteger([
    firstDeepValue([source, raw, context.candidateSource], ['orderUnit', 'order_unit', 'bundleQty', 'bundle_qty', 'unitQty', 'unit_qty']),
  ]) ?? 1;
  const bundle = determineSellUnit({ unitCostPrice: price.value, minOrderQty });

  return {
    productNo: String(productNo),
    supplierMarket: sourceMarket,
    sourceMarket,
    supplierName: compactText(firstValue(source, ['supplierName', 'sellerName', 'seller', 'companyName', 'company']) ?? ''),
    supplierProductUrl: buildSupplierProductUrl(productNo, sourceMarket),
    name: compactText(
      firstValue(source, ['productName', 'itemName', 'goodsName', 'name', 'title']) ?? source.basis?.title,
    ),
    cost: bundle.bundleCostPrice,
    unitCostPrice: price.value,
    bundleCostPrice: bundle.bundleCostPrice,
    sellUnitType: bundle.sellUnitType,
    bundleQuantity: bundle.bundleQuantity,
    bundleReason: bundle.bundleReason,
    rawPriceFieldName: price.fieldName,
    rawPriceValue: price.rawValue,
    priceParseStatus: price.status,
    priceTiers: price.tiers,
    minOrderQty,
    orderUnit,
    shippingFee: shipping.value,
    shippingRawFieldName: shipping.fieldName,
    shippingRawValue: shipping.rawValue,
    shippingParseStatus: shipping.status,
    shippingTiers: shipping.tiers,
    options: normalizeOptions(
      firstValue(source, ['option', 'options', 'optionList', 'items']) ?? source.selectOpt ?? [],
    ),
    images: imageEntries.map((image) => image.url),
    imageEntries,
    detailHtml,
    isSoldOut: Boolean(firstValue(source, ['isSoldOut', 'soldOut', 'soldout'])),
    categoryText: categoryText(source.category),
    brand: null,
    certification: null,
    efficacy: null,
  };
}

export function filterProduct(product) {
  const blockReasons = [];
  const reviewReasons = [];

  if (product.priceParseStatus === 'parsing_error') blockReasons.push('price_parsing_error');
  if (product.priceParseStatus === 'invalid_range') blockReasons.push('price_invalid_range');
  if (!product.name) blockReasons.push('missing_name');
  if (!Number.isFinite(product.cost) || product.cost <= 0) blockReasons.push('missing_or_invalid_cost');
  const unitCostPrice = Number(product.unitCostPrice ?? product.cost);
  const saleUnitCost = Number(product.bundleCostPrice ?? product.cost);
  if (Number.isFinite(saleUnitCost) && saleUnitCost > 0 && saleUnitCost < 3000) {
    blockReasons.push('blocked_low_cost');
  }
  if (!Array.isArray(product.images) || product.images.length === 0) blockReasons.push('missing_images');
  if (product.isSoldOut) blockReasons.push('sold_out');
  if (product.sourceMarket === 'domeggook') reviewReasons.push('needs_review_source_market');
  if (product.sourceMarket === 'unknown') reviewReasons.push('needs_review_source_market_unknown');
  const minOrderQty = Number(product.minOrderQty || 1);
  if (minOrderQty >= 3) {
    // automoney_complete_automation_implementation_plan.md 8.3: "MOQ 3 이상은
    // 원칙적으로 자동등록 후보에서 제외한다" -- this used to only block at >=5,
    // silently letting MOQ 3/4 bundles through as a mere review flag.
    blockReasons.push('blocked_large_bundle');
  } else if (product.sellUnitType === 'bundle') {
    // Only ever MOQ === 2 reaches here now that >=3 is blocked above. Plan
    // 8.2's 2개 세트 조건: 총 공급원가 15,000원 이하, 예상 판매가 35,000원 이하
    // 권장 -- these were never checked at all before; only a generic
    // profit-floor check applied (see minProfit below), so a bundle could
    // clear that while still being an expensive, poor-fit 2-set (e.g. draft
    // 24's real bundleCostPrice of 29,260 -- almost double the recommended
    // ceiling -- currently passes with no signal at all).
    reviewReasons.push('bundle_candidate');
    if (Number.isFinite(product.bundleCostPrice) && product.bundleCostPrice > 15000) {
      reviewReasons.push('needs_review_bundle_cost_over_15000');
    }
    const estimatedSale = estimateSalePrice(product);
    if (estimatedSale !== null && estimatedSale > 35000) {
      reviewReasons.push('needs_review_bundle_sale_over_35000');
    }
  } else if (minOrderQty > 1) {
    reviewReasons.push('needs_review_min_order_qty');
  }
  if (Number(product.orderUnit || 1) > 1) reviewReasons.push('needs_review_order_unit');

  const optionCount = Array.isArray(product.options) ? product.options.length : 0;
  if (optionCount > 30) blockReasons.push('blocked_too_many_options');
  else if (optionCount > 10) reviewReasons.push('needs_review_complex_options');

  const haystack = `${product.name || ''} ${product.categoryText || ''}`.toLowerCase();
  for (const keyword of RISK_KEYWORDS) {
    if (haystack.includes(keyword.toLowerCase())) reviewReasons.push(`risk_keyword:${keyword}`);
  }

  const minProfit = estimateMinimumProfit(product);
  // "예상 순이익 5,000원 이상" is the documented pass bar (both the retired
  // roadmap's 7.1 and the current plan's 7.3) -- this used a different,
  // undocumented 3,000 threshold.
  if (minProfit !== null && minProfit < 5000) {
    if (product.sellUnitType === 'bundle') reviewReasons.push('needs_review_low_margin');
    else blockReasons.push('blocked_low_margin');
  }

  if (blockReasons.length > 0) return filterResult('blocked', unique(blockReasons), unique(reviewReasons), false);
  if (reviewReasons.length > 0) return filterResult('needs_review', [], unique(reviewReasons), true);
  return filterResult('pass', [], [], true);
}

export function calculatePrices(product, rules) {
  const marginRate = rules.defaultMarginRate ?? 0.25;
  const includeShippingFee = rules.includeShippingFeeInPrice ?? true;
  const cost = product.bundleCostPrice ?? product.cost;
  const base = cost + (includeShippingFee ? product.shippingFee || 0 : 0);
  const result = {};
  const optionAdjustments = {};

  for (const [platform, rule] of Object.entries(rules.platforms || {})) {
    const feeRate = rule.feeRate ?? 0;
    const roundTo = rule.roundTo ?? 10;
    const salePrice = roundUp((base * (1 + marginRate)) / (1 - feeRate), roundTo);
    const expectedProfit = Math.round(salePrice * (1 - feeRate) - base);
    const prefix = platform === 'smartstore' ? 'naver' : platform;

    result[platform] = salePrice;
    result[`${prefix}SalePrice`] = salePrice;
    result[`${prefix}ExpectedProfit`] = expectedProfit;
    result[`${prefix}MarginRate`] = roundToDecimals(expectedProfit / salePrice, 2);
    optionAdjustments[platform] = optionPriceAdjustments(product.options, marginRate, feeRate, roundTo);
  }

  return { ...result, optionAdjustments };
}

export function cleanProductName(name) {
  const noiseWords = [
    '\uBB34\uB8CC\uBC30\uC1A1',
    '\uB2F9\uC77C\uBC1C\uC1A1',
    '\uB3C4\uB9E4',
    '\uD2B9\uAC00',
    '\uAD6D\uB0B4\uBC30\uC1A1',
  ];
  const bracketNoise = new RegExp(`\\[(${noiseWords.join('|')})\\]`, 'g');
  const wordNoise = new RegExp(`(${noiseWords.slice(0, 4).join('|')})`, 'g');
  return compactText(String(name || ''))
    .replace(bracketNoise, '')
    .replace(wordNoise, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function buildDetailHtml(product) {
  const productName = compactText(product.name);
  const category = compactText(product.categoryText);
  const options = Array.isArray(product.options) ? product.options : [];
  const imageEntries = Array.isArray(product.imageEntries)
    ? product.imageEntries
    : (product.images || []).map((url, index) => ({ url, imageType: index === 0 ? 'main' : 'detail' }));
  const sortedImages = [...imageEntries].sort(
    (a, b) => (a.sortOrder ?? a.index ?? 0) - (b.sortOrder ?? b.index ?? 0) || (a.sliceIndex ?? 0) - (b.sliceIndex ?? 0),
  );
  const mainImages = sortedImages
    .filter((image) => image.imageType === 'main')
    .map((image) => image.storedUrl || image.url)
    .slice(0, 3);
  const selectedImages = sortedImages
    .filter((image) => image.selectedForDetail && !['detail_source_full', 'detail_full', 'detail_slice', 'detail_source_slice'].includes(image.imageType))
    .map((image) => image.storedUrl || image.url);
  const regeneratedAssets = sortedImages
    .filter((image) => image.imageType === 'regenerated_detail_asset')
    .map((image) => image.storedUrl || image.url);
  const renderedDetailImages = sortedImages
    .filter((image) => image.sourceMethod === 'rendered_dom' && image.sourceSection === 'detail' && image.imageType === 'detail')
    .map((image) => image.storedUrl || image.url);
  const sourceFullImages = sortedImages
    .filter((image) => ['detail_source_full', 'detail_full'].includes(image.imageType))
    .map((image) => image.storedUrl || image.url);
  const sliceFallbackImages = sortedImages
    .filter((image) => ['detail_source_slice', 'detail_slice'].includes(image.imageType))
    .map((image) => image.storedUrl || image.url);
  const bodyImages = unique([selectedImages, regeneratedAssets, renderedDetailImages].flat()).slice(0, 6);
  const referenceImages = unique(sourceFullImages.length > 0 ? sourceFullImages : sliceFallbackImages).slice(0, 3);
  const visibleOptions = options.slice(0, 20);
  const optionRows = visibleOptions
    .map(
      (option) =>
        `<tr><td>${escapeHtml(option.name || '옵션')}</td><td>${escapeHtml(option.value || '-')}</td><td>${formatMoney(option.additionalPrice || 0)}</td></tr>`,
    )
    .join('\n');
  const specs = [
    ...(product.sellUnitType === 'bundle'
      ? [
          ['구성', `동일 상품 ${product.bundleQuantity}개 세트`],
          ['판매단위', `${product.bundleQuantity}개 묶음`],
          ['단품 원가', formatMoney(product.unitCostPrice)],
          ['묶음 원가', formatMoney(product.bundleCostPrice)],
        ]
      : []),
    ['상품명', productName || 'missing'],
    ['카테고리', category || 'missing'],
    ['공급 원가', formatMoney(product.cost)],
    ['배송비', formatMoney(product.shippingFee)],
    ['최소 주문 수량', product.minOrderQty || 1],
    ['가격 원본 필드', product.rawPriceFieldName ? `${product.rawPriceFieldName}: ${product.rawPriceValue}` : 'missing'],
    ['배송 원본 필드', product.shippingRawFieldName ? `${product.shippingRawFieldName}: ${product.shippingRawValue}` : 'missing'],
  ].filter(([, value]) => value !== '' && value !== null && value !== undefined);
  const specRows = specs.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join('\n');
  const mainImageHtml = mainImages.map((url) => `<img src="${escapeHtml(url)}" alt="${escapeHtml(productName)}" loading="lazy">`).join('\n');
  const bodyImageHtml = bodyImages
    .map((url) => `<img src="${escapeHtml(url)}" alt="${escapeHtml(productName)} 상세 이미지" loading="lazy">`)
    .join('\n');
  const referenceImageHtml = referenceImages
    .map(
      (url) =>
        `<p><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"><img src="${escapeHtml(url)}" alt="${escapeHtml(productName)} 원본 상세 이미지" loading="lazy"></a></p>`,
    )
    .join('\n');
  const sourceDetailHtml = compactText(product.detailHtml) ? String(product.detailHtml) : '';
  const recommendationItems = [
    `${productName || '이 상품'}의 원본 상품 정보와 옵션을 확인한 뒤 등록하려는 분`,
    options.length > 0 ? '옵션 구성을 비교해서 판매 문구를 정리해야 하는 분' : '',
    Number(product.shippingFee) > 0 ? '배송비를 포함한 실제 판매가를 검수해야 하는 분' : '',
  ].filter(Boolean);
  const benefitItems = [
    mainImages.length > 0 || bodyImages.length > 0 || referenceImages.length > 0
      ? '원본 이미지 자료를 바탕으로 상품 외형을 검수할 수 있습니다.'
      : '원본 이미지 자료가 부족하므로 공급처 페이지 확인이 필요합니다.',
    options.length > 0 ? `총 ${options.length}개 옵션 정보가 제공됩니다.` : '옵션 정보는 원본에서 확인되지 않았습니다.',
    Number.isFinite(Number(product.shippingFee)) ? `확인된 배송비는 ${formatMoney(product.shippingFee)}입니다.` : '배송비 정보는 missing입니다.',
  ];

  return [
    '<section class="product-draft-detail">',
    '<style>',
    '.product-draft-detail{font-family:Arial,sans-serif;line-height:1.6;color:#1f2933;max-width:860px;margin:0 auto;}',
    '.product-draft-detail h1{font-size:28px;margin:0 0 12px;}',
    '.product-draft-detail h2{font-size:20px;margin:0 0 12px;}',
    '.product-draft-detail .am-section{padding:24px 0;border-bottom:1px solid #e5e7eb;}',
    '.product-draft-detail .am-images{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-top:16px;}',
    '.product-draft-detail .am-reference img{max-height:900px;object-fit:contain;}',
    '.product-draft-detail img{width:100%;height:auto;border:1px solid #e5e7eb;background:#fff;}',
    '.product-draft-detail table{width:100%;border-collapse:collapse;}',
    '.product-draft-detail th,.product-draft-detail td{border:1px solid #e5e7eb;padding:8px;text-align:left;vertical-align:top;}',
    '.product-draft-detail ul{margin:0;padding-left:20px;}',
    '</style>',
    '<section class="am-section am-hero">',
    `<h1>${escapeHtml(productName)}</h1>`,
    category ? `<p>카테고리: ${escapeHtml(category)}</p>` : '',
    mainImageHtml ? `<div class="am-images">${mainImageHtml}</div>` : '',
    '</section>',
    bodyImageHtml ? `<section class="am-section am-detail-assets"><h2>상품 이미지 자료</h2><div class="am-images">${bodyImageHtml}</div></section>` : '',
    '<section class="am-section am-recommend">',
    '<h2>이런 분께 추천</h2>',
    '<ul>',
    recommendationItems.map((item) => `<li>${escapeHtml(item)}</li>`).join('\n'),
    '</ul>',
    '</section>',
    '<section class="am-section am-specs">',
    '<h2>구성/스펙표</h2>',
    `<table><tbody>${specRows}</tbody></table>`,
    '</section>',
    '<section class="am-section am-benefits">',
    '<h2>핵심 장점</h2>',
    '<ul>',
    benefitItems.map((item) => `<li>${escapeHtml(item)}</li>`).join('\n'),
    '</ul>',
    '</section>',
    '<section class="am-section am-reference">',
    '<h2>원본 상세 이미지 참고 영역</h2>',
    referenceImageHtml || '<p>원본 긴 상세 이미지는 missing입니다. 공급처 원본 페이지 확인이 필요합니다.</p>',
    sourceDetailHtml,
    '</section>',
    '<section class="am-section am-options">',
    '<h2>옵션 안내</h2>',
    optionRows
      ? `<table><thead><tr><th>옵션명</th><th>옵션값</th><th>추가금액</th></tr></thead><tbody>${optionRows}</tbody></table>`
      : '<p>원본에서 확인된 옵션 정보가 없습니다.</p>',
    options.length > visibleOptions.length ? `<p>외 ${options.length - visibleOptions.length}개 옵션은 관리자 화면에서 확인하세요.</p>` : '',
    '</section>',
    '<section class="am-section am-shipping">',
    '<h2>배송/교환/반품 안내</h2>',
    '<ul>',
    `<li>배송비: ${formatMoney(product.shippingFee)}</li>`,
    '<li>교환/반품 조건은 공급처 정책과 상품 상태를 확인한 뒤 최종 확정해야 합니다.</li>',
    '<li>등록 전 관리자 화면에서 원본 상품정보와 상세 이미지를 반드시 검수하세요.</li>',
    '</ul>',
    '</section>',
    '</section>',
  ].join('\n');
}

function buildLegacyDetailHtml(product) {
  const productName = compactText(product.name);
  const category = compactText(product.categoryText);
  const options = Array.isArray(product.options) ? product.options : [];
  const imageEntries = Array.isArray(product.imageEntries)
    ? product.imageEntries
    : (product.images || []).map((url, index) => ({ url, imageType: index === 0 ? 'main' : 'detail' }));
  const mainImages = imageEntries.filter((image) => image.imageType === 'main').map((image) => image.url).slice(0, 3);
  const sliceImages = imageEntries
    .filter((image) => image.imageType === 'detail_slice')
    .sort((a, b) => (a.sliceIndex ?? a.sortOrder ?? 0) - (b.sliceIndex ?? b.sortOrder ?? 0))
    .map((image) => image.storedUrl || image.url);
  const fallbackDetailImages = imageEntries
    .filter((image) => ['detail_full', 'detail'].includes(image.imageType))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((image) => image.storedUrl || image.url);
  const detailImages = (sliceImages.length > 0 ? sliceImages : fallbackDetailImages).slice(0, 10);
  const images = [...mainImages, ...detailImages].slice(0, 12);
  const visibleOptions = options.slice(0, 20);
  const optionRows = visibleOptions
    .map(
      (option) =>
        `<tr><td>${escapeHtml(option.name || '옵션')}</td><td>${escapeHtml(option.value || '-')}</td><td>${formatMoney(option.additionalPrice || 0)}</td></tr>`,
    )
    .join('\n');
  const imageHtml = images
    .map((url) => `<img src="${escapeHtml(url)}" alt="${escapeHtml(productName)}" loading="lazy">`)
    .join('\n');
  const detailImageHtml = detailImages
    .map((url) => `<img src="${escapeHtml(url)}" alt="${escapeHtml(productName)} detail" loading="lazy">`)
    .join('\n');
  const specs = [
    ...(product.sellUnitType === 'bundle'
      ? [
          ['구성', `동일 상품 ${product.bundleQuantity}개 세트`],
          ['판매단위', `${product.bundleQuantity}개 묶음`],
          ['단품 원가', formatMoney(product.unitCostPrice)],
          ['묶음 원가', formatMoney(product.bundleCostPrice)],
        ]
      : []),
    ['상품명', productName],
    ['카테고리', category],
    ['공급 원가', formatMoney(product.cost)],
    ['배송비', formatMoney(product.shippingFee)],
    ['최소 주문 수량', product.minOrderQty || ''],
    ['가격 원본 필드', product.rawPriceFieldName ? `${product.rawPriceFieldName}: ${product.rawPriceValue}` : ''],
    ['배송 원본 필드', product.shippingRawFieldName ? `${product.shippingRawFieldName}: ${product.shippingRawValue}` : ''],
  ].filter(([, value]) => value !== '' && value !== null && value !== undefined);
  const specRows = specs
    .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`)
    .join('\n');
  const sourceDetail = compactText(product.detailHtml)
    ? `<section class="am-section am-source"><h2>원본 상세 정보</h2>${product.detailHtml}</section>`
    : '';

  return [
    '<section class="product-draft-detail">',
    '<style>',
    '.product-draft-detail{font-family:Arial,sans-serif;line-height:1.6;color:#1f2933;max-width:860px;margin:0 auto;}',
    '.product-draft-detail h1{font-size:28px;margin:0 0 12px;}',
    '.product-draft-detail h2{font-size:20px;margin:0 0 12px;}',
    '.product-draft-detail .am-section{padding:24px 0;border-bottom:1px solid #e5e7eb;}',
    '.product-draft-detail .am-hero{padding-top:8px;}',
    '.product-draft-detail .am-images{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-top:16px;}',
    '.product-draft-detail img{width:100%;height:auto;border:1px solid #e5e7eb;background:#fff;}',
    '.product-draft-detail table{width:100%;border-collapse:collapse;}',
    '.product-draft-detail th,.product-draft-detail td{border:1px solid #e5e7eb;padding:8px;text-align:left;vertical-align:top;}',
    '.product-draft-detail ul{margin:0;padding-left:20px;}',
    '</style>',
    '<section class="am-section am-hero">',
    `<h1>${escapeHtml(productName)}</h1>`,
    category ? `<p>카테고리: ${escapeHtml(category)}</p>` : '',
    imageHtml ? `<div class="am-images">${imageHtml}</div>` : '',
    '</section>',
    detailImageHtml
      ? `<section class="am-section am-detail-images"><h2>원본 상세 이미지</h2><div class="am-images">${detailImageHtml}</div></section>`
      : '',
    '<section class="am-section am-recommend">',
    '<h2>이런 분께 추천</h2>',
    '<ul>',
    `<li>${escapeHtml(productName)} 상품 정보를 확인하고 구매하려는 분</li>`,
    options.length > 0 ? '<li>옵션 구성을 비교한 뒤 선택하려는 분</li>' : '',
    product.shippingFee > 0 ? '<li>배송비를 포함한 총 구매 비용을 확인하려는 분</li>' : '',
    '</ul>',
    '</section>',
    '<section class="am-section am-specs">',
    '<h2>스펙표</h2>',
    `<table><tbody>${specRows}</tbody></table>`,
    '</section>',
    '<section class="am-section am-benefits">',
    '<h2>핵심 장점</h2>',
    '<ul>',
    images.length > 0 ? `<li>원본 이미지 ${images.length}장을 통해 상품 외형을 확인할 수 있습니다.</li>` : '',
    options.length > 0 ? `<li>총 ${options.length}개 옵션 정보가 제공됩니다.</li>` : '',
    Number.isFinite(product.shippingFee) ? `<li>확인된 배송비는 ${formatMoney(product.shippingFee)}입니다.</li>` : '',
    '</ul>',
    '</section>',
    '<section class="am-section am-options">',
    '<h2>옵션 안내</h2>',
    optionRows
      ? `<table><thead><tr><th>옵션명</th><th>옵션값</th><th>추가금액</th></tr></thead><tbody>${optionRows}</tbody></table>`
      : '<p>원본에서 확인된 옵션 정보가 없습니다.</p>',
    options.length > visibleOptions.length ? `<p>외 ${options.length - visibleOptions.length}개 옵션은 관리자 화면에서 확인하세요.</p>` : '',
    '</section>',
    '<section class="am-section am-shipping">',
    '<h2>배송/교환/반품 안내</h2>',
    '<ul>',
    `<li>배송비: ${formatMoney(product.shippingFee)}</li>`,
    '<li>교환/반품 조건은 판매처 정책과 상품 상태 확인 후 최종 확정해야 합니다.</li>',
    '<li>등록 전 관리자 화면에서 원본 상품정보와 상세 내용을 반드시 검수하세요.</li>',
    '</ul>',
    '</section>',
    sourceDetail,
    '</section>',
  ].join('\n');
}

function unwrapRaw(raw) {
  if (raw?.domeggook && typeof raw.domeggook === 'object') return raw.domeggook;
  if (raw?.data && typeof raw.data === 'object') return raw.data;
  if (raw?.item && typeof raw.item === 'object') return raw.item;
  if (raw?.product && typeof raw.product === 'object') return raw.product;
  return raw || {};
}

function firstValue(source, names) {
  for (const name of names) {
    if (source[name] !== undefined && source[name] !== null && source[name] !== '') return source[name];
  }
  return null;
}

const RISK_KEYWORDS = [
  '\uD654\uC7A5\uD488',
  '\uC2A4\uD0A8',
  '\uB85C\uC158',
  '\uD5A5\uC218',
  '\uC2DD\uD488',
  '\uAC74\uAC15\uAE30\uB2A5\uC2DD\uD488',
  '\uC758\uB8CC\uAE30\uAE30',
  '\uB2E4\uC774\uC5B4\uD2B8',
  'KC',
  '\uC5B4\uB9B0\uC774',
  '\uBC30\uD130\uB9AC',
  '\uCDA9\uC804\uAE30',
  '\uC804\uAE30\uC6A9\uD488',
  '\uBA85\uD488',
  '\uC815\uD488',
  '\uC0E4\uB12C',
  '\uAD6C\uCC0C',
  '\uB8E8\uC774\uBE44\uD1B5',
  '\uB098\uC774\uD0A4',
  '\uC544\uB514\uB2E4\uC2A4',
];

function filterResult(filterStatus, blockReasons, reviewReasons, accepted) {
  const filterReasons = [...blockReasons, ...reviewReasons];
  return {
    accepted,
    reason: filterReasons[0] || 'pass',
    filterStatus,
    filterReasons,
    blockReasons,
    reviewReasons,
  };
}

// Rough go/no-go estimate at the filter stage, before calculatePrices' real
// per-platform fee rates are available (filterProduct only ever sees the
// product, never pricingRules) -- a flat 25% margin / 6% fee heuristic,
// same numbers estimateMinimumProfit already used.
function estimateSalePrice(product) {
  const cost = product.bundleCostPrice ?? product.cost;
  if (!Number.isFinite(cost) || cost <= 0) return null;
  const shippingFee = Number.isFinite(product.shippingFee) ? product.shippingFee : 0;
  return Math.ceil(((cost + shippingFee) * 1.25) / 0.94);
}

function estimateMinimumProfit(product) {
  const cost = product.bundleCostPrice ?? product.cost;
  if (!Number.isFinite(cost) || cost <= 0) return null;
  const shippingFee = Number.isFinite(product.shippingFee) ? product.shippingFee : 0;
  const estimatedSale = estimateSalePrice(product);
  return estimatedSale - cost - shippingFee;
}

function determineSellUnit({ unitCostPrice, minOrderQty }) {
  const unitCost = Number(unitCostPrice || 0);
  const qty = Number(minOrderQty || 1);
  // Supplier enforces a minimum purchase quantity: a single unit is never
  // actually purchasable on its own, so anything with qty > 1 must be sold
  // as a bundle matching that minimum, regardless of its unit cost.
  if (qty > 1 && unitCost > 0) {
    return {
      sellUnitType: 'bundle',
      bundleQuantity: qty,
      bundleCostPrice: unitCost * qty,
      bundleReason: 'bundle_candidate',
    };
  }
  return {
    sellUnitType: 'single',
    bundleQuantity: 1,
    bundleCostPrice: unitCost,
    bundleReason: null,
  };
}

function parseProductPrice(source) {
  const candidates = [
    ['price.dome', source.price?.dome],
    ['price.supply', source.price?.supply],
    ['supplyPrice', source.supplyPrice],
    ['cost', source.cost],
    ['salePrice', source.salePrice],
    ['unitPrice', source.unitPrice],
  ];
  for (const [fieldName, rawValue] of candidates) {
    if (rawValue !== undefined && rawValue !== null && rawValue !== '') {
      return parseMoneyField(fieldName, rawValue, { min: 100, max: 1000000 });
    }
  }
  return { fieldName: null, rawValue: null, value: 0, status: 'missing' };
}

function parseShippingFee(source) {
  const candidates = [
    ['deliveryFee', source.deliveryFee],
    ['shippingFee', source.shippingFee],
    ['deliveryPrice', source.deliveryPrice],
    ['deli.supply.fee', source.deli?.supply?.fee],
    ['deli.dome.fee', source.deli?.dome?.fee],
    ['deli.supply.tbl', source.deli?.supply?.tbl],
    ['deli.dome.tbl', source.deli?.dome?.tbl],
  ];
  for (const [fieldName, rawValue] of candidates) {
    if (rawValue !== undefined && rawValue !== null && rawValue !== '') {
      return parseMoneyField(fieldName, rawValue, { min: 0, max: 1000000 });
    }
  }
  return { fieldName: null, rawValue: null, value: 0, status: 'missing' };
}

function normalizeSourceMarket(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return 'unknown';
  if (['domeme', 'dome', '도매매'].includes(text)) return 'domeme';
  if (['domeggook', 'supply', 'wholesale', '도매꾹'].includes(text)) return 'domeggook';
  if (text.includes('domeme') || text.includes('도매매')) return 'domeme';
  if (text.includes('domeggook') || text.includes('도매꾹')) return 'domeggook';
  return 'unknown';
}

function inferSourceMarket({ source, raw, context }) {
  const explicit = normalizeSourceMarket(
    firstDeepValue([source, raw, context.candidateSource], ['sourceMarket', 'supplierMarket', 'market', 'itemMarket', 'sellMarket', 'source', 'domain', 'itemType']) ??
      context.sourceMarket,
  );
  if (explicit !== 'unknown') return explicit;
  if (context.requestedMarket === 'dome') return 'domeme';
  return 'unknown';
}

function buildSupplierProductUrl(productNo, sourceMarket) {
  const no = encodeURIComponent(String(productNo));
  if (sourceMarket === 'domeme') return `https://domeggook.com/main/item/itemView.php?no=${no}&market=dome`;
  if (sourceMarket === 'domeggook') return `https://domeggook.com/main/item/itemView.php?no=${no}`;
  return `https://domeggook.com/main/item/itemView.php?no=${no}`;
}

function firstPositiveInteger(values) {
  for (const value of values) {
    const number = toNumber(value);
    if (Number.isInteger(number) && number > 0) return number;
  }
  return null;
}

function firstDeepValue(sources, keys) {
  for (const source of sources) {
    const found = findDeepValue(source, new Set(keys));
    if (found !== null && found !== undefined && found !== '') return found;
  }
  return null;
}

function findDeepValue(value, keys, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 4) return null;
  for (const [key, inner] of Object.entries(value)) {
    if (keys.has(key) && inner !== null && inner !== undefined && inner !== '') return inner;
  }
  for (const inner of Object.values(value)) {
    const found = findDeepValue(inner, keys, depth + 1);
    if (found !== null && found !== undefined && found !== '') return found;
  }
  return null;
}

function parseMoneyField(fieldName, rawValue, { min, max }) {
  if (typeof rawValue === 'number') return validateMoney(fieldName, rawValue, rawValue, { min, max });
  if (typeof rawValue !== 'string') return { fieldName, rawValue, value: 0, status: 'parsing_error' };

  const tiers = parseTieredMoney(rawValue);
  if (tiers) {
    const validated = validateMoney(fieldName, rawValue, tiers[0].price, { min, max });
    return {
      ...validated,
      status: validated.status === 'ok' ? 'tiered_price' : validated.status,
      tiers,
      minOrderQty: tiers[0].minQty,
    };
  }

  const cleaned = rawValue.replace(/[,원\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return { fieldName, rawValue, value: 0, status: 'parsing_error' };
  return validateMoney(fieldName, rawValue, Number(cleaned), { min, max });
}

function parseTieredMoney(rawValue) {
  const text = String(rawValue).trim();
  if (!/^\d+\+\d+(?:\|\d+\+\d+)*$/.test(text)) return null;
  return text.split('|').map((tier) => {
    const [minQty, price] = tier.split('+').map(Number);
    return { minQty, price };
  });
}

function validateMoney(fieldName, rawValue, value, { min, max }) {
  if (!Number.isFinite(value)) return { fieldName, rawValue, value: 0, status: 'parsing_error' };
  if (value < min || value > max) return { fieldName, rawValue, value: 0, status: 'invalid_range' };
  return { fieldName, rawValue, value, status: 'ok' };
}

function categoryText(category) {
  if (!category) return '';
  const parts = [];
  const parents = category.parents?.elem;
  if (Array.isArray(parents)) parts.push(...parents.map((item) => item.name).filter(Boolean));
  if (category.current?.name) parts.push(category.current.name);
  return parts.join(' > ');
}

function unique(values) {
  return [...new Set(values)];
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function toNumber(value) {
  if (typeof value === 'number') return value;
  const number = Number(String(value || '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(number) ? number : 0;
}

function normalizeOptions(value) {
  if (!value) return [];
  if (typeof value === 'string') {
    try {
      return normalizeOptions(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (value.set && Array.isArray(value.set)) return normalizeDomeggookOptions(value);
  if (Array.isArray(value)) return value.map(normalizeOption);
  if (typeof value === 'object') {
    return Object.entries(value).map(([name, values]) => ({
      name,
      values,
      additionalPrice: 0,
      raw: { [name]: values },
    }));
  }
  return [];
}

// selectOpt.data (keyed by 도매매's own order-option-code, e.g. "00" for a
// single-dimension option or "01_03" for a combination) is the authoritative
// per-SKU view -- its key IS the exact code Phase 8's setOrder call needs,
// and its qty is the real per-option supplier stock. Prior to this, only
// selectOpt.set[].opts[] (display name/price by array position) was read,
// which has no code at all. Falls back to the set-only reconstruction when
// `data` is absent (defensive -- not observed live, but set is still the
// only field the plan's original normalizeOptions ever guaranteed).
function normalizeDomeggookOptions(value) {
  const sets = Array.isArray(value.set) ? value.set : [];
  const data = value.data && typeof value.data === 'object' && !Array.isArray(value.data) ? value.data : null;

  if (data) {
    const combinedName = sets.map((set) => compactText(set.name ?? '')).filter(Boolean).join('/');
    return Object.entries(data).map(([code, entry]) =>
      normalizeOption({
        name: combinedName,
        value: entry?.name,
        additionalPrice: entry?.domPrice ?? 0,
        optionCode: code,
        stockQuantity: entry?.qty,
      }),
    );
  }

  return sets.flatMap((set) => {
    const name = compactText(set.name ?? '');
    const values = Array.isArray(set.opts) ? set.opts : [];
    const prices = Array.isArray(set.domPrice) ? set.domPrice : [];
    return values.map((value, index) =>
      normalizeOption({
        name,
        value,
        additionalPrice: prices[index] ?? 0,
      }),
    );
  });
}

function normalizeOption(option) {
  if (!option || typeof option !== 'object') {
    return { name: String(option ?? ''), value: '', additionalPrice: 0, raw: option };
  }
  const normalized = {
    name: compactText(firstValue(option, ['name', 'optionName', 'label']) ?? ''),
    value: compactText(firstValue(option, ['value', 'optionValue', 'text']) ?? ''),
    additionalPrice: toNumber(
      firstValue(option, ['additionalPrice', 'addPrice', 'optionPrice', 'priceDiff', 'extraPrice']),
    ),
    raw: option,
  };
  if (option.optionCode != null) normalized.optionCode = String(option.optionCode);
  if (option.stockQuantity != null) normalized.stockQuantity = toNumber(option.stockQuantity);
  return normalized;
}

export function normalizeImages(value) {
  if (!value) return [];
  if (typeof value === 'string') return uniqueImageUrls(extractImageUrlsFromText(value));
  if (Array.isArray(value)) {
    return uniqueImageUrls(value.flatMap((item) => normalizeImages(item)));
  }
  if (typeof value === 'object') {
    if (value.original && hasThumbnailShape(value)) return normalizeImages(value.original);
    return uniqueImageUrls(Object.values(value).flatMap((item) => normalizeImages(item)));
  }
  return [];
}

export function normalizeProductImageEntries({ mainSource, detailHtml = '', pageHtml = '' } = {}) {
  const entries = [];
  for (const url of normalizeImages(mainSource)) {
    entries.push({ url, imageType: 'main', sortOrder: 0, originalUrl: url, storedUrl: url });
  }
  const detailUrls = normalizeImages([extractImageUrlsFromHtml(detailHtml), extractImageUrlsFromHtml(pageHtml)]);
  let detailIndex = 0;
  for (const url of detailUrls) {
    entries.push({
      url,
      imageType: 'detail',
      sortOrder: 100 + detailIndex,
      originalUrl: url,
      storedUrl: url,
    });
    detailIndex += 1;
  }
  return uniqueImageEntries(entries);
}

export function extractDetailHtml(source, raw = source) {
  const direct = firstValue(source, [
      'detailHtml',
      'descriptionHtml',
      'content',
      'description',
      'itemDetail',
      'itemContent',
      'itemDescription',
      'html',
      'detail',
    ]);
  const candidates = [
    direct,
    source.desc?.contents,
    source.desc?.content,
    source.desc?.html,
    source.desc?.detail,
    collectHtmlLikeStrings(source),
    collectHtmlLikeStrings(raw),
  ];
  return decodeHtmlEntities(unique(candidates.map(htmlCandidateToString).filter(Boolean)).join('\n'));
}

function hasThumbnailShape(value) {
  const keys = new Set(Object.keys(value || {}).map((key) => key.toLowerCase()));
  return ['original', 'large', 'medium', 'small', 'thumb'].some((key) => keys.has(key));
}

function extractImageUrlsFromHtml(html) {
  const urls = [];
  const text = String(html || '');
  const imgPattern = /<img\b[^>]*\b(?:src|data-src|data-original|data-lazy|ec-data-src)\s*=\s*(["']?)([^"'\s>]+)\1/gi;
  let match;
  while ((match = imgPattern.exec(text))) {
    urls.push(decodeHtmlAttribute(match[2]));
  }
  const srcsetPattern = /<img\b[^>]*\bsrcset\s*=\s*(["'])(.*?)\1/gi;
  while ((match = srcsetPattern.exec(text))) {
    urls.push(
      ...decodeHtmlAttribute(match[2])
        .split(',')
        .map((item) => item.trim().split(/\s+/)[0])
        .filter(Boolean),
    );
  }
  const looseImageUrlPattern = /https?:\/\/[^\s"'<>]+?\.(?:jpg|jpeg|png|webp|gif)(?:\?[^\s"'<>]*)?/gi;
  while ((match = looseImageUrlPattern.exec(text))) {
    urls.push(decodeHtmlAttribute(match[0]));
  }
  return urls;
}

function extractImageUrlsFromText(value) {
  const text = String(value || '');
  if (/<img\b/i.test(text) || /https?:\/\/[^\s"'<>]+?\.(?:jpg|jpeg|png|webp|gif)/i.test(text)) {
    return extractImageUrlsFromHtml(text);
  }
  return text.split(/[,\s]+/).filter((url) => /^https?:\/\//i.test(url));
}

function uniqueImageUrls(urls) {
  const seen = new Set();
  const result = [];
  for (const rawUrl of urls.flat()) {
    const url = String(rawUrl || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const key = imageIdentity(url);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(url);
  }
  return result;
}

function uniqueImageEntries(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const url = String(entry?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const key = imageIdentity(url);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ ...entry, url, originalUrl: entry.originalUrl || url, storedUrl: entry.storedUrl || url });
  }
  return result;
}

function imageIdentity(url) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/([_-])\d{2,4}x\d{2,4}(?=\.[a-z0-9]+$)/i, '');
    return `${parsed.hostname.toLowerCase()}${path.toLowerCase()}`;
  } catch {
    return url.split(/[?#]/)[0].toLowerCase();
  }
}

function decodeHtmlAttribute(value) {
  return decodeHtmlEntities(value);
}

function decodeHtmlEntities(value) {
  let text = String(value || '');
  for (let i = 0; i < 3; i += 1) {
    const decoded = text
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&amp;', '&')
      .replaceAll('&quot;', '"')
      .replaceAll('&#34;', '"')
      .replaceAll('&#39;', "'")
      .replaceAll('&apos;', "'");
    if (decoded === text) break;
    text = decoded;
  }
  return text;
}

function htmlCandidateToString(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(htmlCandidateToString).filter(Boolean).join('\n');
  if (typeof value === 'object') return Object.values(value).map(htmlCandidateToString).filter(Boolean).join('\n');
  return '';
}

function collectHtmlLikeStrings(value, path = '', depth = 0) {
  if (depth > 8 || value == null) return [];
  if (typeof value === 'string') {
    const lowerPath = path.toLowerCase();
    const lowerValue = value.toLowerCase();
    const pathLooksLikeHtml =
      lowerPath.includes('desc') ||
      lowerPath.includes('detail') ||
      lowerPath.includes('content') ||
      lowerPath.includes('html');
    if (
      pathLooksLikeHtml ||
      (pathLooksLikeHtml && (lowerValue.includes('<img') || lowerValue.includes('&lt;img')))
    ) {
      return [value];
    }
    return [];
  }
  if (Array.isArray(value)) return value.flatMap((item, index) => collectHtmlLikeStrings(item, `${path}[${index}]`, depth + 1));
  if (typeof value === 'object') {
    return Object.entries(value).flatMap(([key, inner]) => collectHtmlLikeStrings(inner, path ? `${path}.${key}` : key, depth + 1));
  }
  return [];
}

function optionPriceAdjustments(options = [], marginRate, feeRate, roundTo) {
  return options
    .filter((option) => Number.isFinite(option.additionalPrice) && option.additionalPrice > 0)
    .map((option) => ({
      name: option.name,
      value: option.value,
      additionalPrice: roundUp((option.additionalPrice * (1 + marginRate)) / (1 - feeRate), roundTo),
    }));
}

function roundUp(value, unit) {
  if (!unit || unit <= 1) return Math.ceil(value);
  return Math.ceil(value / unit) * unit;
}

function roundToDecimals(value, decimals) {
  const multiplier = 10 ** decimals;
  return Math.round(value * multiplier) / multiplier;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function formatMoney(value) {
  if (!Number.isFinite(Number(value))) return '-';
  return `${Number(value).toLocaleString('ko-KR')}원`;
}
