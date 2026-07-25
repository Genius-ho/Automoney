import assert from 'node:assert/strict';
import test from 'node:test';

import { getValidDomemeSId } from '../src/domeme-private-session.mjs';

test('getValidDomemeSId reuses a cached session when checkLogin reports it valid, without calling login()', async () => {
  let loginCalled = false;
  const client = {
    async checkLogin({ sId }) { assert.equal(sId, 'cached-sid'); return { valid: true, sIdRenewDate: 111 }; },
    async login() { loginCalled = true; return { sId: 'new-sid' }; },
  };
  const sId = await getValidDomemeSId({}, client, {
    getDomemeSessionImpl: async () => ({ sId: 'cached-sid', sIdRenewDate: 111 }),
    saveDomemeSessionImpl: async () => { throw new Error('should not save a fresh login'); },
    touchDomemeSessionRenewalImpl: async () => { throw new Error('should not touch -- renewal unchanged'); },
  });
  assert.equal(sId, 'cached-sid');
  assert.equal(loginCalled, false);
});

test('getValidDomemeSId persists a renewed sIdRenewDate without a fresh login', async () => {
  let touched;
  const client = {
    async checkLogin() { return { valid: true, sIdRenewDate: 222 }; },
    async login() { throw new Error('should not log in'); },
  };
  const sId = await getValidDomemeSId({}, client, {
    getDomemeSessionImpl: async () => ({ sId: 'cached-sid', sIdRenewDate: 111 }),
    touchDomemeSessionRenewalImpl: async (db, renewDate) => { touched = renewDate; },
  });
  assert.equal(sId, 'cached-sid');
  assert.equal(touched, 222);
});

test('getValidDomemeSId logs in fresh and saves the session when there is no cached sId', async () => {
  let saved;
  const client = {
    async checkLogin() { throw new Error('should not check a session that does not exist'); },
    async login() { return { sId: 'fresh-sid', grade: 'c' }; },
  };
  const sId = await getValidDomemeSId({}, client, {
    getDomemeSessionImpl: async () => null,
    saveDomemeSessionImpl: async (db, login) => { saved = login; },
  });
  assert.equal(sId, 'fresh-sid');
  assert.deepEqual(saved, { sId: 'fresh-sid', grade: 'c' });
});

test('getValidDomemeSId logs in fresh when checkLogin reports the cached session invalid', async () => {
  const client = {
    async checkLogin() { return { valid: false }; },
    async login() { return { sId: 'fresh-sid' }; },
  };
  const sId = await getValidDomemeSId({}, client, {
    getDomemeSessionImpl: async () => ({ sId: 'stale-sid', sIdRenewDate: 1 }),
    saveDomemeSessionImpl: async () => {},
  });
  assert.equal(sId, 'fresh-sid');
});

test('getValidDomemeSId logs in fresh when checkLogin itself throws (e.g. a rejected/expired sId)', async () => {
  const client = {
    async checkLogin() { throw new Error('INCORRECT_CERTIFICATE'); },
    async login() { return { sId: 'fresh-sid' }; },
  };
  const sId = await getValidDomemeSId({}, client, {
    getDomemeSessionImpl: async () => ({ sId: 'stale-sid', sIdRenewDate: 1 }),
    saveDomemeSessionImpl: async () => {},
  });
  assert.equal(sId, 'fresh-sid');
});
