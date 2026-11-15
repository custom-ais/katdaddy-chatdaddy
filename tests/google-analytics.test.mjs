import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { createGoogleAnalytics, analyticsSettings } from '../server/google-analytics.mjs';
import { createAdminAuth } from '../server/admin-auth.mjs';
import { harness } from './helpers.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const EMAIL = 'dashboard-reader@example-project.iam.gserviceaccount.com';
const KEY_JSON = JSON.stringify({ type: 'service_account', client_email: EMAIL, private_key: PEM, token_uri: 'https://attacker.invalid/token' });
const ENV = { GA4_PROPERTY_ID: '123456789', GA4_SERVICE_ACCOUNT_JSON: KEY_JSON };
// Wednesday 2026-11-11, 10:00 AM in Phoenix.
const NOW = Date.parse('2026-11-11T17:00:00Z');

const row = (dims, mets) => ({ dimensionValues: dims.map((value) => ({ value })), metricValues: mets.map((value) => ({ value: String(value) })) });
const REPORTS = {
  reports: [
    { metadata: { timeZone: 'America/Phoenix' }, rows: [row(['current'], [120, 90, 160, 410, 0.625, 95.5]), row(['previous'], [100, 80, 130, 300, 0.5, 80])] },
    { rows: [row(['20261105'], [20, 25, 60]), row(['20261110'], [30, 40, 90])] },
    { rows: [row(['/'], [200, 100]), row(['/pricing'], [80, 40])] },
    { rows: [row(['Organic Search'], [90]), row(['Direct'], [50])] },
    { rows: [row(['desktop'], [70]), row(['mobile'], [50])] },
  ],
};

function fakeGoogle({ data = () => ({ status: 200, body: REPORTS }), token = () => ({ status: 200, body: { access_token: 'ya29.test-token', expires_in: 3599 } }) } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const reply = String(url).startsWith('https://oauth2.googleapis.com/token') ? token(init) : data(init);
    if (reply instanceof Error) throw reply;
    return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body };
  };
  return { calls, fetchImpl };
}
function memoryCache() {
  const map = new Map();
  return { map, kvGet: async (k) => map.get(k) ?? null, kvSet: async (k, v) => { map.set(k, structuredClone(v)); } };
}

test('without server settings it reports what is missing and never calls Google', async () => {
  const google = fakeGoogle();
  const ga = createGoogleAnalytics({ env: {}, fetchImpl: google.fetchImpl, clock: () => NOW });
  assert.equal(ga.configured, false);
  assert.equal(ga.site, 'Custom-AIs.com');
  const r = await ga.report({ days: 7 });
  assert.equal(r.status, 'not_configured');
  assert.deepEqual(r.missing, ['GA4_PROPERTY_ID', 'GA4_SERVICE_ACCOUNT_JSON']);
  assert.equal(google.calls.length, 0);
});

