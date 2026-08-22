// Daily counterpart to dailySummary.mjs (24h tick, see scheduler.mjs) and
// the reply-driven flow telegram-approval-bot.mjs/coupang-telegram-approval.mjs
// already use -- except this reads a *typed reply*, not a button tap. Coupang
// keyword scouting itself is manual for now (Playwright scraping of the
// public coupang.com listing is blocked by Akamai regardless of IP/stealth
// tooling -- see coupang-storefront-scraper.mjs), so the operator does the
// "browse Coupang, price filter >= 9,900원, read titles off the 추천순
// ranking" step by hand and texts the resulting keywords back; everything
// from there (Domeggook search, 50% margin pricing, enqueueing into
// processing_queue) runs through the same sourceCandidatesFromKeywords used
// by scripts/scout-and-import-coupang-keywords.js.
//
// 2026-08-22 사용자 결정: 리마인더는 평일(월~금)에만 -- 3일 주기 자동발굴처럼
// 매일 돌아가는 게 아니라 사람이 직접 키워드를 조사해야 하니 주말은 제외한다.
// 같은 답장 채널에 도매매/도매꾹 상품 링크 여러 개를 보내면(사람이 직접 후보를
// 찾아온 경우), 키워드 소싱과 달리 아무것도 저장/등록하지 않고 점수만 매겨
// 비교표로 알려준다 -- 분석 결과 메시지에 상품마다 "등록" 버튼을 붙여서, 마음에
// 드는 걸 그 자리에서 탭 한 번으로 커밋할 수도 있다("URL 등록" GUI 화면과 완전히
// 동일한 importDraftFromSupplierUrl/이미지 생성 경로를 그대로 재사용 -- 텔레그램으로
// 하든 GUI로 하든 같은 결과).
import { analyzeProductLinks } from './product-link-analysis.mjs';
import { dedupeKeywords } from './coupang-keyword-extractor.mjs';
import { importDraftFromSupplierUrl, parseSupplierProductNo } from './manual-url-import.mjs';
import { sourceCandidatesFromKeywords } from './coupang-keyword-sourcing.mjs';
import {
  answerCallbackQuery,
  editTelegramMessageText,
  escapeHtml,
  sendTelegramMessage,
} from './telegram-notifier.mjs';

// A stray long paste shouldn't fan out into a dozen Domeggook searches.
const MAX_KEYWORDS_PER_MESSAGE = 10;
const MAX_LINKS_PER_MESSAGE = 10;
const WEEKEND_DAYS = new Set([0, 6]); // Sun, Sat (Date#getDay())

export const DAILY_KEYWORD_REQUEST_TEXT = [
  '🔍 <b>오늘의 쿠팡 키워드를 보내주세요</b>',
  '쿠팡에서 아무 카테고리나 들어가서 가격 필터 최소 9,900원, 추천순 정렬로 목록을 보고,',
  '이미지/가격은 보지 말고 상품명에서 핵심 키워드만 뽑아 답장으로 보내주세요.',
  '쉼표(,) 또는 줄바꿈으로 구분, 최대 10개.',
  '예: 여성 벨트, 쿨스카프, 컵 수거함',
  '',
  '(도매매/도매꾹에서 직접 찾은 상품 링크가 있다면, 그것도 여러 개 줄바꿈으로 보내면 점수를 매겨 비교해드려요.)',
].join('\n');

export async function requestDailyCoupangKeywords(telegramConfig, { sendTelegramMessageImpl = sendTelegramMessage, now = new Date() } = {}) {
  if (!telegramConfig) return null;
  if (WEEKEND_DAYS.has(now.getDay())) return null;
  return sendTelegramMessageImpl(telegramConfig, DAILY_KEYWORD_REQUEST_TEXT);
}

// Splits on commas/newlines/middle dots, trims, dedupes near-duplicates the
// same way the Coupang-scrape extractor does, and caps the count. Bot
// commands (e.g. Telegram's own "/start") are never treated as keywords.
export function parseKeywordMessageText(text) {
  if (typeof text !== 'string') return [];
  if (text.trim().startsWith('/')) return [];
  const raw = text.split(/[\n,·]+/).map((part) => part.trim()).filter(Boolean);
  return dedupeKeywords(raw).slice(0, MAX_KEYWORDS_PER_MESSAGE);
}

