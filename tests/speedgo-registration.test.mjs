import assert from 'node:assert/strict';
import { basename } from 'node:path';
import test from 'node:test';

import { runSpeedgoNaverRegistration } from '../src/speedgo-registration.mjs';

const draft = {
  supplierProductNo: '49168396',
  displayProductName: '무타공 정리 선반',
  salePrice: 19800,
};

const input = {
  draftId: 501,
  supplierProductNo: '49168396',
  productName: '무타공 정리 선반',
  salePrice: 19800,
  requestHash: 'hash-501',
};

function makeHarness({
  confirm = true,
  reservationAction = 'reserved',
  submitIds = { originProductNo: '777', channelProductNo: '888' },
  recoverIds = { originProductNo: '777', channelProductNo: '888' },
  liveProduct = {
    originProduct: { name: '무타공 정리 선반' },
    smartstoreChannelProduct: { channelProductNo: '888' },
  },
  completion = { originProductNo: '777', channelProductNo: '888', linkedVia: 'speedgo_automation' },
  stageError,
  screenshotError,
  closeError,
  failureJournalError,
  terminalJournalError,
  exposeBrowserPage = true,
  openReturnsPage = false,
} = {}) {
  const calls = [];
  const journalStages = [];
  const screenshots = [];
  const failures = [];
  const page = { url: () => 'https://speedgo.example/form' };

  const maybeFail = (stage) => {
    if (stageError?.stage === stage) throw stageError.error;
  };
  const browser = {
    async open() {
      calls.push('open');
      maybeFail('open');
      return openReturnsPage ? page : undefined;
    },
    async assertAuthenticated() { calls.push('auth'); maybeFail('auth'); },
    async findSupplierProduct(value) { assert.equal(value, input); calls.push('find'); maybeFail('find'); },
    async openSpeedgoTransfer() { calls.push('transfer'); maybeFail('transfer'); },
    async selectNaverMarket() { calls.push('naver'); maybeFail('naver'); },
    async fillNaverForm(value) { assert.equal(value, input); calls.push('fill'); maybeFail('fill'); },
    async preview() { calls.push('preview'); maybeFail('preview'); return { ready: true }; },
    async submitAndResolveIds() { calls.push('submit'); maybeFail('submit'); return submitIds; },
    async recoverRegistration(value) { assert.equal(value, input); calls.push('recover'); maybeFail('recover'); return recoverIds; },
    async screenshot(path) {
      const name = basename(path);
      calls.push(`screenshot:${name}`);
      screenshots.push(name);
      if (screenshotError?.(name)) throw new Error('screenshot failed token=shot-secret');
      return path;
    },
    async close() {
      calls.push('close');
      if (closeError) throw closeError;
    },
  };
  if (exposeBrowserPage) browser.page = page;

  const journal = {
    artifactDir: 'C:/artifacts/task-6',
    async recordStep(stage, details) {
      calls.push(`journal:${stage}`);
      if (stage === 'terminal' && terminalJournalError?.method === 'recordStep') {
        throw terminalJournalError.error;
      }
      journalStages.push({ stage, details });
    },
    async setScreenshot(stage, path) {
      calls.push(`attach:${stage}`);
      if (stage === 'terminal' && terminalJournalError?.method === 'setScreenshot') {
        throw terminalJournalError.error;
      }
      assert.equal(basename(path), screenshots.at(-1));
    },
    async recordFailure(failure) {
      calls.push('journal:failure');
      failures.push(failure);
      if (failureJournalError) throw failureJournalError;
    },
    async finish(result) {
      calls.push('journal:finish');
      return { result };
    },
  };

  const naverConfig = { clientId: 'client-id', clientSecret: 'config-secret' };
  const client = {
    async getProduct(originProductNo) {
      calls.push('verify');
      assert.equal(originProductNo, '777');
      if (stageError?.stage === 'verify') throw stageError.error;
      return liveProduct;
    },
  };

  const deps = {
    confirm,
    browserImpl: browser,
    naverConfig,
    clientImpl: client,
    exportDraftImpl: async (dbArg, draftId, channel) => {
      assert.equal(draftId, 501);
      assert.equal(channel, 'naver');
      calls.push('draft');
      return draft;
    },
    buildInputImpl: (value, options) => {
      assert.equal(value, draft);
      assert.deepEqual(options, { draftId: 501 });
      calls.push('input');
      return input;
    },
    createJournalImpl: async ({ draftId, artifactDir }) => {
      assert.equal(draftId, 501);
      assert.equal(artifactDir, undefined);
      calls.push('createJournal');
      return journal;
    },
    reserveImpl: async (dbArg, draftId, value) => {
      calls.push('reserve');
      assert.equal(draftId, 501);
      assert.deepEqual(value, { requestHash: 'hash-501' });
      if (stageError?.stage === 'reserve') throw stageError.error;
      return {
        action: reservationAction,
        registration: reservationAction === 'already_linked'
          ? { originProductNo: '777', channelProductNo: '888', linkedVia: 'direct_api' }
          : { requestHash: 'hash-501', linkedVia: 'speedgo_automation' },
      };
    },
    completeImpl: async (dbArg, draftId, value) => {
      calls.push('complete');
      assert.equal(draftId, 501);
      assert.deepEqual(value, {
        requestHash: 'hash-501',
        originProductNo: '777',
        channelProductNo: '888',
      });
      if (stageError?.stage === 'complete') throw stageError.error;
      return completion;
    },
    postProcessImpl: async (dbArg, rootDir, draftId, options) => {
      calls.push('postProcess');
      if (stageError?.stage === 'postProcess') throw stageError.error;
      assert.equal(rootDir, 'C:/repo');
      assert.equal(draftId, 501);
      assert.equal(options.originProductNo, '777');
      assert.equal(options.channelProductNo, '888');
      assert.equal(options.salePrice, 19800);
      assert.equal(options.clientImpl, client);
      assert.equal(options.naverConfig, naverConfig);
      assert.equal(options.verifiedProduct, liveProduct);
      return { verified: true, salePrice: 19800 };
    },
  };

  return { calls, journalStages, screenshots, failures, deps, browser, client, liveProduct };
}

