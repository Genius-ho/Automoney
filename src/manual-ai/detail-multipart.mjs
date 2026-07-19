import Busboy from 'busboy';
import { createWriteStream } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const EXPECTED_IMAGE_COUNT = 10;
const MAX_FILE_BYTES = 10_000_000;
const MAX_REQUEST_BYTES = 101_000_000;
const MAX_FIELD_BYTES = 16_384;
const KNOWN_FIELDS = new Set([
  'providerCode',
  'providerDisplayName',
  'promptRequestId',
  'promptRevision',
  'notes',
]);

export const DETAIL_MULTIPART_LIMITS = Object.freeze({
  expectedImageCount: EXPECTED_IMAGE_COUNT,
  maxFileBytes: MAX_FILE_BYTES,
  maxRequestBytes: MAX_REQUEST_BYTES,
  maxFieldBytes: MAX_FIELD_BYTES,
});

export async function receiveDetailMultipart(request, { rootDir, draftId }) {
  const directory = detailManualDirectory(rootDir, draftId);
  assertDeclaredRequestSize(request);
  const closingBoundary = readMultipartBoundary(request);

  let parser;
  try {
    parser = Busboy({
      headers: request.headers,
      limits: {
        fieldNameSize: 100,
        fieldSize: MAX_FIELD_BYTES,
        fields: KNOWN_FIELDS.size + 1,
        fileSize: MAX_FILE_BYTES + 1,
        files: EXPECTED_IMAGE_COUNT,
        parts: EXPECTED_IMAGE_COUNT + KNOWN_FIELDS.size + 1,
        headerPairs: 100,
      },
    });
  } catch (cause) {
    throw detailMultipartError(
      'MULTIPART_REQUIRED',
      'multipart/form-data with a valid boundary is required',
      {},
      cause,
    );
  }

  await mkdir(directory, { recursive: true });
  const stagingDir = await mkdtemp(join(directory, '.upload-'));
  const images = [];
  const fields = {};
  const fileTasks = [];
  let receivedCount = 0;
  let requestBytes = 0;
  let fatalError = null;
  let signalFailure;
  const failureSignal = new Promise((resolveFailure) => {
    signalFailure = resolveFailure;
  });

  const fail = (error) => {
    if (fatalError) return;
    fatalError = error;
    signalFailure(error);
  };
  const parserCompletion = new Promise((complete) => {
    parser.once('close', complete);
    parser.once('error', (error) => {
      fail(error);
      complete();
    });
  });

  parser.on('file', (name, fileStream, info) => {
    receivedCount += 1;
    if (name !== 'images[]') {
      fail(detailMultipartError(
        'UNKNOWN_MULTIPART_FIELD',
        `Unknown multipart field: ${name}`,
        { fieldName: name },
      ));
      fileStream.resume();
      return;
    }
    if (receivedCount > EXPECTED_IMAGE_COUNT) {
      fail(imageCountError(receivedCount));
      fileStream.resume();
      return;
    }

    const imageIndex = receivedCount;
    const path = join(stagingDir, `upload-${String(imageIndex).padStart(2, '0')}`);
    const descriptor = {
      imageIndex,
      path,
      filename: info.filename || 'upload',
      mimeType: String(info.mimeType || '').toLowerCase(),
      fileSize: 0,
    };
    images.push(descriptor);

    const counter = new Transform({
      transform(chunk, encoding, callback) {
        descriptor.fileSize += chunk.length;
        if (descriptor.fileSize > MAX_FILE_BYTES) {
          fail(fileSizeError(imageIndex));
        }
        callback(null, chunk);
      },
    });
    fileStream.once('limit', () => fail(fileSizeError(imageIndex)));

    const task = pipeline(
      fileStream,
      counter,
      createWriteStream(path, { flags: 'wx' }),
    ).catch((error) => {
      fail(error);
    });
    fileTasks.push(task);
  });

  parser.on('field', (name, value, info) => {
    if (!KNOWN_FIELDS.has(name)) {
      fail(detailMultipartError(
        'UNKNOWN_MULTIPART_FIELD',
        `Unknown multipart field: ${name}`,
        { fieldName: name },
      ));
      return;
    }
    if (info.nameTruncated || info.valueTruncated) {
      fail(detailMultipartError(
        'UPLOAD_TOO_LARGE',
        `Multipart field ${name} exceeds ${MAX_FIELD_BYTES} bytes`,
        { fieldName: name, maxFieldSize: MAX_FIELD_BYTES },
      ));
      return;
    }
    fields[name] = value;
  });
  parser.once('filesLimit', () => fail(imageCountError(receivedCount + 1)));
  parser.once('fieldsLimit', () => fail(detailMultipartError(
    'MULTIPART_FIELDS_LIMIT_EXCEEDED',
    'Multipart request contains too many text fields',
  )));
  parser.once('partsLimit', () => fail(detailMultipartError(
    'MULTIPART_PARTS_LIMIT_EXCEEDED',
    'Multipart request contains too many parts',
  )));

  const requestAborted = () => fail(detailMultipartError(
    'MULTIPART_REQUEST_ABORTED',
    'Multipart request was aborted before completion',
  ));
  const requestFailed = (error) => fail(error);
  let resumeAfterDrain;
  let signalRequestEnd;
  const requestEnded = new Promise((complete) => {
    signalRequestEnd = complete;
  });
  const requestComplete = () => signalRequestEnd();
  const consumeChunk = (chunk) => {
    request.pause?.();
    requestBytes += chunk.length;
    if (requestBytes > MAX_REQUEST_BYTES) {
      fail(requestSizeError());
      request.resume?.();
      return;
    }
    const acceptsMore = parser.write(chunk);
    if (fatalError) {
      request.resume?.();
      return;
    }
    if (acceptsMore) {
      request.resume?.();
      return;
    }
    resumeAfterDrain = () => {
      resumeAfterDrain = undefined;
      request.resume?.();
    };
    parser.once('drain', resumeAfterDrain);
  };
  request.once?.('end', requestComplete);
  request.once?.('aborted', requestAborted);
  request.once?.('error', requestFailed);
  request.on?.('data', consumeChunk);

  try {
    await Promise.race([requestEnded, failureSignal]);
    if (fatalError && !await endsThisTurn(requestEnded)) throw fatalError;
    parser.end();
    await parserCompletion;
    await Promise.all(fileTasks);
    if (fatalError) throw fatalError;
    if (receivedCount !== EXPECTED_IMAGE_COUNT) throw imageCountError(receivedCount);

    let cleanupPromise;
    return {
      stagingDir,
      images,
      fields,
      cleanup: () => {
        if (!cleanupPromise) {
          cleanupPromise = rm(stagingDir, { recursive: true, force: true }).catch((error) => {
            cleanupPromise = undefined;
            throw error;
          });
        }
        return cleanupPromise;
      },
    };
  } catch (error) {
    fail(error);
    request.removeListener?.('data', consumeChunk);
    if (resumeAfterDrain) parser.removeListener('drain', resumeAfterDrain);
    abortParser(parser, closingBoundary);
    const requestDrain = drainAvailableRequest(request);
    await parserCompletion;
    await Promise.all(fileTasks);
    await requestDrain;
    await rm(stagingDir, { recursive: true, force: true });
    throw fatalError || error;
  } finally {
    request.removeListener?.('data', consumeChunk);
    request.removeListener?.('end', requestComplete);
    if (!fatalError) {
      request.removeListener?.('aborted', requestAborted);
      request.removeListener?.('error', requestFailed);
    }
  }
}

