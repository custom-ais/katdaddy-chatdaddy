import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { notifyOwnerError } from '../server/owner-error-notification.mjs';
import { ownerBookingSms, ownerErrorSms } from '../server/messages.mjs';
import { createOwnerConsent } from '../server/owner-consent.mjs';
import { OWNER_SMS_CONSENT_VERSION } from '../shared/owner-sms-consent.mjs';
import { harness, baseTime } from './helpers.mjs';

const PHONE = '6235550100';
const KINDS = ['booking_action_needed', 'booking_jobber_failed', 'jobber', 'verification', 'assistant', 'email'];
async function fixture(t, { consent = true, config = {}, rest = false, env = {} } = {}) {
  const h = await harness(t, { rest, config: { ownerErrorSmsEnabled: true, bookingOwnerSmsPhone: PHONE, ...config } });
  let now = baseTime;
  const clock = () => now;
  const ownerConsent = createOwnerConsent({ store: h.store, clock });
  if (consent) await ownerConsent.record({ action: 'grant', revision: 0, phone: PHONE, consent: true, disclosureVersion: OWNER_SMS_CONSENT_VERSION, idempotencyKey: randomUUID() }, 'synthetic-owner-session');
  const args = { store: h.store, ownerConsent, smsReady: () => true, sendSms: (...values) => h.twilio.sendSms(...values), clock, env };
  const notify = (kind = 'booking_action_needed', details = {}) => notifyOwnerError({ ...args, kind, details: { appointmentId: 'DVS-error-test', ...details } });
  const sms = () => h.twilio.calls.filter(call => call[0] === 'sms');
  const records = () => h.db.query("select key,value from bob.kv where key like 'owner-error-sms:%'");
  const events = () => h.db.query("select kind,data from bob.events where kind like 'activity.owner_error_alert.%'");
  return { ...h, args, ownerConsent, notify, sms, records, events, setTime: value => { now = value; } };
}

test('owner error messages use only fixed approved copy, references and Arizona time', () => {
  const details = { appointmentId: 'DVS-private-safe-ref', at: Date.parse('2026-11-02T07:05:00Z'), customerName: 'Private Customer', phone: '6235551234', address: '100 Private St', error: 'secret-provider-error' };
  const expected = {
    booking_action_needed: 'Custom-AIs ChatDaddy alert: booking DVS-private-safe-ref needs your review. Jobber did not confirm the visit. Resolve it in your ChatDaddy dashboard. Reply STOP to opt out.',
    booking_jobber_failed: 'Custom-AIs ChatDaddy alert: a customer could not finish booking because Jobber returned an error at 12:05 AM Arizona time. Check your ChatDaddy dashboard. Reply STOP to opt out.',
    jobber: 'Custom-AIs ChatDaddy alert: online booking may be paused because the Jobber calendar connection failed at 12:05 AM Arizona time. Check Settings > Connections in your ChatDaddy dashboard. Reply STOP to opt out.',
    verification: 'Custom-AIs ChatDaddy alert: customers may not be able to verify their phone and book because the phone-code service failed at 12:05 AM Arizona time. Check Settings > Connections in your ChatDaddy dashboard. Reply STOP to opt out.',
    assistant: 'Custom-AIs ChatDaddy alert: the AI assistant connection failed at 12:05 AM Arizona time, so the chat may not understand typed answers. Check Settings > Connections in your ChatDaddy dashboard. Reply STOP to opt out.',
    email: 'Custom-AIs ChatDaddy alert: booking emails may not be sending because the email connection failed at 12:05 AM Arizona time. Check Settings > Connections in your ChatDaddy dashboard. Reply STOP to opt out.',
  };
  for (const kind of KINDS) {
    const text = ownerErrorSms(kind, details);
    assert.equal(text, expected[kind]);
    assert.doesNotMatch(text, /Private Customer|6235551234|100 Private St|secret-provider-error/);
  }
  assert.throws(() => ownerErrorSms('sms', details));
  assert.throws(() => ownerErrorSms('booking_action_needed', { appointmentId: 'DVS-test\nPrivate Customer' }));
});

test('default booking-owner message has campaign prefix and STOP footer, preserving custom templates', () => {
  const appointment = { id: 'DVS-test', customerName: 'Synthetic Customer', package: 'Vent cleaning', scheduledAt: '2026-11-02T18:00:00Z' };
  assert.equal(ownerBookingSms(appointment, {}), 'Custom-AIs ChatDaddy alert: booking confirmed for Synthetic Customer — Vent cleaning. Mon, Nov 2, 2026, 11:00 AM Arizona time. Ref DVS-test. No approval needed. Reply STOP to opt out.');
  assert.equal(ownerBookingSms(appointment, { messageTemplates: { ownerBookingSms: 'Custom {{booking_reference}}' } }), 'Custom DVS-test');
});

