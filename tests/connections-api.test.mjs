import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './helpers.mjs';

test('admin refresh returns passive provider health and retained history without calling providers', async t => {
  const h = await harness(t);
  const cookie = await h.login();
  const maps = { status: 'unknown', checkedAt: null, activeIssue: null, history: [{ at: 1, message: 'Historical routing failure' }] };
  const lc = { status: 'error', checkedAt: 2, activeIssue: { at: 2, message: 'Recorded contact failure' }, history: [] };
  h.geo.health = async () => maps;
  h.lc.health = async () => lc;
  h.geo.geocode = async () => { throw Error('refresh must not call Google'); };
  h.lc.upsertContact = async () => { throw Error('refresh must not call CRM'); };
  for (let n = 0; n < 2; n++) {
    const r = await h.call('/api/admin/data', { cookie });
    assert.equal(r.status, 200);
    assert.deepEqual(r.data.integrations.maps.health, maps);
    assert.deepEqual(r.data.integrations.leadConnector.health, lc);
  }
  assert.equal((await h.call('/api/admin/data')).status, 401, 'diagnostics remain admin-only');
});

test('legacy diagnostic fields are sanitized without deleting stored history', async t => {
  const h = await harness(t), cookie = await h.login();
  const secret = 'pit-old-private-token-123456';
  const old = { at: 1, message: `Old failure Bearer ${secret}`, path: '/api/test?key=old-secret' };
  await h.store.kvSet('diag:lc', old);
  await h.store.kvSet('diag:last-error', old);
  h.geo.lastIssue = async () => old;
  const r = await h.call('/api/admin/data', { cookie });
  assert.equal(r.status, 200);
  assert.ok(!JSON.stringify(r.data.integrations).includes(secret));
  assert.ok(!JSON.stringify(r.data.integrations).includes('old-secret'));
  assert.equal((await h.store.kvGet('diag:lc')).message, old.message);
});

test('account identity refresh requires admin and ordinary status stays passive', async t => {
  let refreshes = 0;
  const names = { jobber: { status: 'verified', displayName: 'Test Company', checkedAt: 1 } };
  const h = await harness(t, { integrationAccounts: { snapshot: async () => names, refresh: async () => { refreshes++; return names; } } });
  assert.equal((await h.call('/api/admin/integration-accounts', { method: 'POST', body: {} })).status, 401);
  const cookie = await h.login();
  const snapshot = await h.call('/api/admin/data', { cookie });
  assert.deepEqual(snapshot.data.integrations.accounts, names);
  assert.equal(refreshes, 0);
  assert.deepEqual((await h.call('/api/admin/integration-accounts', { method: 'POST', cookie, body: {} })).data, names);
  assert.equal(refreshes, 1);
});
