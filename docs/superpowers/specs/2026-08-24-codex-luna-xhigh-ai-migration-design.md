# Codex GPT-5.6 Luna xhigh AI Migration Design

## Goal

Make Automoney's automatic AI work use the local Codex CLI with
`gpt-5.6-luna` and `xhigh` reasoning, instead of the current Claude CLI paths.
The migration covers product analysis, keyword extraction, image analysis,
generated-image review, and Codex-driven image generation. It does not rewrite
historical provider metadata for images uploaded through the manual workflow.

## Scope and invariants

- The automatic provider is explicitly named `codex` in routing and the admin UI.
- Codex authenticates through the operator's existing `codex login` session; no
  OpenAI API key is required for this path.
- `CODEX_MODEL` defaults to `gpt-5.6-luna` and
  `CODEX_REASONING_EFFORT` defaults to `xhigh`.
- Explicit environment overrides remain available for operational rollback or
  benchmarking, but the checked-in defaults are the requested target.
- Existing `anthropic` provider records and `anthropic_claude` manual-upload
  history values remain intact. They are not silently relabeled.
- The current working-tree edits unrelated to this migration must not be
  overwritten.
- No real paid AI call is required for automated tests.

## Architecture

`src/codex-client.mjs` remains the process boundary for Codex CLI. Its config
contains executable, sandbox, concurrency, timeout, model, and reasoning
effort. Both structured JSON analysis and image-generation commands append the
same model and reasoning settings to their CLI invocation.

The provider registry gains a `codex` provider. It implements text and vision
analysis through the Codex client and reports local CLI availability rather
than API-key configuration. The provider is suitable for task routing, while
the existing image-generation workflow continues to use the dedicated Codex
image runner through the same config.

The provider settings store and admin UI treat Codex as a local-session
provider. API-key fields are disabled or omitted for Codex, and its default
models are displayed from the shared Codex configuration rather than from an
encrypted API credential.

## Task flows

1. Product/Codex analysis loads the shared Codex config and inherits the target
   model and reasoning effort unless a caller intentionally overrides them.
2. Main and detail image generation pass the shared model and reasoning effort
   to `codex exec`.
3. Generated-image review changes from Claude vision to Codex structured JSON
   analysis. The existing review verdicts, retry behavior, approval transition,
   and persisted QA records remain unchanged; only provider execution and the
   provider code become Codex.
4. Coupang keyword extraction changes from Claude text output to a Codex JSON
   schema. The extracted keyword semantics and deduplication behavior remain
   unchanged.
5. Existing Codex competitiveness and Naver trend analysis use the shared
   defaults rather than duplicating a hard-coded model/effort pair.

## Configuration and migration

Add a migration that permits `codex` in AI provider and task-routing checks,
creates/updates its provider metadata, and moves the automatic generated-image
review route away from `anthropic` when that route is currently configured for
Claude. The migration must be idempotent and must not delete credentials or
manual workflow records.

Update the canonical `schema.sql` in the same change. Existing databases are
updated by the migration; new databases receive the same constraints and
provider shape from the canonical schema.

## Error handling

- Missing Codex executable or login remains a reportable unavailable result,
  not a server-startup failure.
- Codex timeout and non-zero exit preserve the existing task-specific error
  reporting and resumability behavior.
- Invalid structured output is recorded as an analysis/review error and does
  not approve or register a product.
- Existing fallback/proxy behavior for competitiveness scoring remains intact.
- Claude-specific automatic error codes are replaced with Codex-specific codes
  at the migrated call sites; old persisted error text is left untouched.

## Testing

Add or update unit tests for:

- shared Codex defaults and environment overrides;
- model/reasoning CLI arguments for structured analysis and image generation;
- Codex text/vision provider availability and structured-output parsing;
- keyword extraction and generated-image review using test doubles;
- provider registry/settings validation for `codex`;
- migration/schema acceptance and route conversion;
- absence of Claude CLI calls in the migrated automatic flows.

Run focused tests first, then the repository's full `npm test` suite. Run the
existing admin UI verification if the local database/server prerequisites are
available.

## Rollback

The environment variables can temporarily select another Codex model or
reasoning effort. If the migration must be rolled back, stop automatic AI
jobs, restore the previous task route/provider configuration, and leave
historical QA/manual records untouched. The code must not make rollback depend
on deleting provider credentials.
