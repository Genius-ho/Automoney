// Extracts the notice-relevant fields Domeme actually stores on the supplier
// product (never invents values). Domeme's own `infoDuty.item` list only
// carries *field names* Domeme requires sellers to disclose, each stamped
// with desc:"상세정보 별도표기" ("specified separately in the detail page") --
// that phrase means the real value lives inside a detail-page *image*, not as
// extractable text, so those fields are reported as missing rather than
// guessed from the placeholder description text.
export function extractSupplierNoticeFields(rawJson) {
  const detail = rawJson?.domeggook?.detail || {};
  const infoDutyItems = detail?.infoDuty?.item || [];
  const embeddedInDetailImages = new Set(
    infoDutyItems
      .filter((item) => item?.type === 'item' && String(item?.desc || '').includes('별도표기'))
      .map((item) => item.name),
  );

  return {
    manufacturer: nonEmpty(detail.manufacturer),
    countryOfOrigin: normalizeCountry(detail.country),
    modelName: nonEmpty(detail.model),
    size: extractReliableSize(detail),
    unavailableFromSource: {
      handlingCaution: embeddedInDetailImages.has('취급시 주의사항'),
      warrantyStandard: embeddedInDetailImages.has('품질보증기준'),
      asPhoneNumber: embeddedInDetailImages.has('A/S 책임자와 전화번호'),
    },
    supplierOwnContact: extractSupplierOwnContact(rawJson),
  };
}

function extractReliableSize(detail) {
  const size = nonEmpty(detail.size);
  const weight = nonEmpty(detail.weight);
  // Domeme defaults both size and weight to the same unlabeled placeholder
  // (observed as "0.1"/"0.1") when a seller never filled in real
  // measurements. Treat that specific pattern as "not actually provided"
  // rather than a real physical dimension.
  if (size && size === weight) return null;
  return size;
}

function normalizeCountry(value) {
  const raw = nonEmpty(value);
  if (!raw) return null;
  // Domeme encodes this as underscore-joined segments, e.g. "수입산_아시아_중국".
  return raw.split('_').filter(Boolean).join(' / ');
}

function extractSupplierOwnContact(rawJson) {
  const domeggook = rawJson?.domeggook || {};
  const phone = nonEmpty(domeggook?.seller?.company?.phone) || nonEmpty(domeggook?.return?.addr?.mobile);
  const companyName = nonEmpty(domeggook?.seller?.company?.name);
  if (!phone) return null;
  return {
    phone,
    companyName,
    note: 'This is the original Domeme supplier\'s own business contact, not Automoney\'s storefront contact. Do not reuse as our A/S phone number.',
  };
}

function nonEmpty(value) {
  const text = typeof value === 'string' ? value.trim() : value;
  return text ? text : null;
}