test('all six error triggers remain off when the setting is off', async t => {
  const h = await fixture(t, { config: { ownerErrorSmsEnabled: false } });
  for (const kind of KINDS) assert.equal((await h.notify(kind)).reason, 'disabled');
  assert.equal(h.sms().length, 0);
  assert.deepEqual(await h.records(), []);
});

test('missing, revoked and v1-only consent cannot send or claim an error alert', async t => {
  const h = await fixture(t, { consent: false });
  assert.equal((await h.notify()).reason, 'owner_consent_required');
  await h.ownerConsent.record({ action: 'grant', revision: 0, phone: PHONE, consent: true, disclosureVersion: OWNER_SMS_CONSENT_VERSION, idempotencyKey: randomUUID() }, 'synthetic-owner-session');
  const current = (await h.ownerConsent.snapshot()).current;
  await h.store.kvSet('owner-sms-consent:current', { ...current, disclosureVersion: 'custom-ais-owner-transactional-v1' });
  assert.equal((await h.notify()).reason, 'owner_consent_required');
  await h.store.kvSet('owner-sms-consent:current', current);
  await h.ownerConsent.record({ action: 'revoke', revision: 1, idempotencyKey: randomUUID() }, 'synthetic-owner-session');
  assert.equal((await h.notify()).reason, 'owner_consent_required');
  assert.equal(h.sms().length, 0);
  assert.deepEqual(await h.records(), []);
});

test('invalid recipient, SMS not ready and mismatched consent fail closed', async t => {
  const h = await fixture(t);
  h.args.smsReady = () => false;
  assert.equal((await h.notify()).reason, 'sms_unavailable');
  h.args.smsReady = () => true;
  const config = await h.store.config();
  await h.store.set('config', { ...config, bookingOwnerSmsPhone: 'invalid' });
  assert.equal((await h.notify()).reason, 'not_configured');
  await h.store.set('config', { ...config, bookingOwnerSmsPhone: '6235550199' });
  assert.equal((await h.notify()).reason, 'owner_consent_required');
  assert.equal(h.sms().length, 0);
  assert.deepEqual(await h.records(), []);
});

test('SMS and database failures are not supported owner-error triggers', async t => {
  const h = await fixture(t);
  for (const kind of ['sms', 'database', 'unknown']) assert.equal((await h.notify(kind)).reason, 'unsupported_kind');
  assert.equal(h.sms().length, 0);
  assert.deepEqual(await h.records(), []);
});

test('read-only Vercel previews perform no store, consent, readiness or transport calls', async () => {
  for (const env of [{ VERCEL_ENV: 'preview' }, { VERCEL: '1' }, { VERCEL: '1', VERCEL_ENV: 'development' }]) {
    const calls = [];
    const blocked = name => async () => { calls.push(name); throw new Error('must not run'); };
    const store = { config: blocked('config'), kvGet: blocked('kvGet'), kvSet: blocked('kvSet'), log: blocked('log'), db: { query: blocked('query') } };
    for (const kind of [...KINDS, 'sms', 'database']) {
      const result = await notifyOwnerError({ store, kind, env, details: { appointmentId: 'DVS-preview' }, ownerConsent: { allows: blocked('consent') }, smsReady: blocked('readiness'), sendSms: blocked('send') });
      assert.deepEqual(result, { status: 'skipped', reason: 'read_only_preview' });
    }
    assert.deepEqual(calls, []);
  }
});

test('a late preview change stops further store reads, claims, result persistence and logging', async () => {
  for (const transition of ['config', 'consent', 'readiness', 'claim', 'daily', 'dispatch', 'persist']) {
    const env = {}, calls = [], afterPreview = [];
    let queries = 0;
    const record = name => { calls.push(name); if (env.VERCEL_ENV === 'preview') afterPreview.push(name); if (name === transition) env.VERCEL_ENV = 'preview'; };
    const store = {
      config: async () => { record('config'); return { ownerErrorSmsEnabled: true, bookingOwnerSmsPhone: PHONE }; },
      db: { query: async (_sql, [key]) => { queries++; record(key.includes(':daily:') ? 'daily' : 'claim'); return [{ key }]; } },
      kvSet: async () => { record('persist'); },
      log: async () => { record('log'); },
    };
    const result = await notifyOwnerError({ store, kind: 'jobber', env, clock: () => baseTime,
      ownerConsent: { allows: async () => { record('consent'); return true; } },
      smsReady: () => { record('readiness'); return true; },
      sendSms: async (_phone, _text, { beforeSend }) => { record('dispatch'); await beforeSend(); return { messageId: 'SM-synthetic', status: 'queued' }; },
    });
    assert.equal(calls.includes(transition), true, transition);
    assert.deepEqual(afterPreview, [], transition);
    assert.equal(calls.includes('log'), false, transition);
    if (transition !== 'persist') assert.equal(calls.includes('persist'), false, transition);
    if (transition === 'config' || transition === 'consent') assert.equal(queries, 0, transition);
    assert.ok(['skipped', 'failed_or_uncertain', 'accepted'].includes(result.status));
  }
});

