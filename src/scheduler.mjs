import { loadCoupangConfig, loadNaverCommerceConfig, loadEnvConfig, loadDomemePrivateConfig, loadTelegramConfig } from './config.mjs';
import { sendCriticalAlert } from './telegram-notifier.mjs';
import { notifyPendingPurchaseApprovals, createTelegramApprovalPoller } from './telegram-approval-bot.mjs';
import { CoupangClient } from './coupang-client.mjs';
import { NaverCommerceClient } from './naver-commerce-client.mjs';
import { DomemeClient } from './domeme-client.mjs';
import { DomemePrivateClient } from './domeme-private-client.mjs';
import { runCoupangOrderCollection, runNaverOrderCollection } from './order-collector.mjs';
import { runCoupangReturnRequestCollection } from './return-request-collector.mjs';
import { runNaverClaimDetectionSweep } from './naver-claim-collector.mjs';
import { runSupplierOrderValidationSweep } from './purchase-order-builder.mjs';
import { runShipmentCollectionSweep } from './shipment-collector.mjs';
import { runChannelDispatchSweep } from './channel-dispatch.mjs';
import { runCancellationExceptionSweep } from './cancellation-handler.mjs';
import { runSupplierMonitorAndSuspendSweep } from './channel-suspension.mjs';

// automoney_complete_automation_implementation_plan.md section 18 스케줄
// 기준. 상품 카테고리 발굴(3일)/스피드등록/상품개선(매일)은 admin-server.mjs's own
// pre-existing 5-minute autoBatch tick already covers -- it checks
// batch_schedule_state's next_run_at/processingNextRunAt itself, so nothing
// here duplicates that. Everything below is Phase 6-10's own periodic
// sweeps, none of which ran on any timer before this -- every verification
// this whole session was a manual `npm run ...` invocation. Every sweep
// this calls already has its own lock (order_collection_state,
// batch_schedule_state, etc.) or is naturally idempotent, the same
// "동시 실행 금지" guarantee the plan requires -- this just decides when to
// call them, not how they stay safe under overlap.
export const ORDER_TICK_INTERVAL_MS = 30 * 60 * 1000; // 쿠팡/네이버 주문 조회, 도매매 송장 조회: 30분마다
export const DISPATCH_TICK_INTERVAL_MS = 90 * 60 * 1000; // 배송상태 동기화: 1~2시간마다
export const SUPPLIER_MONITOR_TICK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 공급처 가격·재고 감시: 하루 4회
export const TELEGRAM_APPROVAL_POLL_INTERVAL_MS = 15 * 1000; // 텔레그램 인라인 버튼 응답: 즉시 반응이 필요해 다른 sweep보다 훨씬 짧게

// Loaded once at startup, not per-tick -- same reasoning as admin-server.mjs's
// own loadAutoBatchDeps: missing/invalid config disables scheduling
// (logged, not fatal) rather than crashing the whole admin server.
export async function loadSchedulerDeps(rootDir) {
  // telegramConfig is intentionally not part of the Promise.all above --
  // loadTelegramConfig never throws (returns null when unconfigured), and
  // mixing it in would make a missing bot token indistinguishable from a
  // real credential failure in the catch block below.
  const telegramConfig = await loadTelegramConfig(rootDir);
  try {
    const [coupangConfig, naverConfig, envConfig, domemePrivateConfig] = await Promise.all([
      loadCoupangConfig(rootDir),
      loadNaverCommerceConfig(rootDir),
      loadEnvConfig(rootDir),
      loadDomemePrivateConfig(rootDir),
    ]);
    return {
      coupangClient: new CoupangClient(coupangConfig),
      naverClient: new NaverCommerceClient(naverConfig),
      domemeClient: new DomemeClient({ apiKey: envConfig.domemeApiKey, endpoint: envConfig.domemeEndpoint }),
      domemePrivateClient: new DomemePrivateClient(domemePrivateConfig),
      telegramConfig,
    };
  } catch (error) {
    console.error(`scheduler.configUnavailable=${error.message}`);
    return null;
  }
}

export function tick(label, intervalMs, fn, { setIntervalImpl = setInterval, telegramConfig = null, sendCriticalAlertImpl = sendCriticalAlert } = {}) {
  const handle = setIntervalImpl(async () => {
    try {
      const result = await fn();
      console.log(`scheduler.${label}=${JSON.stringify(result)}`);
    } catch (error) {
      console.error(`scheduler.${label}Error=${error.message}`);
      try {
        await sendCriticalAlertImpl(telegramConfig, `scheduler.${label}`, error.message);
      } catch (alertError) {
        console.error(`scheduler.${label}AlertFailed=${alertError.message}`);
      }
    }
  }, intervalMs);
  handle.unref?.();
  return handle;
}

// Returns the interval handles so the caller (admin-server.mjs) can clear
// them on shutdown, the same lifecycle as the existing autoBatch tick.
// Returns [] (no-op, nothing scheduled) when config is unavailable.
export async function startScheduledJobs(db, rootDir, {
  loadSchedulerDepsImpl = loadSchedulerDeps,
  tickImpl = tick,
  createTelegramApprovalPollerImpl = createTelegramApprovalPoller,
} = {}) {
  const deps = await loadSchedulerDepsImpl(rootDir);
  if (!deps) return [];
  const { coupangClient, naverClient, domemeClient, domemePrivateClient, telegramConfig = null } = deps;
  const opts = { telegramConfig };
  const approvalPoller = createTelegramApprovalPollerImpl();

  return [
    tickImpl('coupangOrders', ORDER_TICK_INTERVAL_MS, () => runCoupangOrderCollection(db, coupangClient), opts),
    tickImpl('naverOrders', ORDER_TICK_INTERVAL_MS, () => runNaverOrderCollection(db, naverClient), opts),
    tickImpl('coupangReturns', ORDER_TICK_INTERVAL_MS, () => runCoupangReturnRequestCollection(db, coupangClient), opts),
    tickImpl('naverClaims', ORDER_TICK_INTERVAL_MS, () => runNaverClaimDetectionSweep(db, naverClient), opts),
    tickImpl('purchaseOrderValidation', ORDER_TICK_INTERVAL_MS, () => runSupplierOrderValidationSweep(db, domemeClient), opts),
    tickImpl('shipments', ORDER_TICK_INTERVAL_MS, () => runShipmentCollectionSweep(db, domemePrivateClient), opts),
    tickImpl('dispatch', DISPATCH_TICK_INTERVAL_MS, () => runChannelDispatchSweep(db, { coupangClient, naverClient }), opts),
    tickImpl('cancellationExceptions', DISPATCH_TICK_INTERVAL_MS, () => runCancellationExceptionSweep(db), opts),
    tickImpl('supplierMonitor', SUPPLIER_MONITOR_TICK_INTERVAL_MS, () => runSupplierMonitorAndSuspendSweep(db, domemeClient, { coupangClient, naverClient }), opts),
    tickImpl('purchaseOrderTelegramNotify', ORDER_TICK_INTERVAL_MS, () => notifyPendingPurchaseApprovals(db, telegramConfig), opts),
    tickImpl('telegramApprovalPoll', TELEGRAM_APPROVAL_POLL_INTERVAL_MS, () => approvalPoller.pollOnce(db, domemePrivateClient, telegramConfig), opts),
  ];
}

export function stopScheduledJobs(handles) {
  for (const handle of handles || []) clearInterval(handle);
}
