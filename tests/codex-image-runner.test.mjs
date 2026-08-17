import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';

import { generateDetailImageSet, generateMainImage } from '../src/manual-ai/codex-image-runner.mjs';
import { getImageGenerationJobPaths } from '../src/product-job-folder.mjs';
import { getDetailPageSections } from '../src/manual-ai/detail-sections.mjs';

const image = (width, height) => sharp({ create: { width, height, channels: 3, background: '#c8d0d8' } }).jpeg().toBuffer();

function fakeDb() {
  return { async query(sql) { if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql.trim())) return { rows: [] }; throw new Error(`unexpected query in fake db: ${sql}`); } };
}

const AVAILABLE_DEPS = {
  checkCodexAvailabilityImpl: async () => ({ available: true, loggedIn: true, message: 'ok' }),
  checkCodexImageGenerationAvailableImpl: async () => ({ available: true, message: 'stable' }),
};

const MAIN_CONTEXT = {
  draft: { id: 27 },
  request: { id: 9, revision: 2, state: 'current', promptRendered: '대표이미지 프롬프트 렌더링본' },
  sourceMainImage: { url: '/generated-images/drafts/27/main.jpg' },
  referenceImages: [],
};

const DETAIL_CONTEXT = {
  draft: { id: 27 },
  request: { id: 10, revision: 1, state: 'current', promptRendered: '상세페이지 프롬프트 렌더링본' },
  sections: [{ index: 1, key: 'hero', label: 'Hero' }],
};

function mainDeps(overrides = {}) {
  return {
    ...AVAILABLE_DEPS,
    createImagePromptRequestImpl: async () => ({ created: false, request: MAIN_CONTEXT.request }),
    getManualMainImageWorkflowContextImpl: async () => MAIN_CONTEXT,
    buildPackageEntriesImpl: async () => [{ name: '01-source-main-image.jpg', data: Buffer.from('fake-reference-bytes') }],
    getNextManualMainImageVersionImpl: async () => 1,
    insertManualMainImageImpl: async (_db, input) => ({ ...input, id: 501, status: 'uploaded' }),
    ...overrides,
  };
}

function detailDeps(overrides = {}) {
  return {
    ...AVAILABLE_DEPS,
    createImagePromptRequestImpl: async () => ({ created: false, request: DETAIL_CONTEXT.request }),
    getManualDetailWorkflowContextImpl: async () => DETAIL_CONTEXT,
    buildDetailPagePackageImpl: async () => ({
      entries: [
        { name: 'main-image.jpg', data: Buffer.from('fake-main') },
        { name: 'reference-01.jpg', data: Buffer.from('fake-ref-1') },
      ],
    }),
    reserveDetailSetVersionImpl: async () => 1,
    finalizeDetailSetDirectoryImpl: async ({ stagingDir }) => stagingDir,
    removeDetailSetDirectoryImpl: async () => {},
    insertDetailSetImpl: async (_client, input) => ({ ...input, id: 601, status: 'uploaded', setVersion: input.setVersion, imageCount: input.images.length }),
    ...overrides,
  };
}

async function withTempDirs(fn) {
  const rootDir = await mkdtemp(join(tmpdir(), 'automoney-root-'));
  const jobDir = await mkdtemp(join(tmpdir(), 'automoney-jobs-'));
  try {
    await fn({ rootDir, jobDir });
  } finally {
    await rm(rootDir, { recursive: true, force: true });
    await rm(jobDir, { recursive: true, force: true });
  }
}

test('generateMainImage reports CODEX_NOT_AVAILABLE without calling anything else when Codex itself is not installed', async () => {
  await withTempDirs(async ({ rootDir, jobDir }) => {
    let contextCalled = false;
    await assert.rejects(
      () => generateMainImage(fakeDb(), rootDir, jobDir, 27, mainDeps({
        checkCodexAvailabilityImpl: async () => ({ available: false, message: 'not installed' }),
        getManualMainImageWorkflowContextImpl: async () => { contextCalled = true; return MAIN_CONTEXT; },
      })),
      (error) => error.code === 'CODEX_NOT_AVAILABLE',
    );
    assert.equal(contextCalled, false);
  });
});