// A message counts as "product links" only when EVERY non-empty line parses
// as a supplier product URL/number -- a single stray keyword line falls
// back to the keyword flow instead of half-succeeding as links.
export function parseProductLinks(text) {
  if (typeof text !== 'string') return null;
  if (text.trim().startsWith('/')) return null;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const productNos = lines.map((line) => parseSupplierProductNo(line));
  if (productNos.some((no) => !no)) return null;
  return [...new Set(productNos)].slice(0, MAX_LINKS_PER_MESSAGE);
}

export function formatKeywordSourcingResultMessage(results) {
  if (results.length === 0) return '처리할 키워드가 없었어요.';
  const lines = results.map((result) => {
    if (result.status === 'enqueued') {
      return `✅ ${escapeHtml(result.keyword)}: ${escapeHtml(result.categoryName || '-')} 큐 등록 (score ${result.score}) — 분석·이미지생성·QA 자동 진행 예정`;
    }
    if (result.status === 'no_winner') {
      return `⏭ ${escapeHtml(result.keyword)}: 기준 점수 미달로 통과 후보 없음 (검색 ${result.candidatesEvaluated}건)`;
    }
    if (result.status === 'already_queued_or_drafted') {
      return `↩️ ${escapeHtml(result.keyword)}: 이미 큐/초안에 있는 상품이라 건너뜀`;
    }
    return `⚠️ ${escapeHtml(result.keyword)}: 처리 실패 (${escapeHtml(result.error || 'unknown')})`;
  });
  return ['📦 <b>키워드 소싱 결과</b>', ...lines].join('\n');
}

export function formatProductLinkAnalysisMessage(results) {
  if (results.length === 0) return '분석할 링크가 없었어요.';
  const lines = results.map((result) => {
    if (result.status === 'error') {
      return `⚠️ ${escapeHtml(result.productNo)}: 조회 실패 (${escapeHtml(result.error || 'unknown')})`;
    }
    const price = result.coupangSalePrice != null ? `${Number(result.coupangSalePrice).toLocaleString('ko-KR')}원` : '-';
    const profit = result.coupangExpectedProfit != null ? `${Number(result.coupangExpectedProfit).toLocaleString('ko-KR')}원` : '-';
    return `⭐ ${result.score}점 -- ${escapeHtml(result.name || result.productNo)} (${escapeHtml(result.sourceMarket || '-')}, ${escapeHtml(result.filterStatus || '-')}) 판매가 ${price} / 예상마진 ${profit}`;
  });
  return ['📊 <b>링크 분석 결과 (점수 높은 순)</b>', ...lines].join('\n');
}

// One row per successfully-analyzed link ("등록" -- error rows get no button,
// there's nothing to register) so tapping commits that single product via
// handleProductLinkImportCallback below, without retyping/repasting it into
// the "URL 등록" GUI screen. Button label is capped well under Telegram's
// limit since product names can run long.
export function productLinkImportKeyboard(results) {
  const rows = results
    .filter((result) => result.status !== 'error')
    .map((result) => {
      const name = String(result.name || result.productNo);
      const label = name.length > 24 ? `${name.slice(0, 24)}…` : name;
      return [{ text: `📥 등록 (${result.score}점) ${label}`, callback_data: `import_link:${result.productNo}` }];
    });
  return rows.length > 0 ? { inline_keyboard: rows } : undefined;
}

