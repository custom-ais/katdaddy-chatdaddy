import test from 'node:test';
import assert from 'node:assert/strict';
import { captureAvailabilityRequest } from '../server/availability-request.mjs';
function setup() {
  const requests = new Map(), calls = [];
  const args = {
    store: {
      requestByIdem: async key => requests.get(key), lock: async () => true, unlock: async () => {},
      rateHit: async () => true, insertRequest: async (request, session, key) => requests.set(key, request),
      updateRequest: async () => {}, technicians: async () => [],
    },
    config: { approver: { name: 'Office', phone: '6235550100' } },
    data: { intent: 'emergency', stage: 'triage', history: [] }, message: 'today',
    session: 'test-session', now: Date.parse('2026-10-31T20:00:00Z'), origin: 'https://example.test', log: async () => {},
    sendStaffSms: async args => { calls.push(args); return { messageId: 'mock-message' }; },
  };
  return { args, requests, calls };
}
test('availability uses explicit Twilio staff sender and deduplicates', async () => {
  const h = setup();
  await captureAvailabilityRequest(h.args);
  await captureAvailabilityRequest(h.args);
  assert.equal(h.calls.length, 1);
  assert.equal([...h.requests.values()][0].notification.provider, 'Twilio');
});
test('missing staff sender preserves request without attempting legacy fallback', async () => {
  const h = setup();
  h.args.sendStaffSms = undefined;
  h.args.lc = { configured: true, upsertContact: async () => { throw Error('must not call'); } };
  assert.match(await captureAvailabilityRequest(h.args), /saved your availability request/);
  assert.equal(h.requests.size, 1);
  assert.equal([...h.requests.values()][0].notification.status, 'failed');
  assert.equal(h.calls.length, 0);
});
test('ordinary requests never notify emergency approver', async () => {
  const h = setup(); h.args.data.intent = 'cleaning';
  assert.equal(await captureAvailabilityRequest(h.args), '');
  assert.equal(h.calls.length, 0); assert.equal(h.requests.size, 0);
});
