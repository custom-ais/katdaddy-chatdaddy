import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { harness, contact, baseTime, approved } from './helpers.mjs';
import { createEmail } from '../server/email.mjs';
import { confirmationEmail } from '../server/confirmation-email.mjs';
import { dailyReportWindow, dailyReportEmail, sendDailyReport } from '../server/daily-report.mjs';
import { createIntegrationSettings } from '../server/integration-settings.mjs';
import { technicianAvailability } from '../server/technician-availability.mjs';
import { candidateStarts } from '../server/schedule-rules.mjs';
import { createJobber } from '../server/jobber.mjs';
import { createAssistant } from '../server/assistant.mjs';
import { validateConfig } from '../shared/domain.mjs';

const fakeEmail = () => ({ configured: true, provider: 'test', from: 'westvalley@dryerventsquad.com', calls: [], async verify() { return true; }, async send(m) { this.calls.push(m); return { messageId: 'test-only' }; } });
const onCallEnv = { PUBLIC_ORIGIN: 'https://bob.example', CRON_SECRET: 'test-only-cron-secret-please-do-not-use', BOB_SECRET_KEY: 'ab'.repeat(32) };
async function configureOnCall(h) {
  const techs = (await h.store.technicians()).map((t, i) => ({ ...t, onCall: true, status: 'available', phone: `623555000${i + 1}`, jobberUserId: `J-${i}` }));
  await h.store.set('technicians', techs); await h.store.set('config', { ...await h.store.config(), activeTechnicianIds: techs.map((t) => t.id) }); return techs;
}
function responseLink(sms) { return new URL(sms.match(/https:\/\/\S+/)[0]); }
async function respond(h, sms, decision = 'accept') {
  const link = responseLink(sms);
  return fetch(`${h.origin}${link.pathname}${link.search}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: link.searchParams.get('token'), decision }) });
}

test('SMTP uses TLS, cleans header newlines, and detects partial rejection', async () => {
  let options, message;
  const email = createEmail({ env: { SMTP_USER: 'westvalley@dryerventsquad.com', SMTP_PASSWORD: 'test only app password', EMAIL_FROM: 'westvalley@dryerventsquad.com' }, transportFactory: (o) => { options = o; return { sendMail: async (m) => { message = m; return { accepted: ['a@example.com'], rejected: ['b@example.com'] }; } }; } });
  await assert.rejects(email.send({ to: 'a@example.com', cc: 'b@example.com', subject: 'hello\nBcc: bad', html: '<p>Hello</p>', text: 'Hello' }), /every recipient/);
  assert.equal(options.secure, true); assert.equal(options.requireTLS, true); assert.equal(options.auth.pass, 'testonlyapppassword');
  assert.equal(message.from.address, 'westvalley@dryerventsquad.com'); assert.ok(!message.subject.includes('\n'));
  assert.equal(createEmail({ env: {} }).configured, false);
});

test('confirmation email keeps booked price and Arizona arrival window and escapes customer data', () => {
  const message = confirmationEmail({ id: 'DVS-EXAMPLE', customerName: '<script>x</script>', scheduledAt: '2026-11-02T18:00:00Z', package: 'Premium cleaning', route: 'cleaning', price: 179, address: '100 <Main> St', city: 'Buckeye', zip: '85326', lineItems: [{ name: 'Premium cleaning', cents: 17900 }] }, approved);
  assert.match(message.html, /&lt;script&gt;/); assert.doesNotMatch(message.html, /<script>/); assert.match(message.text, /\$179/);
  assert.match(message.text, /10:30.*11:30/); assert.match(message.text, /November 2/); assert.doesNotMatch(message.text, /paid in full/i);
});

test('daily report cutoff stays 17:10 Arizona year round and report escapes user content', () => {
  const now = Date.parse('2026-11-02T00:10:00Z');
  assert.deepEqual(dailyReportWindow(now), { from: now - 86400000, to: now });
  assert.equal(dailyReportWindow(now - 1).to, now - 86400000);
  const summer = Date.parse('2026-06-05T00:10:00Z'); assert.equal(dailyReportWindow(summer).to, summer);
  const m = dailyReportEmail({ from: now - 86400000, to: now, counts: {}, requests: [{ name: '<script>', id: 'REQ-1', message: '<img src=x>', status: 'new' }] });
  assert.match(m.html, /&lt;script&gt;/); assert.doesNotMatch(m.html, /<script>/);
});

test('emails send independently of broken LeadConnector; SMS stays paused and Jobber receives consent', async (t) => {
  const email = fakeEmail();
  const h = await harness(t, { email, config: { smsConfirmations: false, requirePhoneVerification: false, phoneServiceReady: false } });
  h.lc.upsertContact = async () => { throw new Error('Invalid integration token (test)'); };
  const result = await h.book('cleaning', { ...contact, email: 'customer@example.com', smsConsent: true });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(email.calls.length, 1); assert.equal(email.calls[0].to, 'customer@example.com');
  assert.equal((await h.store.appointments())[0].notifications.email, 'sent');
  assert.equal(h.jobber.clients[0].contact.smsConsent, true); assert.ok(!h.lc.calls.some((c) => c[0] === 'sms'));
  const token = await h.prepare(); assert.deepEqual(await h.slots(token, '?date=2026-09-21'), []);
});

test('daily reports require cron authentication and duplicate invocations send only once', async (t) => {
  const email = fakeEmail(), h = await harness(t, { email, env: onCallEnv });
  await h.fresh();
  assert.equal((await h.call('/api/cron/daily-report')).status, 401);
  const headers = { Authorization: `Bearer ${onCallEnv.CRON_SECRET}` };
  const first = await h.call('/api/cron/daily-report', { headers }); assert.equal(first.status, 200, JSON.stringify(first.data));
  const second = await h.call('/api/cron/daily-report', { headers }); assert.equal(second.data.alreadySent, true);
  assert.equal(email.calls.length, 1); assert.equal(email.calls[0].to, 'westvalley@dryerventsquad.com'); assert.equal(email.calls[0].cc, 'seth@custom-ais.com');
  const report = await h.store.activityReport(baseTime - 1, baseTime + 1); assert.equal(report.counts.conversations, 1);
  h.advance(86400000);
  email.send = async () => { throw new Error('SMTP timeout'); };
  assert.equal((await h.call('/api/cron/daily-report', { headers })).status, 502);
  assert.equal((await h.call('/api/cron/daily-report', { headers })).status, 409);
});

test('archive is admin-only, deduplicates local messages, outlives sessions, and expires at 60 days', async (t) => {
  const h = await harness(t), token = await h.fresh();
  await h.chat(token, 'How do I prepare?');
  const body = { id: randomUUID(), role: 'user', text: 'Contact step answer' };
  await h.call('/api/conversation/events', { method: 'POST', token, body }); await h.call('/api/conversation/events', { method: 'POST', token, body });
  assert.equal((await h.call('/api/admin/activity')).status, 401);
  const cookie = await h.login();
  const list = await h.call('/api/admin/conversations', { cookie }); assert.equal(list.data.conversations.length, 1);
  const id = list.data.conversations[0].id; assert.notEqual(id, token);
  const record = await h.store.observer.conversation(id); assert.equal(record.events.filter((e) => e.data.text === body.text).length, 1);
  assert.ok(record.events.some((e) => e.data.decision?.reasons.length)); assert.ok(!JSON.stringify(record).includes(token));
  h.advance(2 * 86400000); await h.store.cleanup(); assert.ok(await h.store.observer.conversation(id));
  h.advance(59 * 86400000); assert.equal(await h.store.observer.conversation(id), null); await h.store.cleanup();
  assert.equal(await h.count('conversation_events'), 0); assert.equal(await h.count('conversations'), 0);
});

test('integration keys are encrypted, never returned, authenticated, and reject unsupported settings', async (t) => {
  const h = await harness(t, { env: onCallEnv }), cookie = await h.login();
  const path = '/api/admin/integration-settings', secret = 'test-only-gemini-value';
  assert.equal((await h.call(path)).status, 401);
  const r = await h.call(path, { method: 'PATCH', cookie, body: { values: { GEMINI_API_KEY: secret } } });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.ok(!JSON.stringify(r.data).includes(secret));
  assert.ok(!JSON.stringify(await h.store.kvGet('integrations:encrypted')).includes(secret));
  assert.equal((await createIntegrationSettings({ store: h.store, env: onCallEnv }).resolve()).values.GEMINI_API_KEY, secret);
  await assert.rejects(createIntegrationSettings({ store: h.store, env: { BOB_SECRET_KEY: 'cd'.repeat(32) } }).resolve());
  assert.equal((await h.call(path, { method: 'PATCH', cookie, body: { values: { DATABASE_URL: 'not-allowed' } } })).status, 400);
});

test('on-call timeout creates one support ticket and email even without a customer polling', async (t) => {
  const email = fakeEmail(), h = await harness(t, { email, env: onCallEnv, config: { smsConfirmations: false, requirePhoneVerification: false } });
  const techs = await configureOnCall(h), token = await h.prepare();
  const r = await h.call('/api/on-call', { method: 'POST', token, body: {} }); assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.request.status, 'pending');
  const texts = h.lc.calls.filter((c) => c[0] === 'sms'); assert.equal(texts.length, techs.length);
  await h.call('/api/on-call', { method: 'POST', token, body: {} }); assert.equal(h.lc.calls.filter((c) => c[0] === 'sms').length, techs.length);
  assert.equal((await h.call('/api/cron/on-call')).status, 401);
  h.advance(300001);
  assert.equal((await h.call('/api/cron/on-call', { headers: { Authorization: `Bearer ${onCallEnv.CRON_SECRET}` } })).status, 200);
  const state = await h.call('/api/on-call/current', { token }); assert.equal(state.data.request.status, 'follow_up'); assert.match(state.data.request.reason, /other customers/);
  await h.call('/api/cron/on-call', { headers: { Authorization: `Bearer ${onCallEnv.CRON_SECRET}` } });
  assert.equal((await h.store.requests()).length, 1); assert.equal(email.calls.length, 1); assert.equal(email.calls[0].to, 'westvalley@dryerventsquad.com');
  assert.equal((await respond(h, texts[0][2])).status, 409); assert.equal(await h.count('appointments'), 0);
});

test('first on-call acceptance wins, returns to live slots, and still requires customer booking approval', async (t) => {
  const h = await harness(t, { env: onCallEnv, config: { smsConfirmations: false, requirePhoneVerification: false, emergencyLeadHours: 1 } });
  const techs = await configureOnCall(h), token = await h.prepare('emergency');
  assert.deepEqual(await h.slots(token), [], 'emergency cannot bypass the on-call check');
  await h.call('/api/on-call', { method: 'POST', token, body: {} });
  const texts = h.lc.calls.filter((c) => c[0] === 'sms');
  const preview = responseLink(texts[0][2]); await fetch(`${h.origin}${preview.pathname}${preview.search}`);
  assert.equal((await h.call('/api/on-call/current', { token })).data.request.status, 'pending', 'link previews never accept');
  const accepted = await respond(h, texts[0][2]); assert.equal(accepted.status, 200);
  await respond(h, texts[1][2]);
  assert.equal((await h.call('/api/on-call/current', { token })).data.request.acceptedBy, techs[0].name);
  assert.equal(await h.count('appointments'), 0);
  const [slot] = await h.slots(token); assert.ok(slot); assert.equal(slot.approval, false);
  const held = await h.hold(token, slot.scheduledAt); assert.equal(held.status, 201, JSON.stringify(held.data));
  assert.equal((await h.confirm(token, held.data.hold, { approved: false })).status, 400);
  const booked = await h.confirm(token, held.data.hold); assert.equal(booked.status, 201, JSON.stringify(booked.data));
  assert.equal((await h.store.appointments())[0].technicianId, techs[0].id);
});

test('phone pause routes urgent requests to a support ticket without sending texts', async (t) => {
  const email = fakeEmail(), h = await harness(t, { email, env: onCallEnv, config: { phoneServiceReady: false, smsConfirmations: false, requirePhoneVerification: false } });
  await configureOnCall(h); const token = await h.prepare('emergency');
  const r = await h.call('/api/on-call', { method: 'POST', token, body: {} }); assert.equal(r.data.request.status, 'follow_up');
  assert.equal(h.lc.calls.filter((c) => c[0] === 'sms').length, 0); assert.equal(email.calls.length, 1);
  assert.deepEqual(candidateStarts({ config: { ...approved, phoneServiceReady: false, leadHours: 0, sameDay: { enabled: true, cutoffHour: 20, minNoticeHours: 0 } }, durationMins: 60, now: baseTime, date: '2026-09-21' }), []);
});

test('technician availability follows calendar conflicts, off-duty override, and calendar failure', async () => {
  const tech = { id: 'tech-ryan', jobberUserId: 'J1', name: 'Ryan', status: 'available' };
  const jobber = { readVisits: async () => [{ start: baseTime - 1000, end: baseTime + 600000, jobberUserIds: ['J1'] }] };
  const args = { config: approved, technicians: [tech], appointments: [], jobber, now: baseTime };
  assert.equal((await technicianAvailability(args))[0].availability.state, 'busy');
  jobber.readVisits = async () => []; assert.equal((await technicianAvailability(args))[0].availability.state, 'available');
  jobber.readVisits = async () => { throw new Error('calendar down'); }; assert.equal((await technicianAvailability(args))[0].availability.state, 'unknown');
  tech.status = 'off_duty'; assert.equal((await technicianAvailability(args))[0].availability.state, 'off_duty');
});

test('existing Jobber client gets only its matching phone consent changed', async () => {
  const calls = [], client = { id: 'C1', emails: [], phones: [{ id: 'P1', number: '6235551234', smsAllowed: false }, { id: 'P2', number: '6235559999', smsAllowed: true }], properties: [{ id: 'HOME', address: { street1: '100 W Test St', postalCode: '85326' } }] };
  const jobber = createJobber({ store: {}, env: { JOBBER_CLIENT_ID: 'test', JOBBER_CLIENT_SECRET: 'test', JOBBER_REDIRECT_URI: 'https://bob.example/callback' }, tokens: { load: async () => ({ accessToken: 'test', refreshToken: 'test', expiresAt: Date.now() + 3600000 }) }, fetchImpl: async (_url, opts) => {
    const body = JSON.parse(opts.body); calls.push(body); let data;
    if (body.query.includes('BobClientSearch')) data = { clients: { nodes: [client] } };
    else if (body.query.includes('BobInputFields')) data = { __type: { inputFields: body.variables.name === 'ClientUpdateInput' ? [{ name: 'phones', type: { name: 'PhoneUpdates' } }] : [{ name: 'edit' }, { name: 'add' }] } };
    else data = { clientUpdate: { client: { id: 'C1' }, userErrors: [] } };
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  await jobber.ensureClientAndProperty({ phone: contact.phone, smsConsent: true }, { street1: contact.address, city: contact.city, zip: contact.zip });
  const update = calls.find((c) => c.query.includes('BobClientSmsPreference'));
  assert.deepEqual(update.variables.input, { phones: { edit: [{ id: 'P1', smsAllowed: true }] } });
});

test('a technician acceptance never bypasses a changed calendar', async (t) => {
  const email = fakeEmail(), h = await harness(t, { email, env: onCallEnv, config: { smsConfirmations: false, requirePhoneVerification: false, emergencyLeadHours: 1 } });
  const techs = await configureOnCall(h), token = await h.prepare('emergency');
  await h.call('/api/on-call', { method: 'POST', token, body: {} });
  const sms = h.lc.calls.find((c) => c[0] === 'sms')[2]; await respond(h, sms);
  h.jobber.visits.push({ id: 'BOOKED-ELSEWHERE', start: baseTime - 3600000, end: baseTime + 5 * 3600000, allDay: false, jobberUserIds: [techs[0].jobberUserId], address: '100 W Test St, Buckeye, AZ 85326' });
  assert.deepEqual(await h.slots(token), []);
  const state = (await h.call('/api/on-call/current', { token })).data.request;
  assert.equal(state.status, 'follow_up'); assert.match(state.reason, /no same-day opening/);
  assert.equal(email.calls.length, 1); assert.equal(await h.count('appointments'), 0);
});

test('on-call acceptance cannot be reused after customer contact details change', async (t) => {
  const email = fakeEmail(), h = await harness(t, { email, env: onCallEnv, config: { smsConfirmations: false, requirePhoneVerification: false, emergencyLeadHours: 1 } });
  await configureOnCall(h); const token = await h.prepare('emergency');
  await h.call('/api/on-call', { method: 'POST', token, body: {} });
  await respond(h, h.lc.calls.find((c) => c[0] === 'sms')[2]);
  const slots = await h.slots(token); assert.ok(slots.length);
  await h.call('/api/contact', { method: 'POST', token, body: { ...contact, phone: '6235559876' } });
  assert.equal((await h.hold(token, slots[0].scheduledAt)).status, 409);
  assert.equal((await h.call('/api/on-call/current', { token })).data.request.status, 'follow_up');
  assert.equal(email.calls.length, 1);
});

test('AI settings change the provider call while invalid limits are rejected', async () => {
  let url, body;
  const assistant = createAssistant({ env: { GEMINI_API_KEY: 'test-only-key' }, fetchImpl: async (u, options) => { url = u; body = JSON.parse(options.body); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{}' }] } }] }), { status: 200 }); } });
  const config = { ...approved, smsConfirmations: false, aiSettings: { model: 'gemini-test', temperature: 0.2, maxOutputTokens: 2048, timeoutMs: 5000 } };
  await assistant.interpret({ text: 'Hello', session: { stage: 'welcome', history: [], property: {}, options: [] }, config, faqs: [] });
  assert.match(url, /gemini-test:generateContent$/); assert.equal(body.generationConfig.temperature, 0.2); assert.equal(body.generationConfig.maxOutputTokens, 2048);
  assert.doesNotMatch(body.systemInstruction.parts[0].text, /the customer confirms their phone with a text code/);
  assert.ok(validateConfig({ ...config, aiSettings: { ...config.aiSettings, maxOutputTokens: 100000 } }).some((e) => /response limit/.test(e)));
});
