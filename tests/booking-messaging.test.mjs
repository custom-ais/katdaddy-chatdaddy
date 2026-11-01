import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, contact } from './helpers.mjs';

function transport(configured = true) {
  const calls = [];
  return { calls, messagingConfigured: configured, sendSms: async (phone, message) => { calls.push({ phone, message }); return { messageId: 'SM-test', status: 'accepted' }; } };
}

for (const mode of ['unavailable', 'upsert-failed']) {
  test(`selected Twilio confirmation works with LC ${mode}`, async t => {
    const twilio = transport();
    const h = await harness(t, { config: { requirePhoneVerification: false }, lc: { configured: mode !== 'unavailable' }, twilio, env: { BOOKING_SMS_PROVIDER: 'twilio' } });
    if (mode === 'upsert-failed') h.lc.upsertContact = async () => { throw new Error('CRM down'); };
    const r = await h.book('cleaning', { ...contact, smsConsent: true, email: 'test@example.com' });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(twilio.calls.length, 1);
    assert.equal(twilio.calls[0].phone, '+16235551234');
    const [a] = await h.store.appointments();
    assert.equal(a.notifications.sms, 'sent');
    assert.equal(a.notifications.email, mode === 'unavailable' ? 'skipped' : 'failed');
    assert.equal(h.lc.calls.some(c => c[0] === 'sms'), false);
  });
}

test('selected Twilio without approved sender fails closed with no LC fallback', async t => {
  const twilio = transport(false);
  const h = await harness(t, { config: { requirePhoneVerification: false }, twilio, env: { BOOKING_SMS_PROVIDER: 'twilio' } });
  const r = await h.book('cleaning', { ...contact, smsConsent: true, email: 'test@example.com' });
  assert.equal(r.status, 201);
  assert.equal(twilio.calls.length, 0);
  assert.equal(h.lc.calls.some(c => c[0] === 'sms'), false);
  assert.equal(h.lc.calls.some(c => c[0] === 'email'), true);
  const [a] = await h.store.appointments();
  assert.equal(a.notifications.sms, 'failed');
  assert.equal(a.notifications.email, 'sent');
});

test('Twilio selection preserves LC email and CRM, while SMS consent remains required', async t => {
  const twilio = transport();
  const h = await harness(t, { config: { requirePhoneVerification: false }, twilio, env: { BOOKING_SMS_PROVIDER: 'twilio' } });
  await h.book('cleaning', { ...contact, smsConsent: false, email: 'test@example.com' });
  assert.equal(twilio.calls.length, 0);
  assert.deepEqual(h.lc.calls.map(c => c[0]), ['upsert', 'email', 'note']);
});

test('ordinary SMS and email retain LC default even with configured Twilio', async t => {
  const twilio = transport();
  const h = await harness(t, { twilio });
  await h.book('cleaning', { ...contact, smsConsent: true, email: 'test@example.com' });
  assert.equal(twilio.calls.length, 0);
  assert.deepEqual(h.lc.calls.map(c => c[0]), ['upsert', 'sms', 'email', 'note']);
});

test('emergency approver Twilio text is independent of LC CRM outage', async t => {
  const twilio = transport();
  const h = await harness(t, { config: { requirePhoneVerification: false, emergencyLeadHours: 1, approver: { name: 'Office', phone: '6235559999', email: 'office@example.com' } }, twilio, env: { BOOKING_SMS_PROVIDER: 'twilio' } });
  h.lc.upsertContact = async () => { throw new Error('CRM down'); };
  const token = await h.prepare('emergency');
  const available = await h.slots(token);
  const held = await h.hold(token, available[0].scheduledAt);
  assert.equal(held.status, 201, JSON.stringify(held.data));
  const response = await h.call('/api/approvals', { method: 'POST', token, body: { holdId: held.data.hold.id, approved: true } });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  const approval = await h.store.approval(response.data.approval.id);
  assert.equal(approval.notified.sms, 'sent');
  assert.equal(approval.notified.email, 'failed');
  assert.equal(twilio.calls.some(c => c.phone === '+16235559999' && /approval needed/.test(c.message)), true);
  assert.equal(await h.count('appointments'), 0);
});
