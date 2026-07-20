import { createHash } from 'node:crypto';

import { CoupangClient } from './coupang-client.mjs';
import { createCoupangCategoryAdapter } from './coupang-category-adapter.mjs';
import { buildCoupangProductPayload, extractSupplierNoticeFields, formatKstDateTime, mapOptionsToMandatoryAttributes } from './coupang-payload-builder.mjs';
import { uploadApprovedImagesToR2 } from './r2-publisher.mjs';
import { exportProductDraft } from './admin-store.mjs';
import { getAppliedAnalysis } from './product-analysis-orchestrator.mjs';
import { getApprovedManualMainImage } from './manual-ai/workflow-store.mjs';
import { getApprovedManualDetailSet } from './manual-ai/detail-workflow-store.mjs';
import { getCoupangRegistration, recordApprovalRequested, recordDirectRegistration } from './coupang-registration-store.mjs';
import { getSellerShippingSettings } from './coupang-seller-settings-store.mjs';

// draft 64 / sellerProductId 16301574570 is the one already-live, already
// human-verified listing this whole feature branch must never touch --
// enforced here (not just in the target-selector) so a direct call into any
// of this module's write paths is refused even if a caller bypasses the UI.
export const PROTECTED_DRAFT_ID = 64;

// "공통 판매자 설정" -- these are seller-identity/logistics facts that don't
// vary per product and are never something Codex/the analysis pipeline is
// asked to guess (mirrors the SELLER_FIXED_FIELDS concept in
// product-analysis-schema.mjs: brand/manufacturerFallback/outboundShippingPlace/
// returnCenter/deliveryCompany/remoteAreaDeliverable).
export const SELLER_FIXED_CONFIG = {
  brand: '와우픽',
  manufacture: '와우픽',
  manufacturerFallback: '와우픽',
  deliveryCompanyCode: 'CJGLS',
  remoteAreaDeliverable: false,
  warrantyStandard: '관련 법 및 소비자분쟁해결기준에 따름',
  saleEndedAt: '2099-12-31T23:59:59',
};

export function extractList(raw) {
  const payload = raw?.data ?? raw;
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.content)) return payload.content;
  if (Array.isArray(payload?.elements)) return payload.elements;
  return [];
}

// Outbound/return shipping places are never matched by display name --
// Coupang's own naming is ambiguous under this vendor account (two outbound
// places are both literally named "행당" at different addresses, and the
// return center that is actually the 행당 location is named "반품지1").
// The admin confirms the exact code once (coupang_seller_settings), and
// every registration after that just re-validates the stored code is still
// present and usable in a fresh live call -- never re-derives it from a name.
export async function validateSellerShippingSettings(db, { clientImpl, coupangConfig, getSellerShippingSettingsImpl = getSellerShippingSettings } = {}) {
  const settings = await getSellerShippingSettingsImpl(db);
  if (!settings.outboundShippingPlaceCode || !settings.returnCenterCode) {
    return {
      configured: false, blocked: true,
      reasons: ['공통 설정에서 출고지/반품지를 먼저 확인하고 저장하세요 (표시 이름이 아니라 코드로 저장됩니다).'],
      outboundShippingPlace: null, returnShippingCenter: null, settings,
    };
  }

  const client = clientImpl || new CoupangClient(coupangConfig);
  const [outboundRaw, returnRaw] = await Promise.all([
    client.listOutboundShippingPlaces(),
    client.listReturnShippingCenters(),
  ]);
  const outboundCandidates = extractList(outboundRaw);
  const returnCandidates = extractList(returnRaw);

  const outboundShippingPlace = outboundCandidates.find((place) => String(place?.outboundShippingPlaceCode) === settings.outboundShippingPlaceCode) || null;
  const returnShippingCenter = returnCandidates.find((center) => String(center?.returnCenterCode) === settings.returnCenterCode) || null;

  const reasons = [];
  if (!outboundShippingPlace) reasons.push(`설정된 출고지 코드(${settings.outboundShippingPlaceCode})가 더 이상 API 목록에 없습니다 -- 공통 설정을 다시 확인하세요.`);
  else if (outboundShippingPlace.usable === false) reasons.push(`설정된 출고지 코드(${settings.outboundShippingPlaceCode})가 현재 usable=false 상태입니다.`);
  if (!returnShippingCenter) reasons.push(`설정된 반품지 코드(${settings.returnCenterCode})가 더 이상 API 목록에 없습니다 -- 공통 설정을 다시 확인하세요.`);
  else if (returnShippingCenter.usable === false) reasons.push(`설정된 반품지 코드(${settings.returnCenterCode})가 현재 usable=false 상태입니다.`);

  return {
    configured: true,
    blocked: reasons.length > 0,
    reasons,
    outboundShippingPlace,
    returnShippingCenter,
    settings,
    outboundCandidates,
    returnCandidates,
  };
}