function count(calls, value) {
  return calls.filter((entry) => entry === value).length;
}

test('dry-run follows the exact browser and screenshot sequence with zero mutating or API side effects', async () => {
  const harness = makeHarness({ confirm: false });

  const result = await runSpeedgoNaverRegistration({}, 'C:/repo', 501, harness.deps);

  assert.equal(result.dryRun, true);
  assert.deepEqual(
    harness.calls.filter((value) => ['open', 'auth', 'find', 'transfer', 'naver', 'fill', 'preview'].includes(value)),
    ['open', 'auth', 'find', 'transfer', 'naver', 'fill', 'preview'],
  );
  assert.deepEqual(harness.screenshots, [
    '01-open.png',
    '02-session_verified.png',
    '03-supplier_product_found.png',
    '04-speedgo_transfer_opened.png',
    '05-naver_form_selected.png',
    '06-fields_filled.png',
    '07-preview.png',
    '08-terminal.png',
  ]);
  for (const forbidden of ['reserve', 'submit', 'recover', 'complete', 'verify', 'postProcess']) {
    assert.equal(count(harness.calls, forbidden), 0, `${forbidden} must not run in dry-run`);
  }
  assert.equal(count(harness.calls, 'close'), 1);
});

test('a truthy non-boolean confirm value remains a dry-run with zero reserve or submit side effects', async () => {
  const harness = makeHarness({ confirm: 'false' });

  const result = await runSpeedgoNaverRegistration({}, 'C:/repo', 501, harness.deps);

  assert.equal(result.dryRun, true);
  assert.equal(count(harness.calls, 'preview'), 1);
  assert.equal(count(harness.calls, 'reserve'), 0);
  assert.equal(count(harness.calls, 'submit'), 0);
});

test('a new confirmed reservation occurs immediately before exactly one submit, then verifies, completes, and post-processes', async () => {
  const harness = makeHarness();

  const result = await runSpeedgoNaverRegistration({}, 'C:/repo', 501, harness.deps);

  assert.equal(result.originProductNo, '777');
  assert.equal(result.channelProductNo, '888');
  assert.equal(harness.calls.indexOf('submit'), harness.calls.indexOf('reserve') + 1);
  assert.equal(count(harness.calls, 'submit'), 1);
  assert.ok(harness.calls.indexOf('submit') < harness.calls.indexOf('verify'));
  assert.ok(harness.calls.indexOf('verify') < harness.calls.indexOf('complete'));
  assert.ok(harness.calls.indexOf('complete') < harness.calls.indexOf('postProcess'));
  assert.equal(count(harness.calls, 'close'), 1);
});

test('recovery resolves the existing reservation without submitting and completes it once', async () => {
  const harness = makeHarness({ reservationAction: 'recover' });

  await runSpeedgoNaverRegistration({}, 'C:/repo', 501, harness.deps);

  assert.equal(count(harness.calls, 'submit'), 0);
  assert.equal(count(harness.calls, 'recover'), 1);
  assert.equal(count(harness.calls, 'complete'), 1);
  assert.equal(count(harness.calls, 'postProcess'), 1);
});

