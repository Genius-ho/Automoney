import { createHash } from 'node:crypto';

import { NaverCommerceClient } from './naver-commerce-client.mjs';
import { buildNaverOriginProductPayload } from './naver-payload-builder.mjs';
import { uploadApprovedImagesToR2 } from './r2-publisher.mjs';
import { exportProductDraft } from './admin-store.mjs';
import { extractSupplierNoticeFields } from './coupang-payload-builder.mjs';
import { PROTECTED_DRAFT_ID, getDraftRawImages } from './coupang-registration-flow.mjs';
import { getNaverRegistration, recordNaverDirectRegistration } from './naver-registration-store.mjs';

// NaverCommerceClient.searchCategories() hits GET /v1/categories, which --
// confirmed against the real API on 2026-07-24 -- ignores its searchKeyword
// query param entirely and always returns the full ~5800-row category tree
// as a flat array (not the `{ data: [...] }` / `categoryId` shape this file
// originally assumed). There is no server-side keyword filter, so matching
// has to happen client-side: pick the leaf (`last: true`) category whose
// own name appears verbatim in the product title, preferring the longest
// (most specific) name match to avoid single-character false positives.
export function pickBestNaverCategory(categories, productName) {
  if (!Array.isArray(categories) || !productName) return null;
  const leaves = categories.filter((category) => category.last && category.name && category.name.length >= 2 && productName.includes(category.name));
  if (leaves.length === 0) return null;
  leaves.sort((a, b) => b.name.length - a.name.length);
  return leaves[0].id;
}

// Naver Commerce API registration -- built entirely from public API docs,
// never yet exercised against a real credential (see
// automoney_future_update_roadmap.md's Milestone 2 note). Every payload
// field name here is a best-effort guess; expect a real fix commit the first
// time createOriginProduct() actually runs live, the same way
// coupang-registration-flow.mjs's own history has one (e7153b2).
//
// Scope is intentionally narrower than the Coupang flow: only the raw-mode
// registration the auto-discovery queue needs (register the draft's own
// original images/data immediately after prepareCandidateDraft, before any
// improvement pass) -- no image-swap-on-an-already-registered-listing
// equivalent yet. `confirm` mirrors createDirectRegistration's dry-run/real
// split exactly: defaults to false so a preview never touches the live API.

async function buildNaverRegistrationPreview(db, rootDir, draftId, {
  coupangConfig, // unused here, kept only so admin-server.mjs can pass one options object to both flows if it ever wants to
  naverConfig,
  clientImpl,
  exportProductDraftImpl = exportProductDraft,
  getDraftRawImagesImpl = getDraftRawImages,
  uploadImpl = uploadApprovedImagesToR2,
} = {}) {
  if (draftId === PROTECTED_DRAFT_ID) throw Object.assign(new Error('draft 64는 보호 대상입니다'), { code: 'DRAFT_PROTECTED' });

  const draft = await exportProductDraftImpl(db, draftId, 'naver');
  if (!draft) throw Object.assign(new Error('Product draft not found'), { code: 'DRAFT_NOT_FOUND' });

  const rawImages = await getDraftRawImagesImpl(db, draftId);
  if (!rawImages.mainImageLocalUrl || rawImages.detailImageLocalUrls.length === 0) {
    throw Object.assign(new Error('원본 대표이미지 또는 상세이미지가 없습니다'), { code: 'IMAGES_NOT_APPROVED' });
  }

  const draftRow = (await db.query('select supplier_product_id from product_drafts where id = $1', [draftId])).rows[0];
  const supplierProduct = (await db.query('select raw_json from supplier_products where id = $1', [draftRow.supplier_product_id])).rows[0];
  const supplierNoticeFields = extractSupplierNoticeFields(supplierProduct.raw_json);

  const { mainImageUrl, detailImageUrls } = await uploadImpl({
    rootDir,
    draftId,
    mainImageLocalUrl: rawImages.mainImageLocalUrl,
    detailImageLocalUrls: rawImages.detailImageLocalUrls,
  });

  const client = clientImpl || new NaverCommerceClient(naverConfig);
  const productName = draft.optimizedTitle || draft.name;
  const categorySearch = await client.searchCategories(productName);
  const categoryId = pickBestNaverCategory(categorySearch, productName);

  const payload = buildNaverOriginProductPayload({
    draft,
    categoryId,
    mainImageUrl,
    detailImageUrls,
    supplierNoticeFields,
    countryOfOrigin: supplierNoticeFields.countryOfOrigin,
    manufacturer: supplierNoticeFields.manufacturer,
    deliveryCharge: draft.deliveryFee || 0,
    channelId: naverConfig?.channelId,
  });

  const ready = [];
  const missing = [];
  if (draft.optimizedTitle) ready.push(`상품명: ${draft.optimizedTitle}`); else missing.push('최적화 상품명');
  if (draft.salePrice) ready.push(`판매가: ${draft.salePrice}`); else missing.push('판매가');
  if (mainImageUrl) ready.push('대표이미지 R2 공개 URL 확보'); else missing.push('대표이미지 R2 업로드');
  if (detailImageUrls.length > 0) ready.push(`원본 상세이미지 ${detailImageUrls.length}장 확보`); else missing.push('원본 상세이미지가 없습니다');
  if (categoryId) ready.push(`추천 카테고리: ${categoryId}`); else missing.push('네이버 카테고리 검색 실패 -- 수동 지정 필요');

  const requestHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return { draft, payload, readiness: { ready, missing, blocked: missing.length > 0 }, requestHash, mainImageUrl, detailImageUrls };
}