// Checks whether one draft is eligible to enter this flow: not the protected
// draft, no existing coupang_product_registrations row of ANY kind (dedup --
// a row from the old paused direct-API pipeline or a 스피드고 link both count,
// since either means a real Coupang listing may already exist for it), and
// has both an approved main image and an approved detail-page image set.
async function evaluateCandidate(db, draftId, { getCoupangRegistrationImpl, getApprovedManualMainImageImpl, getApprovedManualDetailSetImpl }) {
  if (draftId === PROTECTED_DRAFT_ID) {
    return { eligible: false, reason: 'draft 64는 보호 대상이라 이 흐름의 대상이 될 수 없습니다.' };
  }
  const existing = await getCoupangRegistrationImpl(db, draftId);
  if (existing) {
    return {
      eligible: false,
      reason: `이미 쿠팡 등록 이력이 있습니다 (status=${existing.status}${existing.sellerProductId ? `, sellerProductId=${existing.sellerProductId}` : ''}) -- 중복 등록 방지를 위해 제외합니다.`,
    };
  }
  const [mainImage, detailSet] = await Promise.all([
    getApprovedManualMainImageImpl(db, draftId),
    getApprovedManualDetailSetImpl(db, draftId),
  ]);
  if (!mainImage || !detailSet) {
    return { eligible: false, reason: '승인된 대표이미지 또는 승인된 상세이미지 세트가 아직 없습니다.' };
  }
  return { eligible: true, reason: null };
}

// Step "대상 상품" selection: checks the preferred draft (46 by default)
// first and reports exactly why it's disqualified if it is, then scans every
// other non-protected draft in id order for the first eligible one. Never
// silently substitutes a candidate without explaining what happened to the
// preferred one -- the admin screen surfaces both.
export async function selectRegistrationTarget(db, {
  preferredDraftId = 46,
  getCoupangRegistrationImpl = getCoupangRegistration,
  getApprovedManualMainImageImpl = getApprovedManualMainImage,
  getApprovedManualDetailSetImpl = getApprovedManualDetailSet,
} = {}) {
  const deps = { getCoupangRegistrationImpl, getApprovedManualMainImageImpl, getApprovedManualDetailSetImpl };
  const rows = (await db.query(
    `select id from product_drafts where id <> $1 order by id`,
    [PROTECTED_DRAFT_ID],
  )).rows.map((row) => Number(row.id));

  let preferredDisqualifiedReason = null;
  if (!rows.includes(preferredDraftId) && preferredDraftId !== PROTECTED_DRAFT_ID) {
    preferredDisqualifiedReason = `draft ${preferredDraftId}를 찾을 수 없습니다.`;
  } else {
    const result = await evaluateCandidate(db, preferredDraftId, deps);
    if (!result.eligible) preferredDisqualifiedReason = result.reason;
  }

  let selectedDraftId = null;
  if (!preferredDisqualifiedReason) {
    selectedDraftId = preferredDraftId;
  } else {
    for (const draftId of rows) {
      if (draftId === preferredDraftId) continue;
      const result = await evaluateCandidate(db, draftId, deps);
      if (result.eligible) { selectedDraftId = draftId; break; }
    }
  }

  return {
    preferredDraftId,
    preferredDisqualifiedReason,
    selectedDraftId,
    noEligibleCandidate: selectedDraftId === null,
    evaluatedCount: rows.length,
  };
}

// Step 3: live Coupang category prediction + metadata + shipping-place
// lookup for one draft. Read-only against Coupang (same calls
// scripts/coupang-preflight.mjs already makes), nothing persisted.
export async function previewCategoryAndShipping(db, draftId, { coupangConfig, clientImpl, categoryAdapterImpl, exportProductDraftImpl = exportProductDraft, getSellerShippingSettingsImpl = getSellerShippingSettings } = {}) {
  const draft = await exportProductDraftImpl(db, draftId, 'coupang');
  if (!draft) throw Object.assign(new Error('Product draft not found'), { code: 'DRAFT_NOT_FOUND' });

  const client = clientImpl || new CoupangClient(coupangConfig);
  const categoryAdapter = categoryAdapterImpl || createCoupangCategoryAdapter(client);

  const productName = draft.optimizedTitle || draft.sellerProductName;
  const prediction = await categoryAdapter.predictCategory(productName);
  const categoryMeta = prediction.displayCategoryCode ? await categoryAdapter.getCategoryMeta(prediction.displayCategoryCode) : null;

  const shipping = await validateSellerShippingSettings(db, { clientImpl: client, getSellerShippingSettingsImpl });

  return {
    draft,
    prediction,
    categoryMeta,
    outboundShippingPlace: shipping.outboundShippingPlace,
    returnShippingCenter: shipping.returnShippingCenter,
    shippingSettings: shipping,
  };
}

