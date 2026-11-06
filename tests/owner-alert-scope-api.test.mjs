import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createOwnerConsent } from '../server/owner-consent.mjs';
import { OWNER_SMS_CONSENT_VERSION } from '../shared/owner-sms-consent.mjs';
import { harness, contact, fakeTwilio } from './helpers.mjs';

const ownerPhone = '6235550100';
const ownerRecipient = '+16235550100';
const customer = { ...contact, email: 'synthetic-customer@example.test', smsConsent: true };
const scopedEnv = { SMS_OWNER_ALERTS_ONLY: 'true' };
const smsCalls = h => h.twilio.calls.filter(call => call[0] === 'sms');
const ownerConfig = { bookingOwnerSmsPhone: ownerPhone, ownerErrorSmsEnabled: true };

async function grant(h) {
  const consent = createOwnerConsent({ store: h.store, clock: h.store.clock });
  const current = await consent.snapshot();
  await consent.record({ action: 'grant', revision: current.revision, phone: ownerPhone, consent: true,
    disclosureVersion: OWNER_SMS_CONSENT_VERSION, idempotencyKey: randomUUID() }, 'synthetic-owner-session');
  return consent;
}

async function heldBooking(h, route = 'cleaning') {
  const token = await h.prepare(route, customer);
  const slots = await h.slots(token);
  assert.ok(slots.length, 'synthetic booking must have an available slot');
  const held = await h.hold(token, slots[0].scheduledAt);
  assert.equal(held.status, 201, JSON.stringify(held.data));
  return { token, hold: held.data.hold };
}

function assertPrivateErrorAlert(text) {
  for (const privateValue of [customer.name, customer.phone, '+16235551234', customer.email, customer.address, customer.notes,
    'Jobber request failed: timeout', 'Jobber jobCreate: boom']) {
    assert.equal(text.includes(privateValue), false, `error alert must omit ${privateValue}`);
  }
  assert.match(text, /Reply STOP to opt out\./);
}

async function errorClaims(h) {
  return h.db.query("select key,value from bob.kv where key like 'owner-error-sms:booking:%'");
}

