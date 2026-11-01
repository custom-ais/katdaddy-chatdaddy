import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, contact } from './helpers.mjs';

test('missing Jobber mapping cannot create a client, job or confirmed booking', async t => {
  const h = await harness(t);
  await h.store.set('technicians', (await h.store.technicians()).map(x => ({ ...x, jobberUserId: '' })));
  const r = await h.book('cleaning', contact);
  assert.equal(r.status, 502);
  assert.equal(h.jobber.clients.length, 0);
  assert.equal(h.jobber.jobs.length, 0);
  assert.ok((await h.store.appointments()).every(a => a.status !== 'confirmed'));
});

test('missing Jobber visit is action-needed, not a customer confirmation or duplicate retry', async t => {
  const h = await harness(t);
  h.jobber.createScheduledJob = async () => ({ job: { id: 'existing-job', jobNumber: 999 }, visit: null });
  const r = await h.book('cleaning', contact);
  assert.ok([200,201,202].includes(r.status), JSON.stringify(r));
  const [a] = await h.store.appointments();
  assert.equal(a.status, 'action_needed');
  assert.equal(a.jobber.jobId, 'existing-job');
  assert.equal(a.notifications, undefined);
});

test('configured base routing outage fails closed instead of dropping travel constraint', async t => {
  const h = await harness(t, { config: { baseAddress: '1 Base Way' } });
  h.geo.driveMinutes = async pairs => pairs.map(() => null);
  const token = await h.accept('cleaning');
  const r = await h.call('/api/contact', { method: 'POST', token, body: contact });
  assert.equal(r.status, 503);
  assert.equal(r.data.code, 'ROUTING_UNAVAILABLE');
  assert.equal(h.jobber.jobs.length, 0);
});

test('office uncertain Jobber create retains reservation and does not send confirmation', async t => {
  const h = await harness(t), cookie = await h.login();
  h.jobber.createScheduledJob = async () => { throw Object.assign(new Error('Assignment mismatch'), { uncertain: true, jobberJob: { id: 'partial-job', jobNumber: 101 }, jobberVisit: { id: 'partial-visit' } }); };
  const body = { ...contact, route: 'cleaning', scheduledAt: '2026-09-23T16:00:00Z', sendConfirmation: true };
  const r = await h.call('/api/admin/appointments', { method: 'POST', cookie, body });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.appointment.status, 'action_needed');
  assert.equal(r.data.appointment.jobber.visitId, 'partial-visit');
  assert.equal(r.data.appointment.notifications, undefined);
  const retry = await h.call('/api/admin/appointments', { method: 'POST', cookie, body });
  assert.equal(retry.status, 409, 'uncertain booking retains occupancy');
});

test('office cannot resolve uncertain assignment using job number alone', async t => {
  const h = await harness(t), cookie = await h.login();
  h.jobber.createScheduledJob = async () => ({ job: { id: 'partial', jobNumber: 101 }, visit: null });
  await h.book('cleaning', contact);
  const [a] = await h.store.appointments();
  const r = await h.call(`/api/admin/appointments/${a.id}/resolve`, { method: 'POST', cookie, body: { outcome: 'in_jobber', jobNumber: 101 } });
  assert.equal(r.status, 409);
  assert.equal((await h.store.appointment(a.id)).status, 'action_needed');
});

test('base travel is reverified before final booking instead of trusting contact-time measurement', async t => {
  const h = await harness(t, { config: { baseAddress: '1 Base Way' } });
  const token = await h.prepare();
  const held = await h.hold(token, (await h.slots(token))[0].scheduledAt);
  assert.equal(held.status, 201);
  h.geo.driveMinutes = async pairs => pairs.map(() => null);
  const r = await h.confirm(token, held.data.hold);
  assert.equal(r.status, 409);
  assert.equal(h.jobber.jobs.length, 0);
});
