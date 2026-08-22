import assert from 'node:assert/strict';
import test from 'node:test';

import { R2ApiError, R2Client, maskR2Secret } from '../src/r2-client.mjs';

function testClient(fetchImpl) {
  return new R2Client({
    accountId: 'acct123',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    bucket: 'automoney-products',
    publicBaseUrl: 'https://pub-example.r2.dev',
    fetchImpl,
  });
}

test('signRequest never embeds the secret access key in the Authorization header', () => {
  const client = testClient(async () => ({ ok: true, status: 200, async text() { return ''; } }));
  const headers = client.signRequest('PUT', '/automoney-products/test.txt', 'hello', { 'content-type': 'text/plain' });
  assert.match(headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
  assert.doesNotMatch(headers.authorization, /wJalrXUtnFEMI/);
  assert.match(headers.authorization, /Signature=[0-9a-f]{64}$/);
});

test('signRequest produces a different signature for a different secret, same request otherwise', () => {
  const clientA = testClient(async () => ({}));
  const clientB = new R2Client({
    accountId: 'acct123', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'a-completely-different-secret',
    bucket: 'automoney-products', publicBaseUrl: 'https://pub-example.r2.dev', fetchImpl: async () => ({}),
  });
  // Freeze x-amz-date by monkeypatching Date is unnecessary: compare the HMAC math directly instead.
  const sigA = clientA.signRequest('PUT', '/x', 'body', {}).authorization.match(/Signature=([0-9a-f]+)$/)[1];
  const sigB = clientB.signRequest('PUT', '/x', 'body', {}).authorization.match(/Signature=([0-9a-f]+)$/)[1];
  assert.notEqual(sigA, sigB);
});

test('putObject sends the object to the R2 S3-compatible endpoint and returns the public URL without a real HTTP call', async () => {
  const calls = [];
  const client = testClient(async (url, init) => {
    calls.push({ url: String(url), method: init.method, contentType: init.headers['content-type'] });
    return { ok: true, status: 200, async text() { return ''; } };
  });

  const result = await client.putObject('drafts/64/main.jpg', Buffer.from('fake-image-bytes'), 'image/jpeg');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://acct123.r2.cloudflarestorage.com/automoney-products/drafts/64/main.jpg');
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].contentType, 'image/jpeg');
  assert.equal(result.publicUrl, 'https://pub-example.r2.dev/drafts/64/main.jpg');
});

test('putObject surfaces a non-OK response as R2ApiError without leaking the secret', async () => {
  const client = testClient(async () => ({ ok: false, status: 403, async text() { return 'SignatureDoesNotMatch'; } }));
  await assert.rejects(
    () => client.putObject('x.jpg', Buffer.from('a'), 'image/jpeg'),
    (error) => {
      assert.ok(error instanceof R2ApiError);
      assert.equal(error.status, 403);
      assert.doesNotMatch(error.message, /wJalrXUtnFEMI/);
      return true;
    },
  );
});

test('headObject returns null on 404 (not-yet-uploaded) and the public URL when present', async () => {
  const missing = testClient(async () => ({ ok: false, status: 404, async text() { return ''; } }));
  assert.equal(await missing.headObject('nope.jpg'), null);

  const present = testClient(async () => ({ ok: true, status: 200, async text() { return ''; } }));
  const result = await present.headObject('drafts/64/abc123.jpg');
  assert.equal(result.publicUrl, 'https://pub-example.r2.dev/drafts/64/abc123.jpg');
});

test('deleteObject treats 404 as a successful no-op cleanup', async () => {
  const client = testClient(async () => ({ ok: false, status: 404, async text() { return 'NoSuchKey'; } }));
  const result = await client.deleteObject('already-gone.txt');
  assert.equal(result.deleted, true);
});

test('maskR2Secret keeps only the first four characters visible', () => {
  const masked = maskR2Secret('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
  assert.equal(masked.startsWith('wJal'), true);
  assert.equal(masked.includes('rXUt'), false);
  assert.equal(masked.length, 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'.length);
});
