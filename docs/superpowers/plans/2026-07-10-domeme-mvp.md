# Domeme MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local CLI MVP that reads Domeme product numbers, fetches product detail data, stores raw JSON, creates normalized marketplace draft rows, and prints per-product results without calling marketplace registration APIs.

**Architecture:** Use a small Python standard-library app with focused modules for config, API client, normalization/filtering/pricing, database persistence, and CLI orchestration. Store data in SQLite under `data/automoney.sqlite3` and use JSON columns as text for raw and normalized payloads.

**Tech Stack:** Python 3 standard library, SQLite, `unittest`.

## Global Constraints

- API keys must come from `.env`, with `env` fallback for the current workspace.
- Do not hardcode API keys.
- Do not invent missing certification, efficacy, or brand information.
- Do not call Coupang or Smartstore registration APIs.
- Failed products must log a failure reason.
- `test-products.csv` may contain either a `product_no` header or one product number per line.

---

### Task 1: Core Pure Logic

**Files:**
- Create: `automoney/config.py`
- Create: `automoney/processing.py`
- Create: `tests/test_processing.py`

**Interfaces:**
- Produces: `load_env_config()`, `normalize_product(raw)`, `filter_product(normalized)`, `calculate_prices(normalized, rules)`, `clean_product_name(name)`, `build_detail_html(normalized)`.

- [x] Write failing tests for env loading fallback, CSV parsing, normalization, filtering, pricing, name cleanup, and HTML generation.
- [x] Run tests and verify failure before implementation.
- [x] Implement minimal pure logic.
- [x] Run tests and verify pass.

### Task 2: Persistence and API Client

**Files:**
- Create: `automoney/database.py`
- Create: `automoney/domeme_client.py`
- Create: `tests/test_database.py`

**Interfaces:**
- Produces: `init_db(path)`, `save_raw_response(conn, product_no, raw)`, `save_product_draft(conn, draft)`, `DomemeClient.fetch_product_detail(product_no)`.

- [x] Write failing persistence tests.
- [x] Run tests and verify failure before implementation.
- [x] Implement SQLite schema and safe API client with configurable endpoint.
- [x] Run tests and verify pass.

### Task 3: CLI Orchestration

**Files:**
- Create: `scripts/process_test_products.py`
- Create: `test-products.csv`
- Create: `pricing-rules.json`
- Create: `README.md`

**Interfaces:**
- Consumes all functions above.
- Produces: executable CLI script that prints `SUCCESS`, `SKIPPED`, or `FAILED` per product.

- [x] Write failing CLI-level tests for product number loading and draft generation path where API fetch is injected.
- [x] Run tests and verify failure before implementation.
- [x] Implement CLI orchestration.
- [x] Run all tests.
