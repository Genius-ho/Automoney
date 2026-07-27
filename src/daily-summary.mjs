import { sendTelegramMessage } from './telegram-notifier.mjs';

// 하루 1회 등록/이미지교체 현황 요약 -- 사용자 요청(2026-07-28): 쿠팡은 direct-API로
// 처음부터 등록하고 네이버는 스피드고 등록 후 이미지/가격을 맞추는 흐름으로 굳히면서,
// 그 결과를 텔레그램으로 매일 알려달라는 요청에 대응. 가격 조정(update-price 라우트)은
// 현재 DB에 타임스탬프를 남기지 않아 이 요약에 포함하지 않음 -- 등록/이미지교체만
// 집계 가능한 이벤트.
//
// "오늘"은 KST 기준 -- (now() at time zone 'Asia/Seoul')::date 로 하루 경계를 잡아
// timestamptz 컬럼과 직접 비교. JS 쪽에서 타임존 산술을 다시 구현하지 않고 Postgres
// 자체 기능에 맡긴다.
const KST_TODAY_SQL = `(now() at time zone 'Asia/Seoul')::date at time zone 'Asia/Seoul'`;

export async function buildDailySummary(db) {
  const [coupangRegistered, coupangSwapped, naverLinked, naverSwapped] = await Promise.all([
    db.query(`select count(*)::int as count from coupang_product_registrations where linked_via = 'direct_api' and created_at >= ${KST_TODAY_SQL}`),
    db.query(`select count(*)::int as count from coupang_product_registrations where images_swapped_at >= ${KST_TODAY_SQL}`),
    db.query(`select count(*)::int as count from naver_product_registrations where linked_via = 'speedgo_link' and updated_at >= ${KST_TODAY_SQL}`),
    db.query(`select count(*)::int as count from naver_product_registrations where images_swapped_at >= ${KST_TODAY_SQL}`),
  ]);
  return {
    coupangRegisteredToday: coupangRegistered.rows[0].count,
    coupangImagesSwappedToday: coupangSwapped.rows[0].count,
    naverLinkedToday: naverLinked.rows[0].count,
    naverImagesSwappedToday: naverSwapped.rows[0].count,
  };
}

// No escapeHtml here -- every line is our own static label + a count, never
// content from an external source (unlike sendCriticalAlert's label/message,
// which come from a thrown error).
export function formatDailySummaryMessage(summary) {
  return [
    '📋 <b>오늘의 등록 현황</b>',
    `쿠팡 신규 등록(API): ${summary.coupangRegisteredToday}건`,
    `쿠팡 이미지 교체: ${summary.coupangImagesSwappedToday}건`,
    `네이버 스피드고 연결: ${summary.naverLinkedToday}건`,
    `네이버 이미지 교체: ${summary.naverImagesSwappedToday}건`,
  ].join('\n');
}

export async function sendDailySummary(db, telegramConfig, {
  buildDailySummaryImpl = buildDailySummary,
  sendTelegramMessageImpl = sendTelegramMessage,
} = {}) {
  if (!telegramConfig) return null;
  const summary = await buildDailySummaryImpl(db);
  return sendTelegramMessageImpl(telegramConfig, formatDailySummaryMessage(summary));
}
