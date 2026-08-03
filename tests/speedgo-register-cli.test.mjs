import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  parseSpeedgoRegisterArgs,
  runSpeedgoRegisterCli,
  SpeedgoRegisterArgumentError,
} from '../scripts/speedgo-register.mjs';

function captureStream() {
  const chunks = [];
  return {
    chunks,
    write(value) {
      chunks.push(String(value));
      return true;
    },
  };
}

function validDependencies(overrides = {}) {
  const stdout = captureStream();
  const stderr = captureStream();
  const calls = {};
  const db = {
    ended: 0,
    async end() {
      this.ended += 1;
    },
  };
  return {
    rootDir: 'C:/automoney',
    stdout,
    stderr,
    loadDatabaseUrlImpl: async (rootDir) => {
      calls.databaseRoot = rootDir;
      return 'postgres://safe';
    },
    loadNaverCommerceConfigImpl: async (rootDir) => {
      calls.naverRoot = rootDir;
      return { clientId: 'client-safe', clientSecret: 'secret-safe', channelId: 'channel-safe' };
    },
    createPgPoolImpl: async (databaseUrl) => {
      calls.databaseUrl = databaseUrl;
      return db;
    },
    runRegistrationImpl: async (receivedDb, rootDir, draftId, options) => {
      calls.runner = { receivedDb, rootDir, draftId, options };
      return {
        status: 'completed',
        draftId,
        password: 'should-not-print',
        headers: { authorization: 'Bearer should-not-print' },
      };
    },
    ...overrides,
    calls,
    db,
  };
}

test('parseSpeedgoRegisterArgs parses all supported options', () => {
  assert.deepEqual(
    parseSpeedgoRegisterArgs(['501', '--confirm', '--headless', '--artifact-dir', 'C:/tmp/run']),
    { draftId: 501, confirm: true, headless: true, artifactDir: 'C:/tmp/run' },
  );
});

test('parseSpeedgoRegisterArgs defaults confirm and headless to false', () => {
  assert.deepEqual(parseSpeedgoRegisterArgs(['501']), {
    draftId: 501,
    confirm: false,
    headless: false,
    artifactDir: undefined,
  });
});

test('parseSpeedgoRegisterArgs rejects invalid or unsafe draft ids', () => {
  for (const value of ['', '0', '-1', '1.5', 'abc', '9007199254740992']) {
    assert.throws(() => parseSpeedgoRegisterArgs(value ? [value] : []), /positive integer/);
  }
  assert.throws(() => parseSpeedgoRegisterArgs(['1', '2']), /exactly one draft ID|duplicate|positional/);
});

test('parseSpeedgoRegisterArgs rejects unknown flags and malformed artifact-dir usage', () => {
  assert.throws(() => parseSpeedgoRegisterArgs(['501', '--wat']), /unknown flag/);
  assert.throws(() => parseSpeedgoRegisterArgs(['501', '--artifact-dir']), /artifact-dir.*value/);
  assert.throws(() => parseSpeedgoRegisterArgs(['501', '--artifact-dir', '--headless']), /artifact-dir.*value/);
  assert.throws(() => parseSpeedgoRegisterArgs(['501', '--confirm', '--confirm']), /duplicate/);
});

test('runSpeedgoRegisterCli passes parsed options and loaded config to the runner', async () => {
  const deps = validDependencies();
  const exitCode = await runSpeedgoRegisterCli(
    ['501', '--confirm', '--headless', '--artifact-dir', 'C:/tmp/run'],
    deps,
  );

  assert.equal(exitCode, 0);
  assert.equal(deps.calls.databaseRoot, 'C:/automoney');
  assert.equal(deps.calls.naverRoot, 'C:/automoney');
  assert.equal(deps.calls.databaseUrl, 'postgres://safe');
  assert.deepEqual(deps.calls.runner, {
    receivedDb: deps.db,
    rootDir: 'C:/automoney',
    draftId: 501,
    options: {
      confirm: true,
      headless: true,
      artifactDir: 'C:/tmp/run',
      naverConfig: { clientId: 'client-safe', clientSecret: 'secret-safe', channelId: 'channel-safe' },
    },
  });
});