test('an already-linked registration never submits, recovers, or completes again', async () => {
  const harness = makeHarness({ reservationAction: 'already_linked' });

  const result = await runSpeedgoNaverRegistration({}, 'C:/repo', 501, harness.deps);

  assert.equal(result.linkedVia, 'direct_api');
  assert.equal(count(harness.calls, 'submit'), 0);
  assert.equal(count(harness.calls, 'recover'), 0);
  assert.equal(count(harness.calls, 'complete'), 0);
  assert.equal(count(harness.calls, 'verify'), 1);
  assert.equal(count(harness.calls, 'postProcess'), 1);
});

test('a reservation conflict fails with its stable code and never submits', async () => {
  const harness = makeHarness({ reservationAction: 'conflict' });

  await assert.rejects(
    runSpeedgoNaverRegistration({}, 'C:/repo', 501, harness.deps),
    (error) => error.code === 'NAVER_REGISTRATION_ALREADY_LINKED',
  );

  assert.equal(count(harness.calls, 'submit'), 0);
  assert.equal(count(harness.calls, 'postProcess'), 0);
  assert.equal(count(harness.calls, 'close'), 1);
});

test('an origin-only browser result derives channelProductNo from the verified live response without resubmitting', async () => {
  const harness = makeHarness({ submitIds: { originProductNo: '777' } });

  const result = await runSpeedgoNaverRegistration({}, 'C:/repo', 501, harness.deps);

  assert.equal(result.channelProductNo, '888');
  assert.equal(count(harness.calls, 'submit'), 1);
  assert.equal(count(harness.calls, 'complete'), 1);
});

test('a missing origin result never verifies, completes, or post-processes', async () => {
  const harness = makeHarness({ submitIds: { channelProductNo: '888' } });

  await assert.rejects(
    runSpeedgoNaverRegistration({}, 'C:/repo', 501, harness.deps),
    (error) => error.code === 'UNRESOLVED_EXTERNAL_RESULT',
  );

  assert.equal(count(harness.calls, 'submit'), 1);
  assert.equal(count(harness.calls, 'verify'), 0);
  assert.equal(count(harness.calls, 'complete'), 0);
  assert.equal(count(harness.calls, 'postProcess'), 0);
});

test('a missing channel after live verification fails safely without completion, post-processing, or a second submit', async () => {
  const harness = makeHarness({
    submitIds: { originProductNo: '777' },
    liveProduct: { originProduct: { name: '무타공 정리 선반' } },
  });

  await assert.rejects(
    runSpeedgoNaverRegistration({}, 'C:/repo', 501, harness.deps),
    (error) => error.code === 'PERSISTENCE_FAILED',
  );

  assert.equal(count(harness.calls, 'submit'), 1);
  assert.equal(count(harness.calls, 'verify'), 1);
  assert.equal(count(harness.calls, 'complete'), 0);
  assert.equal(count(harness.calls, 'postProcess'), 0);
});

test('a null guarded completion blocks post-processing', async () => {
  const harness = makeHarness({ completion: null });

  await assert.rejects(
    runSpeedgoNaverRegistration({}, 'C:/repo', 501, harness.deps),
    (error) => error.code === 'PERSISTENCE_FAILED',
  );

  assert.equal(count(harness.calls, 'complete'), 1);
  assert.equal(count(harness.calls, 'postProcess'), 0);
});

test('post-processing receives verified identifiers, sale price, client, config, draft, and root dependencies', async () => {
  const harness = makeHarness();
  await runSpeedgoNaverRegistration({}, 'C:/repo', 501, harness.deps);
  assert.equal(count(harness.calls, 'postProcess'), 1);
});

test('known browser errors are preserved, journaled with redaction, and followed by close', async () => {
  const primary = Object.assign(
    new Error('field failed password=hunter2 Authorization: Bearer token-1'),
    { code: 'SPEEDGO_FORM_VALIDATION_FAILED', selectorName: 'price', details: { token: 'token-2' } },
  );
  const harness = makeHarness({ stageError: { stage: 'fill', error: primary } });

  await assert.rejects(
    runSpeedgoNaverRegistration({}, 'C:/repo', 501, harness.deps),
    (error) => error === primary,
  );

  assert.equal(count(harness.calls, 'close'), 1);
  assert.equal(harness.failures.length, 1);
  const saved = JSON.stringify(harness.failures[0]);
  assert.doesNotMatch(saved, /hunter2|token-1|token-2/);
  assert.match(saved, /SPEEDGO_FORM_VALIDATION_FAILED/);
});

