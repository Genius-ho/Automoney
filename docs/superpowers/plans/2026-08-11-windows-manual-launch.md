# Windows Manual Desktop Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the operator start Automoney by double-clicking `Automoney 시작` on the Windows desktop, with a visible terminal, browser opening, and duplicate-server protection.

**Architecture:** A repository-owned PowerShell launcher validates prerequisites, probes the configured admin port, starts Node in the foreground, and opens the browser after readiness. A separate idempotent installer creates the current user's `.lnk`; both scripts expose non-mutating test modes so Node tests can verify behavior without registering shortcuts or starting the real server.

**Tech Stack:** Windows PowerShell 5.1, Node.js 24+, Node test runner, WScript.Shell shortcut API.

## Global Constraints

- Do not configure Task Scheduler, services, login startup, or background persistence.
- Preserve an existing `PORT`; default to `3000`.
- Never print `.env` values or terminate arbitrary Node processes.
- Do not modify product data, databases, browser profiles, images, or existing user-owned untracked files.
- Create or update only the current user's exact shortcut `Automoney 시작.lnk`.
- The visible foreground server stops with `Ctrl+C` or when its terminal is closed.

---

### Task 1: Tested Windows Admin Launcher

**Files:**
- Create: `scripts/run-admin-server-windows.ps1`
- Create: `tests/windows-manual-launch.test.mjs`

**Interfaces:**
- Consumes: repository-relative `scripts/admin-server.js`, optional environment variable `PORT`, `node.exe`, and `http://127.0.0.1:<port>/`.
- Produces: `run-admin-server-windows.ps1 [-Describe] [-ProbeOnly] [-NoBrowser] [-StartupTimeoutSeconds <int>]`; `-Describe` emits one JSON object and makes no process or browser changes.

- [ ] **Step 1: Write failing launcher contract tests**

Add Node tests that run Windows PowerShell with `spawnSync`. Assert that `-Describe` returns JSON containing the resolved repository root, admin script path, port `3000`, and admin URL; repeat with `PORT=4317`. Assert that an invalid `PORT` returns non-zero without echoing unrelated environment values. Start a temporary local HTTP server, invoke `-ProbeOnly`, and assert it reports `already-running`; probe an unused port with a one-second timeout and assert a bounded non-zero failure.

```js
const result = runPowerShell(['-File', launcher, '-Describe'], { PORT: '' });
assert.equal(result.status, 0);
assert.equal(JSON.parse(result.stdout).port, 3000);
assert.match(JSON.parse(result.stdout).adminScript, /scripts[\\/]admin-server\.js$/);
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test tests/windows-manual-launch.test.mjs`

Expected: FAIL because `scripts/run-admin-server-windows.ps1` does not exist.

- [ ] **Step 3: Implement the minimal launcher**

Use a parameter block for `Describe`, `ProbeOnly`, `NoBrowser`, and `StartupTimeoutSeconds`. Resolve the root with `Split-Path $PSScriptRoot -Parent`; validate `PORT` as an integer from 1 through 65535; validate `Get-Command node` and the admin script. Probe with `System.Net.Http.HttpClient` using a short timeout. If healthy, open the admin URL unless `NoBrowser` and exit without spawning Node. Otherwise start `node scripts/admin-server.js` as a foreground child, poll readiness until the bounded deadline, open the browser exactly once, then wait for the child. On startup failure, print a concise Korean message to stderr, preserve the child exit code, and never enumerate environment variables.

- [ ] **Step 4: Run the focused test and verify success**

Run: `node --test tests/windows-manual-launch.test.mjs`

Expected: all launcher tests PASS and the test leaves no Automoney server process running.

- [ ] **Step 5: Commit the launcher slice**

```powershell
git add -- scripts/run-admin-server-windows.ps1 tests/windows-manual-launch.test.mjs
git commit -m "feat: add windows admin launcher"
```

### Task 2: Tested Desktop Shortcut Installer

**Files:**
- Create: `scripts/install-windows-desktop-shortcut.ps1`
- Modify: `tests/windows-manual-launch.test.mjs`

