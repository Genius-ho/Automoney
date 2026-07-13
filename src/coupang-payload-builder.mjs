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
// other mandatory attribute for every item, since the physical box size does
// not vary by color; when omitted it is reported unresolved instead of
// guessed.
export function mapOptionsToMandatoryAttributes({ draftOptions, mandatoryOptionNames, stockByOptionValue = {}, sizeAttributeValue = null, exposed = null }) {
  const colorAttributeName = mandatoryOptionNames.find((name) => name === '색상') || null;
  const sizeAttributeName = mandatoryOptionNames.find((name) => name !== '색상') || null;
  const exposedField = exposed ? { exposed } : {};

  const items = (draftOptions || []).map((option) => ({
    optionValue: option.optionValue,
    additionalPrice: option.additionalPrice || 0,
    stockQuantity: Object.hasOwn(stockByOptionValue, option.optionValue) ? stockByOptionValue[option.optionValue] : null,
    attributes: [
      colorAttributeName ? { attributeTypeName: colorAttributeName, attributeValueName: option.optionValue, ...exposedField } : null,
      sizeAttributeName ? { attributeTypeName: sizeAttributeName, attributeValueName: sizeAttributeValue, ...exposedField } : null,
    ].filter(Boolean),
  }));

  const unresolvedMandatoryAttributes = [];
  if (sizeAttributeName && !sizeAttributeValue) unresolvedMandatoryAttributes.push(sizeAttributeName);
  const missingStock = items.filter((item) => item.stockQuantity === null).map((item) => item.optionValue);

  return { items, unresolvedMandatoryAttributes, missingStock };
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
  manufacture = null,
  displayProductNameOverride = null,
  searchTags = [],
  requested = false,
}) {
  const noticeTemplate = (categoryMeta?.noticeCategoryTemplates || [])
    .find((template) => template.noticeCategoryName === noticeCategoryTemplateName) || null;

  const noticeValues = {
    종류: draft.optimizedTitle || null,
    소재: material,
    치수: verifiedSize ?? supplierNoticeFields.size,
    '제조자(수입자)': supplierNoticeFields.manufacturer,
    제조국: supplierNoticeFields.countryOfOrigin,
    취급시_주의사항: handlingCaution,
    품질보증기준: warrantyStandard,
    'A/S 책임자와 전화번호': asPhoneNumber,
  };

  const notices = (noticeTemplate?.noticeCategoryDetailNames || []).map((detail) => ({
    noticeCategoryName: noticeCategoryTemplateName,
    noticeCategoryDetailName: detail.noticeCategoryDetailName,
    content: noticeValues[detail.noticeCategoryDetailName] ?? noticeValues[detail.noticeCategoryDetailName.replace(/\s/g, '_')] ?? null,
  }));

  const mainImagePath = mainImageUrl ?? draft.mainImages?.[0] ?? null;
  const imagesPubliclyHosted = isPubliclyHosted(mainImagePath) && approvedDetailImageUrls.length > 0
    && approvedDetailImageUrls.every(isPubliclyHosted);

  // Coupang deserializes items[].contents as a *list* of content blocks
  // (java type ArrayList<OSellerProductItemContent>), confirmed by the exact
  // "Cannot deserialize ... ArrayList<...OSellerProductItemContent>" error
  // Coupang returned when this was submitted as a single object instead.
  const contents = [
    {
      contentsType: 'IMAGE',
      contentDetails: approvedDetailImageUrls.map((url, index) => ({
        content: url,
        detailType: 'IMAGE',
        order: index + 1,
      })),
    },
  ];

  const returnAddress = returnShippingCenter?.placeAddresses?.[0] || {};

  const payload = {
    ...(sellerProductId ? { sellerProductId } : {}),
    displayCategoryCode: displayCategoryCode ?? categoryMeta?.displayCategoryCode ?? null,
    sellerProductName: draft.optimizedTitle,
    vendorId,
    vendorUserId,
    saleStartedAt,
    saleEndedAt,
    displayProductName: displayProductNameOverride ?? draft.displayProductName,
    brand,
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
      itemName: item.optionValue,
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
      attributes: item.attributes,
      images: [
        { imageOrder: 1, imageType: 'REPRESENTATION', vendorPath: mainImagePath },
        ...detailImageUrlsForImages.map((url, detailIndex) => ({
          imageOrder: detailIndex + 1,
          imageType: 'DETAIL',
          vendorPath: url,
        })),
      ],
      notices,
      contents,
      searchTags,
    })),
    imagesPubliclyHosted,
    requested,
  };

  return payload;
}

function isPubliclyHosted(url) {
  return typeof url === 'string' && /^https?:\/\//.test(url);
}