test('generateMainImage reports CODEX_LOGIN_REQUIRED distinctly from CODEX_NOT_AVAILABLE', async () => {
  await withTempDirs(async ({ rootDir, jobDir }) => {
    await assert.rejects(
      () => generateMainImage(fakeDb(), rootDir, jobDir, 27, mainDeps({
        checkCodexAvailabilityImpl: async () => ({ available: true, loggedIn: false, message: 'not logged in' }),
      })),
      (error) => error.code === 'CODEX_LOGIN_REQUIRED',
    );
  });
});

test('generateMainImage reports IMAGE_GENERATION_UNAVAILABLE when the codex CLI does not expose the feature', async () => {
  await withTempDirs(async ({ rootDir, jobDir }) => {
    await assert.rejects(
      () => generateMainImage(fakeDb(), rootDir, jobDir, 27, mainDeps({
        checkCodexImageGenerationAvailableImpl: async () => ({ available: false, message: 'image_generation stable false' }),
      })),
      (error) => error.code === 'IMAGE_GENERATION_UNAVAILABLE',
    );
  });
});

test('generateMainImage reports MAIN_IMAGE_PROMPT_MISSING when there is no current prompt request', async () => {
  await withTempDirs(async ({ rootDir, jobDir }) => {
    await assert.rejects(
      () => generateMainImage(fakeDb(), rootDir, jobDir, 27, mainDeps({
        getManualMainImageWorkflowContextImpl: async () => ({ ...MAIN_CONTEXT, request: null }),
      })),
      (error) => error.code === 'MAIN_IMAGE_PROMPT_MISSING',
    );
  });
});

test('generateMainImage reports CODEX_TIMEOUT when the Codex process never finishes in time', async () => {
  await withTempDirs(async ({ rootDir, jobDir }) => {
    await assert.rejects(
      () => generateMainImage(fakeDb(), rootDir, jobDir, 27, mainDeps({
        runCodexImagePromptImpl: async () => ({ success: false, timedOut: true, log: 'still running' }),
      })),
      (error) => error.code === 'CODEX_TIMEOUT',
    );
  });
});

test('generateMainImage reports NO_GENERATED_FILES when Codex claims success but generated-main/ stays empty', async () => {
  await withTempDirs(async ({ rootDir, jobDir }) => {
    await assert.rejects(
      () => generateMainImage(fakeDb(), rootDir, jobDir, 27, mainDeps({
        runCodexImagePromptImpl: async () => ({ success: true, log: 'done, but forgot to save' }),
      })),
      (error) => error.code === 'NO_GENERATED_FILES',
    );
  });
});

test('generateMainImage reports MAIN_IMAGE_VALIDATION_FAILED when the generated file is not square', async () => {
  await withTempDirs(async ({ rootDir, jobDir }) => {
    const paths = getImageGenerationJobPaths(jobDir, 27);
    await assert.rejects(
      () => generateMainImage(fakeDb(), rootDir, jobDir, 27, mainDeps({
        runCodexImagePromptImpl: async () => {
          await mkdir(paths.generatedMainDir, { recursive: true });
          await writeFile(join(paths.generatedMainDir, 'main.jpg'), await image(1200, 800));
          return { success: true, log: 'ok' };
        },
      })),
      (error) => error.code === 'MAIN_IMAGE_VALIDATION_FAILED',
    );
  });
});

test('generateMainImage succeeds end to end: validates, derives a Coupang JPEG, persists files, and inserts an uploaded (not approved) row', async () => {
  await withTempDirs(async ({ rootDir, jobDir }) => {
    const paths = getImageGenerationJobPaths(jobDir, 27);
    let insertedInput = null;
    const outcome = await generateMainImage(fakeDb(), rootDir, jobDir, 27, mainDeps({
      runCodexImagePromptImpl: async () => {
        await mkdir(paths.generatedMainDir, { recursive: true });
        await writeFile(join(paths.generatedMainDir, 'main.jpg'), await image(1200, 1200));
        return { success: true, log: 'generated 1 image' };
      },
      insertManualMainImageImpl: async (_db, input) => { insertedInput = input; return { ...input, id: 501, status: 'uploaded' }; },
    }));
    assert.equal(outcome.result.status, 'uploaded');
    assert.equal(outcome.generatedFileCount, 1);
    assert.equal(insertedInput.providerCode, 'custom');
    assert.match(insertedInput.providerDisplayName, /Codex/);
    assert.equal(insertedInput.promptRequestId, 9);
    assert.equal(insertedInput.promptRevision, 2);
    assert.equal(insertedInput.originalWidth, 1200);
    assert.equal(insertedInput.originalHeight, 1200);
    assert.ok(insertedInput.coupangStoredUrl.includes('/generated-ai-images/drafts/27/main/manual/'));
  });
});