test('one durable booking claim survives concurrent invocations, retries and a later day', async t => {
  const h = await fixture(t);
  const results = await Promise.all(Array.from({ length: 6 }, () => h.notify()));
  assert.equal(results.filter(result => result.status === 'accepted').length, 1);
  assert.equal(h.sms().length, 1);
  assert.equal((await h.notify()).reason, 'already_attempted');
  h.setTime(baseTime + 86_400_000);
  assert.equal((await h.notify()).reason, 'already_attempted');
  assert.equal(h.sms().length, 1);
  const records = await h.records();
  assert.equal(records.filter(row => row.key.startsWith('owner-error-sms:booking:')).length, 1);
  assert.equal(records.filter(row => row.key.startsWith('owner-error-sms:daily:')).length, 1);
});

for (const rest of [false, true]) test(`${rest ? 'REST RPC' : 'PGlite'}: different error kinds share one permanent booking attempt and daily slot`, async t => {
  const h = await fixture(t, { rest });
  const details = { appointmentId: 'DVS-cross-kind-sequential' };
  assert.equal((await h.notify('booking_action_needed', details)).status, 'accepted');
  assert.equal((await h.notify('booking_jobber_failed', details)).reason, 'booking_already_attempted');
  assert.equal(h.sms().length, 1);
  let records = await h.records();
  assert.equal(records.filter(row => row.key.startsWith('owner-error-sms:daily:')).length, 1);
  assert.equal(records.filter(row => row.key === 'owner-error-sms:booking-any:DVS-cross-kind-sequential').length, 1);
  assert.equal(records.find(row => row.key === 'owner-error-sms:booking:booking_jobber_failed:DVS-cross-kind-sequential').value.reason, 'booking_already_attempted');

  const concurrent = { appointmentId: 'DVS-cross-kind-concurrent' };
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => h.notify(i % 2 ? 'booking_action_needed' : 'booking_jobber_failed', concurrent)));
  assert.equal(results.filter(result => result.status === 'accepted').length, 1);
  assert.equal(results.filter(result => result.reason === 'booking_already_attempted').length, 1);
  assert.equal(h.sms().length, 2);
  records = await h.records();
  assert.equal(records.filter(row => row.key.startsWith('owner-error-sms:daily:')).length, 2);
  assert.equal(records.filter(row => row.key.startsWith('owner-error-sms:booking-any:')).length, 2);
});

test('an uncertain booking error send prevents a different error kind forever without another daily slot', async t => {
  const h = await fixture(t);
  let attempts = 0;
  h.args.sendSms = async () => { attempts++; throw new Error('synthetic uncertain provider response'); };
  const details = { appointmentId: 'DVS-cross-kind-uncertain' };
  assert.equal((await h.notify('booking_jobber_failed', details)).status, 'failed_or_uncertain');
  h.setTime(baseTime + 86_400_000);
  assert.equal((await h.notify('booking_action_needed', details)).reason, 'booking_already_attempted');
  assert.equal((await h.notify('booking_jobber_failed', details)).reason, 'already_attempted');
  assert.equal(attempts, 1);
  const records = await h.records();
  assert.equal(records.filter(row => row.key.startsWith('owner-error-sms:daily:')).length, 1);
  assert.equal(records.filter(row => row.key.startsWith('owner-error-sms:booking-any:')).length, 1);
});

