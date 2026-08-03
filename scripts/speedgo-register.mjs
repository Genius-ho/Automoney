import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadDatabaseUrl, loadNaverCommerceConfig } from '../src/config.mjs';
import { createPgPool } from '../src/postgres-store.mjs';
import { runSpeedgoNaverRegistration } from '../src/speedgo-registration.mjs';
import { redactSpeedgoValue } from '../src/speedgo-artifacts.mjs';

export class SpeedgoRegisterArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SpeedgoRegisterArgumentError';
    this.code = 'SPEEDGO_ARGUMENT_ERROR';
  }
}

function invalidDraftId() {
  return new SpeedgoRegisterArgumentError('draft ID must be a positive integer');
}

export function parseSpeedgoRegisterArgs(argv) {
  if (!Array.isArray(argv)) throw new SpeedgoRegisterArgumentError('arguments must be an array');

  let draftIdToken;
  let confirm = false;
  let headless = false;
  let artifactDir;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--confirm') {
      if (confirm) throw new SpeedgoRegisterArgumentError('duplicate --confirm flag');
      confirm = true;
      continue;
    }
    if (arg === '--headless') {
      if (headless) throw new SpeedgoRegisterArgumentError('duplicate --headless flag');
      headless = true;
      continue;
    }
    if (arg === '--artifact-dir') {
      if (artifactDir !== undefined) throw new SpeedgoRegisterArgumentError('duplicate --artifact-dir flag');
      const value = argv[index + 1];
      if (typeof value !== 'string' || !value || value.startsWith('-')) {
        throw new SpeedgoRegisterArgumentError('--artifact-dir requires a value');
      }
      artifactDir = value;
      index += 1;
      continue;
    }
    if (typeof arg === 'string' && arg.startsWith('-') && !/^-?\d/.test(arg)) {
      throw new SpeedgoRegisterArgumentError(`unknown flag: ${arg}`);
    }
    if (draftIdToken !== undefined) {
      throw new SpeedgoRegisterArgumentError('exactly one draft ID is required; duplicate positional ID');
    }
    draftIdToken = arg;
  }

  if (draftIdToken === undefined || !/^[1-9]\d*$/.test(String(draftIdToken))) {
    throw invalidDraftId();
  }
  const draftId = Number(draftIdToken);
  if (!Number.isSafeInteger(draftId) || draftId <= 0) throw invalidDraftId();

  return { draftId, confirm, headless, artifactDir };
}

function writeLine(stream, value) {
  stream.write(`${value}\n`);
}

const OMIT_OUTPUT_FIELD = Symbol('omit-output-field');

function compactOutputKey(key) {
  return String(key).replace(/[^a-z]/gi, '').toLowerCase();
}

function isSensitiveOutputKey(key) {
  return /password|secret|token|auth|cookie|apikey|accesskey|privatekey/i.test(compactOutputKey(key));
}

function isRawBodyOutputKey(key) {
  const compact = compactOutputKey(key);
  if (/^body(?:preview|payload|json)?$/.test(compact)) return true;
  const hasTransportMarker = /raw|api|request|response/.test(compact);
  const endsWithBodyLikeField = /(?:body|payload|preview|request|response)(?:json)?$/.test(compact);
  return hasTransportMarker && endsWithBodyLikeField;
}

function sanitizeCliOutput(value, key = '') {
  if (key && isRawBodyOutputKey(key)) return OMIT_OUTPUT_FIELD;
  if (key && isSensitiveOutputKey(key)) return '[REDACTED]';
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeCliOutput(item))
      .filter((item) => item !== OMIT_OUTPUT_FIELD);
  }
  if (value && typeof value === 'object') {
    const sanitized = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const result = sanitizeCliOutput(childValue, childKey);
      if (result !== OMIT_OUTPUT_FIELD) sanitized[childKey] = result;
    }
    return sanitized;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') {
        const sanitized = sanitizeCliOutput(parsed);
        return JSON.stringify(sanitized);
      }
    } catch {
      // Preserve useful non-JSON text while still masking bearer credentials.
    }
    return value.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
  }
  return value;
}

function safeRuntimeCode(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return /^[A-Z][A-Z0-9_]{2,80}$/.test(code) ? code : 'SPEEDGO_RUNTIME_ERROR';
}

function writeFailure(stderr, code) {
  writeLine(stderr, `${code}: registration failed`);
}

export async function runSpeedgoRegisterCli(argv = process.argv.slice(2), dependencies = {}) {
  const {
    rootDir = process.cwd(),
    stdout = process.stdout,
    stderr = process.stderr,
    loadDatabaseUrlImpl = loadDatabaseUrl,
    loadNaverCommerceConfigImpl = loadNaverCommerceConfig,
    createPgPoolImpl = createPgPool,
    runRegistrationImpl = runSpeedgoNaverRegistration,
    redactImpl = redactSpeedgoValue,
  } = dependencies;

  let args;
  try {
    args = parseSpeedgoRegisterArgs(argv);
  } catch (error) {
    writeFailure(stderr, 'SPEEDGO_ARGUMENT_ERROR');
    return 2;
  }

  let db = null;
  let phase = 'config';
  let exitCode = 0;
  let serializedResult;

  try {
    const databaseUrl = await loadDatabaseUrlImpl(rootDir);
    const naverConfig = await loadNaverCommerceConfigImpl(rootDir);
    db = await createPgPoolImpl(databaseUrl);
    phase = 'runtime';
    const result = await runRegistrationImpl(db, rootDir, args.draftId, {
      confirm: args.confirm,
      headless: args.headless,
      artifactDir: args.artifactDir,
      naverConfig,
    });
    const sanitizedResult = sanitizeCliOutput(result);
    const redactedResult = sanitizeCliOutput(redactImpl(sanitizedResult));
    serializedResult = JSON.stringify(redactedResult === undefined ? null : redactedResult);
  } catch (error) {
    exitCode = phase === 'config' ? 2 : 1;
    writeFailure(stderr, phase === 'config' ? 'SPEEDGO_CONFIG_ERROR' : safeRuntimeCode(error));
  } finally {
    if (db) {
      try {
        await db.end();
      } catch {
        if (exitCode === 0) {
          exitCode = 1;
          writeFailure(stderr, 'SPEEDGO_DB_CLOSE_FAILED');
        }
      }
    }
  }

  if (exitCode === 0) writeLine(stdout, serializedResult ?? 'null');
  return exitCode;
}

export function isMainModule(metaUrl = import.meta.url, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    const modulePath = resolve(fileURLToPath(metaUrl));
    const entryPath = resolve(argv1);
    return process.platform === 'win32'
      ? modulePath.toLowerCase() === entryPath.toLowerCase()
      : modulePath === entryPath;
  } catch {
    return false;
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  return runSpeedgoRegisterCli(argv, dependencies);
}

if (isMainModule()) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch(() => {
    process.stderr.write('SPEEDGO_RUNTIME_ERROR: registration failed\n');
    process.exitCode = 1;
  });
}