// generated-image-qa.mjs's retry loop passes the previous attempt's QA
// issues here so a regeneration actually targets what was wrong last time.
test('generateMainImage appends extraInstructions to the Codex prompt when supplied', async () => {
  await withTempDirs(async ({ rootDir, jobDir }) => {
    const paths = getImageGenerationJobPaths(jobDir, 27);
    let capturedPrompt = null;
    await generateMainImage(fakeDb(), rootDir, jobDir, 27, mainDeps({
      extraInstructions: '이전 시도에 색상이 실제 옵션과 다르게 나왔음 -- 반드시 블랙으로 만들 것',
      runCodexImagePromptImpl: async (args) => {
        capturedPrompt = args.prompt;
        await mkdir(paths.generatedMainDir, { recursive: true });
        await writeFile(join(paths.generatedMainDir, 'main.jpg'), await image(1200, 1200));
        return { success: true, log: 'ok' };
      },
    }));
    assert.match(capturedPrompt, /이전 시도에서 발견된 문제/);
    assert.match(capturedPrompt, /반드시 블랙으로 만들 것/);
  });
});

test('generateMainImage omits the extra-issues block entirely when extraInstructions is not supplied', async () => {
  await withTempDirs(async ({ rootDir, jobDir }) => {
    const paths = getImageGenerationJobPaths(jobDir, 27);
    let capturedPrompt = null;
    await generateMainImage(fakeDb(), rootDir, jobDir, 27, mainDeps({
      runCodexImagePromptImpl: async (args) => {
        capturedPrompt = args.prompt;
        await mkdir(paths.generatedMainDir, { recursive: true });
        await writeFile(join(paths.generatedMainDir, 'main.jpg'), await image(1200, 1200));
        return { success: true, log: 'ok' };
      },
    }));
    assert.doesNotMatch(capturedPrompt, /이전 시도에서 발견된 문제/);
  });
});

// Real verification against draft 27 found that asking Codex to generate all
// 10 detail images in one exec session reliably failed (Windows sandbox
// errors reading an attached image plus malformed image-tool calls after a
// long multi-image conversation -- confirmed via a real 20-minute run that
// produced 0 files). generateDetailImageSet now issues one short Codex call
// per section instead, so these mocks simulate that: one file written per
// invocation, matching the real per-section call contract. Section identity
// is read from the prompt text itself (buildDetailSectionPrompt always
// embeds "섹션 키: <key>"), the same way generateDetailImageSet's own
// "already exists" check works off real section-key filenames -- so a
// writer built this way behaves the same whether it's called once (a fresh
// pass) or again as a retry of just the one section still missing.
function sequentialSectionWriter(paths, { transientFailKeys = [], persistentFailKeys = [], malformedKey = null } = {}) {
  const attemptsByKey = new Map();
  return async (args) => {
    const key = args.prompt.match(/섹션 키: ([^)]+)\)/)[1];
    const attempt = (attemptsByKey.get(key) || 0) + 1;
    attemptsByKey.set(key, attempt);
    if (persistentFailKeys.includes(key)) return { success: true, log: `section ${key} silently produced nothing (attempt ${attempt})` };
    if (transientFailKeys.includes(key) && attempt === 1) return { success: true, log: `section ${key} silently produced nothing (attempt ${attempt})` };
    const section = getDetailPageSections().find((s) => s.key === key);
    await mkdir(paths.generatedDetailDir, { recursive: true });
    const buffer = key === malformedKey ? await image(1200, 1200) : await image(1000, 1400);
    await writeFile(join(paths.generatedDetailDir, `${String(section.index).padStart(2, '0')}-${section.key}.jpg`), buffer);
    return { success: true, log: `section ${key} ok (attempt ${attempt})` };
  };
}