test('a measurement ID or an unreadable key is explained instead of used', () => {
  const s = analyticsSettings({ GA4_PROPERTY_ID: 'G-ABC123XYZ', GA4_SERVICE_ACCOUNT_JSON: '{"client_email":"x"}', GA4_SITE_NAME: 'Example.com' });
  assert.equal(s.configured, false);
  assert.equal(s.site, 'Example.com');
  assert.match(s.problems.join(' '), /measurement ID \(G-…\)/);
  assert.match(s.problems.join(' '), /isn't a Google service-account key/);
  assert.equal(analyticsSettings({ GA4_PROPERTY_ID: 'properties/987654', GA4_SERVICE_ACCOUNT_JSON: KEY_JSON }).propertyId, '987654');
  // The key file in base64, and a key whose line breaks were pasted escaped, both work.
  assert.equal(analyticsSettings({ ...ENV, GA4_SERVICE_ACCOUNT_JSON: Buffer.from(KEY_JSON).toString('base64') }).configured, true);
  const escaped = JSON.stringify({ client_email: EMAIL, private_key: PEM.replace(/\n/g, '\\n') });
  assert.equal(analyticsSettings({ ...ENV, GA4_SERVICE_ACCOUNT_JSON: escaped }).account.key, PEM);
});

test('signs in as the service account, reads the property and shapes the report', async () => {
  const google = fakeGoogle();
  const ga = createGoogleAnalytics({ env: ENV, fetchImpl: google.fetchImpl, clock: () => NOW });
  const r = await ga.report({ days: 7 });
  assert.equal(r.status, 'ok', JSON.stringify(r));
  assert.equal(google.calls.length, 2);

  // Token: always Google's endpoint (never the key file's token_uri), a valid RS256 assertion, read-only scope.
  const [tokenCall, dataCall] = google.calls;
  assert.equal(tokenCall.url, 'https://oauth2.googleapis.com/token');
  assert.equal(tokenCall.init.redirect, 'error');
  const form = new URLSearchParams(tokenCall.init.body);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [head, claims, signature] = form.get('assertion').split('.');
  assert.ok(createVerify('RSA-SHA256').update(`${head}.${claims}`).verify(publicKey, Buffer.from(signature, 'base64url')));
  const c = JSON.parse(Buffer.from(claims, 'base64url').toString());
  assert.equal(c.iss, EMAIL);
  assert.equal(c.scope, 'https://www.googleapis.com/auth/analytics.readonly');
  assert.equal(c.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(c.exp - c.iat, 3600);

  assert.equal(dataCall.url, 'https://analyticsdata.googleapis.com/v1beta/properties/123456789:batchRunReports');
  assert.equal(dataCall.init.headers.Authorization, 'Bearer ya29.test-token');
  const sent = JSON.parse(dataCall.init.body);
  assert.equal(sent.requests.length, 5);
  assert.deepEqual(sent.requests[0].dateRanges, [{ name: 'current', startDate: '7daysAgo', endDate: 'yesterday' }, { name: 'previous', startDate: '14daysAgo', endDate: '8daysAgo' }]);

  assert.deepEqual(r.totals, { activeUsers: 120, newUsers: 90, sessions: 160, pageViews: 410, engagementRate: 0.625, avgSessionSeconds: 95.5 });
  assert.equal(r.previous.activeUsers, 100);
  // Seven whole days through yesterday, in the property's time zone; days without visits are zero.
  assert.deepEqual(r.daily.map((d) => d.date), ['2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10']);
  assert.deepEqual(r.daily[1], { date: '2026-11-05', users: 20, sessions: 25, pageViews: 60 });
  assert.deepEqual(r.daily[0], { date: '2026-11-04', users: 0, sessions: 0, pageViews: 0 });
  assert.deepEqual(r.pages[1], { path: '/pricing', views: 80, users: 40 });
  assert.deepEqual(r.channels.map((x) => x.name), ['Organic Search', 'Direct']);
  assert.deepEqual(r.devices[0], { name: 'desktop', users: 70 });
  assert.equal(r.site, 'Custom-AIs.com');
  assert.equal(r.propertyId, '123456789');
  assert.ok(!JSON.stringify(r).includes('PRIVATE KEY'));
  assert.ok(!JSON.stringify(r).includes('ya29'));
});

test('reports are reused for 10 minutes and the sign-in token for its lifetime; failures are not cached', async () => {
  let now = NOW, fail = false;
  const google = fakeGoogle({ data: () => (fail ? { status: 500, body: {} } : { status: 200, body: REPORTS }) });
  const cache = memoryCache();
  const ga = createGoogleAnalytics({ env: ENV, cache, fetchImpl: google.fetchImpl, clock: () => now });
  await ga.report({ days: 28 });
  await ga.report({ days: 28 });
  assert.equal(google.calls.length, 2, 'second read comes from the cache');
  now += 11 * 60_000;
  fail = true;
  const failed = await ga.report({ days: 28 });
  assert.equal(failed.status, 'error');
  assert.equal(google.calls.filter((c) => c.url.includes('oauth2')).length, 1, 'token reused');
  fail = false;
  assert.equal((await ga.report({ days: 28 })).status, 'ok', 'a failure is retried on the next read');
  assert.equal((await ga.report({ days: 365 })).days, 28, 'unknown ranges fall back to 28 days');
});

test("Google's errors become plain setup instructions", async () => {
  const cases = [
    [{ status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'User does not have sufficient permissions for this property.' } } }, 'no_access', new RegExp(`add ${EMAIL.replace(/\./g, '\\.')} as a Viewer`)],
    [{ status: 403, body: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Google Analytics Data API has not been used in project 1 before or it is disabled.', details: [{ reason: 'SERVICE_DISABLED' }] } } }, 'api_disabled', /Google Analytics Data API → Enable/],
    [{ status: 404, body: { error: { code: 404, status: 'NOT_FOUND' } } }, 'bad_property', /GA4_PROPERTY_ID/],
    [{ status: 429, body: {} }, 'quota', /Try again in an hour/],
    [new TypeError('fetch failed'), 'unreachable', /Couldn't reach Google Analytics/],
  ];
  for (const [reply, code, message] of cases) {
    const ga = createGoogleAnalytics({ env: ENV, fetchImpl: fakeGoogle({ data: () => reply }).fetchImpl, clock: () => NOW });
    const r = await ga.report({ days: 7 });
    assert.equal(r.status, 'error');
    assert.equal(r.error.code, code);
    assert.match(r.error.message, message);
  }
  const rejected = createGoogleAnalytics({ env: ENV, fetchImpl: fakeGoogle({ token: () => ({ status: 400, body: { error: 'invalid_grant' } }) }).fetchImpl, clock: () => NOW });
  const r = await rejected.report({ days: 7 });
  assert.equal(r.error.code, 'auth_rejected');
  assert.match(r.error.message, /Create a new JSON key/);
});

test('HTTP: website analytics needs a dashboard sign-in and Analytics access, and only report fields reach the browser', async (t) => {
  const asked = [];
  const websiteAnalytics = {
    configured: true, site: 'Custom-AIs.com',
    async report({ days }) {
      asked.push(days);
      return { status: 'ok', site: 'Custom-AIs.com', propertyId: '123456789', days, fetchedAt: NOW, timeZone: 'America/Phoenix', totals: { activeUsers: 5, sessions: 6, accessToken: 'leak' }, previous: { activeUsers: 4 }, daily: [{ date: '2026-11-10', users: 5, sessions: 6, pageViews: 9, extra: 'leak' }], pages: [{ path: '/', views: 9, users: 5 }], channels: [], devices: [], privateKey: 'leak' };
    },
  };
  const h = await harness(t, { websiteAnalytics });
  assert.equal((await h.call('/api/admin/website-analytics')).status, 401);
  const cookie = await h.login();
  const r = await h.call('/api/admin/website-analytics?days=7', { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'ok');
  assert.equal(r.data.totals.activeUsers, 5);
  assert.equal((await h.call('/api/admin/website-analytics?days=12', { cookie })).status, 200);
  assert.deepEqual(asked, [7, 28]);
  const snapshot = await h.call('/api/admin/data', { cookie });
  assert.deepEqual(snapshot.data.integrations.analytics, { configured: true, site: 'Custom-AIs.com' });

  // Named users: the same people who can open the Analytics tab; the response is an allowlist.
  const password = 'Synthetic-local-account-password-2026';
  const auth = createAdminAuth({ store: h.store, clock: h.store.clock });
  const claim = await auth.prepareOwnerBootstrap({ email: 'owner@example.test', name: 'Synthetic Owner' });
  assert.equal((await h.call('/api/admin/owner-bootstrap/accept', { method: 'POST', body: { token: claim.token, password } })).status, 200);
  const owner = await h.call('/api/admin/login', { method: 'POST', body: { email: 'owner@example.test', password } });
  await auth.activateNamedMode({ ownerId: claim.user.id });
  const member = async (email, permissions) => {
    const issued = await h.call('/api/admin/users/invite', { method: 'POST', cookie: owner.cookie, body: { email, name: 'Synthetic Member', permissions } });
    assert.equal(issued.status, 201, JSON.stringify(issued.data));
    assert.equal((await h.call('/api/admin/invite/accept', { method: 'POST', body: { token: issued.data.token, password } })).status, 200);
    return (await h.call('/api/admin/login', { method: 'POST', body: { email, password } })).cookie;
  };
  const viewer = await member('analytics@example.test', ['analytics.view', 'finance.view']);
  const other = await member('appointments@example.test', ['appointments.view']);
  assert.equal((await h.call('/api/admin/website-analytics', { cookie: other })).status, 403);
  const seen = await h.call('/api/admin/website-analytics?days=90', { cookie: viewer });
  assert.equal(seen.status, 200);
  assert.equal(seen.data.totals.activeUsers, 5);
  assert.deepEqual(seen.data.daily, [{ date: '2026-11-10', users: 5, sessions: 6, pageViews: 9 }]);
  assert.doesNotMatch(JSON.stringify(seen.data), /leak/);
});

test('HTTP: with no Google Analytics settings the endpoint explains setup without any network call', async (t) => {
  const h = await harness(t);
  const cookie = await h.login();
  const r = await h.call('/api/admin/website-analytics', { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'not_configured');
  assert.deepEqual(r.data.missing, ['GA4_PROPERTY_ID', 'GA4_SERVICE_ACCOUNT_JSON']);
  assert.equal(r.data.site, 'Custom-AIs.com');
  assert.deepEqual((await h.call('/api/admin/data', { cookie })).data.integrations.analytics, { configured: false, site: 'Custom-AIs.com' });
});