test('runSpeedgoRegisterCli prints one redacted JSON success and closes the pool', async () => {
  const deps = validDependencies();
  const exitCode = await runSpeedgoRegisterCli(['501'], deps);

  assert.equal(exitCode, 0);
  assert.equal(deps.db.ended, 1);
  assert.equal(deps.stderr.chunks.length, 0);
  assert.equal(deps.stdout.chunks.length, 1);
  assert.deepEqual(JSON.parse(deps.stdout.chunks[0]), {
    status: 'completed',
    draftId: 501,
    password: '[REDACTED]',
    headers: { authorization: '[REDACTED]' },
  });
});

test('runSpeedgoRegisterCli emits success only after the database closes cleanly', async () => {
  const events = [];
  const deps = validDependencies({
    stdout: {
      write(value) {
        events.push(`stdout:${value.trim()}`);
        return true;
      },
    },
    createPgPoolImpl: async () => ({
      async end() {
        events.push('db.end');
      },
    }),
    runRegistrationImpl: async () => {
      events.push('runner');
      return { status: 'completed' };
    },
  });

  assert.equal(await runSpeedgoRegisterCli(['501'], deps), 0);
  assert.deepEqual(events, ['runner', 'db.end', 'stdout:{"status":"completed"}']);
});

test('runSpeedgoRegisterCli suppresses success output when database cleanup fails', async () => {
  const deps = validDependencies({
    createPgPoolImpl: async () => ({
      async end() {
        throw new Error('connection close failed');
      },
    }),
  });

  assert.equal(await runSpeedgoRegisterCli(['501'], deps), 1);
  assert.equal(deps.stdout.chunks.length, 0);
  assert.equal(deps.stderr.chunks.length, 1);
  assert.match(deps.stderr.chunks[0], /^SPEEDGO_DB_CLOSE_FAILED: registration failed\n$/);
});

test('runSpeedgoRegisterCli omits raw bodies and recursively redacts serialized JSON', async () => {
  const deps = validDependencies({
    runRegistrationImpl: async () => ({
      status: 'completed',
      originProductNo: '777',
      rawApiBody: { originProductNo: 'raw-777', clientSecret: 'raw-secret' },
      responseBody: JSON.stringify({ originProductNo: 'raw-888', token: 'raw-token' }),
      bodyPreview: JSON.stringify({ message: 'raw response body' }),
      responsePreview: 'raw response preview',
      requestPreview: 'raw request preview',
      apiResponsePreview: 'raw API response preview',
      rawResponse: { secret: 'raw response secret' },
      requestBody: { token: 'raw request token' },
      responseCode: 200,
      requestId: 'request-123',
      ordinaryPreview: 'retain this useful field',
      diagnostics: JSON.stringify({
        clientSecret: 'serialized-secret',
        token: 'serialized-token',
        cookie: 'serialized-cookie',
        authorization: 'Bearer serialized-auth',
        safe: 'retained',
      }),
    }),
  });

  assert.equal(await runSpeedgoRegisterCli(['501'], deps), 0);
  const output = deps.stdout.chunks.join('');
  const result = JSON.parse(output);
  assert.deepEqual(result, {
    status: 'completed',
    originProductNo: '777',
    responseCode: 200,
    requestId: 'request-123',
    ordinaryPreview: 'retain this useful field',
    diagnostics: JSON.stringify({
      clientSecret: '[REDACTED]',
      token: '[REDACTED]',
      cookie: '[REDACTED]',
      authorization: '[REDACTED]',
      safe: 'retained',
    }),
  });
  assert.doesNotMatch(output, /raw-777|raw-888|raw-secret|raw-token|raw response body|raw response preview|raw request preview|raw API response preview|raw response secret|raw request token|serialized-secret|serialized-token|serialized-cookie|serialized-auth/);
});

