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
  originAreaCode = null,
  // afterServiceTelephoneNumber/importer are NotEmpty on the real API
  // (confirmed live 2026-07-24) but this app has no real AS phone number or
  // importer business name on file anywhere (see extractSupplierOwnContact's
  // own note that the supplier's contact must never be reused as ours). Per
  // user instruction (2026-07-24), importer defaults to pointing buyers at
  // the detail page instead of blocking on business info Claude can't
  // supply -- but afterServiceTelephoneNumber has its own regex validator
  // ("AfterServicePhoneNumber: 숫자, -, +만 입력 가능합니다", confirmed live) that
  // rejects free text outright, so it needs an actual phone number; the user
  // supplied their real AS number (2026-07-24) as this default.
  asPhoneNumber = '010-8795-2571',
  importer = '상세 페이지 참조',
  deliveryCharge = 0,
  // 선불(PREPAID, 배송비를 상품 결제와 함께 선불로 받는 방식) -- deliveryFeePayType is
  // NotEmpty on the real API (confirmed live 2026-07-24), and an unrecognized
  // enum string here silently deserializes to null (hence "NotEmpty" rather
  // than a "not a valid enum" error, the first thing that made this hard to
  // spot). This app's whole delivery-fee model is a single flat baseFee
  // charged at checkout, so PREPAID is the only value that matches how
  // deliveryCharge is actually used here, not a business decision left open
  // per draft.
  deliveryFeePayType = 'PREPAID',
  returnCharge = 0,
  stockQuantity = 999,
  channelId = null,
  searchTags = [],
  minorPurchasable = true,
  // Naver's own 자동 판매 승인 금지 gate (mirrors Coupang's requestApproval
  // step) -- register in SUSPENSION (전시중지) by default so the listing
  // exists but isn't actually purchasable until a human flips it to ON via
  // the admin UI. See automoney_future_update_roadmap.md section 3.4.
  channelProductDisplayStatusType = 'SUSPENSION',
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
        deliveryFeePayType,
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
      // originAreaCode must be one of Naver's own ~535 origin-area codes
      // (GET /v1/product-origin-areas) -- a free-text country string is
      // rejected outright ("원산지 상세코드 항목이 유효하지 않습니다", confirmed
      // live 2026-07-24). content stays the human-readable string for
      // display; it's the code that's actually validated.
      originAreaInfo: {
        originAreaCode,
        content: countryOfOrigin || supplierNoticeFields.countryOfOrigin || null,
        importer,
      },
      manufacturerName: manufacturer || supplierNoticeFields.manufacturer || null,
      taxType: 'TAX',
      minorPurchasable,
      // 'ETC' (기타 재화) is the FTC-guideline catch-all notice type -- its
      // field schema (confirmed live via GET /v1/products-for-provided-notice
      // on 2026-07-24) is just { itemName, modelName, certificateDetails,
      // manufacturer, afterServiceDirector, customerServicePhoneNumber }, NOT
      // the material/size/warranty fields the Coupang notice template uses.
      // A category-specific type (e.g. FURNITURE for storage/shelving) would
      // be the more correct choice per FTC guidance ("use the closest
      // matching category; ETC only if none fits") but needs its own
      // per-category field mapping -- left as a future improvement, same as
      // Coupang's noticeCategoryTemplate matching.
      productInfoProvidedNotice: {
        productInfoProvidedNoticeType: 'ETC',
        etc: {
          itemName: name,
          modelName: supplierNoticeFields.modelName || '해당없음',
          certificateDetails: '해당없음',
          manufacturer: manufacturer || supplierNoticeFields.manufacturer || '해당없음',
          // ExclusiveNotNull on the real API (confirmed live 2026-07-24):
          // afterServiceDirector and customerServicePhoneNumber may not both
          // be set. afterServiceDirector is a free-text name field (no
          // format validator observed, unlike the top-level AS phone
          // number), so it carries the real AS phone number here instead;
          // customerServicePhoneNumber stays null to satisfy the exclusivity.
          afterServiceDirector: asPhoneNumber,
          customerServicePhoneNumber: null,
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
      channelProductDisplayStatusType,
      channelId: channelId || undefined,
    },
  };
}
