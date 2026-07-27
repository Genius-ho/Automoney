import assert from 'node:assert/strict';
import test from 'node:test';

import {
  sendTelegramMessage,
  sendCriticalAlert,
  getTelegramUpdates,
  answerCallbackQuery,
  editTelegramMessageText,
} from '../src/telegram-notifier.mjs';

const config = { botToken: 'TEST_TOKEN', chatId: '123' };

function fakeFetch(jsonResult) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ ok: true, result: jsonResult }) };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test('sendTelegramMessage is a no-op when config is missing (feature unconfigured)', async () => {
  const fetchImpl = fakeFetch({});
  const result = await sendTelegramMessage(null, 'hello', { fetchImpl });
  assert.equal(result, null);
  assert.equal(fetchImpl.calls.length, 0);
});

test('sendTelegramMessage posts chat_id/text/parse_mode to the sendMessage endpoint', async () => {
  const fetchImpl = fakeFetch({ message_id: 1 });
  await sendTelegramMessage(config, 'hello', { fetchImpl });
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(fetchImpl.calls[0].url, /^https:\/\/api\.telegram\.org\/botTEST_TOKEN\/sendMessage$/);
  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.equal(body.chat_id, '123');
  assert.equal(body.text, 'hello');
  assert.equal(body.parse_mode, 'HTML');
});

test('sendTelegramMessage attaches reply_markup when an inline keyboard is passed', async () => {
  const fetchImpl = fakeFetch({ message_id: 1 });
  const replyMarkup = { inline_keyboard: [[{ text: '승인', callback_data: 'approve:1' }]] };
  await sendTelegramMessage(config, 'hello', { replyMarkup, fetchImpl });
  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.deepEqual(body.reply_markup, replyMarkup);
});

test('sendTelegramMessage throws with the API description when Telegram rejects the request', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: false, description: 'bad token' }) });
  await assert.rejects(() => sendTelegramMessage(config, 'hello', { fetchImpl }), /bad token/);
});

test('sendCriticalAlert escapes HTML-significant characters in label and message', async () => {
  const fetchImpl = fakeFetch({ message_id: 1 });
  await sendCriticalAlert(config, 'coupangOrders', 'error: <script> & "quotes"', { fetchImpl });
  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.equal(body.text, '⚠️ <b>coupangOrders</b>\nerror: &lt;script&gt; &amp; "quotes"');
});

test('sendCriticalAlert is a no-op when config is missing', async () => {
  const fetchImpl = fakeFetch({});
  const result = await sendCriticalAlert(null, 'label', 'message', { fetchImpl });
  assert.equal(result, null);
  assert.equal(fetchImpl.calls.length, 0);
});

test('getTelegramUpdates returns [] when config is missing', async () => {
  const fetchImpl = fakeFetch([{ update_id: 1 }]);
  const result = await getTelegramUpdates(null, { fetchImpl });
  assert.deepEqual(result, []);
  assert.equal(fetchImpl.calls.length, 0);
});

test('getTelegramUpdates passes offset and restricts allowed_updates to callback_query', async () => {
  const fetchImpl = fakeFetch([{ update_id: 5 }]);
  const result = await getTelegramUpdates(config, { offset: 42, fetchImpl });
  assert.deepEqual(result, [{ update_id: 5 }]);
  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.searchParams.get('offset'), '42');
  assert.equal(url.searchParams.get('allowed_updates'), JSON.stringify(['callback_query']));
});

test('answerCallbackQuery is a no-op when config is missing', async () => {
  const fetchImpl = fakeFetch({});
  const result = await answerCallbackQuery(null, 'cbid', { fetchImpl });
  assert.equal(result, null);
  assert.equal(fetchImpl.calls.length, 0);
});

test('answerCallbackQuery posts callback_query_id and optional text', async () => {
  const fetchImpl = fakeFetch({});
  await answerCallbackQuery(config, 'cbid', { text: '처리됨', fetchImpl });
  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.equal(body.callback_query_id, 'cbid');
  assert.equal(body.text, '처리됨');
});

test('editTelegramMessageText is a no-op when config is missing', async () => {
  const fetchImpl = fakeFetch({});
  const result = await editTelegramMessageText(null, 1, 'text', { fetchImpl });
  assert.equal(result, null);
  assert.equal(fetchImpl.calls.length, 0);
});

test('editTelegramMessageText posts message_id and new text', async () => {
  const fetchImpl = fakeFetch({});
  await editTelegramMessageText(config, 7, '승인됨', { fetchImpl });
  const body = JSON.parse(fetchImpl.calls[0].options.body);
  assert.equal(body.message_id, 7);
  assert.equal(body.text, '승인됨');
});
