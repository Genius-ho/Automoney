import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getDomemeSession,
  saveDomemeSession,
  touchDomemeSessionRenewal,
  clearDomemeSession,
} from '../src/domeme-session-store.mjs';

test('getDomemeSession returns null when no session has ever been saved (s_id is null)', async () => {
  const db = { async query() { return { rows: [{ id: 1, s_id: null }] }; } };
  assert.equal(await getDomemeSession(db), null);
});

test('getDomemeSession maps a saved row to camelCase', async () => {
  const db = {
    async query() {
      return { rows: [{ s_id: 'sess-1', c_id: 'check-1', grade: 'c', s_id_renew_date: '123', logged_in_at: 't1', updated_at: 't2' }] };
    },
  };
  const session = await getDomemeSession(db);
  assert.deepEqual(session, { sId: 'sess-1', cId: 'check-1', grade: 'c', sIdRenewDate: 123, loggedInAt: 't1', updatedAt: 't2' });
});

test('saveDomemeSession upserts the single row and requires sId', async () => {
  let captured;
  const db = {
    async query(sql, params) {
      captured = { sql, params };
      return { rows: [{ s_id: 'sess-1', c_id: 'check-1', grade: 'c', s_id_renew_date: 123 }] };
    },
  };
  await saveDomemeSession(db, { sId: 'sess-1', cId: 'check-1', grade: 'c', sIdRenewDate: 123 });
  assert.match(captured.sql, /on conflict \(id\) do update/);
  assert.deepEqual(captured.params, ['sess-1', 'check-1', 'c', 123]);

  await assert.rejects(saveDomemeSession(db, {}), /sId is required/);
});

test('touchDomemeSessionRenewal only updates s_id_renew_date', async () => {
  let captured;
  const db = {
    async query(sql, params) {
      captured = { sql, params };
      return { rows: [{ s_id: 'sess-1', s_id_renew_date: 456 }] };
    },
  };
  await touchDomemeSessionRenewal(db, 456);
  assert.match(captured.sql, /s_id_renew_date = \$1/);
  assert.equal(captured.params[0], 456);
});

test('clearDomemeSession nulls out the session fields', async () => {
  let captured;
  const db = { async query(sql, params) { captured = { sql, params }; return { rows: [] }; } };
  await clearDomemeSession(db);
  assert.match(captured.sql, /s_id = null/);
});
