# Codex GPT-5.6 Luna xhigh AI Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Automoney's automatic text, vision, analysis, review, and image-generation work through Codex CLI using `gpt-5.6-luna` with `xhigh` reasoning by default.

**Architecture:** Keep `src/codex-client.mjs` as the only Codex process boundary and make its shared config carry executable, timeout, model, and reasoning effort. Add an explicit local-session `codex` provider for task routing, then migrate Claude-backed keyword extraction and generated-image review to structured Codex JSON calls while preserving existing business state transitions and historical manual-upload metadata.

**Tech Stack:** Node.js ESM, Node test runner, PostgreSQL SQL migrations, Codex CLI, existing provider registry/admin server, JSON Schema, `sharp`/Playwright test infrastructure.

**Spec:** `docs/superpowers/specs/2026-08-24-codex-luna-xhigh-ai-migration-design.md`

## Global Constraints

- The automatic provider is explicitly named `codex` in routing and the admin UI.
- Codex authenticates through the operator's existing `codex login` session; no OpenAI API key is required for this path.
- `CODEX_MODEL` defaults to `gpt-5.6-luna` and `CODEX_REASONING_EFFORT` defaults to `xhigh`.
- Existing `anthropic` provider records and `anthropic_claude` manual-upload history values remain intact.
- Do not overwrite the existing modified files `src/admin-server.mjs` and `tests/approval-inbox-admin.test.mjs`.
- Automated tests must not make real paid AI calls.
- Use `apply_patch` for source edits and run focused tests after each implementation task.

### Task 1: Shared Codex model and reasoning configuration

**Files:**
- Modify: `src/config.mjs` in `loadCodexConfig`
- Modify: `src/codex-client.mjs` in `runCodexAnalysis` and `runCodexImagePrompt`
- Create: `tests/config-codex.test.mjs`
- Modify: `tests/codex-client.test.mjs`
- Modify: `.env.example` if the repository contains or adds a safe example file; never write secret values to `.env`

**Interfaces:**
- Produces `loadCodexConfig()` values `{ executable, sandbox, concurrency, timeoutMs, model, reasoningEffort, imageTimeoutMs }`.
- Produces CLI invocations that include `-m <config.model>` and `-c model_reasoning_effort=<config.reasoningEffort>` for both structured analysis and image generation whenever those values are present.

- [ ] **Step 1: Write failing config tests**

```js
test('loadCodexConfig defaults to the requested Luna xhigh target', async () => {
  const config = await loadCodexConfig(tempRootWithEnv({}));
  assert.equal(config.model, 'gpt-5.6-luna');
  assert.equal(config.reasoningEffort, 'xhigh');
});

test('loadCodexConfig accepts model and reasoning overrides', async () => {
  const config = await loadCodexConfig(tempRootWithEnv({
    CODEX_MODEL: 'gpt-5.6-terra', CODEX_REASONING_EFFORT: 'high',
  }));
  assert.equal(config.model, 'gpt-5.6-terra');
  assert.equal(config.reasoningEffort, 'high');
});
```

- [ ] **Step 2: Run the focused config test and verify it fails**

Run: `node --test tests/config-codex.test.mjs`

Expected: FAIL because `loadCodexConfig` does not currently return model or reasoning effort.

- [ ] **Step 3: Implement the shared defaults**

In `loadCodexConfig`, read `CODEX_MODEL` and `CODEX_REASONING_EFFORT` with the process/environment-file precedence already used for other Codex settings, defaulting to `gpt-5.6-luna` and `xhigh`.

- [ ] **Step 4: Add image-runner argument coverage and implement the arguments**

Capture the `spawnImpl` args in `tests/codex-client.test.mjs` and assert:

```js
assert.equal(args[args.indexOf('-m') + 1], 'gpt-5.6-luna');
assert.equal(args[args.indexOf('-c') + 1], 'model_reasoning_effort=xhigh');
```

Use the same conditional argument construction already present in `runCodexAnalysis` inside `runCodexImagePrompt`.

- [ ] **Step 5: Run the focused tests**