test('generateDetailImageSet calls Codex once per section (10 short calls), not one mega-call for all 10', async () => {
  await withTempDirs(async ({ rootDir, jobDir }) => {
    const paths = getImageGenerationJobPaths(jobDir, 27);
    let callCount = 0;
    const writer = sequentialSectionWriter(paths);
    await generateDetailImageSet(fakeDb(), rootDir, jobDir, 27, detailDeps({
      runCodexImagePromptImpl: async (...args) => { callCount += 1; return writer(...args); },
    }));
    assert.equal(callCount, 10);
  });
});

test('generateDetailImageSet appends extraInstructions to every section prompt when supplied', async () => {
  await withTempDirs(async ({ rootDir, jobDir }) => {
    const paths = getImageGenerationJobPaths(jobDir, 27);
    const writer = sequentialSectionWriter(paths);
    const capturedPrompts = [];
    await generateDetailImageSet(fakeDb(), rootDir, jobDir, 27, detailDeps({
      extraInstructions: '이전 시도에서 "7.5m" 문구가 배경 소품에 잘못 나옴 -- 다른 사이즈 표기가 들어가지 않게 할 것',
      runCodexImagePromptImpl: async (args) => { capturedPrompts.push(args.prompt); return writer(args); },
    }));
    assert.equal(capturedPrompts.length, 10);
    assert.ok(capturedPrompts.every((prompt) => prompt.includes('이전 시도에서 발견된 문제')));
    assert.ok(capturedPrompts.every((prompt) => prompt.includes('7.5m" 문구가 배경 소품에 잘못 나옴')));
  });
});

test('generateDetailImageSet resumes after a partial run instead of re-generating sections that already succeeded on disk', async () => {
  await withTempDirs(async ({ rootDir, jobDir }) => {
    const paths = getImageGenerationJobPaths(jobDir, 27);
    const { getDetailPageSections } = await import('../src/manual-ai/detail-sections.mjs');
    const sections = getDetailPageSections();

    // Simulates the real interruption this test guards against: a first run
    // that only got through the first 5 sections (real section-key
    // filenames, matching what generateDetailImageSet itself writes) before
    // being cut off, with nothing recorded in the DB yet.
    await mkdir(paths.generatedDetailDir, { recursive: true });
    for (const section of sections.slice(0, 5)) {
      await writeFile(join(paths.generatedDetailDir, `${String(section.index).padStart(2, '0')}-${section.key}.png`), await image(1000, 1400));
    }

    const calledForSections = [];
    let nextIndex = 6;
    const outcome = await generateDetailImageSet(fakeDb(), rootDir, jobDir, 27, detailDeps({
      runCodexImagePromptImpl: async () => {
        const section = sections[nextIndex - 1];
        calledForSections.push(section.key);
        await writeFile(join(paths.generatedDetailDir, `${String(section.index).padStart(2, '0')}-${section.key}.png`), await image(1000, 1400));
        nextIndex += 1;
        return { success: true, log: `resumed section ${section.key}` };
      },
    }));

    assert.deepEqual(calledForSections, sections.slice(5).map((s) => s.key), 'only the 5 missing sections should trigger a new Codex call');
    assert.equal(outcome.generatedFileCount, 10);
  });
});

// Confirmed live 2026-08-16 on a real draft: 9 of 10 sections succeeded and
// exactly one Codex call (for the "review/rating" section) hit its own
// per-section timeout and produced no file -- a transient failure of that
// one call, not a content problem (every other section using the same
// prompt/instructions succeeded fine). generateDetailImageSet now retries
// only the still-missing section(s) for up to DETAIL_SECTION_MAX_PASSES
// passes before giving up, so this exact incident now recovers instead of
// aborting generated-image-qa.mjs's whole regenerate-and-re-review attempt.
test('generateDetailImageSet retries only the section that failed transiently, and recovers without regenerating the other 9', async () => {
  await withTempDirs(async ({ rootDir, jobDir }) => {
    const paths = getImageGenerationJobPaths(jobDir, 27);
    let callCount = 0;
    const writer = sequentialSectionWriter(paths, { transientFailKeys: ['review'] });
    const outcome = await generateDetailImageSet(fakeDb(), rootDir, jobDir, 27, detailDeps({
      runCodexImagePromptImpl: async (args) => { callCount += 1; return writer(args); },
    }));
    assert.equal(outcome.generatedFileCount, 10);
    assert.equal(callCount, 11, '10 sections on the first pass + 1 retry for the section that failed transiently');
  });
});

