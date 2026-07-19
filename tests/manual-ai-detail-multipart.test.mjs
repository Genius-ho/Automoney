import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  DETAIL_MULTIPART_LIMITS,
  finalizeDetailSetDirectory,
  receiveDetailMultipart,
  removeDetailSetDirectory,
} from '../src/manual-ai/detail-multipart.mjs';

const EXPECTED_FIELDS = {
  providerCode: 'chatgpt',
  providerDisplayName: 'ChatGPT',
  promptRequestId: '91',
  promptRevision: '2',
  notes: 'ordered detail set',
};

function field(name, value) {
  return {
    headers: `Content-Disposition: form-data; name="${name}"`,
    body: Buffer.from(value),
  };
}

function file(body, {
  name = 'images[]',
  filename = 'detail.png',
  mimeType = 'image/png',
} = {}) {
  return {
    headers: [
      `Content-Disposition: form-data; name="${name}"; filename="${filename}"`,
      `Content-Type: ${mimeType}`,
    ].join('\r\n'),
    body: Buffer.isBuffer(body) ? body : Buffer.from(body),
  };
}

function detailFiles(count, options = {}) {
  return Array.from({ length: count }, (_, offset) => {
    const imageIndex = offset + 1;
    return file(options.body?.(imageIndex) ?? `image-${imageIndex}`, {
      filename: options.filename?.(imageIndex) ?? `detail-${imageIndex}.png`,
      name: options.name?.(imageIndex) ?? 'images[]',
      mimeType: options.mimeType?.(imageIndex) ?? 'image/png',
    });
  });
}