test('a preview change during the cross-kind booking claim prevents all later store calls', async () => {
  const env = {}, calls = [], afterPreview = [];
  const record = name => { calls.push(name); if (env.VERCEL_ENV === 'preview') afterPreview.push(name); };
  const store = {
    config: async () => { record('config'); return { ownerErrorSmsEnabled: true, bookingOwnerSmsPhone: PHONE }; },
    db: { query: async (_sql, [key]) => { record(key); if (key.startsWith('owner-error-sms:booking-any:')) env.VERCEL_ENV = 'preview'; return [{ key }]; } },
    kvSet: async () => record('persist'), log: async () => record('log'),
  };
  const result = await notifyOwnerError({ store, kind: 'booking_action_needed', details: { appointmentId: 'DVS-cross-preview' }, env, clock: () => baseTime,
    ownerConsent: { allows: async () => true }, smsReady: () => true, sendSms: async () => record('send'),
  });
  assert.equal(result.reason, 'read_only_preview');
  assert.ok(calls.includes('owner-error-sms:booking-any:DVS-cross-preview'));
  assert.deepEqual(afterPreview, []);
  assert.equal(calls.some(name => name.startsWith('owner-error-sms:daily:') || ['persist', 'log', 'send'].includes(name)), false);
});

test('connection alerts deduplicate by name and six-hour bucket', async t => {
  const h = await fixture(t);
  assert.equal((await h.notify('jobber')).status, 'accepted');
  assert.equal((await h.notify('jobber')).reason, 'already_attempted');
  assert.equal((await h.notify('email')).status, 'accepted');
  h.setTime(baseTime + 21_600_000);
  assert.equal((await h.notify('jobber')).status, 'accepted');
  assert.equal(h.sms().length, 3);
});

for (const rest of [false, true]) test(`${rest ? 'REST RPC' : 'PGlite'}: atomic daily slots cap concurrent sends across all triggers at ten`, async t => {
  const h = await fixture(t, { rest });
  const events = [...['jobber', 'verification', 'assistant', 'email'].map(kind => [kind, {}]), ...Array.from({ length: 12 }, (_, i) => [i % 2 ? 'booking_action_needed' : 'booking_jobber_failed', { appointmentId: `DVS-cap-${i}` }])];
  const results = await Promise.all(events.map(([kind, details]) => h.notify(kind, details)));
  assert.equal(results.filter(result => result.status === 'accepted').length, 10);
  assert.equal(results.filter(result => result.reason === 'daily_cap').length, 6);
  assert.equal(h.sms().length, 10);
  const records = await h.records();
  assert.equal(records.filter(row => row.key.startsWith('owner-error-sms:daily:2026-09-21:')).length, 10);
  const logs = await h.events();
  assert.equal(logs.filter(row => row.kind === 'activity.owner_error_alert.skipped' && row.data.details.reason === 'daily_cap').length, 6);
});

test('daily cap follows the Arizona calendar day, including UTC date boundary', async t => {
  const h = await fixture(t);
  h.setTime(Date.parse('2026-11-02T06:59:00Z'));
  for (let i = 0; i < 10; i++) assert.equal((await h.notify('booking_action_needed', { appointmentId: `DVS-before-midnight-${i}` })).status, 'accepted');
  assert.equal((await h.notify('jobber')).reason, 'daily_cap');
  h.setTime(Date.parse('2026-11-02T07:01:00Z'));
  assert.equal((await h.notify('booking_jobber_failed', { appointmentId: 'DVS-after-midnight' })).status, 'accepted');
  assert.match(h.sms().at(-1)[2], /12:01 AM Arizona time/);
  const records = await h.records();
  assert.equal(records.filter(row => row.key.startsWith('owner-error-sms:daily:2026-11-01:')).length, 10);
  assert.equal(records.filter(row => row.key.startsWith('owner-error-sms:daily:2026-11-02:')).length, 1);
});

test('all gates and the recipient are checked again after durable claims', async t => {
  const h = await fixture(t);
  const config = await h.store.config();
  const query = h.store.db.query;
  let smsReady = true;
  h.args.smsReady = () => smsReady;
  let change;
  h.store.db.query = async (sql, args) => {
    const result = await query(sql, args);
    if (result.length && String(args?.[0]).startsWith('owner-error-sms:daily:') && change) { const action = change; change = null; await action(); }
    return result;
  };
  for (const [reason, action, restore] of [
    ['disabled', () => h.store.set('config', { ...config, ownerErrorSmsEnabled: false }), () => h.store.set('config', config)],
    ['recipient_changed', () => h.store.set('config', { ...config, bookingOwnerSmsPhone: '6235550199' }), () => h.store.set('config', config)],
    ['sms_unavailable', () => { smsReady = false; }, () => { smsReady = true; }],
    ['read_only_preview', () => { h.args.env.VERCEL_ENV = 'preview'; }, () => { delete h.args.env.VERCEL_ENV; }],
    ['owner_consent_required', () => h.ownerConsent.record({ action: 'revoke', revision: 1, idempotencyKey: randomUUID() }, 'synthetic-owner-session'), async () => {}],
  ]) {
    change = action;
    const result = await h.notify('booking_action_needed', { appointmentId: `DVS-recheck-${reason}` });
    assert.equal(result.reason, reason);
    await restore();
  }
  assert.equal(h.sms().length, 0);
});

