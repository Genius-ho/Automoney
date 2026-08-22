import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DAILY_KEYWORD_REQUEST_TEXT,
  formatKeywordSourcingResultMessage,
  formatProductLinkAnalysisMessage,
  handleCoupangKeywordMessage,
  handleProductLinkImportCallback,
  parseKeywordMessageText,
  parseProductLinks,
  productLinkImportKeyboard,
  requestDailyCoupangKeywords,
} from '../src/coupang-keyword-telegram.mjs';

const MONDAY_10AM = new Date(2026, 7, 24, 10, 0, 0); // 2026-08-24 is a Monday
const SATURDAY_10AM = new Date(2026, 7, 22, 10, 0, 0); // 2026-08-22 is a Saturday
const SUNDAY_10AM = new Date(2026, 7, 23, 10, 0, 0);

test('requestDailyCoupangKeywords is a no-op when telegram is unconfigured', async () => {
  const result = await requestDailyCoupangKeywords(null, { sendTelegramMessageImpl: async () => { throw new Error('must not be called'); }, now: MONDAY_10AM });
  assert.equal(result, null);
});

test('requestDailyCoupangKeywords sends the fixed prompt text on a weekday', async () => {
  let sent = null;
  await requestDailyCoupangKeywords({ botToken: 't', chatId: '1' }, {
    sendTelegramMessageImpl: async (config, text) => { sent = { config, text }; },
    now: MONDAY_10AM,
  });
  assert.equal(sent.text, DAILY_KEYWORD_REQUEST_TEXT);
});

test('requestDailyCoupangKeywords skips sending on Saturday and Sunday', async () => {
  const send = async () => { throw new Error('must not be called on a weekend'); };
  assert.equal(await requestDailyCoupangKeywords({ botToken: 't', chatId: '1' }, { sendTelegramMessageImpl: send, now: SATURDAY_10AM }), null);
  assert.equal(await requestDailyCoupangKeywords({ botToken: 't', chatId: '1' }, { sendTelegramMessageImpl: send, now: SUNDAY_10AM }), null);
});

test('parseKeywordMessageText splits on commas, newlines, and middle dots, trims, and dedupes', () => {
  const result = parseKeywordMessageText('여성 벨트, 쿨스카프\n여성벨트·컵 수거함');
  assert.deepEqual(result, ['여성 벨트', '쿨스카프', '컵 수거함']);
});

test('parseKeywordMessageText treats a leading-slash message as a bot command, not keywords', () => {
  assert.deepEqual(parseKeywordMessageText('/start'), []);
});

test('parseKeywordMessageText caps at 10 keywords', () => {
  const text = Array.from({ length: 15 }, (_, i) => `키워드${i}`).join(',');
  assert.equal(parseKeywordMessageText(text).length, 10);
});

test('parseKeywordMessageText returns [] for non-string input', () => {
  assert.deepEqual(parseKeywordMessageText(undefined), []);
});

test('parseProductLinks returns product numbers when every line is a supplier URL or bare number', () => {
  const text = 'https://domeggook.com/main/item/itemView.php?no=49168396&market=dome\n49168397';
  assert.deepEqual(parseProductLinks(text), ['49168396', '49168397']);
});

test('parseProductLinks returns null when any line is not a recognizable link/number (falls back to keyword parsing)', () => {
  assert.equal(parseProductLinks('여성 벨트\nhttps://domeggook.com/main/item/itemView.php?no=49168396'), null);
});

test('parseProductLinks dedupes and caps at 10 links', () => {
  const lines = Array.from({ length: 15 }, (_, i) => String(1000 + i));
  const result = parseProductLinks(lines.join('\n'));
  assert.equal(result.length, 10);
});

test('parseProductLinks returns null for a bot command or non-string input', () => {
  assert.equal(parseProductLinks('/start'), null);
  assert.equal(parseProductLinks(undefined), null);
});