Run: `node --test tests/config-codex.test.mjs tests/codex-client.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit the isolated configuration change**

```bash
git add src/config.mjs src/codex-client.mjs tests/config-codex.test.mjs tests/codex-client.test.mjs .env.example
git commit -m "feat: configure Codex Luna xhigh defaults"
```

### Task 2: Structured Codex JSON provider adapter and schemas

**Files:**
- Create: `src/ai/providers/codex-provider.mjs`
- Modify: `src/ai/provider-registry.mjs`
- Modify: `src/codex-client.mjs` only if a small reusable structured-analysis helper is needed
- Create: `schemas/keyword-extraction.schema.json`
- Create: `schemas/generated-image-review.schema.json`
- Create: `tests/codex-provider.test.mjs`
- Modify: `tests/ai-provider-framework.test.mjs`

**Interfaces:**
- `codex-provider` exports provider metadata with `id: 'codex'` and capabilities `text_generation`, `vision_analysis`, `image_generation`, and `image_edit`.
- `analyzeText(config, { prompt, schemaPath, outputPath, cwd })` returns `{ model, rawText, analysis, usage: null }` or throws a provider error with `CODEX_CLI_UNAVAILABLE`, `CODEX_TIMEOUT`, `CODEX_ANALYSIS_ERROR`, or `CODEX_INVALID_OUTPUT`.
- `analyzeImages(config, { images, prompt, schemaPath, outputPath, cwd })` returns the same shape and passes local file paths to `runCodexAnalysis`.

- [ ] **Step 1: Write failing provider metadata and availability tests**

```js
test('codex provider exposes local-session text and vision capabilities', () => {
  assert.deepEqual(codex.capabilities, [
    'text_generation', 'vision_analysis', 'image_generation', 'image_edit',
  ]);
});

