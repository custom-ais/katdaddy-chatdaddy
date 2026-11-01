import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistant } from '../server/assistant.mjs';
import { initialSession } from '../shared/conversation.mjs';
import { DEFAULT_CONFIG } from '../shared/domain.mjs';

const args = () => ({ text: 'please clean my vent', session: initialSession(), config: DEFAULT_CONFIG, faqs: [] });
const output = { command: 'START_CLEANING', facts: {}, question: false, answer: null, lead: null };
const completion = (out = output, extra = {}) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(out) }, ...extra }] }));
test('provider metadata defaults to Gemini and selecting a missing key never calls or falls back', async () => {
  let calls = 0;
  const a = createAssistant({ env: { GEMINI_API_KEY: 'fake-gemini' }, fetchImpl: async () => { calls++; } });
  assert.equal(a.provider, 'gemini');
  assert.equal(a.configured, true);
  assert.equal(a.forProvider(), a.forProvider('gemini'));
  assert.equal(a.providers.openai.configured, false);
  assert.equal(a.providers.openai.model, 'gpt-4.1-mini');
  await assert.rejects(a.forProvider('openai').interpret(args()), { code: 'AI_PROVIDER_UNAVAILABLE' });
  assert.throws(() => a.forProvider('constructor'), { code: 'AI_PROVIDER_UNAVAILABLE' });
  assert.equal(calls, 0);
  assert.ok(!JSON.stringify(a.providers).includes('fake-gemini'));
});
test('OpenAI uses fixed endpoint, secret header, no redirects and strict equivalent schema', async () => {
  const calls = [];
  const a = createAssistant({ env: { OPENAI_API_KEY: 'fake-openai', OPENAI_MODEL: 'gpt-4.1-mini' }, fetchImpl: async (url, init) => { calls.push({ url, init }); return completion(); } });
  assert.equal(a.configured, false);
  const result = await a.forProvider('openai').interpret(args());
  assert.equal(result.command, 'START_CLEANING');
  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  const { init } = calls[0];
  assert.equal(init.headers.Authorization, 'Bearer fake-openai');
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal instanceof AbortSignal);
  const body = JSON.parse(init.body);
  assert.equal(body.store, false);
  assert.equal(body.model, 'gpt-4.1-mini');
  assert.equal(body.response_format.json_schema.strict, true);
  const schema = body.response_format.json_schema.schema;
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.facts.additionalProperties, false);
  assert.deepEqual(schema.properties.facts.required, Object.keys(schema.properties.facts.properties));
  assert.match(body.messages[0].content, /cannot book, hold, price/);
  assert.ok(!init.body.includes('fake-openai'));
});
test('OpenAI outputs pass identical command, price and confirmation guardrails', async () => {
  const a = createAssistant({ env: { OPENAI_API_KEY: 'fake' }, fetchImpl: async () => completion({ ...output, command: 'INVENTED', facts: { zip: '85326', power: 'invented' }, answer: "You're confirmed for $1.", lead: 'Send your verification code.' }) });
  const result = await a.forProvider('openai').interpret(args());
  assert.equal(result.command, null);
  assert.deepEqual(result.facts, { zip: '85326' });
  assert.equal(result.answer, null);
  assert.equal(result.lead, null);
});
test('OpenAI refusals, truncation, invalid JSON and provider/network errors fail safely with no retries', async () => {
  for (const response of [
    () => completion(output, { finish_reason: 'length' }),
    () => completion(output, { message: { refusal: 'fake-secret refusal' } }),
    () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'fake-secret invalid' } }] })),
    () => new Response('fake-secret provider error', { status: 401 }),
    () => { throw new Error('fake-secret network'); },
  ]) {
    let calls = 0;
    const a = createAssistant({ env: { OPENAI_API_KEY: 'fake-secret' }, fetchImpl: async () => { calls++; return response(); } });
    await assert.rejects(a.forProvider('openai').interpret(args()), error => error.code === 'AI_PROVIDER_FAILED' && !error.message.includes('fake-secret'));
    assert.equal(calls, 1);
  }
});
test('concurrent provider selection never changes another request or leaks keys across providers', async () => {
  const seen = [];
  const a = createAssistant({ env: { GEMINI_API_KEY: 'fake-g', OPENAI_API_KEY: 'fake-o' }, fetchImpl: async (url, init) => {
    seen.push({ url, init });
    return url.includes('openai.com') ? completion() : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(output) }] } }] }));
  } });
  await Promise.all(['openai', 'gemini', 'openai'].map(p => a.forProvider(p).interpret(args())));
  assert.equal(a.provider, 'gemini');
  for (const { url, init } of seen) {
    if (url.includes('openai.com')) assert.equal(init.headers['x-goog-api-key'], undefined);
    else assert.equal(init.headers.Authorization, undefined);
  }
  assert.equal(seen.filter(x => x.url.includes('openai.com')).length, 2);
});