for (const rest of [false, true]) {
  const adapter = rest ? 'REST RPC' : 'PGlite';

  test(`${adapter}: owner-only scope sends one owner booking alert, suppresses customer SMS and records the reason`, async t => {
    const h = await harness(t, { rest, env: scopedEnv, config: { ...ownerConfig, bookingOwnerSmsEnabled: true } });
    await grant(h);
    const publicConfig = await h.call('/api/public/config');
    assert.equal(publicConfig.status, 200);
    assert.equal(publicConfig.data.textMessages, false);
    assert.equal(publicConfig.data.phoneVerification, true);
    const { token, hold } = await heldBooking(h), idempotencyKey = randomUUID();
    const result = await h.confirm(token, hold, { idempotencyKey });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    const [appointment] = await h.store.appointments();
    assert.equal(appointment.status, 'confirmed');
    assert.equal(appointment.notifications.sms, 'skipped');
    assert.equal(appointment.notifications.smsReason, 'sms_scope_owner_alerts_only');
    assert.equal(smsCalls(h).length, 1);
    assert.equal(smsCalls(h)[0][1], ownerRecipient);
    assert.ok((await h.store.activity()).items.some(event => event.kind === 'notification.skipped'
      && event.details.reason === 'sms_scope_owner_alerts_only' && event.details.appointmentId === appointment.id));
    assert.equal((await h.confirm(token, hold, { idempotencyKey })).data.receipt.id, appointment.id);
    const cookie = await h.login();
    const resend = await h.call(`/api/admin/appointments/${appointment.id}/confirmation`, { method: 'POST', cookie, body: {} });
    assert.equal(resend.status, 200, JSON.stringify(resend.data));
    assert.equal(smsCalls(h).length, 1, 'booking retry and admin confirmation must not bypass owner-only scope');
    assert.deepEqual(h.lc.calls, []);
    assert.deepEqual(await errorClaims(h), []);
  });

  test(`${adapter}: disabled owner-only scope preserves customer SMS without owner consent`, async t => {
    const h = await harness(t, { rest, env: { SMS_OWNER_ALERTS_ONLY: 'false' }, config: { ...ownerConfig, bookingOwnerSmsEnabled: true } });
    assert.equal((await h.call('/api/public/config')).data.textMessages, true);
    assert.equal(await h.store.kvGet('owner-sms-consent:current'), null);
    const booked = await h.book('cleaning', customer);
    assert.equal(booked.status, 201, JSON.stringify(booked.data));
    assert.deepEqual(smsCalls(h).map(call => call[1]), ['+16235551234']);
    assert.equal((await h.store.appointments())[0].notifications.sms, 'accepted');
    assert.deepEqual(h.lc.calls, []);
  });

  for (const failure of ['timeout', 'job']) test(`${adapter}: owner-only scope delivers one private owner error alert for ${failure}`, async t => {
    const h = await harness(t, { rest, env: scopedEnv, config: ownerConfig });
    await grant(h);
    const { token, hold } = await heldBooking(h), idempotencyKey = randomUUID();
    h.jobber.failNext = failure;
    const result = await h.confirm(token, hold, { idempotencyKey });
    assert.equal(result.status, failure === 'timeout' ? 202 : 502, JSON.stringify(result.data));
    assert.equal(smsCalls(h).length, 1);
    assert.equal(smsCalls(h)[0][1], ownerRecipient);
    assert.match(smsCalls(h)[0][2], failure === 'timeout' ? /booking DVS[-\w]+ needs your review/ : /a customer could not finish booking/);
    assertPrivateErrorAlert(smsCalls(h)[0][2]);
    assert.doesNotMatch(JSON.stringify(result.data), /Jobber request failed: timeout|Jobber jobCreate: boom/);
    const claims = await errorClaims(h);
    assert.equal(claims.length, 1);
    assert.equal(claims[0].value.status, 'accepted');
    assert.equal(claims[0].value.delivery, 'not_confirmed');
    if (failure === 'timeout') {
      assert.equal(result.data.pending, true);
      assert.equal(result.data.receipt.status, 'action_needed');
      assert.equal((await h.store.appointments())[0].status, 'action_needed');
      const replay = await h.confirm(token, hold, { idempotencyKey });
      const sameSession = await h.confirm(token, hold);
      for (const response of [replay, sameSession]) {
        assert.equal(response.status, 202);
        assert.equal(response.data.receipt.id, result.data.receipt.id);
      }
      assert.equal(smsCalls(h).length, 1, 'pending booking retries must not duplicate the owner alert');
      assert.equal((await errorClaims(h)).length, 1);
    } else {
      assert.match(result.data.error, /not confirmed/);
      for (const privateValue of [customer.name, customer.email, customer.phone, customer.address, customer.notes]) {
        assert.equal(JSON.stringify(result.data).includes(privateValue), false, 'public scheduling error must omit customer details');
      }
      assert.equal((await h.db.query('select status from bob.appointments'))[0].status, 'failed');
    }
    assert.equal(h.jobber.jobs.length, 0);
    assert.deepEqual(h.lc.calls, []);
  });
}



test('owner-only scope leaves SMS Verify and code replay protection operational', async t => {
  const h = await harness(t, { env: scopedEnv });
  const token = await h.accept();
  const entered = await h.call('/api/contact', { method: 'POST', token, body: customer });
  assert.equal(entered.status, 200);
  const sent = await h.call('/api/verify/send', { method: 'POST', token, body: { channel: 'sms' } });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(h.twilio.calls.filter(call => call[0] === 'verify').length, 1);
  const checked = await h.call('/api/verify/check', { method: 'POST', token, body: { code: '1234' } });
  assert.equal(checked.status, 200, JSON.stringify(checked.data));
  assert.ok(checked.data.session.phoneVerified);
  assert.equal((await h.call('/api/verify/check', { method: 'POST', token, body: { code: '1234' } })).status, 409);
  assert.ok((await h.slots(token)).length);
  assert.deepEqual(smsCalls(h), []);
});

