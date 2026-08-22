import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveNaverTrendTarget } from '../src/naver-trend-keyword-resolver.mjs';

test('resolveNaverTrendTarget returns {keyword, categoryCode} parsed from the Codex analysis result', async () => {
  let receivedArgs = null;
  const result = await resolveNaverTrendTarget(
    { normalized: { name: '버클 슬림 벨트 원피스 데일리 코디 포인트 패션 허리띠 여성 골드 체인 체인벨트 여자' } },
    {
      config: { executable: 'codex' },
      rootDir: '/custom/root',
      runCodexAnalysisImpl: async (args) => {
        receivedArgs = args;
        return { success: true, analysis: { keyword: '여성 벨트', categoryCode: '50000000' } };
      },
    },
  );

  assert.deepEqual(result, { keyword: '여성 벨트', categoryCode: '50000000' });
  assert.equal(receivedArgs.config.model, 'gpt-5.6-luna');
  assert.equal(receivedArgs.config.reasoningEffort, 'xhigh');
  assert.equal(receivedArgs.schemaPath, '/custom/root/schemas/naver-trend-target.schema.json');
  assert.match(receivedArgs.prompt, /버클 슬림 벨트/);
});

test('resolveNaverTrendTarget returns null without calling Codex when the candidate has no normalized name', async () => {
  const result = await resolveNaverTrendTarget({}, {
    config: { executable: 'codex' },
    runCodexAnalysisImpl: async () => { throw new Error('must not be called'); },
  });
  assert.equal(result, null);
});

test('resolveNaverTrendTarget returns null when the Codex call fails', async () => {
  const result = await resolveNaverTrendTarget(
    { normalized: { name: 'A' } },
    { config: {}, runCodexAnalysisImpl: async () => ({ success: false, log: 'codex not logged in' }) },
  );
  assert.equal(result, null);
});

test('resolveNaverTrendTarget returns null when Codex throws', async () => {
  const result = await resolveNaverTrendTarget(
    { normalized: { name: 'A' } },
    { config: {}, runCodexAnalysisImpl: async () => { throw new Error('spawn failed'); } },
  );
  assert.equal(result, null);
});

test('resolveNaverTrendTarget returns null when the analysis is missing keyword or categoryCode', async () => {
  const result = await resolveNaverTrendTarget(
    { normalized: { name: 'A' } },
    { config: {}, runCodexAnalysisImpl: async () => ({ success: true, analysis: { keyword: '', categoryCode: '50000000' } }) },
  );
  assert.equal(result, null);
});
