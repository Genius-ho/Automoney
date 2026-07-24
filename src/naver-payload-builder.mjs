// Naver Commerce API (커머스API) product-creation payload for a fresh
// "raw" registration -- the draft's own original supplier data + images,
// registered before any Codex-driven improvement pass. Field names/shape
// follow the publicly documented POST /external/v2/products schema
// (originProduct + smartstoreChannelProduct); UNLIKE coupang-payload-builder.mjs
// this has never been checked against a real live call, so treat every
// field name here as a best-effort guess until the first real
// createOriginProduct() round-trip confirms or corrects it (see
// naver-registration-flow.mjs's module comment).
//
// Scope is deliberately narrower than the Coupang builder: no multi-option
// attribute mapping (Naver's optionCombinations schema is its own thing),
// just the single-item / no-variant case the roadmap's raw-registration step
// actually needs first. A draft with real Domeggook options still registers
// (as a single listing at its base price), it just doesn't carry per-option
// stock/price yet.
export function buildNaverOriginProductPayload({
  draft,
  categoryId,
  mainImageUrl,
  detailImageUrls = [],
  supplierNoticeFields = {},
  material = null,
  verifiedSize = null,
  manufacturer = null,
  countryOfOrigin = null,
  asPhoneNumber = null,
  deliveryCharge = 0,
  returnCharge = 0,
  stockQuantity = 999,
  channelId = null,
  searchTags = [],
}) {
  const name = draft.optimizedTitle || draft.sellerProductName;
  const detailContent = detailImageUrls.map((url) => `<img src="${url}" />`).join('');

  const originProduct = {
    statusType: 'SALE',
    saleType: 'NEW',
    leafCategoryId: categoryId != null ? String(categoryId) : null,
    name,
    detailContent,
    images: {
      representativeImage: mainImageUrl ? { url: mainImageUrl } : null,
      optionalImages: detailImageUrls.slice(0, 9).map((url) => ({ url })),
    },
    salePrice: draft.salePrice,
    stockQuantity,
    deliveryInfo: {
      deliveryType: 'DELIVERY',
      deliveryAttributeType: 'NORMAL',
      deliveryCompany: 'CJGLS',
      deliveryBundleGroupUsable: false,
      deliveryFee: {
        deliveryFeeType: deliveryCharge > 0 ? 'PAID' : 'FREE',
        baseFee: deliveryCharge,
      },
      claimDeliveryInfo: {
        returnDeliveryFee: returnCharge,
        exchangeDeliveryFee: returnCharge * 2,
      },
    },
    detailAttribute: {
      afterServiceInfo: {
        afterServiceTelephoneNumber: asPhoneNumber,
        afterServiceGuideContent: '관련 법 및 소비자분쟁해결기준에 따름',
      },
      originAreaInfo: {
        originAreaCode: countryOfOrigin || supplierNoticeFields.countryOfOrigin || null,
        content: countryOfOrigin || supplierNoticeFields.countryOfOrigin || null,
      },
      manufacturerName: manufacturer || supplierNoticeFields.manufacturer || null,
      taxType: 'TAX',
      productInfoProvidedNotice: {
        productInfoProvidedNoticeType: '기타 재화',
        etc: {
          returnCostReason: '',
          noRefundReason: '',
          qualityAssuranceStandard: '관련 법 및 소비자분쟁해결기준에 따름',
          compensationProcedure: '관련 법 및 소비자분쟁해결기준에 따름',
          troubleShootingContents: '관련 법 및 소비자분쟁해결기준에 따름',
          itemName: name,
          model: supplierNoticeFields.modelName || null,
          manufacturer: manufacturer || supplierNoticeFields.manufacturer || null,
          asPhoneNumber,
          material,
          size: verifiedSize || supplierNoticeFields.size || null,
        },
      },
      searchTags,
    },
  };

  return {
    originProduct,
    smartstoreChannelProduct: {
      channelProductName: name,
      naverShoppingRegistration: true,
      channelId: channelId || undefined,
    },
  };
}
