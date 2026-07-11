#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadEnvConfig } from '../src/config.mjs';
import { DomemeClient, maskApiKey, maskUrl } from '../src/domeme-client.mjs';

const root = process.cwd();
const envPath = existsSync(join(root, '.env')) ? join(root, '.env') : join(root, 'env');
const envText = await readFile(envPath, 'utf8');
const domemeLines = envText
  .split(/\r?\n/)
  .map((line, index) => ({ line, number: index + 1 }))
  .filter(({ line }) => /^\s*DOMEME_API_KEY\s*=/.test(line));

const config = await loadEnvConfig(root);
const key = config.domemeApiKey;
const suspiciousTokens = ['process.env', 'DOMEME_API_KEY', '{', '}', '$', '"', "'", '`'];
const suspiciousFound = suspiciousTokens.filter((token) => key.includes(token));
const client = new DomemeClient({ apiKey: key, endpoint: config.domemeEndpoint });
const sampleUrl = client.buildProductDetailUrl('49168396');

console.log(`envFile=${envPath}`);
console.log(`domemeKeyLineCount=${domemeLines.length}`);
console.log(`domemeKeyLines=${domemeLines.map(({ number }) => number).join(',') || '-'}`);
console.log(`keyPresent=${key.length > 0}`);
console.log(`keyMasked=${maskApiKey(key)}`);
console.log(`keyLength=${key.length}`);
console.log(`trimApplied=${key === key.trim()}`);
console.log(`containsWhitespace=${/\s/.test(key)}`);
console.log(`suspiciousTokens=${suspiciousFound.length ? suspiciousFound.join(',') : 'none'}`);
console.log(`requestUrlMasked=${maskUrl(sampleUrl)}`);
console.log(`aidEqualsKeyOnly=${sampleUrl.searchParams.get('aid') === key}`);
console.log(`marketParamPresent=${sampleUrl.searchParams.has('market')}`);
