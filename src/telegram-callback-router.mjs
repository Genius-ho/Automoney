import { handleCoupangApprovalCallback } from './coupang-telegram-approval.mjs';
import { handleCoupangKeywordMessage, handleProductLinkImportCallback } from './coupang-keyword-telegram.mjs';
import { handlePurchaseOrderApprovalCallback } from './telegram-approval-bot.mjs';
import { getTelegramUpdates } from './telegram-notifier.mjs';

export function createTelegramCallbackRouter() {
  let offset;

  async function pollOnce(db, {
    domemeClient = null,
    coupangClient = null,
    coupangConfig = null,
    // Separate from `domemeClient` above (that one is the *private*,
    // order-placing session client passed in as domemePrivateClient by
    // scheduler.mjs) -- this is the public search client the Coupang
    // keyword-reply flow searches Domeggook with, and that the "등록" button
    // callback below reuses to actually import the tapped product.
    domemeSearchClient = null,
    pricingRules = null,
    // Needed only by the "등록" button callback, to load codex/job-paths/
    // telegram config the same way the "URL 등록" HTTP route already does.
    rootDir = null,
  } = {}, telegramConfig, {
    getTelegramUpdatesImpl = getTelegramUpdates,
    handlePurchaseOrderImpl = handlePurchaseOrderApprovalCallback,
    handleCoupangImpl = handleCoupangApprovalCallback,
    handleCoupangKeywordMessageImpl = handleCoupangKeywordMessage,
    handleProductLinkImportImpl = handleProductLinkImportCallback,
    purchaseOrderHandlerDeps = {},
    coupangHandlerDeps = {},
    keywordHandlerDeps = {},
    productLinkImportHandlerDeps = {},
  } = {}) {
    if (!telegramConfig) return { processed: 0 };
    const updates = await getTelegramUpdatesImpl(telegramConfig, { offset });
    let processed = 0;
    for (const update of updates) {
      offset = update.update_id + 1;
      const query = update.callback_query;
      if (query?.data) {
        const purchaseResult = await handlePurchaseOrderImpl(
          db,
          domemeClient,
          telegramConfig,
          query,
          purchaseOrderHandlerDeps,
        );
        if (purchaseResult?.handled) {
          processed += 1;
          continue;
        }
        const coupangResult = await handleCoupangImpl(db, telegramConfig, query, {
          ...coupangHandlerDeps,
          coupangClient,
          coupangConfig,
        });
        if (coupangResult?.handled) {
          processed += 1;
          continue;
        }
        const importResult = await handleProductLinkImportImpl(
          db,
          domemeSearchClient,
          pricingRules,
          rootDir,
          telegramConfig,
          query,
          productLinkImportHandlerDeps,
        );
        if (importResult?.handled) processed += 1;
        continue;
      }
      if (update.message?.text) {
        const keywordResult = await handleCoupangKeywordMessageImpl(
          db,
          domemeSearchClient,
          pricingRules,
          telegramConfig,
          update.message,
          keywordHandlerDeps,
        );
        if (keywordResult?.handled) processed += 1;
      }
    }
    return { processed };
  }

  return { pollOnce };
}
