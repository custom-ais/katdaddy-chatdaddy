import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyBookingOwner } from '../server/owner-notification.mjs';
import { DEFAULT_CONFIG, validateConfig, withConfigDefaults } from '../shared/domain.mjs';

function harness() {
  const records = new Map(), calls = [], logs = [];
  const store = {
    db: { query: async (sql, [key, value]) => { assert.match(sql, /on conflict \(key\) do nothing returning key/); if (records.has(key)) return []; records.set(key, JSON.parse(value)); return [{ key }]; } },
    kvSet: async (key, value) => records.set(key, value),
    log: async (...args) => logs.push(args),
  };
  const appointment = { id: 'DVS-test', source: 'ai_bot', status: 'confirmed', customerName: 'Test Customer', package: 'Vent cleaning', scheduledAt: '2026-11-02T18:00:00Z' };
  const config = { bookingOwnerSmsEnabled: true, bookingOwnerSmsPhone: '6235550100' };
  const args = { store, appointment, config, provider: 'Twilio', clock: () => 1, sendSms: async (phone, text) => { assert.equal(records.get('owner-booking-sms:DVS-test').status, 'attempting'); calls.push({ phone, text }); return { messageId: 'SM-test' }; } };
  return { args, records, calls, logs };
}

test('owner alerts default off, remain off for old settings, and require valid configured phone', () => {
  assert.equal(DEFAULT_CONFIG.bookingOwnerSmsEnabled, false);
  assert.equal(DEFAULT_CONFIG.bookingOwnerSmsPhone, '');
  assert.equal(withConfigDefaults({}).bookingOwnerSmsEnabled, false);
  assert.ok(validateConfig({ ...DEFAULT_CONFIG, bookingOwnerSmsEnabled: true }).some(x => /owner notification/.test(x)));
  assert.ok(validateConfig({ ...DEFAULT_CONFIG, bookingOwnerSmsPhone: 'invalid' }).some(x => /owner notification/.test(x)));
});

test('only confirmed ChatDaddy bookings with enabled explicit recipient send', async () => {
  for (const status of ['pending', 'action_needed', 'failed', 'cancelled', 'declined']) {
    const h = harness(); h.args.appointment.status = status;
    assert.equal((await notifyBookingOwner(h.args)).status, 'skipped'); assert.equal(h.calls.length, 0);
  }
  for (const change of [h => h.args.config.bookingOwnerSmsEnabled = false, h => h.args.config.bookingOwnerSmsPhone = '', h => h.args.appointment.source = 'office']) {
    const h = harness(); change(h); await notifyBookingOwner(h.args); assert.equal(h.calls.length, 0); assert.equal(h.records.size, 0);
  }
});

test('successful owner SMS contains customer, service, Arizona date/time, and reference', async () => {
  const h = harness(); const result = await notifyBookingOwner(h.args);
  assert.equal(result.status, 'accepted'); assert.equal(result.delivery, 'not_confirmed');
  assert.equal(h.calls[0].phone, '+16235550100');
  assert.match(h.calls[0].text, /Test Customer.*Vent cleaning.*Nov 2, 2026.*11:00 AM.*Arizona time.*DVS-test/);
  assert.equal(h.logs.length, 1);
});

test('concurrent invocations and later retries produce one durable send attempt', async () => {
  const h = harness();
  const results = await Promise.all([notifyBookingOwner(h.args), notifyBookingOwner(h.args)]);
  assert.equal(h.calls.length, 1);
  assert.ok(results.some(x => x.status === 'already_attempted'));
  assert.equal((await notifyBookingOwner(h.args)).status, 'already_attempted');
  assert.equal(h.calls.length, 1);
});

test('uncertain provider failure remains claimed and never undoes booking or retries', async () => {
  const h = harness(); let attempts = 0;
  h.args.sendSms = async () => { attempts++; throw new Error('private provider error'); };
  const result = await notifyBookingOwner(h.args);
  assert.equal(result.status, 'failed_or_uncertain');
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(h.args.appointment.status, 'confirmed');
  assert.equal((await notifyBookingOwner(h.args)).status, 'already_attempted');
  assert.equal(attempts, 1);
});

