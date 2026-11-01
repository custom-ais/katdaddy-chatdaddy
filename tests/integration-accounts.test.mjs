import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntegrationAccounts } from '../server/integration-accounts.mjs';
const env = { TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32), TWILIO_API_KEY_SID: 'SK' + 'b'.repeat(32), TWILIO_API_KEY_SECRET: 'fake-private-secret', LC_PRIVATE_TOKEN: 'pit-fake-private-token', LC_LOCATION_ID: 'locationFake123' };
const response = data => ({ ok: true, status: 200, json: async () => data });
function fixture(options = {}) {
  const values = new Map(), calls = []; let now = 1000, revision = 'oauth-private-revision';
  const store = { kvGet: async k => values.get(k), kvSet: async (k, v) => values.set(k, structuredClone(v)) };
  const jobber = { accountIdentityRevision: async () => revision, accountIdentity: async () => { calls.push(['jobber']); return { name: 'Test Jobber Company', verified: true, id: 'discard-me' }; } };
  const fetchImpl = async (url, init) => {
    calls.push([url, init]);
    assert.match(url, /^https:\/\/api\.twilio\.com\//);
    return response({ sid: env.TWILIO_ACCOUNT_SID, friendly_name: 'Test Twilio Account', status: 'active', auth_token: 'returned-private-token' });
  };
  const create = overrides => createIntegrationAccounts({ env, store, jobber, fetchImpl, clock: () => now, ...options, ...overrides });
  return { create, store, values, calls, jobber, advance: ms => { now += ms; }, reconnect: () => { revision = 'changed-oauth-revision'; } };
}

test('snapshot never invokes a provider; explicit refresh gets only minimal safe account names', async () => {
  const h = fixture(), identities = h.create();
  assert.equal((await identities.snapshot()).twilio.status, 'unverified');
  assert.equal(h.calls.length, 0);
  const data = await identities.refresh();
  assert.equal(data.twilio.displayName, 'Test Twilio Account');
  assert.equal(data.twilio.accountStatus, 'active');
  assert.equal('leadConnector' in data, false);
  assert.equal(data.jobber.displayName, 'Test Jobber Company');
  assert.ok(Object.values(data).every(x => x.status === 'verified' && x.checkedAt === 1000));
  assert.equal(h.calls.length, 2);
  assert.deepEqual(await identities.snapshot(), data);
  assert.equal(h.calls.length, 2);
  const serialized = JSON.stringify([...h.values]) + JSON.stringify(data);
  for (const secret of [...Object.values(env), 'returned-private-token', 'private@example.test', 'discard-company-id', 'oauth-private-revision']) assert.ok(!serialized.includes(secret), secret);
  for (const [url, init] of h.calls.filter(x => x.length > 1)) {
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.ok(init.signal instanceof AbortSignal); assert.equal(init.body, undefined);
    if (url.includes('twilio.com')) assert.equal(init.headers.Authorization, `Basic ${Buffer.from(`${env.TWILIO_API_KEY_SID}:${env.TWILIO_API_KEY_SECRET}`).toString('base64')}`);
    else assert.fail('Only Twilio HTTP lookup is supported');
  }
});

test('rotation, OAuth reconnect, expiration and separate tenant stores invalidate passive identity', async () => {
  const h = fixture(), identities = h.create(); await identities.refresh();
  const changed = h.create({ env: { ...env, TWILIO_API_KEY_SECRET: 'new-private-secret', LC_PRIVATE_TOKEN: 'pit-new-private-token' } });
  assert.equal((await changed.snapshot()).twilio.status, 'unverified');
  h.reconnect(); assert.equal((await identities.snapshot()).jobber.status, 'unverified');
  const other = h.create({ store: { kvGet: async () => null } });
  assert.equal((await other.snapshot()).twilio.status, 'unverified');
  h.advance(24 * 60 * 60_000); assert.equal((await identities.snapshot()).twilio.status, 'unverified');
  assert.equal(h.calls.length, 2);
});

test('permission denial and malformed or mismatched provider responses expose no raw errors and never retry', async () => {
  for (const raw of [null, {}, { sid: 'AC' + 'c'.repeat(32), friendly_name: 'Wrong account' }]) {
    const h = fixture({ fetchImpl: async () => response(raw) });
    const result = await h.create().refresh();
    assert.equal(result.twilio.status, 'unavailable');
  }
  let calls = 0;
  const h = fixture({ fetchImpl: async () => { calls++; return { ok: false, status: 403, json: async () => { throw Error(env.TWILIO_API_KEY_SECRET); } }; } });
  const result = await h.create().refresh();
  assert.equal(calls, 1); assert.equal(result.twilio.status, 'unavailable');
  assert.ok(!JSON.stringify(result).includes(env.TWILIO_API_KEY_SECRET));
});

test('missing or unsafe configuration never calls the corresponding provider', async () => {
  let calls = 0;
  const identities = createIntegrationAccounts({ env: { ...env, TWILIO_ACCOUNT_SID: '../bad', LC_LOCATION_ID: '../bad' }, fetchImpl: async () => { calls++; throw Error('must not call'); }, jobber: { accountIdentity: async () => { calls++; } } });
  const result = await identities.refresh();
  assert.ok(Object.values(result).every(x => x.status === 'unverified'));
  assert.equal(calls, 0);
});

test('diagnostic store failure does not change successful identity result', async () => {
  const h = fixture({ store: { kvGet: async () => { throw Error('down'); }, kvSet: async () => { throw Error('down'); } } });
  const identities = h.create();
  assert.equal((await identities.refresh()).twilio.status, 'verified');
  assert.equal((await identities.snapshot()).twilio.status, 'unverified');
});

test('OAuth reconnection during lookup does not cache the old account under new credentials', async () => {
  const h = fixture();
  h.jobber.accountIdentity = async () => { h.reconnect(); return { name: 'Old company', verified: true }; };
  const identities = h.create(), result = await identities.refresh();
  assert.equal(result.jobber.status, 'unverified');
  assert.equal((await identities.snapshot()).jobber.status, 'unverified');
});

test('concurrent refresh calls coalesce; errors do not retain stale verified names', async () => {
  const h = fixture(), identities = h.create();
  await Promise.all([identities.refresh(), identities.refresh()]);
  assert.equal(h.calls.length, 2);
  const failed = h.create({ fetchImpl: async () => { throw Error('private request metadata'); } });
  assert.equal((await failed.refresh()).twilio.status, 'unavailable');
  assert.equal((await failed.snapshot()).twilio.displayName, null);
});

test('provider-controlled names and persisted records cannot reflect credentials or extra fields', async () => {
  const h = fixture({ fetchImpl: async () => response({ sid: env.TWILIO_ACCOUNT_SID, friendly_name: 'returned-token', auth_token: 'returned-token' }) });
  const result = await h.create().refresh();
  assert.equal(result.twilio.status, 'unavailable');
  for (const value of h.values.values()) { value.displayName = env.TWILIO_API_KEY_SECRET; value.status = 'verified'; value.authToken = 'do-not-return'; }
  assert.ok(!JSON.stringify(await h.create().snapshot()).includes('do-not-return'));
});

test('disabled tenant integrations hide cached identities and suppress all lookup helpers', async () => {
  const h = fixture(); let integrations = {};
  h.store.config = async () => ({ integrations });
  const identities = h.create();
  await identities.refresh();
  assert.equal(h.calls.length, 2);
  integrations = { jobber: false, verification: false, sms: false };
  h.jobber.accountIdentityRevision = async () => { throw Error('disabled revision helper must not run'); };
  for (const result of [await identities.snapshot(), await identities.refresh()]) {
    assert.deepEqual(Object.keys(result).sort(), ['jobber', 'twilio']);
    assert.ok(Object.values(result).every(v => v.status === 'unverified' && v.displayName === null));
  }
  assert.equal(h.calls.length, 2);
});

test('either enabled Twilio capability permits explicit identity lookup only', async () => {
  for (const integrations of [{ verification: true, sms: false }, { verification: false, sms: true }]) {
    const h = fixture(); h.store.config = async () => ({ integrations: { jobber: false, ...integrations } });
    const identities = h.create();
    await identities.snapshot(); assert.equal(h.calls.length, 0);
    assert.equal((await identities.refresh()).twilio.status, 'verified');
    assert.equal(h.calls.length, 1);
    assert.match(h.calls[0][0], /^https:\/\/api\.twilio\.com\//);
  }
});

test('config failure prevents lookups and disabling during lookup discards result', async () => {
  const h = fixture();
  h.store.config = async () => { throw Error('configuration unavailable'); };
  assert.ok(Object.values(await h.create().refresh()).every(v => v.status === 'unverified'));
  assert.equal(h.calls.length, 0);
  let disabled = false;
  h.store.config = async () => ({ integrations: { jobber: false, sms: false, verification: !disabled } });
  const identities = h.create({ fetchImpl: async () => {
    disabled = true;
    return response({ sid: env.TWILIO_ACCOUNT_SID, friendly_name: 'Must not publish' });
  } });
  assert.equal((await identities.refresh()).twilio.status, 'unverified');
  assert.equal(h.values.size, 0);
});

test('legacy LeadConnector credentials never produce identity calls or output', async () => {
  const h = fixture({ env: { LC_PRIVATE_TOKEN: 'legacy-unused', LC_LOCATION_ID: 'legacy-unused' }, jobber: null });
  const identities = h.create();
  assert.deepEqual(Object.keys(await identities.refresh()).sort(), ['jobber', 'twilio']);
  assert.equal(h.calls.length, 0);
  assert.equal('leadConnector' in await identities.snapshot(), false);
});
