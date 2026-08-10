# Windows Always-On Runtime Design

## Goal

Run the Automoney admin server and scheduler continuously on the current Windows machine, automatically start it when the current user signs in, restart it after failures, preserve logs, and prevent duplicate server instances.

## Runtime Model

Use Windows Task Scheduler under the current Windows user rather than LocalSystem. This preserves the existing user-scoped Playwright browser installation, Speedgo browser profile, Codex login, environment files, and filesystem permissions.

The scheduled task starts at user logon. It runs a checked-in PowerShell launcher from `C:\dogfoot\automoney`, which starts `node scripts/admin-server.js` with the repository as its working directory.

## Launcher

Create `scripts/run-admin-server.ps1` with these responsibilities:

- resolve the repository root from the script location rather than assuming the caller's current directory;
- create a runtime log directory when absent;
- acquire an exclusive process lock before starting Node;
- exit successfully when another healthy launcher already holds the lock;
- start the admin server in the foreground so Task Scheduler can observe its real exit code;
- append timestamped stdout and stderr to separate log files;
- pass through `PORT` when already configured and otherwise retain the application's default port 3000;
- release the lock on exit.

The script must not print or copy `.env` contents.

## Scheduled Task

Create `scripts/install-windows-admin-task.ps1` to register a task named `Automoney Admin Server` for the current user.

The task configuration:

- trigger: current user logon;
- action: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <absolute launcher path>`;
- working directory: repository root;
- execution time limit: disabled;
- start when available: enabled;
- multiple-instance policy: ignore new instances;
- restart after failure: every 1 minute, up to 999 attempts;
- battery policy: allow start and continued execution on battery;
- network availability: no hard gate, because the process must remain alive and its jobs already report transient failures.

Installation requires no stored password because the task runs only in the interactive user's logon session. The installer starts the task once after registration.

Create `scripts/uninstall-windows-admin-task.ps1` to stop and unregister only the exact task name. It does not delete logs, database data, browser profiles, images, or environment files.

## Health and Operations

Create `scripts/check-windows-admin-task.ps1` to report:

- task existence and state;
- last and next run times;
- last task result;
- whether a Node process is listening on the configured/default port;
- the latest stdout and stderr log tails.

Add package scripts for install, uninstall, health check, and foreground launch. Update the README with the exact administrator/non-administrator commands, expected task state, log paths, and recovery procedure.

## Safety

- Never terminate arbitrary Node processes. Any stop operation targets the exact scheduled task and launcher-owned process only.
- Never overwrite or expose `.env`.
- Never delete runtime logs or persistent product/browser assets.
- Re-running installation updates the same exact task idempotently.
- The launcher lock prevents a manually started instance and scheduled instance from binding port 3000 simultaneously.

## Verification

Automated tests exercise launcher path resolution, lock behavior, task definition arguments, idempotent registration, and exact-name uninstallation without registering a real task.

After automated tests pass, register the real task, stop the current temporary admin-server process, start the scheduled task, and verify:

- Task Scheduler reports `Running`;
- the admin endpoint responds on port 3000;
- only one Automoney admin-server Node process exists;
- Telegram polling remains active;
- the task still runs after a manual stop/start cycle;
- no existing user-owned untracked files were modified.
