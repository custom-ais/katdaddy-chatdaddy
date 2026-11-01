import test from 'node:test';
import assert from 'node:assert/strict';
import { createSendGrid } from '../server/sendgrid.mjs';
const env = { SENDGRID_API_KEY: 'fake-private-key', SENDGRID_FROM_EMAIL: 'office@example.com', SENDGRID_FROM_NAME: 'Test Office', SENDGRID_SENDER_VERIFIED: 'true' };
const message = { subject: 'Appointment confirmation', text: 'Confirmed details', html: '<p>Confirmed details</p>' };
test('requires explicit verified sender attestation and valid server configuration, without exposing secrets', async () => {
  for (const change of [{ SENDGRID_API_KEY: '' }, { SENDGRID_FROM_EMAIL: 'bad' }, { SENDGRID_SENDER_VERIFIED: '' }, { SENDGRID_SENDER_VERIFIED: true }, { SENDGRID_FROM_NAME: 'Bad\nName' }]) {
    const p = createSendGrid({ env: { ...env, ...change }, fetchImpl: () => { throw Error('must not call'); } });
    assert.equal(p.configured, false);
    await assert.rejects(p.sendEmail('customer@example.com', message), { code: 'SENDGRID_NOT_CONFIGURED', uncertain: false });
    assert.ok(!JSON.stringify(p).includes(env.SENDGRID_API_KEY));
  }
});
test('sends fixed endpoint with ordered text/html content and records accepted, never delivered', async () => {
  const seen = [];
  const p = createSendGrid({ env, fetchImpl: async (url, init) => { seen.push({ url, init }); return new Response(null, { status: 202, headers: { 'x-message-id': 'mock-message_123' } }); } });
  assert.deepEqual(await p.sendEmail('customer@example.com', message), { messageId: 'mock-message_123', status: 'accepted' });
  const { url, init } = seen[0];
  assert.equal(url, 'https://api.sendgrid.com/v3/mail/send'); assert.equal(init.redirect, 'error');
  assert.equal(init.headers.Authorization, 'Bearer fake-private-key'); assert.ok(init.signal instanceof AbortSignal);
  const body = JSON.parse(init.body);
  assert.deepEqual(body.personalizations, [{ to: [{ email: 'customer@example.com' }] }]);
  assert.deepEqual(body.from, { email: 'office@example.com', name: 'Test Office' });
  assert.deepEqual(body.content.map(c => c.type), ['text/plain', 'text/html']);
  assert.equal(body.template_id, undefined); assert.ok(!init.body.includes(env.SENDGRID_API_KEY));
});
test('invalid recipient, subject or bodies never call provider', async () => {
  const p = createSendGrid({ env, fetchImpl: () => { throw Error('must not call'); } });
  for (const [to, msg] of [['bad', message], ['a@example.com\nBcc: other@example.com', message], ['a@example.com', { ...message, subject: 'Bad\r\nSubject' }], ['a@example.com', { subject: 'Empty' }], ['a@example.com', { ...message, text: {} }], ['a@example.com', { ...message, html: 'x'.repeat(200001) }]]) {
    await assert.rejects(p.sendEmail(to, msg), { code: 'INVALID_EMAIL', uncertain: false });
  }
});
test('only202 is accepted; failures are sanitized with no retries and uncertainty classification', async () => {
  for (const status of [200, 201, 301, 400, 401, 403, 429, 500, 503]) {
    let calls = 0;
    const p = createSendGrid({ env, fetchImpl: async () => { calls++; return new Response(env.SENDGRID_API_KEY, { status }); } });
    const uncertain = status < 400 || status >= 500;
    await assert.rejects(p.sendEmail('customer@example.com', message), e => e.code === (uncertain ? 'SENDGRID_UNCERTAIN' : 'SENDGRID_REJECTED') && e.uncertain === uncertain && !e.message.includes(env.SENDGRID_API_KEY));
    assert.equal(calls, 1);
  }
});
test('network/timeout uncertainty is never retried or leaked', async () => {
  let calls = 0;
  const p = createSendGrid({ env, fetchImpl: async () => { calls++; throw Error(env.SENDGRID_API_KEY); } });
  await assert.rejects(p.sendEmail('customer@example.com', message), e => e.uncertain === true && !e.message.includes(env.SENDGRID_API_KEY));
  assert.equal(calls, 1);
});
test('missing or unsafe tracking headers do not undo accepted send or leak secrets', async () => {
  for (const id of [null, 'fake-private-key', '<unsafe>']) {
    const p = createSendGrid({ env, fetchImpl: async () => new Response(null, { status: 202, headers: id == null ? {} : { 'x-message-id': id } }) });
    assert.deepEqual(await p.sendEmail('customer@example.com', { subject: 'Text only', text: 'Details' }), { messageId: null, status: 'accepted' });
  }
});

test('real transport composes with provider proxy and disabled email makes no external request', async () => {
  const { createIntegrationControls, controlProviders } = await import('../server/integration-controls.mjs');
  const config = { integrations: { email: true } };
  let calls = 0;
  const controls = createIntegrationControls({ store: { config: async () => config } });
  const raw = createSendGrid({ env, fetchImpl: controls.fetchFor('email', async () => { calls++; return new Response(null, { status: 202 }); }) });
  const { sendgrid } = controlProviders({ controls, sendgrid: raw });
  assert.equal(sendgrid.configured, true);
  assert.equal((await sendgrid.sendEmail('customer@example.com', message)).status, 'accepted');
  config.integrations.email = false;
  await assert.rejects(sendgrid.sendEmail('customer@example.com', message), { code: 'INTEGRATION_DISABLED' });
  assert.equal(calls, 1);
});