// WING-검수 style ready/missing report, adapted from the read-only
// scripts/coupang-preflight.mjs logic so both surfaces agree on what
// "ready to register" means.
function buildReadinessReport({ draft, prediction, categoryMeta, optionMapping, outboundShippingPlace, returnShippingCenter, shippingSettings, material, verifiedSize, manufacturer, countryOfOrigin, mainImageUrl, detailImageUrls, noticeCategoryTemplateName, resolvedNotices = [] }) {
  const ready = [];
  const missing = [];

  if (draft.optimizedTitle) ready.push(`상품명: ${draft.optimizedTitle}`); else missing.push('최적화 상품명');
  if (draft.salePrice) ready.push(`판매가: ${draft.salePrice}`); else missing.push('판매가');
  if (mainImageUrl) ready.push('대표이미지 R2 공개 URL 확보'); else missing.push('대표이미지 R2 업로드');
  if (detailImageUrls.length === 10) ready.push(`상세이미지 R2 공개 URL ${detailImageUrls.length}장 확보`);
  else missing.push(`상세이미지 10장 필요 (현재 ${detailImageUrls.length}장)`);

  if (prediction?.displayCategoryCode) ready.push(`추천 카테고리: ${prediction.displayCategoryCode} (${prediction.categoryName})`);
  else missing.push('쿠팡 카테고리 예측 실패 -- 수동 지정 필요');

  if (categoryMeta) {
    if (optionMapping.unresolvedMandatoryAttributes.length === 0) ready.push('필수 구매옵션 전부 매핑됨');
    else missing.push(`필수 구매옵션 미해결: ${JSON.stringify(optionMapping.unresolvedMandatoryAttributes)}`);
    if (optionMapping.missingStock.length === 0) ready.push('전체 옵션 재고수량 입력됨');
    else missing.push(`재고수량 미입력 옵션: ${JSON.stringify(optionMapping.missingStock)}`);
    if (noticeCategoryTemplateName) {
      ready.push(`고시정보 템플릿 선택: ${noticeCategoryTemplateName}`);
      const template = (categoryMeta.noticeCategoryTemplates || []).find((t) => t.noticeCategoryName === noticeCategoryTemplateName);
      const unresolvedNoticeFields = (template?.noticeCategoryDetailNames || [])
        .filter((detail) => detail.required === 'MANDATORY')
        .filter((detail) => !resolvedNotices.find((n) => n.noticeCategoryDetailName === detail.noticeCategoryDetailName)?.content)
        .map((detail) => detail.noticeCategoryDetailName);
      if (unresolvedNoticeFields.length === 0) ready.push('고시정보 필수 항목 전부 입력됨');
      else missing.push(`고시정보 미입력: ${JSON.stringify(unresolvedNoticeFields)}`);
    } else {
      missing.push('고시정보 템플릿 미선택');
    }
    if (categoryMeta.mandatoryCertificationNames.length > 0) missing.push(`필수 인증정보: ${JSON.stringify(categoryMeta.mandatoryCertificationNames)}`);
    else ready.push('필수 인증정보 없음');
  } else {
    missing.push('카테고리 메타정보 없음 -- 필수옵션/고시정보/인증 확인 불가');
  }

  if (material) ready.push(`소재: ${material}`); else missing.push('소재 (고시정보 필수)');
  if (verifiedSize) ready.push(`치수: ${verifiedSize}`); else missing.push('치수 (고시정보 필수)');
  if (manufacturer) ready.push(`제조자: ${manufacturer}`); else missing.push('제조자 (고시정보 필수)');
  if (countryOfOrigin) ready.push(`제조국: ${countryOfOrigin}`); else missing.push('제조국 (고시정보 필수)');

  if (outboundShippingPlace) ready.push(`출고지: ${outboundShippingPlace.shippingPlaceName} (code=${outboundShippingPlace.outboundShippingPlaceCode})`);
  if (returnShippingCenter) ready.push(`반품지: ${returnShippingCenter.shippingPlaceName} (code=${returnShippingCenter.returnCenterCode})`);
  for (const reason of shippingSettings?.reasons || []) missing.push(reason);

  return { ready, missing, blocked: missing.length > 0 };
}

