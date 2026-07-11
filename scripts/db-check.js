#!/usr/bin/env node
import net from 'node:net';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const databaseUrl = await readDatabaseUrl(root);
const urlDetails = parseDatabaseUrl(databaseUrl);
const pgPackageAvailable = await canImportPg();
const tcpHost = ['localhost', '127.0.0.1', '::1'].includes(urlDetails.host) ? '127.0.0.1' : urlDetails.host;
const tcpConnectionTo5432 =
  tcpHost && urlDetails.port
    ? await canConnectTcp(tcpHost, urlDetails.port)
    : false;

let postgresConnection = false;
let postgresStatus = databaseUrl ? 'error' : 'disabled';
let errorCode = '-';
let errorMessage = '-';

if (databaseUrl && pgPackageAvailable) {
  let pool;
  try {
    const { Pool } = await import('pg');
    pool = new Pool({ connectionString: databaseUrl });
    await pool.query('select 1');
    postgresConnection = true;
    postgresStatus = 'enabled';
  } catch (error) {
    const info = describeError(error);
    errorCode = info.code;
    errorMessage = info.message;
  } finally {
    if (pool) await pool.end();
  }
} else if (!databaseUrl) {
  errorCode = 'DATABASE_URL_MISSING';
  errorMessage = 'DATABASE_URL is missing';
} else if (!pgPackageAvailable) {
  errorCode = 'PG_PACKAGE_MISSING';
  errorMessage = 'pg package is not installed';
}

console.log(`DATABASE_URL exists=${databaseUrl ? 'true' : 'false'}`);
console.log(`maskedDatabaseUrl=${databaseUrl ? maskDatabaseUrl(databaseUrl) : '-'}`);
console.log(`host=${urlDetails.host || '-'}`);
console.log(`port=${urlDetails.port || '-'}`);
console.log(`database=${urlDetails.database || '-'}`);
console.log(`pgPackageAvailable=${pgPackageAvailable ? 'true' : 'false'}`);
console.log(`tcpConnectionTo5432=${tcpConnectionTo5432 ? 'true' : 'false'}`);
console.log(`postgresConnection=${postgresConnection ? 'true' : 'false'}`);
console.log(`postgresStatus=${postgresStatus}`);
console.log(`errorCode=${errorCode}`);
console.log(`errorMessage=${errorMessage}`);
console.log(`nextAction=${nextAction({ databaseUrl, pgPackageAvailable, tcpConnectionTo5432, postgresConnection })}`);

async function readDatabaseUrl(rootDir) {
  if (process.env.DATABASE_URL?.trim()) return process.env.DATABASE_URL.trim();
  const envPath = existsSync(join(rootDir, '.env')) ? join(rootDir, '.env') : join(rootDir, 'env');
  if (!existsSync(envPath)) return '';
  const text = await readFile(envPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    if (key !== 'DATABASE_URL') continue;
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '').trim();
    if (value) return value;
  }
  return '';
}

function parseDatabaseUrl(value) {
  if (!value) return { host: '', port: '', database: '' };
  try {
    const url = new URL(value);
    return {
      host: url.hostname,
      port: Number(url.port || 5432),
      database: url.pathname.replace(/^\//, ''),
    };
  } catch {
    return { host: '', port: '', database: '' };
  }
}

function maskDatabaseUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = url.username ? '****' : '';
      url.password = url.password ? '****' : '';
    }
    return url.toString();
  } catch {
    return value.replace(/:\/\/.*@/, '://****@');
  }
}

async function canImportPg() {
  try {
    await import('pg');
    return true;
  } catch {
    return false;
  }
}

function canConnectTcp(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: 3000 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function describeError(error) {
  const nested = Array.isArray(error?.errors) ? error.errors.find(Boolean) : null;
  return {
    code: error?.code || nested?.code || error?.cause?.code || 'UNKNOWN',
    message:
      error?.message ||
      nested?.message ||
      error?.cause?.message ||
      String(error || 'Unknown database connection error'),
  };
}

function nextAction({ databaseUrl: value, pgPackageAvailable: hasPg, tcpConnectionTo5432: tcpOk, postgresConnection: pgOk }) {
  if (!value) return 'Add DATABASE_URL to the project root .env file.';
  if (!hasPg) return 'Run npm.cmd install to install the pg package.';
  if (!tcpOk) return 'Install and start PostgreSQL so it listens on the DATABASE_URL host and port.';
  if (!pgOk) return 'Check PostgreSQL username, password, database name, and pg_hba.conf access.';
  return 'Run npm.cmd run test:import twice to verify inserted then updated.';
}