// Maps the draft's single Domeme option group (one row per value, e.g. 베이지/그레이)
// onto Coupang's mandatory "색상" attribute. A `sizeAttributeValue` may be
// supplied (e.g. a dimension read off the detail-page images) to fill the
// first non-색상 mandatory attribute for every item, since the physical box
// size does not vary by color. Categories can require more than one such
// fixed (non-variant) attribute beyond that -- e.g. a "수량" (piece count)
// attribute alongside 색상/사이즈 -- so any further non-색상 mandatory names
// are filled from `additionalAttributeValues` (keyed by attribute name).
// Anything left unfilled is reported unresolved instead of guessed.
// When a draft has no Domeme option rows at all (a genuine single-SKU,
// no-variant product), there is no per-option row to read a 색상 value or
// stock quantity from. In that case exactly one synthetic item is built
// instead, with every mandatory attribute (색상 included) and the stock
// quantity coming from the same admin-supplied overrides used for every
// other unresolved field -- `additionalAttributeValues` keyed by the
// mandatory attribute's own name, and `singleItemStockQuantity`.
export function mapOptionsToMandatoryAttributes({ draftOptions, mandatoryOptionNames, stockByOptionValue = {}, sizeAttributeValue = null, additionalAttributeValues = {}, exposed = null, singleItemStockQuantity = null, attributeMeta = [] }) {
  const colorAttributeName = mandatoryOptionNames.find((name) => name === '색상') || null;
  const remainingAttributeNames = mandatoryOptionNames.filter((name) => name !== colorAttributeName);
  const sizeAttributeName = remainingAttributeNames[0] || null;
  const exposedField = exposed ? { exposed } : {};
  const hasOptions = (draftOptions || []).length > 0;

  const valueForAttribute = (name) => (name === sizeAttributeName
    ? sizeAttributeValue
    : (Object.hasOwn(additionalAttributeValues, name) ? additionalAttributeValues[name] : null));

  // Coupang rejects a NUMBER-datatype mandatory attribute (e.g. "단 수") that
  // carries a bare numeric string with no unit -- confirmed by a real
  // createProduct rejection ("유효하지 않은 구매 옵션 값 혹은 단위가 존재합니다").
  // The category meta names the allowed unit(s) itself (usableUnits, falling
  // back to basicUnit), so it is derived here rather than guessed per call.
  const unitForAttribute = (name) => {
    const meta = attributeMeta.find((attr) => attr.attributeTypeName === name);
    if (!meta || meta.dataType !== 'NUMBER') return null;
    return meta.usableUnits?.[0] || (meta.basicUnit && meta.basicUnit !== '없음' ? meta.basicUnit : null);
  };
  const unitField = (name) => { const unit = unitForAttribute(name); return unit ? { attributeValueUnit: unit } : {}; };

  const items = hasOptions
    ? (draftOptions || []).map((option) => ({
      optionValue: option.optionValue,
      additionalPrice: option.additionalPrice || 0,
      stockQuantity: Object.hasOwn(stockByOptionValue, option.optionValue) ? stockByOptionValue[option.optionValue] : null,
      attributes: [
        colorAttributeName ? { attributeTypeName: colorAttributeName, attributeValueName: option.optionValue, ...exposedField } : null,
        ...remainingAttributeNames.map((name) => ({ attributeTypeName: name, attributeValueName: valueForAttribute(name), ...unitField(name), ...exposedField })),
      ].filter(Boolean),
    }))
    : [{
      optionValue: null,
      additionalPrice: 0,
      stockQuantity: singleItemStockQuantity,
      attributes: [
        colorAttributeName ? { attributeTypeName: colorAttributeName, attributeValueName: Object.hasOwn(additionalAttributeValues, colorAttributeName) ? additionalAttributeValues[colorAttributeName] : null, ...exposedField } : null,
        ...remainingAttributeNames.map((name) => ({ attributeTypeName: name, attributeValueName: valueForAttribute(name), ...unitField(name), ...exposedField })),
      ].filter(Boolean),
    }];

  const unresolvedMandatoryAttributes = hasOptions
    ? remainingAttributeNames.filter((name) => !valueForAttribute(name))
    : mandatoryOptionNames.filter((name) => !items[0].attributes.find((attr) => attr.attributeTypeName === name)?.attributeValueName);
  const missingStock = items.filter((item) => item.stockQuantity === null).map((item) => item.optionValue ?? '(단일상품)');

  return { items, unresolvedMandatoryAttributes, missingStock };
}

