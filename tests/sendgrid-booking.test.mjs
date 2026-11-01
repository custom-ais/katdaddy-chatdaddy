import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { harness, contact } from './helpers.mjs';

const who = { ...contact, email: 'customer@example.test', smsConsent: false };
function mailer() {
  const api = { configured: true, calls: [], fail: false,
    async sendEmail(to, message) {
      api.calls.push({ to, ...message });
      if (api.fail) throw Object.assign(new Error('Delivery failed'), api.fail === 'rejected' ? { rejected: true, uncertain: false } : { uncertain: true });
      return { status: 'accepted', messageId: 'fake-message-id' };
    },
  };
  return api;
}
async function setup(t, options = {}) {
  const sendgrid = mailer();
  const h = await harness(t, { sendgrid, env: { BOOKING_EMAIL_PROVIDER: 'sendgrid' }, ...options });
  return { h, sendgrid };
}
async function heldBooking(h, route = 'cleaning') {
  const token = await h.prepare(route, who);
  const held = await h.hold(token, (await h.slots(token))[0].scheduledAt);
  assert.equal(held.status, 201, JSON.stringify(held.data));
  return { token, hold: held.data.hold };
}

test('SendGrid customer confirmation is accepted without SMS consent and receipt never claims delivery', async t => {
  const { h, sendgrid } = await setup(t);
  const result = await h.book('cleaning', who);
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(sendgrid.calls.length, 1);
  assert.equal(sendgrid.calls[0].to, who.email);
  assert.match(sendgrid.calls[0].subject, /booked/i);
  assert.match(sendgrid.calls[0].text, /Reference:/);
  assert.match(sendgrid.calls[0].html, /<html>/);
  const [appointment] = await h.store.appointments();
  assert.equal(appointment.notifications.email, 'accepted');
  assert.equal(appointment.notifications.emailDelivery, 'not_confirmed');
  assert.match(result.data.receipt.notification, /accepted.*delivery/i);
  assert.equal(h.twilio.calls.filter(c => c[0] === 'sms').length, 0);
  assert.deepEqual(h.lc.calls, []);
});

test('same booking retry and repeated admin confirmation never duplicate accepted email', async t => {
  const { h, sendgrid } = await setup(t);
  const { token, hold } = await heldBooking(h), idempotencyKey = randomUUID();
  const first = await h.confirm(token, hold, { idempotencyKey });
  const again = await h.confirm(token, hold, { idempotencyKey });
  assert.equal(first.status, 201);
  assert.equal(again.data.receipt.id, first.data.receipt.id);
  const cookie = await h.login();
  for (let n = 0; n < 2; n++) {
    const r = await h.call(`/api/admin/appointments/${first.data.receipt.id}/confirmation`, { method: 'POST', cookie, body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  assert.equal(sendgrid.calls.length, 1);
  assert.equal((await h.store.appointments())[0].notifications.email, 'accepted');
  assert.deepEqual(h.lc.calls, []);
});

for (const disabled of ['customer preference', 'integration switch', 'provider selection', 'credentials missing']) {
  test(`email disabled by ${disabled} never calls SendGrid and receipt stays honest`, async t => {
    const sendgrid = mailer();
    if (disabled === 'credentials missing') sendgrid.configured = false;
    const h = await harness(t, { sendgrid,
      env: { BOOKING_EMAIL_PROVIDER: disabled === 'provider selection' ? '' : 'sendgrid' },
      config: disabled === 'customer preference' ? { emailConfirmations: false } : disabled === 'integration switch' ? { integrations: { email: false } } : {},
    });
    const r = await h.book('cleaning', who);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal(sendgrid.calls.length, 0);
    assert.equal((await h.store.appointments())[0].notifications.email, 'skipped');
    assert.match(r.data.receipt.notification, /not been confirmed sent/i);
    assert.doesNotMatch(r.data.receipt.notification, /accepted for delivery/i);
    assert.deepEqual(h.lc.calls, []);
  });
}

for (const failure of ['uncertain', 'rejected']) test(`${failure} email never rolls back booking or resends on booking/admin retries`, async t => {
  const { h, sendgrid } = await setup(t); sendgrid.fail = failure;
  const { token, hold } = await heldBooking(h);
  const result = await h.confirm(token, hold);
  assert.equal(result.status, 201);
  const [a] = await h.store.appointments();
  assert.equal(a.status, 'confirmed');
  assert.notEqual(a.notifications.email, 'accepted');
  await h.confirm(token, hold);
  const cookie = await h.login();
  await h.call(`/api/admin/appointments/${a.id}/confirmation`, { method: 'POST', cookie, body: {} });
  assert.equal(sendgrid.calls.length, 1);
  assert.equal(h.jobber.jobs.length, 1);
});

test('uncertain Jobber creates no final email; verified office resolution sends once', async t => {
  const { h, sendgrid } = await setup(t);
  const { token, hold } = await heldBooking(h);
  h.jobber.failNext = 'timeout';
  const r = await h.confirm(token, hold);
  assert.equal(r.status, 202);
  assert.equal(sendgrid.calls.length, 0);
  const [a] = await h.store.appointments();
  h.jobber.visits.push({ id: 'real-mocked-visit', jobNumber: 4521, start: Date.parse(a.scheduledAt), end: Date.parse(a.scheduledAt) + a.durationMins * 60_000, jobberUserIds: ['J-RYAN'] });
  const cookie = await h.login();
  const resolved = await h.call(`/api/admin/appointments/${a.id}/resolve`, { method: 'POST', cookie, body: { outcome: 'in_jobber', jobNumber: '4521' } });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.data));
  await h.call(`/api/admin/appointments/${a.id}/confirmation`, { method: 'POST', cookie, body: {} });
  assert.equal(sendgrid.calls.length, 1);
  assert.equal(sendgrid.calls[0].to, who.email);
});

test('emergency same-day approval emails office without a phone; customer waits for approval', async t => {
  const { h, sendgrid } = await setup(t, { config: { emergencyLeadHours: 1, approver: { name: 'Office', phone: '', email: 'office@example.test' } } });
  const { token, hold } = await heldBooking(h, 'emergency');
  assert.equal(hold.approvalRequired, true);
  const requested = await h.call('/api/approvals', { method: 'POST', token, body: { holdId: hold.id, approved: true } });
  assert.equal(requested.status, 201, JSON.stringify(requested.data));
  assert.equal(sendgrid.calls.length, 1);
  assert.equal(sendgrid.calls[0].to, 'office@example.test');
  assert.match(sendgrid.calls[0].subject + sendgrid.calls[0].text, /approval/i);
  assert.equal(await h.count('appointments'), 0);
  const cookie = await h.login();
  const ok = await h.call(`/api/admin/approvals/${requested.data.approval.id}`, { method: 'POST', cookie, body: { decision: 'approve', approverName: 'Office' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(sendgrid.calls.length, 2);
  assert.equal(sendgrid.calls[1].to, who.email);
  assert.deepEqual(h.lc.calls, []);
});

test('regular bookings send no approval email even with office email configured', async t => {
  const { h, sendgrid } = await setup(t, { config: { approver: { name: 'Office', phone: '', email: 'office@example.test' } } });
  assert.equal((await h.book('cleaning', who)).status, 201);
  assert.deepEqual(sendgrid.calls.map(c => c.to), [who.email]);
  assert.deepEqual(h.lc.calls, []);
});