test('codex provider maps unavailable CLI to a reportable provider error', async () => {
  await assert.rejects(
    () => codex.analyzeImages({ executable: 'codex' }, {
      images: [{ filePath: '/tmp/a.jpg' }], prompt: 'review', schemaPath: 'schema.json',
    }, { checkAvailabilityImpl: async () => ({ available: false, loggedIn: false, message: 'not logged in' }) }),
    (error) => error.code === 'CODEX_CLI_UNAVAILABLE',
  );
});
```

- [ ] **Step 2: Run the focused provider test and verify it fails**

Run: `node --test tests/codex-provider.test.mjs`

Expected: FAIL because the provider module and registry entry do not exist.

- [ ] **Step 3: Add the two strict JSON schemas**

`schemas/keyword-extraction.schema.json` must require an object with `keywords`, an array of strings, and no additional properties. `schemas/generated-image-review.schema.json` must require `pass` as boolean and `issues` as an array of objects with `severity` (`high` or `low`) and `description`, with no additional properties.

- [ ] **Step 4: Implement the Codex provider and registry entry**

Reuse `checkCodexAvailability` and `runCodexAnalysis`; check availability before a paid call, use the configured model, and convert failed results into provider errors without changing the caller's business state.

- [ ] **Step 5: Run provider and framework tests**

Run: `node --test tests/codex-provider.test.mjs tests/ai-provider-framework.test.mjs`

Expected: PASS, including registry discovery of `codex`.

- [ ] **Step 6: Commit the structured Codex provider**

```bash
git add src/ai/providers/codex-provider.mjs src/ai/provider-registry.mjs src/codex-client.mjs schemas/keyword-extraction.schema.json schemas/generated-image-review.schema.json tests/codex-provider.test.mjs tests/ai-provider-framework.test.mjs
git commit -m "feat: add structured Codex provider"
```

### Task 3: Move Coupang keyword extraction from Claude to Codex

**Files:**
- Modify: `src/coupang-keyword-extractor.mjs`
- Modify: `scripts/scout-and-import-coupang-keywords.js`
- Modify: `src/config.mjs` only if the script needs a Codex config loader already absent from its imports
- Modify: `tests/coupang-keyword-extractor.test.mjs`
- Modify: `tests/auto-discovery-batch.test.mjs` if its unavailable-reason assertion is Claude-specific

**Interfaces:**
- `extractKeywordsFromTitles({ titles, config, runAnalysisImpl })` invokes structured Codex analysis with `schemas/keyword-extraction.schema.json` and returns the existing `string[]` result.
- The prompt and `dedupeKeywords`/`selectFinalKeywords` behavior remain unchanged.

- [ ] **Step 1: Change the test double contract to structured analysis and add a Claude-free assertion**

```js
const runAnalysisImpl = async () => ({
  success: true,
  analysis: { keywords: ['여성 벨트', '쿨스카프'] },
});
const result = await extractKeywordsFromTitles({ titles, config, runAnalysisImpl });
assert.deepEqual(result, ['여성 벨트', '쿨스카프']);
```

Add a test that rejects when `runAnalysisImpl` returns `{ success: false, log: 'quota' }` with `CODEX_ANALYSIS_ERROR`.

- [ ] **Step 2: Run the keyword tests and verify the migrated contract fails**

Run: `node --test tests/coupang-keyword-extractor.test.mjs`

Expected: FAIL because the implementation still calls `runClaudeTextPrompt` and expects `rawText`.

- [ ] **Step 3: Implement the Codex structured call**

Load the schema and output paths under a temporary directory, call `runCodexAnalysis`, read `analysis.keywords`, and remove the output file in `finally`. Preserve the existing prompt builder and deduplication functions.

- [ ] **Step 4: Switch the sourcing script to `loadCodexConfig`**

Replace `loadClaudeCliConfig` and `claudeCliConfig` with `loadCodexConfig` and `codexConfig`. Update unavailable/error handling in `auto-discovery-batch.mjs` to recognize `CODEX_CLI_UNAVAILABLE` while retaining old persisted Claude reason compatibility.

- [ ] **Step 5: Run focused keyword and batch tests**

Run: `node --test tests/coupang-keyword-extractor.test.mjs tests/auto-discovery-batch.test.mjs tests/coupang-keyword-sourcing.test.mjs`

Expected: PASS and no test invokes the Claude CLI client.

- [ ] **Step 6: Commit the keyword migration**

```bash
git add src/coupang-keyword-extractor.mjs scripts/scout-and-import-coupang-keywords.js src/auto-discovery-batch.mjs tests/coupang-keyword-extractor.test.mjs tests/auto-discovery-batch.test.mjs tests/coupang-keyword-sourcing.test.mjs
git commit -m "feat: extract Coupang keywords with Codex"
```

### Task 4: Move generated-image review from Claude vision to Codex

**Files:**
- Modify: `src/generated-image-qa.mjs`
- Modify: `tests/generated-image-qa.test.mjs`
- Modify: `src/image-qa-store.mjs` only if provider/error metadata needs a non-breaking field adjustment

**Interfaces:**
- `reviewGeneratedImages` keeps the existing return values, retry loop, approval call, and cleanup behavior.
- The review call uses the `codex` provider with `schemas/generated-image-review.schema.json`; `providerCode` stored for new reviews is `codex` and `model` is `gpt-5.6-luna` unless overridden by routing.

- [ ] **Step 1: Add failing tests for Codex review routing**

Inject `getProviderImpl` returning the Codex provider test double and assert:

```js
assert.equal(analyzeImagesArgs[0].model, 'gpt-5.6-luna');
assert.equal(insertedReview.providerCode, 'codex');
assert.equal(insertedReview.model, 'gpt-5.6-luna');
```

Add an unavailable-Codex test expecting `{ skipped: true, reason: 'CODEX_CLI_UNAVAILABLE' }` and a test ensuring no Claude availability loader is called.

- [ ] **Step 2: Run the generated-image QA tests and verify they fail**

Run: `node --test tests/generated-image-qa.test.mjs`

Expected: FAIL because the current implementation loads/checks Claude and passes `claudeCliConfig`.

- [ ] **Step 3: Implement Codex review wiring**

Load `loadCodexConfig`, check `checkCodexAvailability`, resolve the `codex` provider, and pass the generated local image paths plus the review schema to the provider. Keep competitor-thumbnail download cleanup, parse validation, retry regeneration, and approval exactly as they are.

- [ ] **Step 4: Preserve old persisted records and update scheduler compatibility**

Do not update existing `image_qa_reviews` rows. Ensure admin rendering accepts both old `anthropic` and new `codex` provider codes in history.

- [ ] **Step 5: Run focused QA and image workflow tests**

Run: `node --test tests/generated-image-qa.test.mjs tests/codex-image-runner.test.mjs tests/processing.test.mjs`

Expected: PASS with no automatic Claude call path.

- [ ] **Step 6: Commit the image-review migration**

```bash
git add src/generated-image-qa.mjs tests/generated-image-qa.test.mjs src/image-qa-store.mjs
git commit -m "feat: review generated images with Codex"
```

### Task 5: Add the Codex provider to routing, schema, migration, and admin settings

**Files:**
- Modify: `src/ai/provider-settings-store.mjs`
- Modify: `src/ai/task-routing.mjs`
- Modify: `src/admin-server.mjs` provider endpoint regex and AI settings renderer
- Modify: `schema.sql` provider and routing checks
- Create: `migrations/2026-08-24-codex-provider-routing.sql`
- Modify: `tests/provider-settings-store.test.mjs`
- Modify: `tests/verify-ai-provider-settings` fixtures or related admin tests if needed

**Interfaces:**
- `SUPPORTED_PROVIDER_CODES` includes `codex`.
- `resolveProviderCredential(db, 'codex', options)` returns `{ apiKey: null, enabled, defaultTextModel, defaultVisionModel, defaultImageModel }` without reading an API-key environment variable.
- Provider settings display `credentialSource: 'codex_login'` when the local provider is enabled/configured by the runtime, and never renders an API-key value for Codex.
- `validateTaskRouting({ taskType, providerCode: 'codex', ... })` accepts Codex for all declared capabilities.

- [ ] **Step 1: Write failing schema/store/registry tests**

Add assertions that the provider list contains `codex`, `validateTaskRouting` accepts it for `generated_image_review` and `product_text_generation`, and Codex credential resolution returns `apiKey: null` without requiring `AUTOMONEY_CREDENTIAL_MASTER_KEY`.

- [ ] **Step 2: Run focused settings tests and verify failure**

Run: `node --test tests/provider-settings-store.test.mjs tests/ai-provider-framework.test.mjs`

Expected: FAIL because the database checks and registry do not yet include `codex`.

- [ ] **Step 3: Implement provider settings and canonical schema updates**

Add `codex` to all AI provider/routing constraints, keep encrypted key columns for backward-compatible schema shape, and branch provider credential serialization so Codex has no API-key source.

- [ ] **Step 4: Add an idempotent migration**

The migration must:

```sql
-- outline of required behavior; use the repository's existing migration style
-- for constraint replacement and safe repeated execution.
insert into ai_provider_configs (provider_code, display_name, enabled, default_text_model, default_vision_model, default_image_model, capabilities)
values ('codex', 'OpenAI Codex', true, 'gpt-5.6-luna', 'gpt-5.6-luna', 'gpt-5.6-luna', '["text_generation","vision_analysis","image_generation","image_edit"]'::jsonb)
on conflict (provider_code) do update
set display_name = excluded.display_name,
    default_text_model = coalesce(ai_provider_configs.default_text_model, excluded.default_text_model),
    default_vision_model = coalesce(ai_provider_configs.default_vision_model, excluded.default_vision_model),
    default_image_model = coalesce(ai_provider_configs.default_image_model, excluded.default_image_model),
    capabilities = excluded.capabilities;