test('an unclassified screenshot failure is coded and redacted while the browser still closes', async () => {
  const harness = makeHarness({ screenshotError: (name) => name === '03-supplier_product_found.png' });

  await assert.rejects(
    runSpeedgoNaverRegistration({}, 'C:/repo', 501, harness.deps),
    (error) => error.code === 'SPEEDGO_SUBMIT_FAILED',
  );

  assert.equal(count(harness.calls, 'close'), 1);
  assert.doesNotMatch(JSON.stringify(harness.failures), /shot-secret/);
});

test('terminal screenshot and journal failures are classified by their failing boundary', async (t) => {
  await t.test('terminal screenshot', async () => {
    const harness = makeHarness({ screenshotError: (name) => name.endsWith('-terminal.png') });
    await assert.rejects(
      runSpeedgoNaverRegistration({}, 'C:/repo', 501, harness.deps),
      (error) => error.code === 'SPEEDGO_SUBMIT_FAILED',
    );
    assert.equal(count(harness.calls, 'close'), 1);
  });

  for (const method of ['recordStep', 'setScreenshot']) {
    await t.test(`terminal journal ${method}`, async () => {
      const harness = makeHarness({
        terminalJournalError: { method, error: new Error('disk full') },
      });
      await assert.rejects(
        runSpeedgoNaverRegistration({}, 'C:/repo', 501, harness.deps),
        (error) => error.code === 'PERSISTENCE_FAILED',
      );
      assert.equal(count(harness.calls, 'close'), 1);
    });
  }
});

test('the page returned by open drives URLs and terminal screenshot when the adapter exposes no page property', async () => {
  const harness = makeHarness({ exposeBrowserPage: false, openReturnsPage: true, confirm: false });

  const result = await runSpeedgoNaverRegistration({}, 'C:/repo', 501, harness.deps);

  assert.equal(result.dryRun, true);
  assert.equal('page' in harness.browser, false);
  assert.equal(harness.screenshots.at(-1), '08-terminal.png');
  const browserStageUrls = harness.journalStages
    .filter(({ stage }) => stage !== 'draft_loaded')
    .map(({ details }) => details.url);
  assert.deepEqual(browserStageUrls, Array(8).fill('https://speedgo.example/form'));
});

test('a Naver read failure maps to NAVER_VERIFY_FAILED and blocks completion and post-processing', async () => {
  const harness = makeHarness({ stageError: { stage: 'verify', error: new Error('API unavailable') } });

  await assert.rejects(
    runSpeedgoNaverRegistration({}, 'C:/repo', 501, harness.deps),
    (error) => error.code === 'NAVER_VERIFY_FAILED',
  );

  assert.equal(count(harness.calls, 'complete'), 0);
  assert.equal(count(harness.calls, 'postProcess'), 0);
});

test('reservation and completion failures map to PERSISTENCE_FAILED', async (t) => {
  for (const stage of ['reserve', 'complete']) {
    await t.test(stage, async () => {
      const harness = makeHarness({ stageError: { stage, error: new Error(`${stage} unavailable`) } });
      await assert.rejects(
        runSpeedgoNaverRegistration({}, 'C:/repo', 501, harness.deps),
        (error) => error.code === 'PERSISTENCE_FAILED',
      );
      assert.equal(count(harness.calls, 'postProcess'), 0);
      assert.equal(count(harness.calls, 'close'), 1);
    });
  }
});

test('terminal screenshot and close failures never hide the primary error', async () => {
  const primary = Object.assign(new Error('session expired'), { code: 'SPEEDGO_SESSION_EXPIRED' });
  const harness = makeHarness({
    stageError: { stage: 'auth', error: primary },
    screenshotError: (name) => name.endsWith('-terminal.png'),
    closeError: new Error('close failed'),
  });

  await assert.rejects(
    runSpeedgoNaverRegistration({}, 'C:/repo', 501, harness.deps),
    (error) => error === primary,
  );
  assert.equal(count(harness.calls, 'close'), 1);
});

test('failure-journal cleanup never hides the primary error', async () => {
  const primary = Object.assign(new Error('session expired'), { code: 'SPEEDGO_SESSION_EXPIRED' });
  const harness = makeHarness({
    stageError: { stage: 'auth', error: primary },
    failureJournalError: new Error('journal unavailable'),
  });

  await assert.rejects(
    runSpeedgoNaverRegistration({}, 'C:/repo', 501, harness.deps),
    (error) => error === primary,
  );
  assert.equal(count(harness.calls, 'close'), 1);
});