test('failed or unconfirmed sends remain claimed, never retry and never leak errors or recipient', async t => {
  const h = await fixture(t);
  let attempts = 0;
  h.args.sendSms = async () => { attempts++; throw new Error('Private Customer 6235551234 100 Private St secret-provider-error'); };
  const failed = await h.notify('booking_jobber_failed');
  assert.equal(failed.status, 'failed_or_uncertain');
  assert.equal((await h.notify('booking_jobber_failed')).reason, 'already_attempted');
  for (const [i, response] of [undefined, {}, { messageId: 'SM-test' }, { status: 'queued' }, { messageId: 'SM-test', status: 'failed' }].entries()) {
    h.args.sendSms = async () => { attempts++; return response; };
    const details = { appointmentId: `DVS-uncertain-${i}` };
    assert.equal((await h.notify('booking_action_needed', details)).status, 'failed_or_uncertain');
    assert.equal((await h.notify('booking_action_needed', details)).reason, 'already_attempted');
  }
  assert.equal(attempts, 6);
  const persisted = JSON.stringify([failed, await h.records(), await h.events()]);
  assert.doesNotMatch(persisted, /Private Customer|6235551234|100 Private St|secret-provider-error|6235550100|Custom-AIs ChatDaddy alert:/);
});

test('final transport dispatch guard catches late config changes, withdrawal and a changed Arizona day', async t => {
  const h = await fixture(t);
  const config = await h.store.config();
  let smsReady = true;
  h.args.smsReady = () => smsReady;
  let change, dispatched = 0;
  h.args.sendSms = async (_phone, _text, options) => {
    assert.equal(typeof options.beforeSend, 'function');
    await change();
    await options.beforeSend();
    dispatched++;
    return { messageId: 'SM-not-expected', status: 'queued' };
  };
  for (const [name, action, restore] of [
    ['toggle', () => h.store.set('config', { ...config, ownerErrorSmsEnabled: false }), () => h.store.set('config', config)],
    ['phone', () => h.store.set('config', { ...config, bookingOwnerSmsPhone: '6235550199' }), () => h.store.set('config', config)],
    ['sms', () => { smsReady = false; }, () => { smsReady = true; }],
    ['preview', () => { h.args.env.VERCEL_ENV = 'preview'; }, () => { delete h.args.env.VERCEL_ENV; }],
    ['day', () => h.setTime(baseTime + 86_400_000), () => h.setTime(baseTime)],
    ['consent', () => h.ownerConsent.record({ action: 'revoke', revision: 1, idempotencyKey: randomUUID() }, 'synthetic-owner-session'), async () => {}],
  ]) {
    change = action;
    const details = { appointmentId: `DVS-dispatch-${name}` };
    assert.equal((await h.notify('booking_action_needed', details)).status, 'failed_or_uncertain');
    await restore();
  }
  assert.equal(dispatched, 0);
});

test('claim, config, post-send persistence and logging failures do not escape', async t => {
  const h = await fixture(t);
  const query = h.store.db.query;
  h.store.db.query = async (sql, args) => {
    if (String(args?.[0]).startsWith('owner-error-sms:booking:')) throw new Error('private database error');
    return query(sql, args);
  };
  assert.equal((await h.notify()).reason, 'claim_failed'); assert.equal(h.sms().length, 0);
  h.store.db.query = query;
  const config = h.store.config;
  h.store.config = async () => { throw new Error('private configuration error'); };
  assert.equal((await h.notify()).reason, 'unavailable'); assert.equal(h.sms().length, 0);
  h.store.config = config;
  h.store.kvSet = async () => { throw new Error('private persistence error'); };
  h.store.log = async () => { throw new Error('private logging error'); };
  assert.equal((await h.notify()).status, 'accepted');
  assert.equal((await h.notify()).reason, 'already_attempted');
  assert.equal(h.sms().length, 1);
});

test('owner-only campaign scope does not suppress error alerts', async t => {
  const h = await fixture(t, { env: { SMS_OWNER_ALERTS_ONLY: 'true' } });
  assert.equal((await h.notify('verification')).status, 'accepted');
  assert.equal(h.sms().length, 1);
});
