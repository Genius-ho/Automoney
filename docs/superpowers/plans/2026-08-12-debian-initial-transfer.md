# Debian Initial Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Copy a restorable snapshot of Automoney and its PostgreSQL database from Windows to `ho@192.168.1.50` without interrupting the live Windows runtime.

**Architecture:** Build two timestamped transfer artifacts in a workspace-local staging directory: one project archive and one PostgreSQL custom-format dump. Transfer them with OpenSSH SCP to `/home/ho`, verify sizes and SHA-256 hashes remotely, and leave extraction and Debian configuration for the Debian session.

**Tech Stack:** PowerShell, tar, PostgreSQL 18 `pg_dump`, OpenSSH/SCP, Debian 13.6

## Global Constraints

- The Debian application directory will be `/home/ho/automoney`.
- Never print or commit `.env` secrets.
- Do not copy `node_modules` or `.git`.
- Do not stop or modify the running Windows Automoney instance during this initial transfer.
- Do not delete local or remote transfer artifacts until the Debian restore is verified.

---

### Task 1: Preflight and Inventory

**Files:**
- Read: `.env`
- Read: `package.json`
- Create at runtime: `.migration-staging/<timestamp>/inventory.txt`

**Interfaces:**
- Consumes: Windows repository and `DATABASE_URL` from `.env`
- Produces: confirmed tool paths, source size, free space, and a non-secret inventory

- [ ] **Step 1: Confirm SSH connectivity and remote capacity**

Run OpenSSH in batch mode against `ho@192.168.1.50`; record `whoami`, Debian version, architecture, and free space under `/home/ho`.

- [ ] **Step 2: Locate PostgreSQL 18 backup tools**

Resolve `pg_dump.exe` from the PostgreSQL service installation and verify `pg_dump --version` reports major version 18.

- [ ] **Step 3: Inventory transfer scope**

Measure the repository excluding `.git`, `node_modules`, `.migration-staging`, reproducible artifacts, and caches. Confirm `.env`, `data`, `public`, and `.playwright-profile` presence without printing file contents.

### Task 2: Create Restorable Artifacts

**Files:**
- Create at runtime: `.migration-staging/<timestamp>/automoney-project.tar.gz`
- Create at runtime: `.migration-staging/<timestamp>/domeme_market.dump`
- Create at runtime: `.migration-staging/<timestamp>/SHA256SUMS`

**Interfaces:**
- Consumes: verified inventory and local PostgreSQL connection
- Produces: compressed project archive, custom-format DB dump, and SHA-256 manifest

- [ ] **Step 1: Create the project archive**

Use `tar` from the repository root with explicit exclusions for `.git`, `node_modules`, `.migration-staging`, caches, and reproducible artifacts. Include hidden files such as `.env` and `.playwright-profile`.

- [ ] **Step 2: Create the PostgreSQL logical backup**

Invoke PostgreSQL 18 `pg_dump.exe` with the existing `DATABASE_URL`, custom format, verbose diagnostics, and output in the timestamped staging directory. Do not echo the connection URL.

- [ ] **Step 3: Validate artifacts locally**

List the archive to confirm `.env`, `package.json`, `src`, and `scripts` exist and `node_modules` and `.git` do not. Run `pg_restore --list` against the dump. Generate SHA-256 hashes for both artifacts.

### Task 3: Transfer and Remote Verification

**Files:**
- Create remotely: `/home/ho/automoney-transfer-<timestamp>/automoney-project.tar.gz`
- Create remotely: `/home/ho/automoney-transfer-<timestamp>/domeme_market.dump`
- Create remotely: `/home/ho/automoney-transfer-<timestamp>/SHA256SUMS`

**Interfaces:**
- Consumes: locally validated artifacts
- Produces: verified remote snapshot ready for Debian installation

- [ ] **Step 1: Create the remote transfer directory**

Use SSH to create the exact timestamped directory under `/home/ho` with mode `700`.

- [ ] **Step 2: Copy the three artifacts**

Use Windows OpenSSH `scp.exe` to transfer the archive, database dump, and checksum manifest.

- [ ] **Step 3: Verify remote integrity and permissions**

Run `sha256sum -c SHA256SUMS` remotely, compare byte sizes, and set all transferred files to mode `600`. Do not extract or start Automoney.

- [ ] **Step 4: Record the handoff**

Report the exact remote directory, artifact sizes, checksum results, and the next Debian-side steps. Leave Windows and all staging files intact.
