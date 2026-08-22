# Debian Full Migration Design

## Goal

Move the complete Automoney runtime from the Windows workstation to the Debian 13.6 server at `ho@192.168.1.50`, using `/home/ho/automoney` as the application directory. Windows remains the active source until the Debian installation has been verified.

## Transfer

Create one project archive containing the source, `.env`, generated assets, job data, and Playwright profile. Exclude `node_modules`, `.git`, disposable caches, and reproducible test artifacts. Create a separate PostgreSQL logical backup of the local `domeme_market` database with `pg_dump`.

Transfer both files over SSH to `/home/ho`. Do not stop or modify the Windows installation during this initial copy. Restrict secret-bearing files on Debian to the `ho` user.

## Debian Setup

In a later session running on Debian, install PostgreSQL directly on the host, Node.js 24 or newer, Python dependencies, Tesseract Korean and English data, Playwright Chromium dependencies, and Codex CLI. Restore the database, update machine-specific environment values, and recreate browser login state through the server GUI when required.

Replace the Windows launcher with a `systemd` service that starts at boot and restarts after failure. Make Windows-specific verification scripts cross-platform where they are needed for Debian validation.

## Cutover and Recovery

Keep Windows as the live system until Debian passes database, scheduler, API, browser, OCR, Codex, Telegram, Coupang, Naver, and Speedgo checks. At cutover, stop the Windows Automoney process, take and restore a final database backup, then start the Debian service. Retain the Windows installation and backups until Debian operation is confirmed, allowing rollback without data loss.

## Safety

- Never print or commit `.env` secrets.
- Do not copy `node_modules` across operating systems.
- Do not run Windows and Debian schedulers concurrently against the live database.
- Do not delete Windows data or temporary transfer files until the Debian restore is verified.
- Treat the copied Playwright profile as provisional; perform a fresh Linux GUI login if it is incompatible or expired.