test('formatProductLinkAnalysisMessage renders analyzed and error rows', () => {
  const message = formatProductLinkAnalysisMessage([
    { productNo: '1', status: 'analyzed', name: '여성 벨트', score: 80, filterStatus: 'pass', sourceMarket: 'domeme', coupangSalePrice: 15000, coupangExpectedProfit: 3000 },
    { productNo: '2', status: 'error', error: '상품을 찾을 수 없습니다' },
  ]);
  assert.match(message, /⭐ 80점 -- 여성 벨트 \(domeme, pass\) 판매가 15,000원 \/ 예상마진 3,000원/);
  assert.match(message, /⚠️ 2: 조회 실패 \(상품을 찾을 수 없습니다\)/);
});

test('formatKeywordSourcingResultMessage renders each status line distinctly', () => {
  const message = formatKeywordSourcingResultMessage([
    { keyword: '수납정리함', status: 'enqueued', categoryName: '정리함/수납함', score: 80 },
    { keyword: '홍삼', status: 'enqueued', categoryName: '쿠팡 키워드 소싱 (미분류)', score: 70 },
    { keyword: '컵 수거함', status: 'no_winner', candidatesEvaluated: 10 },
    { keyword: '행거', status: 'already_queued_or_drafted' },
    { keyword: '라면 정리함', status: 'error', error: 'domeme down' },
  ]);
  assert.match(message, /✅ 수납정리함: 정리함\/수납함 큐 등록 \(score 80\)/);
  assert.match(message, /✅ 홍삼: 쿠팡 키워드 소싱 \(미분류\) 큐 등록 \(score 70\)/);
  assert.match(message, /⏭ 컵 수거함: 기준 점수 미달로 통과 후보 없음 \(검색 10건\)/);
  assert.match(message, /↩️ 행거: 이미 큐\/초안에 있는 상품이라 건너뜀/);
  assert.match(message, /⚠️ 라면 정리함: 처리 실패 \(domeme down\)/);
});

test('formatKeywordSourcingResultMessage escapes HTML-significant characters in keyword/error text', () => {
  const message = formatKeywordSourcingResultMessage([
    { keyword: '<script>', status: 'error', error: '<b>boom</b>' },
  ]);
  assert.ok(!message.includes('<script>'));
  assert.ok(!message.includes('<b>boom</b>'));
});

test('handleCoupangKeywordMessage ignores a message with no text', async () => {
  const result = await handleCoupangKeywordMessage({}, {}, {}, { chatId: '1' }, {});
  assert.deepEqual(result, { handled: false });
});

test('handleCoupangKeywordMessage ignores a message from a different chat than configured', async () => {
  const result = await handleCoupangKeywordMessage({}, {}, {}, { chatId: '1' }, { text: '여성 벨트', chat: { id: 999 } });
  assert.deepEqual(result, { handled: false });
});

test('handleCoupangKeywordMessage ignores a bot command, without calling the sourcing pipeline', async () => {
  const result = await handleCoupangKeywordMessage({}, {}, {}, { chatId: '1' }, { text: '/start', chat: { id: 1 } }, {
    sourceCandidatesFromKeywordsImpl: async () => { throw new Error('must not be called'); },
  });
  assert.deepEqual(result, { handled: false });
});

test('handleCoupangKeywordMessage parses keywords, runs the sourcing pipeline, and replies with a summary', async () => {
  let sourcingArgs = null;
  let sentMessage = null;
  const result = await handleCoupangKeywordMessage(
    { name: 'db' },
    { name: 'domeme' },
    { defaultMarginRate: 0.25 },
    { botToken: 't', chatId: '1' },
    { text: '여성 벨트, 쿨스카프', chat: { id: 1 } },
    {
      sourceCandidatesFromKeywordsImpl: async (domemeClient, keywords, pricingRules, opts) => {
        sourcingArgs = { domemeClient, keywords, pricingRules, opts };
        return [{ keyword: '여성 벨트', status: 'imported', sourceMarket: 'domeggook', productNo: '1', coupangSalePrice: 10000 }];
      },
      sendTelegramMessageImpl: async (config, text) => { sentMessage = { config, text }; },
    },
  );
  assert.deepEqual(sourcingArgs.keywords, ['여성 벨트', '쿨스카프']);
  assert.equal(sourcingArgs.domemeClient.name, 'domeme');
  assert.equal(sourcingArgs.opts.db.name, 'db');
  assert.match(sentMessage.text, /여성 벨트/);
  assert.equal(result.handled, true);
  assert.deepEqual(result.keywords, ['여성 벨트', '쿨스카프']);
});

