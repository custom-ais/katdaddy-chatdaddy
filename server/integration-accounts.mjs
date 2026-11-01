// Account identity is not provider health or permission to send messages.
// Read-only endpoints, only invoked by an explicitly requested admin refresh:
// https://www.twilio.com/docs/iam/api/account
// https://marketplace.gohighlevel.com/docs/ghl/locations/get-location/index.html
import { createHash } from 'node:crypto';
import { cleanSecret } from './leadconnector.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sid = (value, prefix) => new RegExp(`^${prefix}[a-fA-F0-9]{32}$`).test(value);
const empty = (status = 'unverified', checkedAt = null) => ({ status, displayName: null, checkedAt });

export function createIntegrationAccounts({ env = process.env, fetchImpl = fetch, store, jobber, clock = Date.now, maxAgeMs = 24 * 60 * 60_000 } = {}) {
  const account = String(env.TWILIO_ACCOUNT_SID || '').trim();
  const apiKey = String(env.TWILIO_API_KEY_SID || '').trim();
  const apiSecret = String(env.TWILIO_API_KEY_SECRET || '').trim();
  const lcToken = cleanSecret(env.LC_PRIVATE_TOKEN), location = cleanSecret(env.LC_LOCATION_ID);
  const secrets = [account, apiKey, apiSecret, lcToken, location, env.JOBBER_CLIENT_SECRET].filter(Boolean);
  const safeName = (value, extraSecrets = []) => {
    if (typeof value !== 'string') return null;
    let name = value.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
    // Reject, rather than display, a name containing credentials or raw identifiers.
    if ([...secrets, ...extraSecrets].some(secret => secret && name.includes(secret)) || /\b(?:AC|SK)[a-f\d]{32}\b|\bpit-[\w-]+|Bearer\s|\beyJ[\w-]+\.[\w-]+\.[\w-]+/i.test(name)) return null;
    return name ? name.slice(0, 160) : null;
  };
  const cfg = {
    twilio: { configured: sid(account, 'AC') && sid(apiKey, 'SK') && Boolean(apiSecret), revision: hash([account, apiKey, apiSecret]) },
    leadConnector: { configured: Boolean(lcToken) && /^[a-zA-Z0-9_-]{1,120}$/.test(location), revision: hash([lcToken, location]) },
  };
  // The OAuth helper reads only local token state, never a provider. Without a
  // revision helper we cannot safely reuse Jobber identity across reconnections.
  async function context(provider) {
    if (provider !== 'jobber') return cfg[provider];
    try {
      const revision = await jobber?.accountIdentityRevision?.();
      return { configured: Boolean(revision && jobber?.accountIdentity), revision: revision ? hash(['jobber', revision]) : null };
    } catch { return { configured: false, revision: null }; }
  }
  const key = (provider, revision) => `account-identity:v1:${provider}:${revision}`;
  function project(saved) {
    if (!saved || !Number.isFinite(saved.checkedAt) || clock() < saved.checkedAt || clock() - saved.checkedAt >= maxAgeMs) return empty();
    const displayName = safeName(saved.displayName);
    if (saved.status === 'verified' && displayName) return { status: 'verified', displayName, checkedAt: saved.checkedAt, ...( ['active', 'suspended', 'closed'].includes(saved.accountStatus) ? { accountStatus: saved.accountStatus } : {} ) };
    return empty(saved.status === 'unavailable' ? 'unavailable' : 'unverified', saved.checkedAt);
  }
  async function read(provider, config) {
    if (!config.configured) return empty();
    try { return project(await store?.kvGet(key(provider, config.revision))); } catch { return empty(); }
  }
  async function snapshot() {
    const result = {};
    for (const provider of ['jobber', 'twilio', 'leadConnector']) result[provider] = await read(provider, await context(provider));
    return result;
  }
  async function get(url, headers) {
    const response = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json', ...headers }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error('Account identity unavailable');
    return response.json();
  }
  async function fetchIdentity(provider) {
    if (provider === 'twilio') {
      const data = await get(`https://api.twilio.com/2010-04-01/Accounts/${account}.json`, { Authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}` });
      if (data.sid !== account) throw new Error('Account identity mismatch');
      return { displayName: safeName(data.friendly_name, [data.auth_token]), accountStatus: data.status };
    }
    if (provider === 'leadConnector') {
      const data = await get(`https://services.leadconnectorhq.com/locations/${encodeURIComponent(location)}`, { Authorization: `Bearer ${lcToken}`, Version: 'v3' });
      if (data.location?.id !== location) throw new Error('Account identity mismatch');
      return { displayName: safeName(data.location.name || data.location.business?.name) };
    }
    const data = await jobber.accountIdentity();
    if (data?.verified !== true) throw new Error('Account identity unavailable');
    return { displayName: safeName(data?.name) };
  }
  let pending = null;
  async function performRefresh() {
    const result = {};
    await Promise.all(['jobber', 'twilio', 'leadConnector'].map(async provider => {
      const config = await context(provider);
      if (!config.configured) { result[provider] = empty(); return; }
      let record;
      try {
        const identity = await fetchIdentity(provider);
        if (!identity.displayName) throw new Error('Account name unavailable');
        record = { status: 'verified', displayName: identity.displayName, checkedAt: clock(), ...(['active', 'suspended', 'closed'].includes(identity.accountStatus) ? { accountStatus: identity.accountStatus } : {}) };
      } catch { record = empty('unavailable', clock()); }
      // Do not attach an old account's response to a changed OAuth connection.
      const current = await context(provider);
      if (!current.configured || current.revision !== config.revision) { result[provider] = empty(); return; }
      try { await store?.kvSet(key(provider, config.revision), record, Math.ceil(maxAgeMs / 1000)); } catch {}
      result[provider] = record;
    }));
    return result;
  }
  function refresh() {
    if (!pending) pending = performRefresh().finally(() => { pending = null; });
    return pending;
  }
  return { snapshot, refresh };
}
