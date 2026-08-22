// automoney_complete_automation_implementation_plan.md section 22.9: critical
// errors go to the admin screen and a Telegram alert channel. Config comes
// from loadTelegramConfig (config.mjs) -- null when unconfigured, in which
// case every function here is a no-op so callers never need their own
// feature-flag checks.
const TELEGRAM_API_BASE = 'https://api.telegram.org';

export async function sendTelegramMessage(telegramConfig, text, { replyMarkup, fetchImpl = fetch } = {}) {
  if (!telegramConfig) return null;
  const body = {
    chat_id: telegramConfig.chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (replyMarkup) body.reply_markup = replyMarkup;

  const response = await fetchImpl(`${TELEGRAM_API_BASE}/bot${telegramConfig.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (!json.ok) throw new Error(`telegram sendMessage failed: ${json.description || response.status}`);
  return json.result;
}

export async function editTelegramMessageText(telegramConfig, messageId, text, { replyMarkup, fetchImpl = fetch } = {}) {
  if (!telegramConfig) return null;
  const body = {
    chat_id: telegramConfig.chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
  };
  if (replyMarkup) body.reply_markup = replyMarkup;

  const response = await fetchImpl(`${TELEGRAM_API_BASE}/bot${telegramConfig.botToken}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (!json.ok) throw new Error(`telegram editMessageText failed: ${json.description || response.status}`);
  return json.result;
}

export async function answerCallbackQuery(telegramConfig, callbackQueryId, { text, fetchImpl = fetch } = {}) {
  if (!telegramConfig) return null;
  const response = await fetchImpl(`${TELEGRAM_API_BASE}/bot${telegramConfig.botToken}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
  const json = await response.json();
  if (!json.ok) throw new Error(`telegram answerCallbackQuery failed: ${json.description || response.status}`);
  return json.result;
}

export async function getTelegramUpdates(telegramConfig, { offset, timeoutSeconds = 0, fetchImpl = fetch } = {}) {
  if (!telegramConfig) return [];
  const params = new URLSearchParams({ timeout: String(timeoutSeconds) });
  if (offset !== undefined && offset !== null) params.set('offset', String(offset));
  // 'message' added alongside 'callback_query' for the Coupang keyword-request
  // reply flow (coupang-keyword-telegram.mjs) -- createTelegramApprovalPoller
  // (telegram-approval-bot.mjs) is the only other reader of getUpdates and it
  // already ignores updates with no callback_query, so this is additive.
  params.set('allowed_updates', JSON.stringify(['callback_query', 'message']));

  const response = await fetchImpl(`${TELEGRAM_API_BASE}/bot${telegramConfig.botToken}/getUpdates?${params}`);
  const json = await response.json();
  if (!json.ok) throw new Error(`telegram getUpdates failed: ${json.description || response.status}`);
  return json.result;
}

// label identifies the failing sweep/job (e.g. "coupangOrders",
// "playwrightLoginExpired") so the same wording used in scheduler.mjs's own
// console.error(`scheduler.${label}Error=...`) logging is recognizable in
// the alert too.
export async function sendCriticalAlert(telegramConfig, label, message, { fetchImpl = fetch } = {}) {
  if (!telegramConfig) return null;
  const text = `⚠️ <b>${escapeHtml(label)}</b>\n${escapeHtml(message)}`;
  return sendTelegramMessage(telegramConfig, text, { fetchImpl });
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
