import assert from 'node:assert/strict';
import test from 'node:test';

import { generateManualImportImagesAndNotify, importDraftFromSupplierUrl, parseSupplierProductNo } from '../src/manual-url-import.mjs';

test('parseSupplierProductNo accepts a bare product number', () => {
  assert.equal(parseSupplierProductNo('49168396'), '49168396');
  assert.equal(parseSupplierProductNo('  49168396  '), '49168396');
});

test('parseSupplierProductNo extracts no= from a domeggook item view URL', () => {
  assert.equal(parseSupplierProductNo('https://domeggook.com/main/item/itemView.php?no=49168396&market=dome'), '49168396');
  assert.equal(parseSupplierProductNo('https://domeggook.com/main/item/itemView.php?no=49168396'), '49168396');
});

test('parseSupplierProductNo returns null for unrecognizable input', () => {
  assert.equal(parseSupplierProductNo(''), null);
  assert.equal(parseSupplierProductNo(undefined), null);
  assert.equal(parseSupplierProductNo('not a url or number'), null);
  assert.equal(parseSupplierProductNo('https://domeggook.com/main/item/itemView.php?no=abc'), null);
});

test('importDraftFromSupplierUrl rejects unrecognizable input before touching Domeme/the db', async () => {
  await assert.rejects(
    () => importDraftFromSupplierUrl({}, 'garbage', {}, {
      db: {},
      evaluateCandidatesImpl: async () => { throw new Error('must not be called'); },
    }),
    (error) => error.code === 'INVALID_INPUT',
  );
});

test('importDraftFromSupplierUrl evaluates exactly one candidate for the parsed product number and saves it, regardless of filter status', async () => {
  let receivedCandidates = null;
  let receivedRules = null;
  const savedArgs = [];
  const result = await importDraftFromSupplierUrl({ name: 'domeme' }, '49168396', { defaultMarginRate: 0.25 }, {
    db: { name: 'db' },
    evaluateCandidatesImpl: async (client, candidates, rules, options) => {
      receivedCandidates = candidates;
      receivedRules = { rules, options };
      return [{ productNo: '49168396', raw: {}, normalized: { sourceMarket: 'domeggook' }, filter: { filterStatus: 'needs_review' }, prices: { coupangSalePrice: 10000 } }];
    },
    saveEvaluatedCandidateImpl: async (db, candidate, opts) => { savedArgs.push({ candidate, opts }); return { saved: true, draftId: 77, supplierProductId: 5, dbAction: 'inserted' }; },
  });

  assert.deepEqual(receivedCandidates, [{ productNo: '49168396' }]);
  assert.equal(receivedRules.rules.defaultMarginRate, 0.25);
  assert.equal(receivedRules.options.includeDomeggook, true);
  assert.equal(receivedRules.options.includeNeedsReview, true);
  assert.match(savedArgs[0].opts.importBatchId, /^manual-url-import-\d+$/);
  assert.deepEqual(result, {
    draftId: 77,
    supplierProductId: 5,
    dbAction: 'inserted',
    filterStatus: 'needs_review',
    sourceMarket: 'domeggook',
  });
});

test('importDraftFromSupplierUrl throws the underlying error when fetchProductDetail failed inside evaluateCandidates', async () => {
  await assert.rejects(
    () => importDraftFromSupplierUrl({}, '49168396', {}, {
      db: {},
      evaluateCandidatesImpl: async () => [{ productNo: '49168396', error: new Error('fetch failed') }],
    }),
    /fetch failed/,
  );
});

test('importDraftFromSupplierUrl throws when saveEvaluatedCandidate reports a failed save', async () => {
  await assert.rejects(
    () => importDraftFromSupplierUrl({}, '49168396', {}, {
      db: {},
      evaluateCandidatesImpl: async () => [{ productNo: '49168396', raw: {}, normalized: {}, filter: { filterStatus: 'pass' }, prices: {} }],
      saveEvaluatedCandidateImpl: async () => ({ saved: false, error: new Error('db down') }),
    }),
    /db down/,
  );
});

test('generateManualImportImagesAndNotify generates main+detail images then sends a success message with the admin link', async () => {
  const calls = [];
  let sentMessage = null;
  await generateManualImportImagesAndNotify({ name: 'db' }, '/root', 77, {
    loadCodexConfigImpl: async () => ({ codex: true }),
    loadJobPathsConfigImpl: async () => ({ jobDir: '/jobs' }),
    loadTelegramConfigImpl: async () => ({ botToken: 't', chatId: 'c' }),
    generateMainImageImpl: async (...args) => { calls.push(['main', args]); },
    generateDetailImageSetImpl: async (...args) => { calls.push(['detail', args]); },
    sendTelegramMessageImpl: async (config, text) => { sentMessage = { config, text }; },
  });

  assert.equal(calls[0][0], 'main');
  assert.deepEqual(calls[0][1], [{ name: 'db' }, '/root', '/jobs', 77, { codexConfig: { codex: true } }]);
  assert.equal(calls[1][0], 'detail');
  assert.match(sentMessage.text, /✅ 초안 #77 1차 가공\(대표\+상세 이미지\) 완료/);
  assert.match(sentMessage.text, /draftId=77/);
});

test('generateManualImportImagesAndNotify sends a failure message instead of throwing when image generation fails', async () => {
  let sentMessage = null;
  await generateManualImportImagesAndNotify({ name: 'db' }, '/root', 77, {
    loadCodexConfigImpl: async () => ({}),
    loadJobPathsConfigImpl: async () => ({ jobDir: '/jobs' }),
    loadTelegramConfigImpl: async () => ({ botToken: 't', chatId: 'c' }),
    generateMainImageImpl: async () => { throw new Error('codex down'); },
    generateDetailImageSetImpl: async () => { throw new Error('must not be called'); },
    sendTelegramMessageImpl: async (config, text) => { sentMessage = { config, text }; },
  });

  assert.match(sentMessage.text, /⚠️ 초안 #77 이미지 생성 실패: codex down/);
});

test('generateManualImportImagesAndNotify swallows a Telegram send failure rather than throwing', async () => {
  await assert.doesNotReject(() => generateManualImportImagesAndNotify({ name: 'db' }, '/root', 77, {
    loadCodexConfigImpl: async () => ({}),
    loadJobPathsConfigImpl: async () => ({ jobDir: '/jobs' }),
    loadTelegramConfigImpl: async () => ({ botToken: 't', chatId: 'c' }),
    generateMainImageImpl: async () => {},
    generateDetailImageSetImpl: async () => {},
    sendTelegramMessageImpl: async () => { throw new Error('telegram down'); },
  }));
});
