import { handleCoupangApprovalCallback } from './coupang-telegram-approval.mjs';
import { handlePurchaseOrderApprovalCallback } from './telegram-approval-bot.mjs';
import { getTelegramUpdates } from './telegram-notifier.mjs';

export function createTelegramCallbackRouter() {
  let offset;

  async function pollOnce(db, {
    domemeClient = null,
    coupangClient = null,
    coupangConfig = null,
  } = {}, telegramConfig, {
    getTelegramUpdatesImpl = getTelegramUpdates,
    handlePurchaseOrderImpl = handlePurchaseOrderApprovalCallback,
    handleCoupangImpl = handleCoupangApprovalCallback,
    purchaseOrderHandlerDeps = {},
    coupangHandlerDeps = {},
  } = {}) {
    if (!telegramConfig) return { processed: 0 };
    const updates = await getTelegramUpdatesImpl(telegramConfig, { offset });
    let processed = 0;
    for (const update of updates) {
      offset = update.update_id + 1;
      const query = update.callback_query;
      if (!query?.data) continue;
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
      if (coupangResult?.handled) processed += 1;
    }
    return { processed };
  }

  return { pollOnce };
}
