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
  const salePrice = Number(draft.salePrice);
  const mainImageUrl = draft.mainImages?.[0] || null;
  if (!hasValue(draft.supplierProductNo) || !productName || !Number.isFinite(salePrice) || salePrice <= 0 || !mainImageUrl) {
    throw draftError('DRAFT_NOT_READY', 'Product draft is not ready for registration');
  }

  const detailImageUrls = draft.approvedAiDetailImages?.length
    ? [...draft.approvedAiDetailImages]
    : draft.detailImages?.length
      ? [...draft.detailImages]
      : [...(draft.detailSliceImages || [])];
  const snapshot = {
    draftId,
    supplierProductNo: String(draft.supplierProductNo),
    productName,
    salePrice,
    deliveryFee: Number(draft.deliveryFee || 0),
    detailContent: String(draft.detailContent || ''),
    mainImageUrl,
    detailImageUrls,
    options: (draft.options || []).map((option) => ({
      groupName: option.groupName || '옵션',
      optionName: option.optionName,
      additionalPrice: Number(option.price || 0),
      stockQuantity: Number(option.stockQuantity ?? 999),
    })),
  };
  snapshot.requestHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  return snapshot;
}
