import test from 'node:test';
import assert from 'node:assert/strict';
import { createVerification } from '../server/verification.mjs';

function harness() {
  let now = 1_000_000;
  const sessions = new Map(), locks = new Set(), hits = new Map(), calls = [], releases = [];
  const copy = v => structuredClone(v);
  const seed = (token = 'one', contact = {}) => sessions.set(token, { stage: 'verify', contact: { phone: '+16235550100', email: 'Customer@example.com', ...contact } });
  seed();
  const store = {
    lock: async key => { if (locks.has(key)) return false; locks.add(key); return true; },
    unlock: async key => locks.delete(key),
    loadSession: async token => sessions.has(token) ? copy(sessions.get(token)) : null,
    saveSession: async (token, value) => sessions.set(token, copy(value)),
    releaseHolds: async token => releases.push(token),
    rateHit: async (key, limit, window) => { const list = (hits.get(key) || []).filter(t => now - t < window); list.push(now); hits.set(key, list); return list.length <= limit; },
  };
  const twilio = {
    verifyConfigured: true,
    sendVerification: async args => { calls.push(['send', args]); return { sid: 'VE' + 'a'.repeat(32), status: 'pending' }; },
    checkVerification: async args => { calls.push(['check', args]); return { sid: args.sid, status: 'approved' }; },
  };
  const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
  const service = createVerification({ store, twilio, clock: () => now, fail });
  return { service, store, twilio, sessions, locks, calls, releases, hits, seed, advance: ms => { now += ms; } };
}

const rejects = (promise, status) => assert.rejects(promise, e => e.status === status);

test('channel choice itself does not send or modify a session', () => {
  const h = harness(), data = h.sessions.get('one');
  assert.deepEqual(h.service.info(data).channels, ['sms', 'email']);
  assert.equal(h.service.info(data).chooseChannel, true);
  assert.equal(h.service.info(data).sent, false);
  assert.equal(h.calls.length, 0);
  assert.equal(data.verification, undefined);
  assert.deepEqual(h.service.info({ contact: { phone: '+16235550100' } }).channels, ['sms']);
});

for (const channel of ['sms', 'email']) {
  test(`${channel} verifies only the selected destination and consumes the code`, async () => {
    const h = harness();
    const sent = await h.service.send('one', channel);
    assert.equal(sent.sent, true);
    assert.equal(sent.channel, channel);
    assert.equal(sent.to.includes('Customer'), false);
    assert.deepEqual(h.releases, ['one']);
    const data = await h.service.check('one', '1234');
    assert.equal(data.stage, 'slots');
    assert.equal(data.verifiedContact.channel, channel);
    assert.equal(h.service.verified(data), true);
    assert.equal(Boolean(data.phoneVerified), channel === 'sms');
    assert.equal(data.verification, undefined);
    await rejects(h.service.check('one', '1234'), 409);
    assert.equal(h.calls.filter(x => x[0] === 'check').length, 1);
    const changed = structuredClone(data);
    changed.contact[channel === 'sms' ? 'phone' : 'email'] = channel === 'sms' ? '+16235550199' : 'other@example.com';
    assert.equal(h.service.verified(changed), false);
    h.advance(6 * 3_600_000);
    assert.equal(h.service.verified(data), false);
  });
}

test('editing the destination while a code is pending invalidates its check', async () => {
  for (const channel of ['sms', 'email']) {
    const h = harness();
    await h.service.send('one', channel);
    h.sessions.get('one').contact[channel === 'sms' ? 'phone' : 'email'] = channel === 'sms' ? '+16235550199' : 'other@example.com';
    await rejects(h.service.check('one', '1234'), 409);
    assert.equal(h.calls.filter(x => x[0] === 'check').length, 0);
  }
});

test('expiry rejects before the provider, including the exact expiration boundary', async () => {
  const h = harness();
  await h.service.send('one', 'sms');
  h.advance(10 * 60_000);
  await rejects(h.service.check('one', '1234'), 410);
  assert.equal(h.calls.length, 1);
});

test('wrong codes and provider failures count toward the five-attempt limit', async () => {
  const h = harness();
  await h.service.send('one', 'sms');
  h.twilio.checkVerification = async () => ({ status: 'pending' });
  await rejects(h.service.check('one', 'bad'), 400);
  await rejects(h.service.check('one', '1234'), 400);
  h.twilio.checkVerification = async () => { throw new Error('private provider error'); };
  for (let i = 0; i < 3; i++) await rejects(h.service.check('one', '1234'), 502);
  await rejects(h.service.check('one', '1234'), 429);
  assert.equal(h.sessions.get('one').verification.attempts, 5);
  assert.equal(h.locks.size, 0);
});