// Only reacts to a plain-text reply from the configured operator chat --
// everything else (other chats, bot commands, messages with no usable
// keyword/link) is left unhandled so the caller's router can pass it along
// to whatever else might want it.
export async function handleCoupangKeywordMessage(db, domemeClient, pricingRules, telegramConfig, message, {
  rootDir = process.cwd(),
  sourceCandidatesFromKeywordsImpl = sourceCandidatesFromKeywords,
  analyzeProductLinksImpl = analyzeProductLinks,
  sendTelegramMessageImpl = sendTelegramMessage,
} = {}) {
  if (!message?.text) return { handled: false };
  if (telegramConfig?.chatId != null && String(message.chat?.id) !== String(telegramConfig.chatId)) return { handled: false };

  const productNos = parseProductLinks(message.text);
  if (productNos) {
    const results = await analyzeProductLinksImpl(domemeClient, productNos, pricingRules, { db, rootDir, source: 'telegram' });
    await sendTelegramMessageImpl(telegramConfig, formatProductLinkAnalysisMessage(results), {
      replyMarkup: productLinkImportKeyboard(results),
    });
    return { handled: true, productNos, results };
  }

  const keywords = parseKeywordMessageText(message.text);
  if (keywords.length === 0) return { handled: false };

  const results = await sourceCandidatesFromKeywordsImpl(domemeClient, keywords, pricingRules, { db });
  await sendTelegramMessageImpl(telegramConfig, formatKeywordSourcingResultMessage(results));
  return { handled: true, keywords, results };
}

// Runs after a tap on the "📥 등록" button productLinkImportKeyboard attaches
// to a link-analysis reply -- commits that one product to a draft via the
// exact same importDraftFromSupplierUrl path the "URL 등록"/"점수" GUI
// screens' POST /api/product-drafts/import-by-url route uses, so a Telegram
// tap and a GUI click both end up in the same place. 2026-08-22 사용자 요청:
// 등록이 이미지 생성을 자동으로 시작하지 않는다 -- GUI "이미지 개선" 탭에서
// 사람이 명시적으로 시작해야 한다 (admin-server.mjs의 그 결정과 일관성 유지).
// Answering/editing failures are swallowed (not rethrown) the same
// way coupang-telegram-approval.mjs/telegram-approval-bot.mjs already do --
// by the time Telegram's response window can close, the draft itself may
// already be genuinely created, so none of these notification steps may
// ever look like the import itself failed.
async function presentImportResult(telegramConfig, query, resultText, {
  answerCallbackQueryImpl,
  editTelegramMessageTextImpl,
  sendTelegramMessageImpl,
}) {
  try {
    await answerCallbackQueryImpl(telegramConfig, query.id, { text: resultText.slice(0, 200) });
  } catch (error) {
    console.error(`coupangKeywordTelegram.answerCallbackQueryFailed=${error.message}`);
  }
  const originalText = escapeHtml(query.message?.text || '');
  try {
    await editTelegramMessageTextImpl(telegramConfig, query.message?.message_id, `${originalText}\n\n${escapeHtml(resultText)}`);
  } catch (error) {
    console.error(`coupangKeywordTelegram.editMessageFailed=${error.message}`);
    try {
      await sendTelegramMessageImpl(telegramConfig, escapeHtml(resultText));
    } catch (fallbackError) {
      console.error(`coupangKeywordTelegram.fallbackSendFailed=${fallbackError.message}`);
    }
  }
}

export async function handleProductLinkImportCallback(db, domemeClient, pricingRules, rootDir, telegramConfig, query, {
  importDraftFromSupplierUrlImpl = importDraftFromSupplierUrl,
  answerCallbackQueryImpl = answerCallbackQuery,
  editTelegramMessageTextImpl = editTelegramMessageText,
  sendTelegramMessageImpl = sendTelegramMessage,
} = {}) {
  const [action, productNo] = String(query?.data || '').split(':');
  if (action !== 'import_link' || !productNo) return { handled: false };

  const presentation = { answerCallbackQueryImpl, editTelegramMessageTextImpl, sendTelegramMessageImpl };
  let resultText;
  let draftId = null;
  try {
    const imported = await importDraftFromSupplierUrlImpl(domemeClient, productNo, pricingRules, { db });
    draftId = imported.draftId;
    resultText = `✅ 초안 #${draftId} 등록됨 (필터 상태: ${imported.filterStatus}) -- 관리자 화면 "이미지 개선" 탭에서 이미지 생성을 시작해주세요.`;
  } catch (error) {
    resultText = `⚠️ 등록 실패: ${error.message}`;
  }
  await presentImportResult(telegramConfig, query, resultText, presentation);

  return { handled: true, action: 'import_link', productNo, draftId };
}