// Dedup-checked, gated, raw-mode createOriginProduct() call + persistence --
// mirrors coupang-registration-flow.mjs's createDirectRegistration exactly
// (same confirm-flag dry-run split, same protected-draft guard, same
// race-check right before the real call).
export async function createNaverDirectRegistration(db, rootDir, draftId, {
  confirm = false,
  naverConfig,
  clientImpl,
  getNaverRegistrationImpl = getNaverRegistration,
  recordNaverDirectRegistrationImpl = recordNaverDirectRegistration,
  buildNaverRegistrationPreviewImpl = buildNaverRegistrationPreview,
} = {}) {
  if (draftId === PROTECTED_DRAFT_ID) throw Object.assign(new Error('draft 64는 보호 대상입니다'), { code: 'DRAFT_PROTECTED' });

  const existing = await getNaverRegistrationImpl(db, draftId);
  if (existing) {
    throw Object.assign(new Error(`이미 등록된 draft입니다 (status=${existing.status}${existing.originProductNo ? `, originProductNo=${existing.originProductNo}` : ''})`), { code: 'ALREADY_REGISTERED', existing });
  }

  const preview = await buildNaverRegistrationPreviewImpl(db, rootDir, draftId, { naverConfig, clientImpl });
  if (preview.readiness.blocked) {
    throw Object.assign(new Error('미확정 항목이 남아있어 등록할 수 없습니다'), { code: 'REGISTRATION_NOT_READY', readiness: preview.readiness });
  }

  if (!confirm) {
    return { dryRun: true, payload: preview.payload, readiness: preview.readiness, requestHash: preview.requestHash };
  }

  const raceCheck = await getNaverRegistrationImpl(db, draftId);
  if (raceCheck) {
    throw Object.assign(new Error('이미 등록된 draft입니다 (동시 실행 감지)'), { code: 'ALREADY_REGISTERED', existing: raceCheck });
  }

  const client = clientImpl || new NaverCommerceClient(naverConfig);
  const result = await client.createOriginProduct(preview.payload);
  const originProductNo = result?.data?.originProductNo ?? result?.originProductNo;
  if (!originProductNo) {
    throw Object.assign(new Error(`createOriginProduct did not return an originProductNo: ${JSON.stringify(result)}`), { code: 'CREATE_PRODUCT_NO_ID', raw: result });
  }

  const registration = await recordNaverDirectRegistrationImpl(db, draftId, {
    originProductNo,
    channelProductNo: result?.data?.channelProducts?.[0]?.channelProductNo ?? null,
    requestHash: preview.requestHash,
  });
  if (!registration) {
    throw Object.assign(new Error(`createOriginProduct succeeded (originProductNo=${originProductNo}) but a registration row already existed for this draft -- check naver_product_registrations manually`), { code: 'RECORD_CONFLICT_AFTER_CREATE', originProductNo });
  }

  return { dryRun: false, originProductNo, registration, payload: preview.payload };
}

export { buildNaverRegistrationPreview };