update ai_task_routing
set provider_code = 'codex', model = coalesce(model, 'gpt-5.6-luna')
where task_type = 'generated_image_review' and provider_code = 'anthropic';
```

Replace the existing check constraints safely before these statements, and make the migration rerunnable without deleting credentials or manual records.

- [ ] **Step 5: Update the admin settings UI**

Include `codex` in endpoint matching and render it as a local-session provider: hide/disable API-key and base-URL inputs, show login-based status, and use the shared Luna defaults. Keep manual external-provider selectors unchanged.

- [ ] **Step 6: Run provider/admin/settings tests**

Run: `node --test tests/provider-settings-store.test.mjs tests/ai-provider-framework.test.mjs tests/generated-image-qa.test.mjs`

Expected: PASS; existing Anthropic tests still pass for historical/provider compatibility.

- [ ] **Step 7: Commit the provider-routing migration**

```bash
git add src/ai/provider-settings-store.mjs src/ai/task-routing.mjs src/admin-server.mjs schema.sql migrations/2026-08-24-codex-provider-routing.sql tests/provider-settings-store.test.mjs tests/ai-provider-framework.test.mjs
git commit -m "feat: add Codex task routing provider"
```

### Task 6: Remove duplicated hard-coded scoring target and align existing Codex callers

**Files:**
- Modify: `src/ai-competitiveness-scoring.mjs`
- Modify: `src/naver-trend-keyword-resolver.mjs` if it has its own model override
- Modify: `src/product-analysis-orchestrator.mjs` or callers only where they bypass `loadCodexConfig`
- Modify: related tests such as `tests/ai-competitiveness-scoring.test.mjs`, `tests/naver-trend-keyword-resolver.test.mjs`, and `tests/product-analysis-orchestrator.test.mjs`

**Interfaces:**
- `withScoringModel(config)` returns a copy whose `model` and `reasoningEffort` come from the shared Codex config, defaulting through `loadCodexConfig` rather than hard-coded literals.
- Existing fallback-to-formula behavior remains unchanged.

- [ ] **Step 1: Add failing tests for shared-config propagation**

Pass `{ model: 'gpt-5.6-luna', reasoningEffort: 'xhigh' }` and an override config such as `{ model: 'gpt-5.6-terra', reasoningEffort: 'high' }`; assert the injected `runCodexAnalysisImpl` receives the exact config values.

- [ ] **Step 2: Run focused scoring/analysis tests and verify failure**

Run: `node --test tests/ai-competitiveness-scoring.test.mjs tests/naver-trend-keyword-resolver.test.mjs tests/product-analysis-orchestrator.test.mjs`

Expected: FAIL for the override case because scoring currently replaces the model and effort with literals.

- [ ] **Step 3: Implement shared-config alignment**

Remove duplicated target literals, preserve explicit caller overrides, and ensure product analysis/image generation always receive the `loadCodexConfig` object from their existing orchestrators.

- [ ] **Step 4: Run focused tests**

Run: `node --test tests/ai-competitiveness-scoring.test.mjs tests/naver-trend-keyword-resolver.test.mjs tests/product-analysis-orchestrator.test.mjs tests/codex-client.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit the shared-config alignment**