for (const failure of ['timeout', 'job']) {
  test(`owner error alerts default off without altering ${failure} booking outcome`, async t => {
    const h = await harness(t, { env: scopedEnv, config: { bookingOwnerSmsPhone: ownerPhone } });
    await grant(h);
    assert.equal((await h.store.config()).ownerErrorSmsEnabled, false);
    const { token, hold } = await heldBooking(h);
    h.jobber.failNext = failure;
    const result = await h.confirm(token, hold);
    assert.equal(result.status, failure === 'timeout' ? 202 : 502);
    assert.deepEqual(smsCalls(h), []);
    assert.deepEqual(await errorClaims(h), []);
  });

  for (const gate of ['no consent', 'v1 consent', 'revoked', 'toggle off', 'sender unavailable', 'recipient changed']) {
    test(`${gate} blocks owner error SMS while preserving ${failure} booking outcome`, async t => {
      const twilio = fakeTwilio();
      if (gate === 'sender unavailable') twilio.messagingConfigured = false;
      const h = await harness(t, { twilio, env: scopedEnv, config: ownerConfig });
      if (gate === 'v1 consent') {
        await h.store.kvSet('owner-sms-consent:current', { revision: 1, active: true, sendingAuthorized: true,
          phone: ownerRecipient, disclosureVersion: 'custom-ais-owner-transactional-v1' });
      } else if (gate !== 'no consent') {
        const consent = await grant(h);
        if (gate === 'revoked') await consent.record({ action: 'revoke', revision: 1, idempotencyKey: randomUUID() }, 'synthetic-owner-session');
        if (gate === 'toggle off') await h.store.set('config', { ...await h.store.config(), ownerErrorSmsEnabled: false });
        if (gate === 'recipient changed') await h.store.set('config', { ...await h.store.config(), bookingOwnerSmsPhone: '6235550199' });
      }
      const { token, hold } = await heldBooking(h);
      h.jobber.failNext = failure;
      const result = await h.confirm(token, hold);
      assert.equal(result.status, failure === 'timeout' ? 202 : 502, JSON.stringify(result.data));
      assert.equal((await h.db.query('select status from bob.appointments'))[0].status, failure === 'timeout' ? 'action_needed' : 'failed');
      assert.deepEqual(smsCalls(h), []);
      assert.deepEqual(await errorClaims(h), []);
      assert.deepEqual(h.lc.calls, []);
    });
  }

  test(`office ${failure} booking does not generate the customer-chat owner error alert`, async t => {
    const h = await harness(t, { env: scopedEnv, config: ownerConfig });
    await grant(h);
    const token = await h.prepare('cleaning', customer);
    const scheduledAt = (await h.slots(token))[0].scheduledAt;
    const cookie = await h.login();
    h.jobber.failNext = failure;
    const result = await h.call('/api/admin/appointments', { method: 'POST', cookie,
      body: { ...customer, route: 'cleaning', package: 'premium', scheduledAt, sendConfirmation: true } });
    assert.equal(result.status, failure === 'timeout' ? 201 : 502, JSON.stringify(result.data));
    if (failure === 'timeout') assert.equal(result.data.appointment.status, 'action_needed');
    assert.deepEqual(smsCalls(h), []);
    assert.deepEqual(await errorClaims(h), []);
  });

}

test('legacy shared-password HTTP session cannot enable or disable owner error alerts', async t => {
  const h = await harness(t, { config: { bookingOwnerSmsPhone: ownerPhone } });
  const cookie = await h.login();
  for (const enabled of [false, true]) {
    await h.store.set('config', { ...await h.store.config(), ownerErrorSmsEnabled: enabled });
    const old = await h.store.config();
    const result = await h.call('/api/admin/config', { method: 'PATCH', cookie,
      body: { version: old.version, ownerErrorSmsEnabled: !enabled } });
    assert.equal(result.status, 403, JSON.stringify(result.data));
    assert.match(result.data.error, /Master Admin/);
    assert.deepEqual(await h.store.config(), old);
  }
  assert.deepEqual(h.twilio.calls, []);
  assert.deepEqual(h.jobber.jobs, []);
});
