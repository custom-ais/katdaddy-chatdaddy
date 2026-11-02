import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createConnectionHealth } from '../server/connection-health.mjs';
import { createOwnerConsent } from '../server/owner-consent.mjs';
import { notifyOwnerError } from '../server/owner-error-notification.mjs';
import { OWNER_SMS_CONSENT_VERSION } from '../shared/owner-sms-consent.mjs';
import { harness } from './helpers.mjs';

function fixture(onError, env = {}) {
  const saved = new Map();
  const store = { config: async () => ({ integrations: {} }), kvGet: async key => saved.get(key), kvSet: async (key, value) => saved.set(key, value) };
  const health = createConnectionHealth({ store, env, clock: () => 12345, onError });
  return { saved, store, health };
}

test('connection error callback runs after save only on a transition for the current revision', async () => {
  const events = [], env = { SENDGRID_API_KEY: 'synthetic-first' };
  const h = fixture(event => { assert.equal(h.saved.get('connection-observation:v1:email').status, 'error'); events.push(event); }, env);
  const healthy = h.health.observe('email', 'send_email', async () => 'ok');
  const failing = h.health.observe('email', 'send_email', async () => { throw new Error('synthetic private provider error'); });
  await healthy();
  await assert.rejects(failing());
  await assert.rejects(failing());
  assert.deepEqual(events, [{ name: 'email', operation: 'send_email', at: 12345 }]);
  await healthy();
  await assert.rejects(failing());
  assert.equal(events.length, 2);
  env.SENDGRID_API_KEY = 'synthetic-second';
  await assert.rejects(failing());
  assert.equal(events.length, 3, 'an error on a new revision is an unknown-to-error transition');
  assert.doesNotMatch(JSON.stringify(events), /synthetic|private|provider error/);
});

test('callback and observation failures never replace the provider result or exception', async () => {
  let callbacks = 0;
  const h = fixture(async () => { callbacks++; throw new Error('synthetic callback failure'); });
  assert.equal(await h.health.observe('verification', 'send_code', async () => 42, { valid: () => false })(), 42);
  const original = new Error('synthetic provider failure');
  await assert.rejects(h.health.observe('jobber', 'calendar', async () => { throw original; })(), error => error === original);
  assert.equal(callbacks, 2);
  h.store.kvSet = async () => { throw new Error('synthetic database failure'); };
  assert.equal(await h.health.observe('assistant', 'interpret', async () => 99, { valid: () => false })(), 99);
  assert.equal(callbacks, 2, 'no callback when observation could not be saved');
});

test('health transitions dispatch owner alerts once per connection bucket without texting about SMS/database', async t => {
  const h = await harness(t, { config: { ownerErrorSmsEnabled: true, bookingOwnerSmsPhone: '6235550100' } });
  const consent = createOwnerConsent({ store: h.store, clock: h.store.clock });
  await consent.record({ action: 'grant', revision: 0, phone: '6235550100', consent: true, disclosureVersion: OWNER_SMS_CONSENT_VERSION, idempotencyKey: randomUUID() }, 'synthetic-admin');
  const health = createConnectionHealth({ store: h.store, clock: h.store.clock, jobber: { accountIdentityRevision: async () => 'synthetic-jobber' }, onError: ({ name, at }) => {
    if (!['jobber', 'verification', 'assistant', 'email'].includes(name)) return;
    return notifyOwnerError({ store: h.store, kind: name, details: { at }, ownerConsent: consent, clock: h.store.clock, smsReady: () => true, sendSms: async (phone, text, options) => { await options.beforeSend(); return h.twilio.sendSms(phone, text); } });
  } });
  const healthy = health.observe('jobber', 'calendar', async () => 'ok');
  const failing = health.observe('jobber', 'calendar', async () => { throw new Error('PRIVATE provider phone 6235559999 address 100 Test St'); });
  await healthy(); await assert.rejects(failing());
  assert.equal(h.twilio.calls.length, 1);
  await assert.rejects(failing());
  await healthy(); await assert.rejects(failing());
  assert.equal(h.twilio.calls.length, 1);
  h.advance(21_600_000);
  await healthy(); await assert.rejects(failing());
  assert.equal(h.twilio.calls.length, 2);
  for (const name of ['verification', 'assistant', 'email', 'sms', 'database']) {
    await assert.rejects(health.observe(name, 'synthetic_operation', async () => { throw new Error('PRIVATE raw failure'); })());
  }
  assert.equal(h.twilio.calls.length, 5);
  assert.doesNotMatch(JSON.stringify(h.twilio.calls.map(call => call[2])), /PRIVATE|6235559999|100 Test St|raw failure/);
});
