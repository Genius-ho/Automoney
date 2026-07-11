import { saveImportFailure, saveImportResult } from './postgres-store.mjs';
import {
  calculatePrices,
  cleanProductName,
  filterProduct,
  normalizeProduct,
} from './processing.mjs';

export async function processProducts({ productNumbers, client, db, pricingRules }) {
  const results = [];
  for (const productNo of productNumbers) {
    results.push(await processProduct({ productNo, client, db, pricingRules }));
  }
  return results;
}

export async function processProduct({ productNo, client, db, pricingRules }) {
  try {
    const raw = await client.fetchProductDetail(productNo);

    const normalized = normalizeProduct(productNo, raw);
    const filter = filterProduct(normalized);
    const cleanedName = cleanProductName(normalized.name);
    if (!filter.accepted) {
      await saveImportResult(db, {
        productNo,
        raw,
        normalized: { ...normalized, name: cleanedName },
        filter,
        prices: {},
      });
      return { productNo, status: 'SKIPPED', reason: filter.reason, filter };
    }

    const namedProduct = { ...normalized, name: cleanedName };
    const prices = calculatePrices(namedProduct, pricingRules);

    await saveImportResult(db, {
      productNo,
      raw,
      normalized: namedProduct,
      filter,
      prices,
    });

    return {
      productNo,
      status: 'SUCCESS',
      cleanedName,
      coupangPrice: prices.coupang,
      smartstorePrice: prices.smartstore,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await saveImportFailure(db, { productNo, reason });
    return { productNo, status: 'FAILED', reason };
  }
}
