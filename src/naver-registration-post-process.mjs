import { NaverCommerceClient } from './naver-commerce-client.mjs';
import { getApprovedManualMainImage } from './manual-ai/workflow-store.mjs';
import { getApprovedManualDetailSet } from './manual-ai/detail-workflow-store.mjs';
import { uploadApprovedImagesToR2 } from './r2-publisher.mjs';
import { uploadImagesToNaver } from './naver-registration-flow.mjs';
import { mapLiveNaverProductToImageSwapPayload } from './naver-payload-builder.mjs';
import { recordImagesSwapped } from './naver-registration-store.mjs';

function postProcessError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function countDetailImageEvidence(product) {
  const optionalImageCount = (product?.originProduct?.images?.optionalImages || [])
    .filter((image) => typeof image?.url === 'string' && image.url.length > 0)
    .length;
  const detailContentImageCount = (String(product?.originProduct?.detailContent || '').match(/<img\b/gi) || []).length;
  return Math.max(optionalImageCount, detailContentImageCount);
}

export function buildNaverPriceUpdatePayload(liveProduct, salePrice) {
  const optionInfo = liveProduct?.originProduct?.detailAttribute?.optionInfo || {};
  return {
    productSalePrice: { salePrice },
    optionInfo: {
      optionCombinations: optionInfo.optionCombinations || [],
      optionStandards: optionInfo.optionStandards || [],
      useStockManagement: optionInfo.useStockManagement ?? false,
    },
  };
}

export async function postProcessNaverRegistration(db, rootDir, draftId, {
  originProductNo,
  salePrice,
  naverConfig,
  clientImpl,
  getApprovedMainImpl = getApprovedManualMainImage,
  getApprovedDetailImpl = getApprovedManualDetailSet,
  publishImpl = uploadApprovedImagesToR2,
  uploadToNaverImpl = uploadImagesToNaver,
  mapImagePayloadImpl = mapLiveNaverProductToImageSwapPayload,
  recordImagesSwappedImpl = recordImagesSwapped,
} = {}) {
  const normalizedOriginProductNo = String(originProductNo ?? '').trim();
  if (!normalizedOriginProductNo || !Number.isFinite(salePrice)) {
    throw postProcessError(
      'NAVER_POST_PROCESS_INVALID_INPUT',
      'originProductNo and a finite salePrice are required',
    );
  }

  const approvedMain = await getApprovedMainImpl(db, draftId);
  const approvedDetail = await getApprovedDetailImpl(db, draftId);
  const mainImageLocalUrl = typeof approvedMain?.coupangStoredUrl === 'string'
    ? approvedMain.coupangStoredUrl.trim()
    : '';
  const detailImageLocalUrls = (approvedDetail?.images || [])
    .map((image) => typeof image?.normalizedStoredUrl === 'string' ? image.normalizedStoredUrl.trim() : '')
    .filter(Boolean);
  if (!mainImageLocalUrl || detailImageLocalUrls.length === 0) {
    throw postProcessError(
      'IMAGES_NOT_APPROVED',
      'Approved main image and detail image set are required',
    );
  }

  const client = clientImpl || new NaverCommerceClient(naverConfig);
  const liveProduct = await client.getProduct(normalizedOriginProductNo);
  const r2Images = await publishImpl({
    rootDir,
    draftId,
    mainImageLocalUrl,
    detailImageLocalUrls,
  });
  const naverImages = await uploadToNaverImpl(client, {
    mainImageUrl: r2Images.mainImageUrl,
    detailImageUrls: r2Images.detailImageUrls,
  });

  const imagePayload = mapImagePayloadImpl(liveProduct, {
    mainImageUrl: naverImages.mainImageUrl,
    detailImageUrls: naverImages.detailImageUrls,
  });
  await client.updateOriginProduct(normalizedOriginProductNo, imagePayload);

  const pricePayload = buildNaverPriceUpdatePayload(liveProduct, salePrice);
  await client.updateOptionStock(normalizedOriginProductNo, pricePayload);

  const registration = await recordImagesSwappedImpl(db, draftId);
  if (!registration) {
    throw postProcessError('PERSISTENCE_FAILED', 'Naver image-swap state could not be persisted');
  }

  const finalProduct = await client.getProduct(normalizedOriginProductNo);
  const actualSalePrice = finalProduct?.originProduct?.salePrice ?? null;
  const actualRepresentativeImageUrl = finalProduct?.originProduct?.images?.representativeImage?.url ?? null;
  const actualDetailImageCount = countDetailImageEvidence(finalProduct);
  const expectedDetailImageCount = naverImages.detailImageUrls.length;
  const mismatches = {};

  if (actualSalePrice !== salePrice) {
    mismatches.salePrice = { expected: salePrice, actual: actualSalePrice };
  }
  if (actualRepresentativeImageUrl !== naverImages.mainImageUrl) {
    mismatches.representativeImageUrl = {
      expected: naverImages.mainImageUrl,
      actual: actualRepresentativeImageUrl,
    };
  }
  if (actualDetailImageCount < expectedDetailImageCount) {
    mismatches.detailImageCount = {
      expectedMinimum: expectedDetailImageCount,
      actual: actualDetailImageCount,
    };
  }
  if (Object.keys(mismatches).length > 0) {
    throw postProcessError(
      'NAVER_POST_PROCESS_FAILED',
      'Naver post-processing verification failed',
      mismatches,
    );
  }

  return {
    verified: true,
    draftId,
    originProductNo: normalizedOriginProductNo,
    salePrice: actualSalePrice,
    representativeImageUrl: actualRepresentativeImageUrl,
    detailImageCount: actualDetailImageCount,
    registration,
  };
}
