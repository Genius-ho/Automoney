import { getDomemeSession, saveDomemeSession, touchDomemeSessionRenewal } from './domeme-session-store.mjs';

// Reuses the cached sId across calls (checkLogin is a cheap validity check,
// setLogin is not something to repeat on every request) -- logs in fresh
// only when there's no cached session or checkLogin reports it invalid/
// errored. This is the one place in Phase 8 that's allowed to call
// client.login() -- everything else in the pre-check panel and (later) the
// order-draft pipeline should go through this instead of logging in itself.
export async function getValidDomemeSId(db, client, {
  getDomemeSessionImpl = getDomemeSession,
  saveDomemeSessionImpl = saveDomemeSession,
  touchDomemeSessionRenewalImpl = touchDomemeSessionRenewal,
} = {}) {
  const existing = await getDomemeSessionImpl(db);
  if (existing?.sId) {
    try {
      const check = await client.checkLogin({ sId: existing.sId, sIdRenewDate: existing.sIdRenewDate });
      if (check.valid) {
        if (check.sIdRenewDate && check.sIdRenewDate !== existing.sIdRenewDate) {
          await touchDomemeSessionRenewalImpl(db, check.sIdRenewDate);
        }
        return existing.sId;
      }
    } catch {
      // Fall through to a fresh login -- an errored checkLogin (network
      // blip, expired-and-rejected sId) is not distinguishable here from
      // "definitely expired," and re-logging in is cheap and safe either way.
    }
  }
  const login = await client.login();
  await saveDomemeSessionImpl(db, login);
  return login.sId;
}