**Interfaces:**
- Consumes: absolute path to `scripts/run-admin-server-windows.ps1`, current user's Desktop special folder, and `WScript.Shell`.
- Produces: `install-windows-desktop-shortcut.ps1 [-Describe]`; `-Describe` emits shortcut path, executable, arguments, and working directory as JSON without writing a shortcut.

- [ ] **Step 1: Add failing installer contract tests**

Assert that `-Describe` exits zero, targets exactly `Automoney 시작.lnk` inside `[Environment]::GetFolderPath('Desktop')`, uses `powershell.exe`, contains `-NoProfile -ExecutionPolicy Bypass -NoExit -File` with the absolute launcher path, and sets the repository root as working directory. Assert that calling `-Describe` twice produces identical JSON and creates no `.lnk`.

```js
assert.equal(description.shortcutPath, path.join(desktop, 'Automoney 시작.lnk'));
assert.match(description.arguments, /-NoProfile -ExecutionPolicy Bypass -NoExit -File/);
assert.equal(description.workingDirectory, repoRoot);
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test tests/windows-manual-launch.test.mjs`

Expected: FAIL because the shortcut installer does not exist.

- [ ] **Step 3: Implement the idempotent installer**

Resolve all paths from `$PSScriptRoot`. Build a single shortcut description shared by `-Describe` and installation. In normal mode use `New-Object -ComObject WScript.Shell`, `CreateShortcut`, assign `TargetPath`, quoted `Arguments`, `WorkingDirectory`, and a Node or PowerShell icon, then call `Save()`. Print the final shortcut path. Do not request elevation and do not inspect or delete any other shortcut.

- [ ] **Step 4: Run the focused test and verify success**

Run: `node --test tests/windows-manual-launch.test.mjs`

Expected: all launcher and installer contract tests PASS; no real shortcut is created by tests.

- [ ] **Step 5: Commit the installer slice**

```powershell
git add -- scripts/install-windows-desktop-shortcut.ps1 tests/windows-manual-launch.test.mjs
git commit -m "feat: install automoney desktop shortcut"
```

### Task 3: Commands, Documentation, and End-to-End Verification

**Files:**
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: the two PowerShell scripts from Tasks 1 and 2.
- Produces: npm scripts `admin:windows` and `admin:windows:install-shortcut`, plus the operator runbook.

- [ ] **Step 1: Add package-script assertions**

Extend `tests/windows-manual-launch.test.mjs` to parse `package.json` and require exact commands:

```js
assert.equal(pkg.scripts['admin:windows'], 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/run-admin-server-windows.ps1');
assert.equal(pkg.scripts['admin:windows:install-shortcut'], 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-windows-desktop-shortcut.ps1');
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `node --test tests/windows-manual-launch.test.mjs`

Expected: FAIL because the npm scripts are absent.

- [ ] **Step 3: Add commands and operator documentation**

Add the two exact package commands. Add a `Windows 수동 실행` README section showing the one-time `npm run admin:windows:install-shortcut`, normal double-click workflow, browser URL, visible-terminal behavior, `Ctrl+C` shutdown, default/configured port behavior, and troubleshooting for missing Node, occupied ports, startup timeout, and Telegram configuration. State explicitly that the shortcut does not configure automatic startup.

- [ ] **Step 4: Run automated verification**

Run: `node --test tests/windows-manual-launch.test.mjs`

Expected: PASS.

Run: `npm.cmd test`

Expected: the complete repository test suite exits 0.

- [ ] **Step 5: Install and verify the real shortcut**

Run: `npm.cmd run admin:windows:install-shortcut`

Confirm `Automoney 시작.lnk` exists on the current user's desktop. Stop only a temporary admin-server process known to have been started by this work session. Double-click the shortcut, verify the visible terminal remains open, the browser reaches the admin page, and only one command line containing this repository's `scripts/admin-server.js` exists. Confirm the console reports Telegram polling startup. Press `Ctrl+C`, verify port 3000 (or `PORT`) stops listening, then double-click again and verify recovery.

- [ ] **Step 6: Commit commands and documentation**

```powershell
git add -- package.json README.md tests/windows-manual-launch.test.mjs
git commit -m "docs: add windows manual launch workflow"
```

- [ ] **Step 7: Preserve unrelated workspace files**

Run: `git status --short`

Expected: only pre-existing user-owned untracked files remain; none are staged or modified by this work.
