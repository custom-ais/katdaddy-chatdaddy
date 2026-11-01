import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, contact } from './helpers.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

for (const channel of ['sms', 'email']) {
  test(`slow ${channel} verification serializes chat, contact and resend without overwriting safety or destination`, async t => {
    const entered = deferred(), finish = deferred();
    const twilio = {
      verifyConfigured: true, messagingConfigured: false,
      sendVerification: async () => ({ sid: 'VE' + 'a'.repeat(32), status: 'pending' }),
      checkVerification: async ({ sid }) => { entered.resolve(); await finish.promise; return { sid, status: 'approved' }; },
    };
    const h = await harness(t, { twilio, env: { BOOKING_VERIFICATION_PROVIDER: 'twilio' } });
    const token = await h.accept();
    const details = { ...contact, email: 'owner@example.test' };
    assert.equal((await h.call('/api/contact', { method: 'POST', token, body: details })).status, 200);
    assert.equal((await h.call('/api/verify/send', { method: 'POST', token, body: { channel } })).status, 200);
    const checking = h.call('/api/verify/check', { method: 'POST', token, body: { code: '123456' } });
    await entered.promise;
    try {
      const attempts = await Promise.all([
        h.call('/api/chat', { method: 'POST', token, body: { message: 'There is smoke coming from my dryer' } }),
        h.call('/api/contact', { method: 'POST', token, body: { ...details, phone: '6235559999', email: 'other@example.test' } }),
        h.call('/api/verify/send', { method: 'POST', token, body: { channel: channel === 'sms' ? 'email' : 'sms' } }),
      ]);
      for (const result of attempts) {
        assert.equal(result.status, 409, JSON.stringify(result.data));
        assert.match(result.data.error, /request.*in progress/i);
      }
    } finally { finish.resolve(); }
    const checked = await checking;
    assert.equal(checked.status, 200, JSON.stringify(checked.data));
    const current = await h.call('/api/session', { token });
    assert.equal(current.data.session.stage, 'slots');
    assert.equal(current.data.session.contact.email, details.email);
    assert.equal(current.data.session.contact.phone, '+16235551234');
    assert.equal(current.data.session.verifiedContact.channel, channel);
    assert.equal(Boolean(current.data.session.phoneVerified), channel === 'sms');
    assert.equal(current.data.session.verification, undefined);
    assert.equal(await h.count('appointments'), 0);
    assert.equal(h.jobber.jobs.length, 0);
    // Once the pending operation finishes, the safety message can be retried and
    // must stay authoritative; no delayed verifier remains to restore old data.
    const safety = await h.call('/api/chat', { method: 'POST', token, body: { message: 'There is smoke coming from my dryer' } });
    assert.equal(safety.status, 200, JSON.stringify(safety.data));
    assert.ok(safety.data.session.safety);
    assert.equal((await h.call('/api/availability', { token })).status, 409);
  });
}
