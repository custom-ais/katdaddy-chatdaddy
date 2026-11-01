import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeo } from '../server/geo.mjs';
const cache = () => { const m = new Map(); return { m, kvGet: async k => m.get(k), kvSet: async (k, v) => m.set(k, v) }; };
const reply = (json, status = 200) => ({ ok: status < 400, status, json: async () => json });
const pairs = [{ from: { lat: 33.4, lng: -112.5 }, to: { lat: 33.5, lng: -112.6 } }];
const route = [{ destinationIndex: 0, condition: 'ROUTE_EXISTS', duration: '600s', distanceMeters: 6000 }];

test('rotated Maps key shows historical error but unknown current health, without any diagnostic fetch', async () => {
  const c = cache(); let calls = 0;
  const old = createGeo({ cache: c, googleKey: 'old-secret', fetchImpl: async () => { calls++; return reply({ error: { message: 'Denied old-secret' } }, 403); } });
  await assert.rejects(old.roadRoutes(pairs));
  const fresh = createGeo({ cache: c, googleKey: 'new-secret', fetchImpl: async () => { calls++; throw Error('must not fetch'); } });
  const snapshot = await fresh.diagnostics();
  assert.equal(calls, 1); assert.equal(snapshot.status, 'unknown'); assert.equal(snapshot.activeIssue, null);
  assert.ok(snapshot.lastIssue); assert.equal(/old-secret|new-secret/.test(JSON.stringify(snapshot)), false);
});

test('Google fallback and cache hit do not clear Google geocode error', async () => {
  const c = cache(); let calls = 0;
  const geo = createGeo({ cache: c, googleKey: 'key', fetchImpl: async url => { calls++; return url.includes('googleapis') ? reply({ status: 'REQUEST_DENIED' }) : reply({ result: { addressMatches: [] } }); } });
  await geo.geocode('1 Test Road');
  assert.equal((await geo.diagnostics()).operations.geocode.status, 'error');
  await geo.geocode('1 Test Road');
  assert.equal(calls, 2); assert.equal((await geo.diagnostics()).operations.geocode.status, 'error');
});

test('actual Routes success clears only Routes error, expired route cache requests new measurement', async () => {
  const c = cache(); let fail = true, now = 1000, calls = 0;
  const geo = createGeo({ cache: c, googleKey: 'key', clock: () => now, fetchImpl: async url => { calls++; return fail ? reply({ error: { message: 'Denied' } }, 403) : url.includes('routes') ? reply(route) : reply({ suggestions: [] }); } });
  await assert.rejects(geo.roadRoutes(pairs));
  await assert.rejects(geo.suggestAddresses('test', 'token'));
  fail = false; now++;
  await geo.roadRoutes(pairs);
  const snapshot = await geo.diagnostics();
  assert.equal(snapshot.operations.routes.status, 'healthy'); assert.equal(snapshot.operations.places.status, 'error'); assert.equal(snapshot.status, 'error');
  now += 15 * 60_000; const before = calls; await geo.roadRoutes(pairs);
  assert.equal(calls, before + 1); assert.equal((await geo.diagnostics()).operations.routes.status, 'healthy');
});

test('network failure and per-route status errors are failures, not healthy estimate fallback', async () => {
  const geo = createGeo({ cache: cache(), googleKey: 'key', fetchImpl: async () => reply([{ destinationIndex: 0, status: { code: 7 }, condition: 'ROUTE_NOT_FOUND' }]) });
  await geo.driveMinutes(pairs);
  assert.equal((await geo.diagnostics()).operations.routes.status, 'error');
  const places = createGeo({ cache: cache(), googleKey: 'key', fetchImpl: async () => { throw Error('offline'); } });
  await assert.rejects(places.suggestAddresses('test', 'token'));
  assert.equal((await places.diagnostics()).operations.places.status, 'error');
});