// Steps 4-7: autofill from product_analysis_applied + supplier raw data +
// seller-fixed config, R2-publish the approved images, and assemble the
// final requested=false payload via the existing payload builder. `overrides`
// carries whatever the admin typed in for fields the autofill left
// unresolved (step 5) -- every override wins over the autofilled value, and
// nothing here writes to the DB except the (idempotent, content-hash-deduped)
// R2 upload.
export async function buildRegistrationPreview(db, rootDir, draftId, {
  overrides = {},
  coupangConfig,
  clientImpl,
  categoryAdapterImpl,
  uploadImpl = uploadApprovedImagesToR2,
  exportProductDraftImpl = exportProductDraft,
  getAppliedAnalysisImpl = getAppliedAnalysis,
  getApprovedManualMainImageImpl = getApprovedManualMainImage,
  getApprovedManualDetailSetImpl = getApprovedManualDetailSet,
  getSellerShippingSettingsImpl = getSellerShippingSettings,
} = {}) {
  if (draftId === PROTECTED_DRAFT_ID) throw Object.assign(new Error('draft 64는 보호 대상입니다'), { code: 'DRAFT_PROTECTED' });

  const { draft, prediction, categoryMeta, outboundShippingPlace, returnShippingCenter, shippingSettings } =
    await previewCategoryAndShipping(db, draftId, { coupangConfig, clientImpl, categoryAdapterImpl, exportProductDraftImpl, getSellerShippingSettingsImpl });

  const appliedAnalysis = await getAppliedAnalysisImpl(db, draftId);
  const mainImage = await getApprovedManualMainImageImpl(db, draftId);
  const detailSet = await getApprovedManualDetailSetImpl(db, draftId);
  if (!mainImage || !detailSet) {
    throw Object.assign(new Error('승인된 대표이미지 또는 상세이미지 세트가 없습니다'), { code: 'IMAGES_NOT_APPROVED' });
  }

  const draftRow = (await db.query('select supplier_product_id from product_drafts where id = $1', [draftId])).rows[0];
  const supplierProduct = (await db.query('select raw_json from supplier_products where id = $1', [draftRow.supplier_product_id])).rows[0];
  const supplierNoticeFields = extractSupplierNoticeFields(supplierProduct.raw_json);

  const { mainImageUrl, detailImageUrls } = await uploadImpl({
    rootDir,
    draftId,
    mainImageLocalUrl: mainImage.coupangStoredUrl,
    detailImageLocalUrls: detailSet.images.map((image) => image.normalizedStoredUrl),
  });

  const stockByOptionValue = Object.fromEntries(
    (draft.options || []).filter((option) => option.stockQuantity != null).map((option) => [option.optionValue, option.stockQuantity]),
  );
  const noticeCategoryTemplateName = overrides.noticeCategoryTemplateName
    ?? categoryMeta?.noticeCategoryTemplates?.[0]?.noticeCategoryName ?? null;

  const optionMapping = categoryMeta
    ? mapOptionsToMandatoryAttributes({
      draftOptions: draft.options,
      mandatoryOptionNames: categoryMeta.mandatoryOptionNames,
      stockByOptionValue: { ...stockByOptionValue, ...(overrides.stockByOptionValue || {}) },
      sizeAttributeValue: overrides.sizeAttributeValue ?? overrides.dimensions ?? appliedAnalysis?.dimensions ?? null,
      additionalAttributeValues: overrides.additionalAttributeValues || {},
      singleItemStockQuantity: overrides.singleItemStockQuantity ?? null,
      attributeMeta: categoryMeta.attributes || [],
    })
    : { items: [], unresolvedMandatoryAttributes: [], missingStock: [] };

  const asPhoneNumber = overrides.asPhoneNumber
    ?? outboundShippingPlace?.placeAddresses?.[0]?.companyContactNumber
    ?? returnShippingCenter?.placeAddresses?.[0]?.companyContactNumber
    ?? null;

  const material = overrides.material ?? appliedAnalysis?.material ?? null;
  const verifiedSize = overrides.dimensions ?? appliedAnalysis?.dimensions ?? null;
  const manufacturer = overrides.manufacturer ?? appliedAnalysis?.manufacturer ?? supplierNoticeFields.manufacturer ?? SELLER_FIXED_CONFIG.manufacturerFallback;
  const countryOfOrigin = overrides.countryOfOrigin ?? appliedAnalysis?.countryOfOrigin ?? supplierNoticeFields.countryOfOrigin ?? null;
  const handlingCaution = overrides.handlingCaution ?? appliedAnalysis?.handlingPrecautions ?? null;
  const warrantyStandard = overrides.warrantyStandard ?? SELLER_FIXED_CONFIG.warrantyStandard;
  const searchTags = appliedAnalysis?.searchTags || [];

  const saleStartedAt = formatKstDateTime(new Date());
  const payload = buildCoupangProductPayload({
    draft,
    vendorId: coupangConfig.vendorId,
    vendorUserId: coupangConfig.vendorUserId,
    displayCategoryCode: overrides.displayCategoryCode ?? prediction.displayCategoryCode,
    categoryMeta: categoryMeta || {},
    noticeCategoryTemplateName,
    supplierNoticeFields: { ...supplierNoticeFields, manufacturer, countryOfOrigin },
    optionMapping,
    outboundShippingPlace,
    returnShippingCenter,
    mainImageUrl,
    approvedDetailImageUrls: detailImageUrls,
    detailImageUrlsForImages: detailImageUrls.slice(0, 9),
    material,
    verifiedSize,
    handlingCaution,
    warrantyStandard,
    asPhoneNumber,
    noticeContentOverrides: overrides.noticeContentOverrides || {},
    saleStartedAt,
    saleEndedAt: SELLER_FIXED_CONFIG.saleEndedAt,
    deliveryCompanyCode: SELLER_FIXED_CONFIG.deliveryCompanyCode,
    deliveryCharge: draft.shippingFee || 0,
    returnCharge: draft.registrationOptimization?.shippingPolicies?.[0]?.returnShippingFee || 0,
    remoteAreaDeliverable: SELLER_FIXED_CONFIG.remoteAreaDeliverable,
    unionDeliverable: true,
    brand: SELLER_FIXED_CONFIG.brand,
    manufacture: SELLER_FIXED_CONFIG.manufacture,
    searchTags,
    requested: false,
  });

  const readiness = buildReadinessReport({
    draft, prediction, categoryMeta, optionMapping, outboundShippingPlace, returnShippingCenter, shippingSettings,
    material, verifiedSize, manufacturer, countryOfOrigin, mainImageUrl, detailImageUrls, noticeCategoryTemplateName,
    resolvedNotices: payload.items?.[0]?.notices || [],
  });

  const requestHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');

  return { draft, prediction, categoryMeta, payload, readiness, requestHash, mainImageUrl, detailImageUrls, appliedAnalysis };
}