test('handleCoupangKeywordMessage routes an all-links message to link analysis instead of keyword sourcing, attaching a per-product 등록 keyboard', async () => {
  let analyzeArgs = null;
  let sentMessage = null;
  const result = await handleCoupangKeywordMessage(
    { name: 'db' },
    { name: 'domeme' },
    { defaultMarginRate: 0.25 },
    { botToken: 't', chatId: '1' },
    { text: 'https://domeggook.com/main/item/itemView.php?no=49168396\n49168397', chat: { id: 1 } },
    {
      sourceCandidatesFromKeywordsImpl: async () => { throw new Error('must not be called for a links message'); },
      analyzeProductLinksImpl: async (domemeClient, productNos, pricingRules) => {
        analyzeArgs = { domemeClient, productNos, pricingRules };
        return [{ productNo: '49168396', status: 'analyzed', name: 'A', score: 70, filterStatus: 'pass', sourceMarket: 'domeme' }];
      },
      sendTelegramMessageImpl: async (config, text, options) => { sentMessage = { config, text, options }; },
    },
  );
  assert.deepEqual(analyzeArgs.productNos, ['49168396', '49168397']);
  assert.equal(analyzeArgs.domemeClient.name, 'domeme');
  assert.match(sentMessage.text, /링크 분석 결과/);
  assert.deepEqual(sentMessage.options.replyMarkup, {
    inline_keyboard: [[{ text: '📥 등록 (70점) A', callback_data: 'import_link:49168396' }]],
  });
  assert.equal(result.handled, true);
  assert.deepEqual(result.productNos, ['49168396', '49168397']);
});

test('handleCoupangKeywordMessage passes db and rootDir through to analyzeProductLinks (so its AI scoring can load Codex config and fetch existing draft titles)', async () => {
  let analyzeOpts = null;
  await handleCoupangKeywordMessage(
    { name: 'db' },
    { name: 'domeme' },
    {},
    { botToken: 't', chatId: '1' },
    { text: '49168396', chat: { id: 1 } },
    {
      rootDir: '/custom/root',
      analyzeProductLinksImpl: async (domemeClient, productNos, pricingRules, opts) => { analyzeOpts = opts; return []; },
      sendTelegramMessageImpl: async () => {},
    },
  );
  assert.equal(analyzeOpts.db.name, 'db');
  assert.equal(analyzeOpts.rootDir, '/custom/root');
  assert.equal(analyzeOpts.source, 'telegram');
});

test('handleCoupangKeywordMessage defaults rootDir to process.cwd() when not supplied', async () => {
  let analyzeOpts = null;
  await handleCoupangKeywordMessage(
    { name: 'db' },
    { name: 'domeme' },
    {},
    { botToken: 't', chatId: '1' },
    { text: '49168396', chat: { id: 1 } },
    {
      analyzeProductLinksImpl: async (domemeClient, productNos, pricingRules, opts) => { analyzeOpts = opts; return []; },
      sendTelegramMessageImpl: async () => {},
    },
  );
  assert.equal(analyzeOpts.rootDir, process.cwd());
});