export async function finalizeDetailSetDirectory({
  stagingDir,
  rootDir,
  draftId,
  revision,
  setVersion,
}) {
  const directory = detailManualDirectory(rootDir, draftId);
  const normalizedRevision = normalizeVersionNumber(revision, 'revision');
  const normalizedSetVersion = normalizeVersionNumber(setVersion, 'setVersion');
  assertOwnedStagingDirectory(stagingDir, directory);
  await mkdir(directory, { recursive: true });

  const finalDir = join(directory, `r${normalizedRevision}-v${normalizedSetVersion}`);
  const lockPath = join(directory, `.r${normalizedRevision}-v${normalizedSetVersion}.lock`);
  let lock;
  try {
    try {
      lock = await open(lockPath, 'wx');
    } catch (cause) {
      if (cause.code === 'EEXIST') throw directoryExistsError(finalDir, cause);
      throw cause;
    }
    if (await exists(finalDir)) throw directoryExistsError(finalDir);
    await rename(stagingDir, finalDir);
    return finalDir;
  } finally {
    await lock?.close().catch(() => {});
    // Lock cleanup must never override the result of the atomic rename.
    if (lock) await rm(lockPath, { force: true }).catch(() => {});
  }
}

export async function removeDetailSetDirectory({
  rootDir,
  draftId,
  revision,
  setVersion,
}) {
  const directory = detailManualDirectory(rootDir, draftId);
  const normalizedRevision = normalizeVersionNumber(revision, 'revision');
  const normalizedSetVersion = normalizeVersionNumber(setVersion, 'setVersion');
  const finalDir = join(directory, `r${normalizedRevision}-v${normalizedSetVersion}`);
  await rm(finalDir, { recursive: true, force: true });
  return finalDir;
}

