import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../api/bob.mjs';
import { isReadOnlyPreview } from '../server/preview.mjs';

function response() {
  return { headersSent: false, writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }, end(text) { this.body = JSON.parse(text); } };
}
function preview(env = { VERCEL: '1', VERCEL_ENV: 'preview' }) {
  let runtimeLoads = 0;
  const handle = createHandler({ env, loadRuntime: async () => { runtimeLoads++; throw new Error('Preview must not load runtime'); } });
  return { loads: () => runtimeLoads, call: async (url, method = 'GET') => { const res = response(); await handle({ url, method, headers: {}, body: { phone: 'do not process', code: '123456' } }, res); return res; } };
}

test('preview guard is fail closed for Vercel non-production or missing environment', () => {
  for (const env of [{ VERCEL_ENV: 'preview' }, { VERCEL: '1' }, { VERCEL: '1', VERCEL_ENV: 'development' }, { VERCEL: '', VERCEL_ENV: '' }]) assert.equal(isReadOnlyPreview(env), true);
  assert.equal(isReadOnlyPreview({}), false);
  assert.equal(isReadOnlyPreview({ VERCEL: '1', VERCEL_ENV: 'production' }), false);
});

test('health/config/bootstrap are static and never load runtime or expose inherited secrets/private recipients', async () => {
  const env = new Proxy({ VERCEL: '1', VERCEL_ENV: 'preview' }, { get(target, key) { if (!['VERCEL', 'VERCEL_ENV'].includes(key)) throw new Error(`Forbidden environment read: ${String(key)}`); return target[key]; } });
  const h = preview(env);
  const health = await h.call('/api/health');
  assert.equal(health.status, 200); assert.equal(health.body.runtimeInitialized, false);
  const config = await h.call('/api/public/config?cache=ignored');
  assert.equal(config.status, 200);
  for (const key of ['bookingEnabled', 'smartChat', 'notificationsConfigured', 'textMessages', 'phoneVerification']) assert.equal(config.body[key], false);
  assert.equal(config.body.preview, true); assert.equal(config.body.phone, ''); assert.equal(config.body.approverName, '');
  assert.equal('bookingOwnerSmsPhone' in config.body, false);
  assert.equal('services' in config.body, false);
  const first = await h.call('/api/session', 'POST'), second = await h.call('/api/session', 'POST');
  assert.equal(first.status, 201); assert.equal(first.body.token, 'preview-read-only');
  assert.deepEqual(first.body, second.body);
  assert.equal(first.body.config.bookingEnabled, false);
  assert.equal(h.loads(), 0);
  assert.equal(config.headers['Cache-Control'], 'no-store');
});

test('every live mutation and private read is refused before runtime, including login and OAuth', async () => {
  const h = preview();
  for (const [path, method] of [
    ['/api/chat', 'POST'], ['/api/contact', 'POST'], ['/api/verify/send', 'POST'], ['/api/verify/check', 'POST'],
    ['/api/holds', 'POST'], ['/api/bookings', 'POST'], ['/api/approvals', 'POST'], ['/api/requests', 'POST'],
    ['/api/activity', 'POST'], ['/api/admin/login', 'POST'], ['/api/admin/setup', 'POST'], ['/api/admin/config', 'PATCH'],
    ['/api/admin/data', 'GET'], ['/api/admin/status', 'GET'], ['/api/admin/jobber/connect', 'GET'],
    ['/api/jobber/callback?code=secret', 'GET'], ['/api/availability', 'GET'], ['/api/session', 'GET'],
  ]) {
    const result = await h.call(path, method);
    assert.equal(result.status, 403, `${method} ${path}`);
    assert.equal(result.body.readOnly, true);
    assert.equal(JSON.stringify(result.body).includes('secret'), false);
  }
  assert.equal(h.loads(), 0);
});

test('missing deployment environment still refuses all live routes without runtime', async () => {
  const h = preview({ VERCEL: '1' });
  assert.equal((await h.call('/api/bookings', 'POST')).status, 403);
  assert.equal(h.loads(), 0);
});

test('production and local execution retain normal runtime dispatch', async () => {
  for (const env of [{ VERCEL: '1', VERCEL_ENV: 'production' }, {}]) {
    let loads = 0, starts = 0, requests = 0;
    const handle = createHandler({ env, loadRuntime: async () => { loads++; return { bobRuntime: async () => { starts++; return { handle: async (_req, res) => { requests++; res.writeHead(200, {}); res.end('{"live":true}'); } }; } }; } });
    const res = response(); await handle({ url: '/api/health', method: 'GET' }, res);
    assert.equal(res.body.live, true); assert.equal(loads, 1); assert.equal(starts, 1); assert.equal(requests, 1);
  }
});