// Steps 8-9: dedup-checked, gated, requested=false createProduct() call and
// sellerProductId persistence. `confirm` defaults to false so this is safe
// to call from a "미리보기" click -- the real API call only happens when the
// caller explicitly passes confirm:true (the admin UI does this only after
// its own browser confirm() dialog, per spec section "실제 쿠팡 호출 전 최종
// 확인창 표시"). Never calls requestApproval -- that stays a manual,
// separate step the user does in WING themselves.
export async function createDirectRegistration(db, rootDir, draftId, {
  overrides = {},
  confirm = false,
  coupangConfig,
  clientImpl,
  getCoupangRegistrationImpl = getCoupangRegistration,
  recordDirectRegistrationImpl = recordDirectRegistration,
  buildRegistrationPreviewImpl = buildRegistrationPreview,
} = {}) {
  if (draftId === PROTECTED_DRAFT_ID) throw Object.assign(new Error('draft 64는 보호 대상입니다'), { code: 'DRAFT_PROTECTED' });

  const existing = await getCoupangRegistrationImpl(db, draftId);
  if (existing) {
    throw Object.assign(new Error(`이미 등록된 draft입니다 (status=${existing.status}${existing.sellerProductId ? `, sellerProductId=${existing.sellerProductId}` : ''})`), { code: 'ALREADY_REGISTERED', existing });
  }

  const preview = await buildRegistrationPreviewImpl(db, rootDir, draftId, { overrides, coupangConfig, clientImpl });
  if (preview.readiness.blocked) {
    throw Object.assign(new Error('미확정 항목이 남아있어 등록할 수 없습니다'), { code: 'REGISTRATION_NOT_READY', readiness: preview.readiness });
  }

  if (!confirm) {
    return { dryRun: true, payload: preview.payload, readiness: preview.readiness, requestHash: preview.requestHash };
  }

  // Re-check immediately before the real API call -- defends against a race
  // between the dry-run preview above and the admin clicking confirm.
  const raceCheck = await getCoupangRegistrationImpl(db, draftId);
  if (raceCheck) {
    throw Object.assign(new Error('이미 등록된 draft입니다 (동시 실행 감지)'), { code: 'ALREADY_REGISTERED', existing: raceCheck });
  }

  const client = clientImpl || new CoupangClient(coupangConfig);
  const result = await client.createProduct(preview.payload);
  const sellerProductId = result?.data;
  if (!sellerProductId || result?.code !== 'SUCCESS') {
    throw Object.assign(new Error(`createProduct did not return a sellerProductId: ${JSON.stringify(result)}`), { code: 'CREATE_PRODUCT_NO_ID', raw: result });
  }

  const registration = await recordDirectRegistrationImpl(db, draftId, {
    sellerProductId,
    sellerProductName: preview.payload.sellerProductName,
    requestHash: preview.requestHash,
  });
  if (!registration) {
    // The unique constraint caught a race we didn't -- a real listing now
    // exists on Coupang but we couldn't record it locally. Surface loudly
    // instead of silently losing track of a live product.
    throw Object.assign(new Error(`createProduct succeeded (sellerProductId=${sellerProductId}) but a registration row already existed for this draft -- check coupang_product_registrations manually`), { code: 'RECORD_CONFLICT_AFTER_CREATE', sellerProductId });
  }

  return { dryRun: false, sellerProductId, registration, payload: preview.payload };
}