function detailManualDirectory(rootDir, draftId) {
  if (typeof rootDir !== 'string' || rootDir.length === 0) {
    throw detailMultipartError('DETAIL_ROOT_DIRECTORY_INVALID', 'rootDir is required');
  }
  const normalizedDraftId = normalizeVersionNumber(draftId, 'draftId');
  return join(
    resolve(rootDir),
    'public',
    'generated-ai-images',
    'drafts',
    String(normalizedDraftId),
    'detail',
    'manual',
  );
}

function normalizeVersionNumber(value, name) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1 || String(value).trim() === '') {
    throw detailMultipartError(
      'DETAIL_PATH_COMPONENT_INVALID',
      `${name} must be a positive safe integer`,
      { component: name },
    );
  }
  return normalized;
}

function assertOwnedStagingDirectory(stagingDir, directory) {
  const resolvedStagingDir = resolve(String(stagingDir || ''));
  if (
    dirname(resolvedStagingDir) !== resolve(directory)
    || !basename(resolvedStagingDir).startsWith('.upload-')
  ) {
    throw detailMultipartError(
      'DETAIL_STAGING_DIRECTORY_INVALID',
      'Staging directory must be an upload directory for this draft',
    );
  }
}

function assertDeclaredRequestSize(request) {
  const value = request.headers?.['content-length'];
  if (value === undefined) return;
  const contentLength = Number(Array.isArray(value) ? value[0] : value);
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
    throw detailMultipartError('CONTENT_LENGTH_INVALID', 'Content-Length must be a non-negative integer');
  }
  if (contentLength > MAX_REQUEST_BYTES) throw requestSizeError();
}

function readMultipartBoundary(request) {
  const contentType = String(request.headers?.['content-type'] || '');
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return (match?.[1] || match?.[2] || '').trim();
}

function abortParser(parser, boundary) {
  if (parser.destroyed || parser.writableEnded) return;
  try {
    parser.end(boundary ? Buffer.from(`\r\n--${boundary}--\r\n`) : undefined);
  } catch (error) {
    if (!parser.destroyed) parser.destroy(error);
  }
}

function drainAvailableRequest(request) {
  if (request.destroyed || request.readableEnded) return Promise.resolve();
  return new Promise((complete) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      request.removeListener?.('end', finish);
      request.removeListener?.('close', finish);
      request.removeListener?.('error', finish);
      complete();
    };
    request.once?.('end', finish);
    request.once?.('close', finish);
    request.once?.('error', finish);
    request.resume?.();
    setImmediate(() => {
      if (!settled) request.pause?.();
      finish();
    });
  });
}

function endsThisTurn(requestEnded) {
  return Promise.race([
    requestEnded.then(() => true),
    new Promise((complete) => setImmediate(() => complete(false))),
  ]);
}

function imageCountError(receivedCount) {
  return detailMultipartError(
    'DETAIL_IMAGE_COUNT_INVALID',
    `Detail page upload requires exactly ${EXPECTED_IMAGE_COUNT} images`,
    { expectedCount: EXPECTED_IMAGE_COUNT, receivedCount },
  );
}

function fileSizeError(imageIndex) {
  return detailMultipartError(
    'UPLOAD_TOO_LARGE',
    `Detail image ${imageIndex} exceeds ${MAX_FILE_BYTES} bytes`,
    { imageIndex, maxFileSize: MAX_FILE_BYTES },
  );
}

function requestSizeError() {
  return detailMultipartError(
    'UPLOAD_TOO_LARGE',
    `Multipart request exceeds ${MAX_REQUEST_BYTES} bytes`,
    { maxRequestSize: MAX_REQUEST_BYTES },
  );
}

function directoryExistsError(finalDir, cause) {
  return detailMultipartError(
    'DETAIL_SET_DIRECTORY_EXISTS',
    'Detail set version directory already exists',
    { finalDir },
    cause,
  );
}

function detailMultipartError(code, message, details = {}, cause) {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = code;
  Object.assign(error, details);
  return error;
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
