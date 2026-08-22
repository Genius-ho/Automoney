import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcher = path.join(repoRoot, 'scripts', 'run-admin-server-windows.ps1');
const shortcutInstaller = path.join(repoRoot, 'scripts', 'install-windows-desktop-shortcut.ps1');

function runPowerShell(script, args = [], env = {}) {
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
    {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
}

async function getUnusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startHttpServer() {
  const child = spawn(
    process.execPath,
    ['-e', "require('http').createServer((req,res)=>{res.statusCode=200;res.end('ok')}).listen(0,'127.0.0.1',()=>console.log(process._getActiveHandles().find(h=>h.address).address().port))"],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const port = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim())));
  });
  return { child, port };
}

test('launcher describe resolves repository paths and defaults to port 3000', () => {
  const result = runPowerShell(launcher, ['-Describe'], { PORT: '' });
  assert.equal(result.status, 0, result.stderr);
  const description = JSON.parse(result.stdout);
  assert.equal(path.resolve(description.repositoryRoot), repoRoot);
  assert.match(description.adminScript, /scripts[\\/]admin-server\.js$/);
  assert.equal(description.port, 3000);
  assert.equal(description.adminUrl, 'http://127.0.0.1:3000/');
});

test('launcher describe preserves a configured valid port', () => {
  const result = runPowerShell(launcher, ['-Describe'], { PORT: '4317' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).port, 4317);
});

test('launcher rejects an invalid port without exposing unrelated environment values', () => {
  const secret = 'must-not-appear-in-output';
  const result = runPowerShell(launcher, ['-Describe'], {
    PORT: '70000',
    AUTOMONEY_TEST_SECRET: secret,
  });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret));
});

test('probe-only reports an already-running healthy endpoint', async (t) => {
  const { child, port } = await startHttpServer();
  t.after(() => child.kill());
  const result = runPowerShell(launcher, ['-ProbeOnly'], { PORT: String(port) });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already-running/);
});

test('probe-only fails within its bounded timeout when no endpoint is listening', async () => {
  const port = await getUnusedPort();
  const startedAt = Date.now();
  const result = runPowerShell(
    launcher,
    ['-ProbeOnly', '-StartupTimeoutSeconds', '1'],
    { PORT: String(port) },
  );
  assert.notEqual(result.status, 0);
  assert.ok(Date.now() - startedAt < 5_000, 'probe exceeded its bounded timeout');
});

test('shortcut description targets only the current desktop with exact launch arguments', () => {
  const result = runPowerShell(shortcutInstaller, ['-Describe']);
  assert.equal(result.status, 0, result.stderr);
  const description = JSON.parse(result.stdout);
  assert.equal(path.basename(description.shortcutPath), 'Automoney 시작.lnk');
  assert.equal(description.targetPath.toLowerCase(), 'powershell.exe');
  assert.equal(path.resolve(description.workingDirectory), repoRoot);
  assert.match(
    description.arguments,
    /^-NoProfile -ExecutionPolicy Bypass -NoExit -File ".+run-admin-server-windows\.ps1"$/,
  );
  assert.ok(path.isAbsolute(description.shortcutPath));
});

test('shortcut describe is deterministic and does not create the shortcut', () => {
  const first = runPowerShell(shortcutInstaller, ['-Describe']);
  assert.equal(first.status, 0, first.stderr);
  const description = JSON.parse(first.stdout);
  const existedBefore = fs.existsSync(description.shortcutPath);

  const second = runPowerShell(shortcutInstaller, ['-Describe']);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout), description);
  assert.equal(fs.existsSync(description.shortcutPath), existedBefore);
});

test('package scripts expose the manual Windows launch workflow', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(
    pkg.scripts['admin:windows'],
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/run-admin-server-windows.ps1',
  );
  assert.equal(
    pkg.scripts['admin:windows:install-shortcut'],
    'powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/install-windows-desktop-shortcut.ps1',
  );
});