```bash
git add src/ai-competitiveness-scoring.mjs src/naver-trend-keyword-resolver.mjs src/product-analysis-orchestrator.mjs tests/ai-competitiveness-scoring.test.mjs tests/naver-trend-keyword-resolver.test.mjs tests/product-analysis-orchestrator.test.mjs
git commit -m "refactor: use shared Codex model configuration"
```

### Task 7: Full regression verification and operator documentation

**Files:**
- Modify: `README.md` environment/configuration section
- Modify: `package.json` only if a focused verification script is useful
- Modify: tests only for failures demonstrated by the verification commands

- [ ] **Step 1: Document Codex login and model settings**

Document:

```text
codex login
CODEX_MODEL=gpt-5.6-luna
CODEX_REASONING_EFFORT=xhigh
```

State that the local Codex session is required and no Claude usage is needed for automatic AI tasks.

- [ ] **Step 2: Run all focused migration tests**

Run:

```bash
node --test tests/config-codex.test.mjs tests/codex-client.test.mjs tests/codex-provider.test.mjs tests/coupang-keyword-extractor.test.mjs tests/generated-image-qa.test.mjs tests/provider-settings-store.test.mjs tests/ai-provider-framework.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Verify no automatic Claude call sites remain**

Run: `rg -n --glob '!docs/**' --glob '!tests/**' --glob '!public/**' 'runClaude|loadClaudeCliConfig|checkClaudeCliAvailability|claudeCliConfig' src scripts`

Expected: no matches in automatic production flows; the legacy Claude client/provider may remain only for backward-compatible manual/provider records if the implementation keeps it.

- [ ] **Step 4: Run the full test suite**

Run: `npm test`

Expected: PASS. If the suite requires a configured database or browser, report the exact prerequisite failure instead of weakening the test.

- [ ] **Step 5: Run admin UI verification when prerequisites are available**

Run: `npm run verify:ai-settings`

Expected: the provider page includes Codex, no Codex API-key value is rendered, all task routes accept Codex where capability permits, and no browser console/request errors occur.

- [ ] **Step 6: Verify final working-tree scope**

Run: `git status --short` and `git diff --stat`.

Expected: only migration files, source/tests/docs in this plan, and the user's pre-existing modifications are present. Do not stage or revert the user's unrelated edits.

- [ ] **Step 7: Commit documentation and final verified changes**

```bash
git add README.md package.json src scripts schemas migrations schema.sql tests
git commit -m "docs: document Codex Luna xhigh automation"
```

If `.git` remains read-only, leave the files in place and report that commit creation was blocked by the workspace permission rather than attempting destructive workarounds.
