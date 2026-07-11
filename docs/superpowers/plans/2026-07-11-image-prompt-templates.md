# Image Prompt Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import the two supplied DOCX prompt templates without rewriting their text, render product-specific prompt snapshots, and expose them in the admin UI and channel exports without calling image or marketplace APIs.

**Architecture:** PostgreSQL holds the latest active template for each template type and the latest per-draft request for each request type. A DOCX importer uses Mammoth for the raw text; the renderer only replaces approved product placeholders and records warnings for absent source data.

**Tech Stack:** Node.js ESM, PostgreSQL, Mammoth, built-in HTTP admin UI, `node:test`.

## Global Constraints

- Preserve the imported DOCX prompt text and line breaks; never summarize, delete, paraphrase, or rewrite prompt sentences.
- Replace only named product placeholders and the supplied DOCX's blue placeholder values; leave instructional bracket text unchanged.
- Default missing brand/store name to `와우픽`; do not invent product facts.
- Derive size and selling points only from original source text; otherwise render `정보 없음` and record warnings.
- No image-generation, Coupang, or Smartstore registration API calls.

---

### Task 1: Template data model, raw DOCX import, and pure rendering

**Files:**
- Modify: `package.json`, `schema.sql`
- Create: `scripts/import-docx-prompts.js`, `src/image-prompt-templates.mjs`, `tests/image-prompt-templates.test.mjs`

- [ ] Write failing tests for exact template body persistence, version increments on changed source, approved placeholder replacement, literal bracket preservation, and missing-value warnings.
- [ ] Add Mammoth and the `prompts:import-docx` script.
- [ ] Add the two template/request tables and latest-request uniqueness.
- [ ] Implement DOCX text import and deterministic rendering from draft fields, options, source HTML, product images, and Naver raw image URLs.
- [ ] Run the focused tests.

### Task 2: Draft request storage, APIs, and export projection

**Files:**
- Modify: `src/admin-store.mjs`, `src/admin-server.mjs`, `tests/admin-store.test.mjs`

- [ ] Write failing store/API tests for main/detail request generation, status updates, and export fields.
- [ ] Implement active-template lookup, request snapshot upsert, retrieval, and approval/rejection validation.
- [ ] Add POST generation and PATCH status API routes, then add image prompt fields to Coupang and Naver export projections.
- [ ] Run the focused tests.

### Task 3: Admin prompt tab and end-to-end checks

**Files:**
- Modify: `src/admin-server.mjs`
- Create or modify: route/UI test covering the tab's essential markup if a lightweight server fixture is feasible.

- [ ] Render a dedicated AI image prompt tab with per-type generate, original/rendered read-only text, copy, approve/reject, warning badges, and grouped reference images.
- [ ] Bind the controls to the new endpoints with safe clipboard fallback; no external API actions.
- [ ] Install dependencies, import the supplied DOCXs, exercise draft 64 endpoints and both exports, then run `npm.cmd test`.