// Sale-approval request (WING's requestApproval, PUT .../approvals). This is
// the one API call every other function in this module was deliberately
// built to never make on its own -- everything else here stops at
// requested=false. It exists only for a human who has independently
// reviewed the live listing in WING to explicitly trigger, here, once.
// Guarded so it can only ever fire once per draft: refuses the protected
// draft (this module's standing guard), refuses without a linked
// sellerProductId, re-queries the LIVE status right before calling (never
// trusts the locally cached status -- Coupang's real state is the only
// source of truth for whether it's still safe to request), and refuses
// outright unless that live status is genuinely "임시저장" (never yet
// requested) -- if Coupang already shows anything else (승인요청중, 승인완료,
// 승인반려, ...), or this app's own record already shows requested=true,
// this returns the current state without ever touching the approval
// endpoint.
export async function requestCoupangSaleApproval(db, draftId, {
  clientImpl,
  coupangConfig,
  getCoupangRegistrationImpl = getCoupangRegistration,
  recordApprovalRequestedImpl = recordApprovalRequested,
} = {}) {
  if (draftId === PROTECTED_DRAFT_ID) throw Object.assign(new Error('draft 64는 보호 대상입니다'), { code: 'DRAFT_PROTECTED' });

  const registration = await getCoupangRegistrationImpl(db, draftId);
  if (!registration?.sellerProductId) {
    throw Object.assign(new Error('이 draft는 아직 쿠팡 sellerProductId와 연결되어 있지 않습니다'), { code: 'NOT_LINKED' });
  }
  if (registration.requested || registration.status === 'approval_requested') {
    throw Object.assign(new Error(`이미 판매 승인을 요청한 draft입니다 (status=${registration.status})`), { code: 'ALREADY_REQUESTED', existing: registration });
  }

  const client = clientImpl || new CoupangClient(coupangConfig);
  const live = await client.getProduct(registration.sellerProductId);
  const liveStatusName = live?.data?.statusName ?? null;
  if (liveStatusName !== '임시저장') {
    throw Object.assign(new Error(`현재 쿠팡 상태(${liveStatusName ?? '알 수 없음'})가 임시저장이 아니어서 승인 요청을 보내지 않았습니다`), { code: 'NOT_TEMPORARY_SAVED', liveStatusName, existing: registration });
  }

  const result = await client.requestApproval(registration.sellerProductId);

  const after = await client.getProduct(registration.sellerProductId);
  const updated = await recordApprovalRequestedImpl(db, draftId, {
    statusName: after?.data?.statusName ?? null,
    responseMessage: JSON.stringify(result),
  });

  return {
    registration: updated,
    requestApprovalResult: result,
    liveStatusNameBefore: liveStatusName,
    liveStatusNameAfter: after?.data?.statusName ?? null,
  };
}