test('runSpeedgoRegisterCli redacts API, access, private, and auth key aliases', async () => {
  const deps = validDependencies({
    runRegistrationImpl: async () => ({
      apiKey: 'api-key-literal',
      api_key: 'api-underscore-literal',
      'API-Key': 'api-header-literal',
      accessKey: 'access-key-literal',
      access_key: 'access-underscore-literal',
      privateKey: 'private-key-literal',
      private_key: 'private-underscore-literal',
      auth: 'auth-literal',
      diagnostics: JSON.stringify({
        apiKey: 'serialized-api-key',
        access_key: 'serialized-access-key',
        privateKey: 'serialized-private-key',
        authorization: 'serialized-authorization',
        safe: 'retained',
      }),
    }),
  });

  assert.equal(await runSpeedgoRegisterCli(['501'], deps), 0);
  const output = deps.stdout.chunks.join('');
  const result = JSON.parse(output);
  assert.deepEqual(result, {
    apiKey: '[REDACTED]',
    api_key: '[REDACTED]',
    'API-Key': '[REDACTED]',
    accessKey: '[REDACTED]',
    access_key: '[REDACTED]',
    privateKey: '[REDACTED]',
    private_key: '[REDACTED]',
    auth: '[REDACTED]',
    diagnostics: JSON.stringify({
      apiKey: '[REDACTED]',
      access_key: '[REDACTED]',
      privateKey: '[REDACTED]',
      authorization: '[REDACTED]',
      safe: 'retained',
    }),
  });
  assert.doesNotMatch(output, /api-key-literal|api-underscore-literal|api-header-literal|access-key-literal|access-underscore-literal|private-key-literal|private-underscore-literal|auth-literal|serialized-api-key|serialized-access-key|serialized-private-key|serialized-authorization/);
});

test('runSpeedgoRegisterCli maps runtime failures to exit 1 with compact coded stderr', async () => {
  const deps = validDependencies({
    runRegistrationImpl: async () => {
      const error = new Error('raw API body password=do-not-print');
      error.code = 'SPEEDGO_SESSION_EXPIRED';
      throw error;
    },
  });

  const exitCode = await runSpeedgoRegisterCli(['501'], deps);

  assert.equal(exitCode, 1);
  assert.equal(deps.db.ended, 1);
  assert.equal(deps.stdout.chunks.length, 0);
  assert.equal(deps.stderr.chunks.length, 1);
  assert.match(deps.stderr.chunks[0], /SPEEDGO_SESSION_EXPIRED/);
  assert.doesNotMatch(deps.stderr.chunks[0], /raw API body|do-not-print/);
});

test('runSpeedgoRegisterCli maps argument and config failures to exit 2', async () => {
  const argumentDeps = validDependencies();
  assert.equal(await runSpeedgoRegisterCli(['0'], argumentDeps), 2);
  assert.equal(argumentDeps.db.ended, 0);
  assert.match(argumentDeps.stderr.chunks[0], /SPEEDGO_ARGUMENT_ERROR/);

  const configDeps = validDependencies({
    loadDatabaseUrlImpl: async () => {
      throw new Error('DATABASE_URL is missing in .env');
    },
  });
  assert.equal(await runSpeedgoRegisterCli(['501'], configDeps), 2);
  assert.equal(configDeps.db.ended, 0);
  assert.match(configDeps.stderr.chunks[0], /SPEEDGO_CONFIG_ERROR/);
});

test('parseSpeedgoRegisterArgs rejects a non-string artifact directory value', () => {
  assert.throws(
    () => parseSpeedgoRegisterArgs(['501', '--artifact-dir', 123]),
    (error) => error instanceof SpeedgoRegisterArgumentError && /requires a value/.test(error.message),
  );
});

test('importing the CLI module does not execute it', () => {
  const moduleUrl = new URL('../scripts/speedgo-register.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(moduleUrl)})`], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