test('productLinkImportKeyboard puts one row per analyzed result, skips error rows, and truncates long names', () => {
  const keyboard = productLinkImportKeyboard([
    { productNo: '1', status: 'analyzed', name: '아주아주아주아주아주아주아주아주아주아주 긴 상품명', score: 80 },
    { productNo: '2', status: 'error', error: '조회 실패' },
    { productNo: '3', status: 'analyzed', name: '짧은 이름', score: 60 },
  ]);
  assert.equal(keyboard.inline_keyboard.length, 2);
  assert.equal(keyboard.inline_keyboard[0][0].callback_data, 'import_link:1');
  assert.ok(keyboard.inline_keyboard[0][0].text.includes('…'));
  assert.deepEqual(keyboard.inline_keyboard[1][0], { text: '📥 등록 (60점) 짧은 이름', callback_data: 'import_link:3' });
});

test('productLinkImportKeyboard returns undefined when every result errored (no reply_markup sent)', () => {
  assert.equal(productLinkImportKeyboard([{ productNo: '1', status: 'error', error: 'boom' }]), undefined);
});

test('handleProductLinkImportCallback ignores callback data with an unrecognized prefix', async () => {
  const result = await handleProductLinkImportCallback({}, {}, {}, '/root', {}, { data: 'unknown:1' }, {
    importDraftFromSupplierUrlImpl: async () => { throw new Error('must not be called'); },
  });
  assert.deepEqual(result, { handled: false });
});

test('handleProductLinkImportCallback imports the tapped product and edits the message, without triggering image generation (that is now a separate explicit "이미지 개선" tab step)', async () => {
  let edited = null;
  let answered = null;
  const result = await handleProductLinkImportCallback(
    { name: 'db' },
    { name: 'domeme' },
    { defaultMarginRate: 0.25 },
    '/root',
    { botToken: 't', chatId: '1' },
    { id: 'q1', data: 'import_link:49168396', message: { message_id: 5, text: '📊 링크 분석 결과' } },
    {
      importDraftFromSupplierUrlImpl: async (domemeClient, productNo, pricingRules, opts) => {
        assert.equal(productNo, '49168396');
        assert.equal(opts.db.name, 'db');
        return { draftId: 77, filterStatus: 'pass', sourceMarket: 'domeggook' };
      },
      answerCallbackQueryImpl: async (config, id, options) => { answered = { id, options }; },
      editTelegramMessageTextImpl: async (config, messageId, text) => { edited = { messageId, text }; },
      sendTelegramMessageImpl: async () => { throw new Error('must not be called when edit succeeds'); },
    },
  );

  assert.deepEqual(result, { handled: true, action: 'import_link', productNo: '49168396', draftId: 77 });
  assert.equal(answered.id, 'q1');
  assert.match(answered.options.text, /초안 #77 등록됨/);
  assert.match(answered.options.text, /이미지 개선.*탭/);
  assert.equal(edited.messageId, 5);
  assert.match(edited.text, /초안 #77 등록됨/);
});

test('handleProductLinkImportCallback reports an import failure without throwing', async () => {
  const result = await handleProductLinkImportCallback(
    {},
    {},
    {},
    '/root',
    { botToken: 't', chatId: '1' },
    { id: 'q2', data: 'import_link:1', message: { message_id: 6, text: 'x' } },
    {
      importDraftFromSupplierUrlImpl: async () => { throw new Error('상품을 찾을 수 없습니다'); },
      answerCallbackQueryImpl: async () => {},
      editTelegramMessageTextImpl: async () => {},
      sendTelegramMessageImpl: async () => {},
    },
  );
  assert.equal(result.handled, true);
  assert.equal(result.draftId, null);
});

test('handleCoupangKeywordMessage accepts numeric chat.id compared against a string-configured chatId', async () => {
  const result = await handleCoupangKeywordMessage({}, {}, {}, { chatId: '555' }, { text: '여성 벨트', chat: { id: 555 } }, {
    sourceCandidatesFromKeywordsImpl: async () => [],
    sendTelegramMessageImpl: async () => {},
  });
  assert.equal(result.handled, true);
});
