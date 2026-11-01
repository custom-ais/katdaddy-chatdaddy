import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntegrationStatus } from '../server/integration-status.mjs';

function fixture() {
  const values = new Map(); let now = 1000;
  const cache = { kvGet: async key => structuredClone(values.get(key)), kvSet: async (key, value) => values.set(key, structuredClone(value)) };
  const create = (revision = 'private-config-one') => createIntegrationStatus({ cache, provider: 'test', revision, operations: ['routes', 'geocode'], legacyKey: 'diag:legacy', clock: () => now });
  return { values, cache, create, advance: ms => { now += ms; } };
}

test('passive snapshot is unknown until all current required operations succeed', async () => {
  const h = fixture(), status = h.create();
  assert.equal((await status.snapshot()).status, 'unknown');
  await status.recordSuccess('routes');
  assert.equal((await status.snapshot()).status, 'unknown');
  await status.recordSuccess('geocode');
  assert.equal((await status.snapshot()).status, 'healthy');
});

test('success clears only the same operation error and preserves failure history', async () => {
  const h = fixture(), status = h.create();
  await status.recordFailure('routes', 'Routes blocked');
  h.advance(1); await status.recordSuccess('geocode');
  assert.equal((await status.snapshot()).status, 'error');
  assert.equal((await status.snapshot()).activeIssue.operation, 'routes');
  h.advance(1); await status.recordSuccess('routes');
  const snapshot = await status.snapshot();
  assert.equal(snapshot.status, 'healthy'); assert.equal(snapshot.activeIssue, null);
  assert.equal(snapshot.lastIssue.message, 'Routes blocked'); assert.equal(snapshot.lastIssue.historical, true);
});

test('key/config revision changes make old observations historical unknown without deleting them', async () => {
  const h = fixture(); await h.create().recordFailure('routes', 'Old key blocked');
  const snapshot = await h.create('private-config-two').snapshot();
  assert.equal(snapshot.status, 'unknown'); assert.equal(snapshot.activeIssue, null);
  assert.equal(snapshot.checkedAt, null); assert.equal(snapshot.lastIssue.message, 'Old key blocked');
  assert.equal(/private-config/.test(JSON.stringify(snapshot)), false);
  assert.equal(h.values.size, 1);
});

test('stale observations are unknown, retain check time, and do not show active issues', async () => {
  const h = fixture(), status = h.create();
  await status.recordFailure('routes', 'Old failure');
  await status.recordSuccess('geocode');
  h.advance(15 * 60_000);
  const snapshot = await status.snapshot();
  assert.equal(snapshot.status, 'unknown'); assert.equal(snapshot.activeIssue, null);
  assert.equal(snapshot.operations.routes.stale, true); assert.equal(snapshot.checkedAt, 1000);
  assert.equal(snapshot.lastIssue.message, 'Old failure');
});

test('legacy issue is historical only and is never overwritten or cleared', async () => {
  const h = fixture(); h.values.set('diag:legacy', { at: 9, message: 'Legacy error' });
  const status = h.create(); await status.recordSuccess('routes'); await status.recordSuccess('geocode');
  const snapshot = await status.snapshot();
  assert.equal(snapshot.status, 'healthy'); assert.equal(snapshot.lastIssue.message, 'Legacy error');
  assert.equal(snapshot.lastIssue.operation, 'unknown'); assert.deepEqual(h.values.get('diag:legacy'), { at: 9, message: 'Legacy error' });
});

test('operation records remain independent during concurrent updates', async () => {
  const h = fixture(), status = h.create();
  await Promise.all([status.recordSuccess('routes'), status.recordFailure('geocode', 'Denied')]);
  const snapshot = await status.snapshot();
  assert.equal(snapshot.operations.routes.status, 'healthy'); assert.equal(snapshot.operations.geocode.status, 'error');
});

test('diagnostic storage failures never fail the provider operation', async () => {
  const status = createIntegrationStatus({ cache: { kvGet: async () => { throw Error('down'); }, kvSet: async () => { throw Error('down'); } }, provider: 'test', revision: 'private' });
  await status.recordSuccess('default'); await status.recordFailure('default', 'Failure');
  assert.equal((await status.snapshot()).status, 'unknown');
});

test('optional absent store is safe and common credential patterns are redacted', async () => {
  const empty = createIntegrationStatus({ store: null, provider: 'test', revision: 'private' });
  await empty.recordSuccess('default'); await empty.recordFailure('default', 'failure');
  assert.equal((await empty.snapshot()).status, 'unknown');
  const h = fixture(), status = h.create();
  await status.recordFailure('routes', 'Failed https://example.com/?key=secret-value&x=2 Authorization Bearer secret-token');
  const text = JSON.stringify(await status.snapshot());
  assert.equal(/secret-value|secret-token/.test(text), false);
});