test('uncertain sends count, invalidate old verification and honor cooldown', async () => {
  const h = harness();
  h.sessions.get('one').phoneVerified = { phone: '+16235550100', at: 1_000_000 };
  h.twilio.sendVerification = async () => { throw new Error('private error'); };
  await rejects(h.service.send('one', 'sms'), 502);
  const data = h.sessions.get('one');
  assert.equal(data.phoneVerified, undefined);
  assert.equal(data.verification, undefined);
  assert.equal((await h.service.send('one', 'sms')).retryInSeconds, 30);
  for (let i = 0; i < 3; i++) { h.advance(30_000); await rejects(h.service.send('one', 'sms'), 502); }
  h.advance(30_000);
  await rejects(h.service.send('one', 'sms'), 429);
});

test('a duplicate or channel switch during cooldown preserves the pending code and code-entry information', async () => {
  const h = harness();
  const first = await h.service.send('one', 'sms');
  for (const channel of ['sms', 'email']) {
    const reused = await h.service.send('one', channel);
    assert.equal(reused.sent, true);
    assert.equal(reused.reused, true);
    assert.equal(reused.chooseChannel, false);
    assert.equal(reused.channel, 'sms');
    assert.equal(reused.expiresAt, first.expiresAt);
    assert.equal(reused.retryInSeconds, 30);
  }
  assert.equal(h.calls.length, 1);
  assert.equal((await h.service.check('one', '1234')).verifiedContact.channel, 'sms');
});

test('switching channels shares cooldown and removes previous ownership', async () => {
  const h = harness();
  await h.service.send('one', 'sms');
  await h.service.check('one', '1234');
  const before = h.calls.length;
  assert.equal((await h.service.send('one', 'email')).sent, false);
  assert.equal(h.calls.length, before);
  h.advance(30_000);
  await h.service.send('one', 'email');
  assert.equal(h.sessions.get('one').phoneVerified, undefined);
  assert.equal(h.sessions.get('one').verifiedContact, undefined);
  assert.equal(h.sessions.get('one').verification.channel, 'email');
  assert.equal((await h.service.check('one', '1234')).phoneVerified, undefined);
});

test('destination budget spans new sessions and does not contain the destination', async () => {
  const h = harness();
  for (let i = 0; i < 4; i++) { h.seed('s' + i); await h.service.send('s' + i, 'email'); }
  h.seed('s5');
  await rejects(h.service.send('s5', 'email'), 429);
  assert.equal(h.calls.length, 4);
  assert.equal([...h.hits.keys()].some(k => /@|1623555/.test(k)), false);
  h.advance(3_600_000);
  assert.equal((await h.service.send('s5', 'email')).sent, true);
});

test('session lock blocks concurrent sends/checks and releases on every failure', async () => {
  const h = harness();
  h.locks.add('verification:one');
  await rejects(h.service.send('one', 'sms'), 409);
  await rejects(h.service.check('one', '1234'), 409);
  assert.equal(h.calls.length, 0);
  h.locks.clear();
  await rejects(h.service.send('missing', 'sms'), 401);
  h.sessions.get('one').stage = 'confirmed';
  await rejects(h.service.send('one', 'sms'), 409);
  assert.equal(h.locks.size, 0);
});

test('unconfigured service and unsupported channels never send', async () => {
  const h = harness();
  h.twilio.verifyConfigured = false;
  await rejects(h.service.send('one', 'sms'), 503);
  h.twilio.verifyConfigured = true;
  await rejects(h.service.send('one', 'call'), 400);
  h.sessions.get('one').contact.email = '';
  await rejects(h.service.send('one', 'email'), 400);
  assert.equal(h.calls.length, 0);
});

for (const channel of ['sms', 'email']) {
  test(`${channel} advertises four digits and rejects other lengths before provider checks`, async () => {
    const h = harness();
    assert.equal(h.service.info(h.sessions.get('one')).codeLength, 4);
    assert.equal((await h.service.send('one', channel)).codeLength, 4);
    for (const code of ['123', '12345', '123456', 'abcd']) {
      await rejects(h.service.check('one', code), 400);
    }
    assert.equal(h.calls.filter(c => c[0] === 'check').length, 0);
    assert.equal((await h.service.check('one', '0123')).stage, 'slots');
    assert.equal(h.calls.at(-1)[1].code, '0123', 'leading zero is preserved');
  });
}