function multipartRequest(parts, {
  boundary = 'automoney-detail-boundary',
  headers = {},
} = {}) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n${part.headers}\r\n\r\n`));
    chunks.push(part.body);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const request = Readable.from(chunks);
  request.headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    ...headers,
  };
  return request;
}

function erroredMultipartRequest() {
  const boundary = 'automoney-error-boundary';
  let sentHeader = false;
  const request = new Readable({
    read() {
      if (!sentHeader) {
        sentHeader = true;
        this.push(Buffer.from([
          `--${boundary}`,
          'Content-Disposition: form-data; name="images[]"; filename="partial.png"',
          'Content-Type: image/png',
          '',
          'partial-file-bytes',
        ].join('\r\n')));
        return;
      }
      this.destroy(new Error('connection reset during upload'));
    },
  });
  request.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
  return request;
}

function stalledInvalidMultipartRequest() {
  const boundary = 'automoney-stalled-boundary';
  let sent = false;
  const request = new Readable({
    read() {
      if (sent) return;
      sent = true;
      this.push(Buffer.from([
        `--${boundary}`,
        'Content-Disposition: form-data; name="unexpected"; filename="partial.png"',
        'Content-Type: image/png',
        '',
        'partial-file-body',
      ].join('\r\n')));
    },
  });
  request.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
  return request;
}

function chunkedOversizedRequest() {
  const boundary = 'automoney-aggregate-boundary';
  const chunk = Buffer.alloc(1_000_000, 0x61);
  let remaining = Math.floor(DETAIL_MULTIPART_LIMITS.maxRequestBytes / chunk.length) + 1;
  const request = new Readable({
    read() {
      if (remaining > 0) {
        remaining -= 1;
        this.push(chunk);
      }
    },
  });
  request.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
  return request;
}

function metadataParts() {
  return Object.entries(EXPECTED_FIELDS).map(([name, value]) => field(name, value));
}

async function tempRoot(t) {
  const rootDir = await mkdtemp(join(tmpdir(), 'automoney-detail-multipart-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  return rootDir;
}

function manualRoot(rootDir, draftId = 64) {
  return join(
    rootDir,
    'public',
    'generated-ai-images',
    'drafts',
    String(draftId),
    'detail',
    'manual',
  );
}

async function stagedEntries(rootDir) {
  try {
    return (await readdir(manualRoot(rootDir))).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function settleBeforeTimeout(operation, request, timeoutMs = 1_000) {
  let timeout;
  const result = await Promise.race([
    operation.then(
      (value) => ({ value }),
      (error) => ({ error }),
    ),
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    }),
  ]);
  clearTimeout(timeout);
  if (result.timedOut) {
    request.destroy(new Error('test cleanup after stalled upload'));
    await operation.catch(() => {});
  }
  return result;
}

test('streams exactly ten files in multipart arrival order and preserves known fields', async (t) => {
  const rootDir = await tempRoot(t);
  const uploads = detailFiles(10, {
    filename: (imageIndex) => imageIndex <= 2 ? 'duplicate.png' : `client-${imageIndex}.webp`,
    mimeType: (imageIndex) => imageIndex % 2 ? 'image/png' : 'image/webp',
  });
  const parts = [
    field('providerCode', EXPECTED_FIELDS.providerCode),
    uploads[0],
    field('providerDisplayName', EXPECTED_FIELDS.providerDisplayName),
    ...uploads.slice(1, 6),
    field('promptRequestId', EXPECTED_FIELDS.promptRequestId),
    field('promptRevision', EXPECTED_FIELDS.promptRevision),
    ...uploads.slice(6),
    field('notes', EXPECTED_FIELDS.notes),
  ];

  const received = await receiveDetailMultipart(multipartRequest(parts), { rootDir, draftId: 64 });
  t.after(received.cleanup);

  assert.equal(received.images.length, 10);
  assert.deepEqual(received.images.map((image) => image.imageIndex), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(received.images.slice(0, 2).map((image) => image.filename), ['duplicate.png', 'duplicate.png']);
  assert.equal(new Set(received.images.map((image) => image.path)).size, 10);
  assert.deepEqual(received.fields, EXPECTED_FIELDS);
  for (const [offset, image] of received.images.entries()) {
    assert.equal((await readFile(image.path)).toString(), `image-${offset + 1}`);
    assert.equal(image.fileSize, Buffer.byteLength(`image-${offset + 1}`));
    assert.equal(image.mimeType, offset % 2 === 0 ? 'image/png' : 'image/webp');
  }
});

test('eight files fail with the exact 422 payload contract and no residue', async (t) => {
  const rootDir = await tempRoot(t);
  const request = multipartRequest(detailFiles(8));
  await assert.rejects(
    () => receiveDetailMultipart(request, { rootDir, draftId: 64 }),
    (error) => error.code === 'DETAIL_IMAGE_COUNT_INVALID'
      && error.expectedCount === 10
      && error.receivedCount === 8,
  );
  assert.deepEqual(await stagedEntries(rootDir), []);
});

test('nine and eleven files fail with their received count and leave no staged files', async (t) => {
  for (const receivedCount of [9, 11]) {
    const rootDir = await tempRoot(t);
    await assert.rejects(
      () => receiveDetailMultipart(multipartRequest(detailFiles(receivedCount)), { rootDir, draftId: 64 }),
      (error) => error.code === 'DETAIL_IMAGE_COUNT_INVALID'
        && error.expectedCount === 10
        && error.receivedCount === receivedCount,
    );
    assert.deepEqual(await stagedEntries(rootDir), []);
  }
});

test('rejects unknown text fields and wrong file field names without residue', async (t) => {
  for (const parts of [
    [...detailFiles(10), field('unexpected', 'value')],
    detailFiles(10, { name: (imageIndex) => imageIndex === 4 ? 'images' : 'images[]' }),
  ]) {
    const rootDir = await tempRoot(t);
    await assert.rejects(
      () => receiveDetailMultipart(multipartRequest(parts), { rootDir, draftId: 64 }),
      (error) => error.code === 'UNKNOWN_MULTIPART_FIELD',
    );
    assert.deepEqual(await stagedEntries(rootDir), []);
  }
});

test('rejects and cleans an invalid multipart part before the request reaches EOF', async (t) => {
  const rootDir = await tempRoot(t);
  const request = stalledInvalidMultipartRequest();
  const operation = receiveDetailMultipart(request, { rootDir, draftId: 64 });
  const result = await settleBeforeTimeout(operation, request);
  request.destroy();

  assert.equal(result.timedOut, undefined, 'receiver waited for EOF after a terminal multipart error');
  assert.equal(result.error?.code, 'UNKNOWN_MULTIPART_FIELD');
  assert.deepEqual(await stagedEntries(rootDir), []);
});

test('accepts a file at exactly 10,000,000 bytes', async (t) => {
  const rootDir = await tempRoot(t);
  const parts = detailFiles(10, {
    body: (imageIndex) => imageIndex === 3
      ? Buffer.alloc(DETAIL_MULTIPART_LIMITS.maxFileBytes, 0x61)
      : Buffer.from(`small-${imageIndex}`),
  });
  const received = await receiveDetailMultipart(multipartRequest(parts), { rootDir, draftId: 64 });
  t.after(received.cleanup);
  assert.equal(received.images[2].fileSize, 10_000_000);
  assert.equal((await stat(received.images[2].path)).size, 10_000_000);
});

test('rejects a file above 10,000,000 bytes and removes every partial file', async (t) => {
  const rootDir = await tempRoot(t);
  const parts = detailFiles(10, {
    body: (imageIndex) => imageIndex === 3
      ? Buffer.alloc(DETAIL_MULTIPART_LIMITS.maxFileBytes + 1, 0x61)
      : Buffer.from(`small-${imageIndex}`),
  });
  await assert.rejects(
    () => receiveDetailMultipart(multipartRequest(parts), { rootDir, draftId: 64 }),
    (error) => error.code === 'UPLOAD_TOO_LARGE'
      && error.imageIndex === 3
      && error.maxFileSize === 10_000_000,
  );
  assert.deepEqual(await stagedEntries(rootDir), []);
});

test('rejects a declared aggregate request above the bounded input limit before staging', async (t) => {
  const rootDir = await tempRoot(t);
  const request = multipartRequest(detailFiles(10), {
    headers: { 'content-length': String(DETAIL_MULTIPART_LIMITS.maxRequestBytes + 1) },
  });
  await assert.rejects(
    () => receiveDetailMultipart(request, { rootDir, draftId: 64 }),
    (error) => error.code === 'UPLOAD_TOO_LARGE'
      && error.maxRequestSize === DETAIL_MULTIPART_LIMITS.maxRequestBytes,
  );
  assert.deepEqual(await stagedEntries(rootDir), []);
});

test('rejects actual chunked input above the aggregate request bound', async (t) => {
  const rootDir = await tempRoot(t);
  const request = chunkedOversizedRequest();
  try {
    await assert.rejects(
      () => receiveDetailMultipart(request, { rootDir, draftId: 64 }),
      (error) => error.code === 'UPLOAD_TOO_LARGE'
        && error.maxRequestSize === DETAIL_MULTIPART_LIMITS.maxRequestBytes,
    );
  } finally {
    request.destroy();
  }
  assert.deepEqual(await stagedEntries(rootDir), []);
});

test('request stream errors remove a partially written staging directory', async (t) => {
  const rootDir = await tempRoot(t);
  await assert.rejects(
    () => receiveDetailMultipart(erroredMultipartRequest(), { rootDir, draftId: 64 }),
    /connection reset during upload/,
  );
  assert.deepEqual(await stagedEntries(rootDir), []);
});

test('cleanup is idempotent and removes only the unique staging directory', async (t) => {
  const rootDir = await tempRoot(t);
  const received = await receiveDetailMultipart(
    multipartRequest([...detailFiles(10), ...metadataParts()]),
    { rootDir, draftId: 64 },
  );
  assert.deepEqual(await stagedEntries(rootDir), [basename(received.stagingDir)]);
  const firstCleanup = received.cleanup();
  const secondCleanup = received.cleanup();
  assert.equal(secondCleanup, firstCleanup);
  await Promise.all([firstCleanup, secondCleanup]);
  await received.cleanup();
  assert.deepEqual(await stagedEntries(rootDir), []);
});

test('canonicalizes numeric draft, revision, and set-version path values', async (t) => {
  const rootDir = await tempRoot(t);
  const received = await receiveDetailMultipart(
    multipartRequest(detailFiles(10)),
    { rootDir, draftId: '064' },
  );
  const finalDir = await finalizeDetailSetDirectory({
    stagingDir: received.stagingDir,
    rootDir,
    draftId: '064',
    revision: '02',
    setVersion: '003',
  });
  assert.equal(finalDir, join(manualRoot(rootDir), 'r2-v3'));
  await removeDetailSetDirectory({ rootDir, draftId: 64, revision: 2, setVersion: 3 });
});

test('finalizes the whole staging directory at an immutable revision/version path', async (t) => {
  const rootDir = await tempRoot(t);
  const first = await receiveDetailMultipart(multipartRequest(detailFiles(10)), { rootDir, draftId: 64 });
  const firstFinalDir = await finalizeDetailSetDirectory({
    stagingDir: first.stagingDir,
    rootDir,
    draftId: 64,
    revision: 2,
    setVersion: 3,
  });
  assert.equal(firstFinalDir, join(manualRoot(rootDir), 'r2-v3'));
  assert.equal(await pathExists(first.stagingDir), false);
  assert.equal((await readFile(join(firstFinalDir, basename(first.images[0].path)))).toString(), 'image-1');

  const second = await receiveDetailMultipart(multipartRequest(detailFiles(10)), { rootDir, draftId: 64 });
  t.after(second.cleanup);
  await assert.rejects(
    () => finalizeDetailSetDirectory({
      stagingDir: second.stagingDir,
      rootDir,
      draftId: 64,
      revision: 2,
      setVersion: 3,
    }),
    (error) => error.code === 'DETAIL_SET_DIRECTORY_EXISTS',
  );
  assert.equal((await readFile(join(firstFinalDir, basename(first.images[0].path)))).toString(), 'image-1');
  assert.equal(await pathExists(second.stagingDir), true);

  await removeDetailSetDirectory({ rootDir, draftId: 64, revision: 2, setVersion: 3 });
  assert.equal(await pathExists(firstFinalDir), false);
});

test('a failed atomic rename never creates a partial final directory', async (t) => {
  const rootDir = await tempRoot(t);
  const missingStagingDir = join(manualRoot(rootDir), '.upload-missing');
  const finalDir = join(manualRoot(rootDir), 'r4-v7');
  await assert.rejects(
    () => finalizeDetailSetDirectory({
      stagingDir: missingStagingDir,
      rootDir,
      draftId: 64,
      revision: 4,
      setVersion: 7,
    }),
    (error) => error.code === 'ENOENT',
  );
  assert.equal(await pathExists(finalDir), false);
});