test('generateDetailImageSet reports DETAIL_IMAGE_COUNT_INSUFFICIENT when one section keeps failing across every retry pass', async () => {
  await withTempDirs(async ({ rootDir, jobDir }) => {
    const paths = getImageGenerationJobPaths(jobDir, 27);
    let callCount = 0;
    const writer = sequentialSectionWriter(paths, { persistentFailKeys: ['point_01'] });
    await assert.rejects(
      () => generateDetailImageSet(fakeDb(), rootDir, jobDir, 27, detailDeps({
        runCodexImagePromptImpl: async (args) => { callCount += 1; return writer(args); },
      })),
      (error) => error.code === 'DETAIL_IMAGE_COUNT_INSUFFICIENT' && error.actualCount === 9 && error.expectedCount === 10,
    );
    assert.equal(callCount, 12, '10 sections on the first pass + 2 more retry passes for the one section that never succeeds');
  });
});

test('generateDetailImageSet reports DETAIL_IMAGE_VALIDATION_FAILED with the offending index when one section is square instead of portrait', async () => {
  await withTempDirs(async ({ rootDir, jobDir }) => {
    const paths = getImageGenerationJobPaths(jobDir, 27);
    await assert.rejects(
      () => generateDetailImageSet(fakeDb(), rootDir, jobDir, 27, detailDeps({
        runCodexImagePromptImpl: sequentialSectionWriter(paths, { malformedKey: 'core_values' }),
      })),
      (error) => error.code === 'DETAIL_IMAGE_VALIDATION_FAILED' && error.imageIndex === 3,
    );
  });
});

test('generateDetailImageSet succeeds end to end: validates all 10, reserves a version, and inserts an uploaded (not approved) set', async () => {
  await withTempDirs(async ({ rootDir, jobDir }) => {
    const paths = getImageGenerationJobPaths(jobDir, 27);
    let insertedInput = null;
    let finalizeArgs = null;
    const outcome = await generateDetailImageSet(fakeDb(), rootDir, jobDir, 27, detailDeps({
      runCodexImagePromptImpl: sequentialSectionWriter(paths),
      finalizeDetailSetDirectoryImpl: async (args) => { finalizeArgs = args; return args.stagingDir; },
      insertDetailSetImpl: async (_client, input) => { insertedInput = input; return { ...input, id: 601, status: 'uploaded', imageCount: input.images.length }; },
    }));
    assert.equal(outcome.result.status, 'uploaded');
    assert.equal(outcome.generatedFileCount, 10);
    assert.equal(insertedInput.images.length, 10);
    assert.deepEqual(insertedInput.images.map((i) => i.imageIndex), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(insertedInput.providerCode, 'custom');
    assert.equal(insertedInput.promptRequestId, 10);
    assert.equal(finalizeArgs.setVersion, 1);
    assert.equal(finalizeArgs.revision, 1);
  });
});

test('generateDetailImageSet never touches product_options or any Coupang API -- it only calls the injected manual-workflow store functions', async () => {
  await withTempDirs(async ({ rootDir, jobDir }) => {
    const paths = getImageGenerationJobPaths(jobDir, 27);
    const calls = [];
    await generateDetailImageSet(fakeDb(), rootDir, jobDir, 27, detailDeps({
      runCodexImagePromptImpl: sequentialSectionWriter(paths),
      insertDetailSetImpl: async (_client, input) => { calls.push('insertDetailSet'); return { ...input, id: 601, status: 'uploaded', imageCount: input.images.length }; },
    }));
    assert.deepEqual(calls, ['insertDetailSet']);
  });
});
