import { createHash, createHmac } from 'node:crypto';

const REGION = 'auto';
const SERVICE = 's3';

export class R2ApiError extends Error {
  constructor({ status, operation, bodyPreview, key }) {
    super(`R2 API failed: HTTP ${status} operation=${operation}${key ? ` key=${key}` : ''}`);
    this.name = 'R2ApiError';
    this.status = status;
    this.operation = operation;
    this.bodyPreview = bodyPreview;
    this.key = key;
  }
}

export class R2Client {
  constructor({
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    publicBaseUrl,
    fetchImpl = globalThis.fetch,
  }) {
    if (!accountId) throw new Error('R2_ACCOUNT_ID is required');
    if (!accessKeyId) throw new Error('R2_ACCESS_KEY_ID is required');
    if (!secretAccessKey) throw new Error('R2_SECRET_ACCESS_KEY is required');
    if (!bucket) throw new Error('R2_BUCKET is required');
    if (!publicBaseUrl) throw new Error('R2_PUBLIC_BASE_URL is required');
    this.accountId = accountId;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.bucket = bucket;
    this.publicBaseUrl = publicBaseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.endpoint = `https://${accountId}.r2.cloudflarestorage.com`;
    this.host = `${accountId}.r2.cloudflarestorage.com`;
  }

  publicUrl(key) {
    return `${this.publicBaseUrl}/${key}`;
  }

  async putObject(key, body, contentType) {
    const path = `/${this.bucket}/${key}`;
    const headers = this.signRequest('PUT', path, body, { 'content-type': contentType || 'application/octet-stream' });
    const response = await this.fetchImpl(`${this.endpoint}${path}`, { method: 'PUT', headers, body });
    if (!response.ok) {
      throw new R2ApiError({ status: response.status, operation: 'put_object', bodyPreview: previewBody(await response.text()), key });
    }
    return { key, publicUrl: this.publicUrl(key) };
  }

  async headObject(key) {
    const path = `/${this.bucket}/${key}`;
    const headers = this.signRequest('HEAD', path, '', {});
    const response = await this.fetchImpl(`${this.endpoint}${path}`, { method: 'HEAD', headers });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new R2ApiError({ status: response.status, operation: 'head_object', bodyPreview: previewBody(await response.text().catch(() => '')), key });
    }
    return { key, publicUrl: this.publicUrl(key) };
  }

  async deleteObject(key) {
    const path = `/${this.bucket}/${key}`;
    const headers = this.signRequest('DELETE', path, '', {});
    const response = await this.fetchImpl(`${this.endpoint}${path}`, { method: 'DELETE', headers });
    if (!response.ok && response.status !== 404) {
      throw new R2ApiError({ status: response.status, operation: 'delete_object', bodyPreview: previewBody(await response.text()), key });
    }
    return { key, deleted: true };
  }

  // AWS Signature Version 4, the standard S3-compatible signing scheme R2
  // implements. The secret key and derived signing key are never returned or
  // logged by this method -- only the finished request headers are.
  signRequest(method, path, body, extraHeaders = {}) {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = createHash('sha256').update(body || '').digest('hex');

    const headers = {
      host: this.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...extraHeaders,
    };
    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join('');
    const signedHeaders = signedHeaderNames.join(';');

    const canonicalRequest = [
      method,
      path,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');

    const signingKey = deriveSigningKey(this.secretAccessKey, dateStamp);
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    const authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return { ...headers, authorization };
  }
}

function deriveSigningKey(secretAccessKey, dateStamp) {
  const kDate = createHmac('sha256', `AWS4${secretAccessKey}`).update(dateStamp).digest();
  const kRegion = createHmac('sha256', kDate).update(REGION).digest();
  const kService = createHmac('sha256', kRegion).update(SERVICE).digest();
  return createHmac('sha256', kService).update('aws4_request').digest();
}

export function maskR2Secret(value) {
  const text = String(value || '');
  if (text.length <= 4) return '*'.repeat(text.length);
  return `${text.slice(0, 4)}${'*'.repeat(text.length - 4)}`;
}

function previewBody(body, limit = 500) {
  return String(body || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
