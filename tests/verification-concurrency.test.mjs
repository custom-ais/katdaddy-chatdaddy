import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { harness, contact } from './helpers.mjs';
import { waitForRequestLock } from '../server/request-lock.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
const digest = value => createHash('sha256').update(value).digest('hex');
const env = { BOOKING_VERIFICATION_PROVIDER: 'twilio' };
const fakeTwilio = () => ({
  verifyConfigured: true, messagingConfigured: false,
  sendVerification: async () => ({ sid: 'VE' + 'a'.repeat(32), status: 'pending' }),
  checkVerification: async ({ sid }) => ({ sid, status: 'approved' }),
});
async function prepare(h, details = contact) {
  const token = await h.accept();
  assert.equal((await h.call('/api/contact', { method: 'POST', token, body: details })).status, 200);
  return token;
}
function observeContention(store) {
  const waiting = deferred(), acquire = store.acquireLease;
  store.acquireLease = async (...args) => {
    const acquired = await acquire(...args);
    if (!acquired) waiting.resolve();
    return acquired;
  };
  return waiting.promise;
}

for (const channel of ['sms', 'email']) {
  test(`slow ${channel} verification queues a safety message instead of dropping it`, { timeout: 15_000 }, async t => {
    const entered = deferred(), finish = deferred(), twilio = fakeTwilio();
    twilio.checkVerification = async ({ sid }) => { entered.resolve(); await finish.promise; return { sid, status: 'approved' }; };
    const h = await harness(t, { twilio, env });
    const token = await prepare(h, { ...contact, email: 'owner@example.test' });
    await h.call('/api/verify/send', { method: 'POST', token, body: { channel } });
    const checking = h.call('/api/verify/check', { method: 'POST', token, body: { code: '123456' } });
    await entered.promise;
    const waiting = observeContention(h.store);
    const safety = h.call('/api/chat', { method: 'POST', token, body: { message: 'There is smoke coming from my dryer' } });
    try { await waiting; } finally { finish.resolve(); }
    assert.equal((await checking).status, 200);
    const result = await safety;
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.ok(result.data.session.safety);
    assert.equal(result.data.session.contact.email, 'owner@example.test');
    assert.equal((await h.call('/api/availability', { token })).status, 409);
    assert.equal(await h.count('appointments'), 0);
  });
}

for (const rest of [false, true]) {
  test(`overlapping code requests wait and reuse one accepted code (${rest ? 'REST' : 'direct SQL'})`, { timeout: 15_000 }, async t => {
    const entered = deferred(), finish = deferred(), twilio = fakeTwilio();
    let sends = 0;
    twilio.sendVerification = async () => { sends++; entered.resolve(); await finish.promise; return { sid: 'VE' + 'a'.repeat(32), status: 'pending' }; };
    const h = await harness(t, { twilio, env, rest });
    const token = await prepare(h);
    const first = h.call('/api/verify/send', { method: 'POST', token, body: { channel: 'sms' } });
    await entered.promise;
    const waiting = observeContention(h.store);
    const second = h.call('/api/verify/send', { method: 'POST', token, body: { channel: 'sms' } });
    try { await waiting; assert.equal(sends, 1); } finally { finish.resolve(); }
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.status, 200, JSON.stringify(a.data));
    assert.equal(b.status, 200, JSON.stringify(b.data));
    assert.equal(b.data.verification.sent, true);
    assert.equal(b.data.verification.reused, true);
    assert.equal(a.data.verification.expiresAt, b.data.verification.expiresAt);
    assert.equal(sends, 1, 'no second provider send or code invalidation');
    const checked = await h.call('/api/verify/check', { method: 'POST', token, body: { code: '123456' } });
    assert.equal(checked.status, 200);
  });
}

