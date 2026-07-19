export class CoupangCategoryAdapter {
  constructor(client) {
    if (!client) throw new Error('CoupangClient is required');
    this.client = client;
  }

  async predictCategory(productName) {
    const raw = await this.client.predictCategory(productName);
    return normalizePrediction(raw);
  }

  async getCategoryMeta(displayCategoryCode) {
    const raw = await this.client.getCategoryMeta(displayCategoryCode);
    return normalizeCategoryMeta(raw);
  }
}

export function createCoupangCategoryAdapter(client) {
  return new CoupangCategoryAdapter(client);
}

function normalizePrediction(raw) {
  const payload = raw?.data ?? raw ?? {};
  return {
    displayCategoryCode: firstDefined(payload.predictedCategoryId, payload.displayCategoryCode, payload.categoryId),
    categoryName: firstDefined(payload.predictedCategoryName, payload.categoryName, payload.displayCategoryName),
    predictionResultType: firstDefined(payload.autoCategorizationPredictionResultType, payload.predictionResultType),
    raw,
  };
}

// Matches the real "category-related-metas" response: attributes carry a
// per-item MANDATORY/OPTIONAL flag; noticeCategories is a list of *templates*
// the seller must pick one of (each with its own required detail-field
// names), not a flat requirement list; certifications/requiredDocumentNames
// are similarly conditional lists, not booleans.
function normalizeCategoryMeta(raw) {
  const payload = raw?.data ?? raw ?? {};
  const attributes = normalizeList(payload.attributes);
  const certifications = normalizeList(payload.certifications);
  return {
    displayCategoryCode: firstDefined(payload.displayCategoryCode, payload.categoryId),
    categoryPath: normalizeCategoryPath(payload),
    attributes,
    mandatoryOptionNames: attributes
      .filter((attribute) => attribute?.required === 'MANDATORY')
      .map((attribute) => attribute.attributeTypeName),
    noticeCategoryTemplates: normalizeList(payload.noticeCategories),
    requiredDocumentNames: normalizeList(payload.requiredDocumentNames),
    certifications,
    mandatoryCertificationNames: certifications
      .filter((certification) => certification?.required === 'MANDATORY')
      .map((certification) => certification.name),
    allowedOfferConditions: normalizeList(payload.allowedOfferConditions),
    raw,
  };
}

function normalizeCategoryPath(payload) {
  const path = firstDefined(payload.displayCategoryPath, payload.categoryPath, payload.displayItemCategoryPath);
  if (Array.isArray(path)) {
    return path.map((entry) => (typeof entry === 'string' ? entry : entry?.name ?? entry?.displayItemCategoryName ?? JSON.stringify(entry)));
  }
  return typeof path === 'string' ? [path] : [];
}

function normalizeList(value) {
  return Array.isArray(value) ? value : [];
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null) ?? null;
}