// "API 판매자 브랜드 및 상품 식별 정보 필수 입력" (Coupang policy for sellers whose
// first API key was issued on/after 2026-06-01): every item needs a GTIN or
// MPN whenever its brand's own Coupang brand-master entry says so
// (isUIDRequired). Pure so it's testable without a live searchBrand() call
// -- coupang-registration-flow.mjs is the only caller that touches the
// network, passing in whatever CoupangClient.searchBrand(brandName) returned.
// Never fabricates a GTIN/MPN for a brand that doesn't have one for real
// (Coupang explicitly bans inventing purchase-order/SKU numbers as a stand-in,
// e.g. "P003"/"SKU-001") -- MISSING_GTIN_MPN blocks registration instead.
export function resolveBrandIdentifier({ brandSearchResult, brandName, gtin = null, mpn = null }) {
  const candidates = extractList(brandSearchResult);
  const match = candidates.find((candidate) => candidate?.brandName === brandName) || null;

  if (!match) {
    return { status: 'BRAND_NOT_FOUND', brandId: null, isUIDRequired: null, allowedUIDTypes: [], identifierAttributes: [] };
  }
  if (!match.isUIDRequired) {
    return { status: 'NO_UID_REQUIRED', brandId: match.brandId, isUIDRequired: false, allowedUIDTypes: match.allowedUIDTypes || [], identifierAttributes: [] };
  }

  const allowedUIDTypes = match.allowedUIDTypes || [];
  if (allowedUIDTypes.includes('GTIN') && gtin) {
    return {
      status: 'PASS', brandId: match.brandId, isUIDRequired: true, allowedUIDTypes,
      identifierAttributes: [{ attributeTypeName: 'Global Trade Item Number', attributeValueName: gtin, exposed: 'NONE' }],
    };
  }
  if (allowedUIDTypes.includes('MPN') && mpn) {
    return {
      status: 'PASS', brandId: match.brandId, isUIDRequired: true, allowedUIDTypes,
      identifierAttributes: [{ attributeTypeName: 'Manufacturer Part Number', attributeValueName: mpn, exposed: 'NONE' }],
    };
  }
  return { status: 'MISSING_GTIN_MPN', brandId: match.brandId, isUIDRequired: true, allowedUIDTypes, identifierAttributes: [] };
}

function extractList(raw) {
  const payload = raw?.data ?? raw;
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.content)) return payload.content;
  return [];
}

