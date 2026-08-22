# Windows Manual Desktop Launch Design

## Goal

Start Automoney manually from a Windows desktop shortcut. Keep the server visible in a terminal so the operator can see its status and stop it with `Ctrl+C`. Do not configure Task Scheduler or automatic startup.

## User Experience

The desktop contains a shortcut named `Automoney 시작`. Double-clicking it launches a checked-in PowerShell script in a visible terminal.

The launcher:

1. resolves the repository root from its own location;
2. verifies that Node.js and `scripts/admin-server.js` are available;
3. checks whether the Automoney admin endpoint is already responding on the configured port, or port 3000 by default;
4. opens the admin page without starting a duplicate process when it is already running;
5. otherwise starts `node scripts/admin-server.js` in the foreground;
6. opens `http://localhost:<port>` after the server becomes ready;
7. keeps the terminal open so runtime output and errors remain visible.

The operator stops the server by focusing the terminal and pressing `Ctrl+C`. Closing the terminal also ends the foreground server.

## Components

### Launcher

Add `scripts/run-admin-server-windows.ps1`. It changes to the repository root before starting Node, preserves an existing `PORT` environment variable, and otherwise uses port 3000.

Readiness checks have a bounded timeout. If startup fails or times out, the launcher prints a clear Korean error and leaves the terminal open long enough for the operator to read it. It never prints `.env` values.

### Shortcut Installer

Add `scripts/install-windows-desktop-shortcut.ps1`. It creates or updates only the current user's desktop shortcut named `Automoney 시작.lnk`. The shortcut invokes:

`powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit -File <absolute launcher path>`

Its working directory is the repository root. Re-running the installer updates the same shortcut. It does not require administrator privileges.

### Package Commands and Documentation

Add package commands for launching the server and installing the shortcut. Update the README with the one-time installation command, normal click-to-start workflow, `Ctrl+C` shutdown instructions, and troubleshooting steps.

## Safety

- Do not configure Task Scheduler, services, login startup, or background persistence.
- Do not terminate arbitrary Node processes.
- Do not start another process when the admin endpoint is already healthy.
- Do not overwrite or expose `.env`.
- Do not modify or delete product data, database contents, browser profiles, images, or existing user-owned untracked files.
- Only create or update the exact desktop shortcut `Automoney 시작.lnk`.

## Verification

Automated tests cover repository path resolution, default and configured ports, existing-server detection, bounded readiness behavior, failure messaging, and shortcut arguments without creating a real desktop shortcut.

After the tests pass:

1. run the installer to create the real desktop shortcut;
2. stop any temporary Automoney admin-server process owned by this work session;
3. double-click the shortcut;
4. verify that the visible terminal stays open;
5. verify that the browser opens the admin page on the correct port;
6. verify that only one Automoney admin server is running;
7. press `Ctrl+C` and verify that the server stops;
8. launch it again and verify that Telegram polling starts normally.