test('different customers request codes concurrently', { timeout: 15_000 }, async t => {
  const entered = deferred(), finish = deferred(), twilio = fakeTwilio();
  let active = 0;
  twilio.sendVerification = async () => {
    if (++active === 4) entered.resolve();
    await finish.promise;
    return { sid: 'VE' + 'a'.repeat(32), status: 'pending' };
  };
  const h = await harness(t, { twilio, env });
  const tokens = [];
  for (let i = 0; i < 4; i++) {
    const token = await h.fresh(), key = digest(token), data = await h.store.loadSession(key);
    data.contact = { ...contact, phone: `+1623555010${i}` };
    data.stage = 'verify';
    await h.store.saveSession(key, data);
    tokens.push(token);
  }
  const requests = tokens.map(token => h.call('/api/verify/send', { method: 'POST', token, body: { channel: 'sms' } }));
  try { await entered.promise; assert.equal(active, 4); } finally { finish.resolve(); }
  for (const result of await Promise.all(requests)) assert.equal(result.status, 200, JSON.stringify(result.data));
});

test('activity logging cannot block a verification-code request', { timeout: 15_000 }, async t => {
  const entered = deferred(), finish = deferred(), sent = deferred(), twilio = fakeTwilio();
  twilio.sendVerification = async () => { sent.resolve(); return { sid: 'VE' + 'a'.repeat(32), status: 'pending' }; };
  const h = await harness(t, { twilio, env });
  const token = await prepare(h), log = h.store.log;
  h.store.log = async (kind, ...args) => { if (kind === 'widget.minimized') { entered.resolve(); await finish.promise; } return log(kind, ...args); };
  const logging = h.call('/api/activity', { method: 'POST', token, body: { kind: 'widget.minimized' } });
  await entered.promise;
  const sending = h.call('/api/verify/send', { method: 'POST', token, body: { channel: 'sms' } });
  try { await sent.promise; assert.equal((await sending).status, 200); } finally { finish.resolve(); }
  assert.equal((await logging).status, 201);
});

test('a contact edit waits for verification and cannot retain ownership of the old destination', { timeout: 15_000 }, async t => {
  const entered = deferred(), finish = deferred(), twilio = fakeTwilio();
  twilio.checkVerification = async ({ sid }) => { entered.resolve(); await finish.promise; return { sid, status: 'approved' }; };
  const h = await harness(t, { twilio, env });
  const token = await prepare(h);
  await h.call('/api/verify/send', { method: 'POST', token, body: { channel: 'sms' } });
  const checking = h.call('/api/verify/check', { method: 'POST', token, body: { code: '123456' } });
  await entered.promise;
  const waiting = observeContention(h.store);
  const editing = h.call('/api/contact', { method: 'POST', token, body: { ...contact, phone: '6235559999' } });
  try { await waiting; } finally { finish.resolve(); }
  assert.equal((await checking).status, 200);
  const edited = await editing;
  assert.equal(edited.status, 200, JSON.stringify(edited.data));
  const current = (await h.call('/api/session', { token })).data.session;
  assert.equal(current.contact.phone, '+16235559999');
  assert.equal(current.verifiedContact, undefined);
  assert.equal(current.phoneVerified, undefined);
  assert.equal(current.stage, 'verify');
});

test('a successful response is withheld until its conversation lease is released', { timeout: 15_000 }, async t => {
  const h = await harness(t, { twilio: fakeTwilio(), env });
  const token = await prepare(h), entered = deferred(), finish = deferred(), release = h.store.releaseLease;
  h.store.releaseLease = async (...args) => { entered.resolve(); await finish.promise; return release(...args); };
  let replied = false;
  const sending = h.call('/api/verify/send', { method: 'POST', token, body: { channel: 'sms' } }).then(result => { replied = true; return result; });
  try { await entered.promise; assert.equal(replied, false); } finally { finish.resolve(); }
  assert.equal((await sending).status, 200);
  assert.equal(await h.store.kvGet(`lock:conversation:${digest(token)}`), null);
});

test('expired request owners cannot unlock a newer request, and waits are bounded', async t => {
  const h = await harness(t);
  assert.equal(await h.store.acquireLease('lease-test', 'old', 1), true);
  h.advance(1_001);
  assert.equal(await h.store.acquireLease('lease-test', 'new', 90), true);
  await h.store.releaseLease('lease-test', 'old');
  assert.equal(await h.store.acquireLease('lease-test', 'third', 90), false);
  await assert.rejects(waitForRequestLock(h.store, 'lease-test', { waitMs: 1 }), e => e.status === 409 && e.extra.code === 'CONVERSATION_PENDING');
  await h.store.releaseLease('lease-test', 'new');
  const lease = await waitForRequestLock(h.store, 'lease-test');
  await lease.release();
});