export function formatKstDateTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce((map, part) => ({ ...map, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

// Assembles a best-effort Coupang product-creation payload for local review
// only. Field names for the outer envelope and `items[]` core fields are
// confirmed against public Coupang Open API examples and, for the fields
// listed below, against the actual validation error Coupang returned for an
// earlier, incomplete submission (a real API call that Coupang rejected
// before creating anything -- the error body named every missing field).
//
// Per-item `images[]` carries the single REPRESENTATION photo plus, when
// `detailImageUrlsForImages` is supplied, up to 9 DETAIL photos (Coupang's
// product-images area). The full ordered set of approved detail-page images
// always goes into each item's own `contents` block as well (Coupang's
// validation error named this a per-item requirement, not a product-level
// one) -- so contents can hold all 10 while images[] holds at most 9 DETAIL.
// `generated_detail_html` (the site's own HTML detail page) is never read or
// modified here -- `contents` is built fresh from the approved image URLs.
export function buildCoupangProductPayload({
  draft,
  vendorId,
  vendorUserId = null,
  displayCategoryCode,
  categoryMeta,
  noticeCategoryTemplateName,
  supplierNoticeFields,
  optionMapping,
  outboundShippingPlace,
  returnShippingCenter,
  mainImageUrl = null,
  approvedDetailImageUrls = [],
  detailImageUrlsForImages = [],
  material = null,
  verifiedSize = null,
  handlingCaution = null,
  warrantyStandard = null,
  asPhoneNumber = null,
  noticeContentOverrides = {},
  saleStartedAt = null,
  saleEndedAt = null,
  deliveryCompanyCode,
  deliveryCharge = 0,
  returnCharge = 0,
  remoteAreaDeliverable = true,
  unionDeliverable = true,
  sellerProductId = null,
  sellerProductItemIds = [],
  brand = null,
  brandId = null,
  identifierAttributes = [],
  manufacture = null,
  sellerProductNameOverride = null,
  displayProductNameOverride = null,
  itemNameOverride = null,
  searchTags = [],
  requested = false,
}) {
  const noticeTemplate = (categoryMeta?.noticeCategoryTemplates || [])
    .find((template) => template.noticeCategoryName === noticeCategoryTemplateName) || null;

  // Different Coupang notice templates name the same real-world fact
  // differently (e.g. "제조국" vs "제조국(원산지)"), so common synonyms are
  // covered here directly. `noticeContentOverrides` is the escape hatch for
  // whatever a specific template needs beyond that (e.g. "인증/허가 사항"),
  // keyed by the literal noticeCategoryDetailName Coupang returned.
  const noticeValues = {
    종류: draft.optimizedTitle || null,
    '품명 및 모델명': supplierNoticeFields.modelName ?? draft.optimizedTitle ?? null,
    // Unlike "품명 및 모델명" (a combined field that prefers the real model
    // name when Domeme provides one), a bare "품명" field means just the
    // product's own name -- falling back through modelName here would leak
    // Domeme's literal "해당없음" ("not applicable") placeholder into the
    // product name notice for products with no separate model name.
    '품명': draft.optimizedTitle ?? null,
    소재: material,
    '주요 소재': material,
    치수: verifiedSize ?? supplierNoticeFields.size,
    크기: verifiedSize ?? supplierNoticeFields.size,
    '제조자(수입자)': supplierNoticeFields.manufacturer,
    제조국: supplierNoticeFields.countryOfOrigin,
    '제조국(원산지)': supplierNoticeFields.countryOfOrigin,
    취급시_주의사항: handlingCaution,
    품질보증기준: warrantyStandard,
    'A/S 책임자와 전화번호': asPhoneNumber,
    '소비자상담 관련 전화번호': asPhoneNumber,
    ...noticeContentOverrides,
  };

  const notices = (noticeTemplate?.noticeCategoryDetailNames || []).map((detail) => ({
    noticeCategoryName: noticeCategoryTemplateName,
    noticeCategoryDetailName: detail.noticeCategoryDetailName,
    content: noticeValues[detail.noticeCategoryDetailName] ?? noticeValues[detail.noticeCategoryDetailName.replace(/\s/g, '_')] ?? null,
  }));

  const mainImagePath = mainImageUrl ?? draft.mainImages?.[0] ?? null;
  const imagesPubliclyHosted = isPubliclyHosted(mainImagePath) && approvedDetailImageUrls.length > 0
    && approvedDetailImageUrls.every(isPubliclyHosted);

  const { images: imageOnlyImages, contents } = buildImageOnlyFragments({
    mainImageUrl: mainImagePath,
    detailImageUrls: approvedDetailImageUrls,
    detailImageUrlsForImages,
  });

  const returnAddress = returnShippingCenter?.placeAddresses?.[0] || {};

  const payload = {
    ...(sellerProductId ? { sellerProductId } : {}),
    displayCategoryCode: displayCategoryCode ?? categoryMeta?.displayCategoryCode ?? null,
    sellerProductName: sellerProductNameOverride ?? draft.optimizedTitle,
    vendorId,
    vendorUserId,
    saleStartedAt,
    saleEndedAt,
    displayProductName: displayProductNameOverride ?? draft.displayProductName,
    brand,
    ...(brandId ? { brandId } : {}),
    manufacture,
    deliveryMethod: 'SEQUENCIAL',
    deliveryCompanyCode,
    deliveryChargeType: deliveryCharge > 0 ? 'NOT_FREE' : 'FREE',
    deliveryCharge,
    freeShipOverAmount: 0,
    deliveryChargeOnReturn: returnCharge,
    remoteAreaDeliverable: remoteAreaDeliverable ? 'Y' : 'N',
    unionDeliveryType: unionDeliverable ? 'UNION_DELIVERY' : 'NOT_UNION_DELIVERY',
    outboundShippingPlaceCode: outboundShippingPlace?.outboundShippingPlaceCode ?? null,
    returnCenterCode: returnShippingCenter?.returnCenterCode ?? null,
    returnChargeName: returnShippingCenter?.shippingPlaceName ?? null,
    returnCharge,
    companyContactNumber: asPhoneNumber,
    returnZipCode: returnAddress.returnZipCode ?? null,
    returnAddress: returnAddress.returnAddress ?? null,
    returnAddressDetail: returnAddress.returnAddressDetail ?? null,
    items: optionMapping.items.map((item, index) => ({
      ...(sellerProductItemIds[index] ? { sellerProductItemId: sellerProductItemIds[index] } : {}),
      itemName: itemNameOverride ?? item.optionValue ?? sellerProductNameOverride ?? draft.optimizedTitle,
      originalPrice: draft.salePrice,
      salePrice: draft.salePrice,
      stockQuantity: item.stockQuantity,
      maximumBuyCount: item.stockQuantity,
      maximumBuyForPerson: 0,
      maximumBuyForPersonPeriod: 1,
      outboundShippingTimeDay: 1,
      unitCount: 1,
      taxType: 'TAX',
      parallelImported: 'NOT_PARALLEL_IMPORTED',
      overseasPurchased: 'NOT_OVERSEAS_PURCHASED',
      adultOnly: 'EVERYONE',
      attributes: [...item.attributes, ...identifierAttributes],
      images: imageOnlyImages,
      notices,
      contents,
      searchTags,
    })),
    imagesPubliclyHosted,
    requested,
  };

  return payload;
}

// Builds just the two Coupang product fields that carry images -- items[].
// images (REPRESENTATION + up to 9 DETAIL, Wing's own "상품조회" image
// gallery reads this) and items[].contents (the full ordered detail-page
// image set as HTML, the storefront's long-form description reads this).
// Split out so a later image-only "swap into an already-registered listing"
// flow can reuse the exact same, already-verified-working construction
// (including the contentsType:'TEXT' + <img> fix) without going through the
// rest of buildCoupangProductPayload's category/notice/attribute assembly.
export function buildImageOnlyFragments({ mainImageUrl, detailImageUrls = [], detailImageUrlsForImages = [] }) {
  const images = [
    { imageOrder: 1, imageType: 'REPRESENTATION', vendorPath: mainImageUrl },
    ...detailImageUrlsForImages.map((url, detailIndex) => ({
      imageOrder: detailIndex + 1,
      imageType: 'DETAIL',
      vendorPath: url,
    })),
  ];

  // Coupang deserializes items[].contents as a *list* of content blocks
  // (java type ArrayList<OSellerProductItemContent>), confirmed by the exact
  // "Cannot deserialize ... ArrayList<...OSellerProductItemContent>" error
  // Coupang returned when this was submitted as a single object instead.
  //
  // contentsType/detailType must be "TEXT" with the image wrapped in an
  // <img> tag, not "IMAGE" with a bare URL: the API accepts the latter
  // without error, but the storefront detail page silently fails to render
  // those images. "TEXT" + <img> matches the payload Wing's own "HTML
  // 직접입력" editor produces, per Coupang's official product-creation docs.
  const contents = [
    {
      contentsType: 'TEXT',
      contentDetails: detailImageUrls.map((url, index) => ({
        content: `<img src="${url}" />`,
        detailType: 'TEXT',
        order: index + 1,
      })),
    },
  ];

  return { images, contents };
}

// Translates a Coupang getProduct() response into a valid updateProduct()
// request body for an image-only swap on an already-registered listing
// (e.g. one created outside this app via 스피드고전송기, so this app never
// built the original create payload and can't just re-derive one). GET and
// PUT do NOT share a field-for-field shape -- confirmed by diffing a real
// getProduct() response against a known-good updateProduct() payload from
// this app's own prior registration run:
//   - items[].stockQuantity is absent from GET; the live count only comes
//     back as maximumBuyCount.
//   - items[].images[].vendorPath in GET is a bare filename, with the real
//     fetchable URL only in the sibling cdnPath field; PUT needs a full URL
//     (irrelevant here since images/contents are always fully replaced by
//     the caller, never read from `live`).
//   - items[].attributes in GET is the *entire* category attribute schema
//     (mostly blank values, plus an `editable` flag PUT doesn't expect);
//     PUT only wants the attributes that actually have a value.
//   - GET also carries many response-only fields (trackingId, productId,
//     statusName, vendorItemId, itemId, ...) that don't exist in the PUT
//     schema at all and must be dropped, not passed through blindly.
//   - live.deliveryChargeOnReturn comes back 0 regardless of the real
//     return-shipping charge; live.returnCharge holds the correct value and
//     is what the original create/modify payloads always mirrored it from.
// Every other field this function copies was confirmed identical in shape
// between GET and a known-good PUT payload before this function was
// written. `images`/`contents` (from buildImageOnlyFragments) are applied
// to every item uniformly, since this app's manual-AI image workflow
// approves one main image + one detail-page set per product draft, not per
// Coupang item/variant.
export function mapLiveProductToUpdatePayload(live, { images, contents }) {
  return {
    sellerProductId: live.sellerProductId,
    displayCategoryCode: live.displayCategoryCode,
    sellerProductName: live.sellerProductName,
    vendorId: live.vendorId,
    vendorUserId: live.vendorUserId,
    saleStartedAt: live.saleStartedAt,
    saleEndedAt: live.saleEndedAt,
    displayProductName: live.displayProductName,
    brand: live.brand,
    manufacture: live.manufacture,
    deliveryMethod: live.deliveryMethod,
    deliveryCompanyCode: live.deliveryCompanyCode,
    deliveryChargeType: live.deliveryChargeType,
    deliveryCharge: live.deliveryCharge,
    freeShipOverAmount: live.freeShipOverAmount,
    // Not live.deliveryChargeOnReturn -- confirmed by live diffing (see
    // module comment) that field comes back 0 regardless of the real return
    // charge; the original create/modify payloads always set both
    // deliveryChargeOnReturn and returnCharge from the same source value,
    // so returnCharge is the reliable one to mirror it from.
    deliveryChargeOnReturn: live.returnCharge,
    remoteAreaDeliverable: live.remoteAreaDeliverable,
    unionDeliveryType: live.unionDeliveryType,
    outboundShippingPlaceCode: live.outboundShippingPlaceCode,
    returnCenterCode: live.returnCenterCode,
    returnChargeName: live.returnChargeName,
    returnCharge: live.returnCharge,
    companyContactNumber: live.companyContactNumber,
    returnZipCode: live.returnZipCode,
    returnAddress: live.returnAddress,
    returnAddressDetail: live.returnAddressDetail,
    // Never re-trigger an approval submission as a side effect of an image
    // swap -- always submit as a temp-saved modify, same as every other
    // modify call in this codebase.
    requested: false,
    items: (live.items || []).map((item) => ({
      sellerProductItemId: item.sellerProductItemId,
      itemName: item.itemName,
      originalPrice: item.originalPrice,
      salePrice: item.salePrice,
      stockQuantity: item.maximumBuyCount,
      maximumBuyCount: item.maximumBuyCount,
      maximumBuyForPerson: item.maximumBuyForPerson,
      maximumBuyForPersonPeriod: item.maximumBuyForPersonPeriod,
      outboundShippingTimeDay: item.outboundShippingTimeDay,
      unitCount: item.unitCount,
      taxType: item.taxType,
      parallelImported: item.parallelImported,
      overseasPurchased: item.overseasPurchased,
      adultOnly: item.adultOnly,
      attributes: (item.attributes || [])
        .filter((attribute) => String(attribute.attributeValueName || '').trim())
        .map(({ attributeTypeName, attributeValueName, exposed }) => ({ attributeTypeName, attributeValueName, exposed })),
      images,
      notices: item.notices,
      contents,
      searchTags: item.searchTags,
    })),
  };
}

function isPubliclyHosted(url) {
  return typeof url === 'string' && /^https?:\/\//.test(url);
}
