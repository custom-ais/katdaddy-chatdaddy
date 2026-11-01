import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeadConnector } from '../server/leadconnector.mjs';

const env = { LC_PRIVATE_TOKEN: 'pit-test-token-abcdefgh', LC_LOCATION_ID: 'location-test' };
const store = () => { const data = new Map(); return { kvGet: async k => data.get(k) || null, kvSet: async (k,v) => data.set(k,structuredClone(v)) }; };

test('LC recorded errors are operation/config scoped, retain history and refresh never calls provider', async () => {
  const cache = store(); let now = 1000, fail = true, calls = 0;
  const fetchImpl = async () => { calls++; return new Response(JSON.stringify(fail ? { message: 'Invalid JWT' } : { contact: { id: 'contact-test' } }), { status: fail ? 401 : 200 }); };
  const lc = createLeadConnector({ env, store: cache, clock: () => now, fetchImpl });
  await assert.rejects(lc.upsertContact({ phone: '+16235550100' }));
  assert.equal((await lc.health()).status, 'error');
  const before = calls;
  await lc.health(); await lc.health();
  assert.equal(calls, before, 'refresh only reads observations');
  const replaced = createLeadConnector({ env: { ...env, LC_PRIVATE_TOKEN: 'pit-replacement-abcdefgh' }, store: cache, clock: () => now, fetchImpl });
  const changed = await replaced.health();
  assert.equal(changed.status, 'unknown');
  assert.equal(changed.activeIssue, null);
  assert.ok(changed.history.length > 0, 'older error retained as history');
  fail = false; now++;
  await lc.upsertContact({ phone: '+16235550100' });
  const recovered = await lc.health();
  assert.equal(recovered.operations.contacts.status, 'healthy');
  assert.equal(recovered.operations.contacts.activeIssue, null);
  assert.ok(recovered.history.length > 0, 'successful call does not delete prior failure');
  assert.equal(recovered.status, 'unknown', 'other capabilities untested, no blanket green');
  assert.ok(!JSON.stringify(recovered).includes(env.LC_PRIVATE_TOKEN));
});

test('diagnostic storage outage never changes successful provider outcome', async () => {
  const lc = createLeadConnector({ env, store: { kvGet: async () => { throw Error('storage unavailable'); }, kvSet: async () => { throw Error('storage unavailable'); } }, fetchImpl: async () => new Response(JSON.stringify({ contact: { id: 'ok' } })) });
  assert.equal(await lc.upsertContact({ phone: '+16235550100' }), 'ok');
  assert.equal((await lc.health()).status, 'unknown');
});

test('HTTP success without required contact ID records failure, never healthy', async () => {
  const lc = createLeadConnector({ env, store: store(), fetchImpl: async () => new Response('{}') });
  await assert.rejects(lc.upsertContact({ phone: '+16235550100' }), /no contact id/);
  assert.equal((await lc.health()).operations.contacts.status, 'error');
  assert.equal((await lc.health()).lastSuccessAt, null);
});