test('claim failure sends nothing; post-send persistence failure retains pre-send claim', async () => {
  const h = harness(); h.args.store.db.query = async () => { throw new Error('db down'); };
  assert.equal((await notifyBookingOwner(h.args)).reason, 'claim_failed'); assert.equal(h.calls.length, 0);
  const second = harness(); second.args.store.kvSet = async () => { throw new Error('db down'); };
  assert.equal((await notifyBookingOwner(second.args)).status, 'accepted');
  assert.equal((await notifyBookingOwner(second.args)).status, 'already_attempted');
  assert.equal(second.calls.length, 1);
});

// Real HTTP/store pipeline, mocked external providers only.
import { harness as appHarness, contact, fakeTwilio } from './helpers.mjs';

test('a normal confirmed booking sends one separate owner alert even without customer SMS consent', async t => {
  const calls = [];
  const twilio = { ...fakeTwilio(), messagingConfigured: true, sendSms: async (phone, text) => { calls.push({ phone, text }); return { messageId: 'SM-owner' }; } };
  const h = await appHarness(t, { config: { bookingOwnerSmsEnabled: true, bookingOwnerSmsPhone: '6235550100' }, twilio });
  const r = await h.book('cleaning', { ...contact, smsConsent: false });
  assert.equal(r.status, 201);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /ChatDaddy booked an appointment/);
  const [a] = await h.store.appointments();
  const claim = await h.store.kvGet(`owner-booking-sms:${a.id}`);
  assert.equal(claim.status, 'accepted');
  assert.equal(a.status, 'confirmed');
});

test('uncertain Jobber appointment alerts only after office confirms it exists, never on resend', async t => {
  const calls = [];
  const twilio = { ...fakeTwilio(), messagingConfigured: true, sendSms: async (phone, text) => { calls.push({ phone, text }); return { messageId: 'SM-owner' }; } };
  const h = await appHarness(t, { config: { bookingOwnerSmsEnabled: true, bookingOwnerSmsPhone: '6235550100' }, twilio });
  h.jobber.failNext = 'timeout';
  const booked = await h.book('cleaning');
  assert.equal(booked.status, 202);
  assert.equal(calls.length, 0);
  const [a] = await h.store.appointments();
  const cookie = await h.login();
  h.jobber.visits.push({ id: 'verified-visit', jobNumber: 123, start: Date.parse(a.scheduledAt), end: Date.parse(a.scheduledAt) + a.durationMins * 60_000, allDay: false, jobberUserIds: ['J-RYAN'], address: a.address });
  const resolved = await h.call(`/api/admin/appointments/${a.id}/resolve`, { method: 'POST', cookie, body: { outcome: 'in_jobber', jobNumber: '123' } });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.data));
  assert.equal(calls.length, 1);
  const resent = await h.call(`/api/admin/appointments/${a.id}/confirmation`, { method: 'POST', cookie, body: {} });
  assert.equal(resent.status, 200);
  assert.equal(calls.length, 1);
});

test('emergency booking owner alert waits for named approval and successful booking', async t => {
  const calls = [];
  const twilio = { ...fakeTwilio(), messagingConfigured: true, sendSms: async (phone, text) => { calls.push({ phone, text }); return { messageId: 'SM-owner' }; } };
  const h = await appHarness(t, { config: { emergencyLeadHours: 1, bookingOwnerSmsEnabled: true, bookingOwnerSmsPhone: '6235550100', approver: { name: 'Office', phone: '6235559999', email: '' } }, twilio });
  const token = await h.prepare('emergency');
  const held = await h.hold(token, (await h.slots(token))[0].scheduledAt);
  const asked = await h.call('/api/approvals', { method: 'POST', token, body: { holdId: held.data.hold.id, approved: true } });
  assert.equal(asked.status, 201);
  const ownerCalls = () => calls.filter(c => /ChatDaddy booked an appointment/.test(c.text));
  assert.equal(ownerCalls().length, 0);
  const cookie = await h.login();
  const result = await h.call(`/api/admin/approvals/${asked.data.approval.id}`, { method: 'POST', cookie, body: { decision: 'approve', approverName: 'Office' } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.result.status, 'booked');
  assert.equal(ownerCalls().length, 1);
  assert.equal(ownerCalls()[0].phone, '+16235550100');
});
