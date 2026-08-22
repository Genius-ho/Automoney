import { createHash } from 'node:crypto';

function draftError(code, message) {
  return Object.assign(new Error(message), { code });
}

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

export function buildSpeedgoRegistrationInput(draft, { draftId } = {}) {
  if (Number(draftId) === 64) {
    throw draftError('DRAFT_NOT_READY', 'draft 64는 보호 대상입니다');
  }
  if (!draft) throw draftError('DRAFT_NOT_FOUND', 'Product draft not found');
  if (draft.exportBlocked) throw draftError('DRAFT_BLOCKED', 'Product draft is blocked');

  const productName = String(draft.displayProductName || draft.name || '').trim();
  const mainImageUrl = draft.mainImages?.[0] || null;
  const detailImageUrls = draft.approvedAiDetailImages?.length
    ? [...draft.approvedAiDetailImages]
    : draft.detailImages?.length
      ? [...draft.detailImages]
      : [...(draft.detailSliceImages || [])];
  const detailContent = String(draft.detailContent || '');
  const deliveryFee = Number(draft.deliveryFee ?? 0);
  const rawOptions = (draft.options || []).map((option) => ({
    groupName: option.groupName || '옵션',
    optionName: option.optionName,
    additionalPrice: Number(option.price ?? 0),
    stockQuantity: Number(option.stockQuantity ?? 999),
  }));
  // Naver/Speedgo rejects a negative additionalPrice outright, but a
  // per-option discount relative to the reference price (e.g. draft 11's
  // "소형" priced 1800원 below "중형") is a normal, real price structure, not
  // invalid data. Re-anchoring salePrice down to the cheapest option's real
  // price -- and re-deriving every option's additionalPrice as its own real
  // price's delta from that new floor -- keeps every option's actual price
  // unchanged while making every additionalPrice >= 0.
  const lowestAdditionalPrice = rawOptions.length ? Math.min(0, ...rawOptions.map((option) => option.additionalPrice)) : 0;
  const salePrice = Number(draft.salePrice) + lowestAdditionalPrice;
  const options = rawOptions.map((option) => ({ ...option, additionalPrice: option.additionalPrice - lowestAdditionalPrice }));
  const hasValidNumbers = Number.isFinite(deliveryFee) && deliveryFee >= 0
    && options.every((option) => Number.isFinite(option.additionalPrice)
      && option.additionalPrice >= 0
      && Number.isFinite(option.stockQuantity)
      && option.stockQuantity >= 0);
  if (!hasValue(draft.supplierProductNo) || !productName || !Number.isFinite(salePrice) || salePrice <= 0
    || !mainImageUrl || !detailContent.trim() || !detailImageUrls.some(hasValue) || !hasValidNumbers) {
    throw draftError('DRAFT_NOT_READY', 'Product draft is not ready for registration');
  }

  const snapshot = {
    draftId,
    supplierProductNo: String(draft.supplierProductNo),
    productName,
    salePrice,
    deliveryFee,
    detailContent,
    mainImageUrl,
    detailImageUrls,
    options,
  };
  snapshot.requestHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  return snapshot;
}
