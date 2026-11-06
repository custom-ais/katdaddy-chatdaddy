import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DEFAULT_CONFIG } from '../shared/domain.mjs';
import { bookingNoticeAllows } from '../shared/booking-notice.mjs';
import { candidateStarts } from '../server/schedule-rules.mjs';
import { harness, contact, baseTime } from './helpers.mjs';

const HOUR = 3_600_000;
const start = Date.parse('2026-09-22T16:00:00Z'); // Tuesday 9 AM Phoenix
const slots = (config, now) => candidateStarts({ config: { ...DEFAULT_CONFIG, ...config }, durationMins: 60, now, date: '2026-09-22' });

test('the twelve-hour boundary is inclusive, with no short-notice emergency or legacy setting bypass', () => {
  for (const leadHours of [0, 2, 4, 12]) {
    assert.ok(slots({ leadHours }, start - 12 * HOUR).some(s => s.start === start));
    assert.ok(!slots({ leadHours }, start - 12 * HOUR + 1).some(s => s.start === start));
    assert.ok(slots({ leadHours }, start - 12 * HOUR - 1).some(s => s.start === start));
  }
  assert.ok(!slots({ leadHours: 24 }, start - 12 * HOUR).some(s => s.start === start), 'longer configured notice remains in effect');
});

test('same-day and overflow lanes cannot bypass twelve hours, and disabled same-day blocks even long notice', () => {
  const now = Date.parse('2026-09-22T07:00:00Z'); // midnight in Phoenix
  const sameDay = { enabled: true, cutoffHour: 15, minNoticeHours: 0, requireNearby: false };
  const config = { ...DEFAULT_CONFIG, sameDay, leadHours: 0, overflow: { ...DEFAULT_CONFIG.overflow, enabled: true, minTicketCents: 0 } };
  const enabled = candidateStarts({ config, durationMins: 60, now, date: '2026-09-22' });
  assert.ok(enabled.length > 0);
  assert.ok(enabled.every(s => s.start - now >= 12 * HOUR));
  assert.deepEqual(slots({ ...config, sameDay: { ...sameDay, enabled: false } }, now), []);
  const afternoon = Date.parse('2026-09-22T20:00:00Z');
  assert.deepEqual(candidateStarts({ config, durationMins: 60, now: afternoon, date: '2026-09-22' }), []);
  assert.equal(bookingNoticeAllows(DEFAULT_CONFIG, now + 15 * HOUR, now), false);
});

test('customer availability and holds enforce twelve hours even with old notice settings', async t => {
  const h = await harness(t, { config: { leadHours: 2, emergencyLeadHours: 2 } });
  h.advance(start - 12 * HOUR - baseTime);
  const token = await h.prepare();
  assert.ok((await h.slots(token, '?date=2026-09-22')).some(s => Date.parse(s.scheduledAt) === start));
  h.advance(1);
  assert.ok(!(await h.slots(token, '?date=2026-09-22')).some(s => Date.parse(s.scheduledAt) === start));
  assert.equal((await h.hold(token, new Date(start).toISOString())).status, 409);
  assert.equal(h.jobber.jobs.length, 0);
});

test('a held opening crossing the twelve-hour boundary cannot be confirmed', async t => {
  const h = await harness(t);
  h.advance(start - 12 * HOUR - baseTime);
  const token = await h.prepare();
  const held = await h.hold(token, new Date(start).toISOString());
  assert.equal(held.status, 201, JSON.stringify(held.data));
  h.advance(1);
  const confirmed = await h.confirm(token, held.data.hold);
  assert.equal(confirmed.status, 409);
  assert.equal(h.jobber.jobs.length, 0);
  assert.equal((await h.store.appointments()).length, 0);
});

test('confirmation at exactly twelve hours succeeds, while slow final checks cannot cross the boundary', async t => {
  for (const delay of [0, 1]) await t.test(`routing delay: ${delay}ms`, async t => {
    const h = await harness(t);
    h.advance(start - 12 * HOUR - baseTime);
    const token = await h.prepare();
    const held = await h.hold(token, new Date(start).toISOString());
    assert.equal(held.status, 201);
    const driveMinutes = h.geo.driveMinutes;
    h.geo.driveMinutes = async (...args) => { h.advance(delay); return driveMinutes(...args); };
    const confirmed = await h.confirm(token, held.data.hold);
    assert.equal(confirmed.status, delay ? 409 : 201, JSON.stringify(confirmed.data));
    assert.equal(h.jobber.jobs.length, delay ? 0 : 1);
  });
});

test('availability contains no same-day slots even when more than twelve hours away', async t => {
  const h = await harness(t, { config: { leadHours: 0 } });
  h.advance(Date.parse('2026-09-22T07:00:00Z') - baseTime);
  const token = await h.prepare();
  const found = await h.slots(token, '?date=2026-09-22');
  assert.deepEqual(found, []);
  assert.equal((await h.hold(token, '2026-09-22T22:00:00Z')).status, 409);
});

test('office creation and rescheduling obey the same minimum', async t => {
  const h = await harness(t, { config: { scheduleSource: 'BOB', leadHours: 0 } });
  h.advance(start - 12 * HOUR - baseTime + 1);
  const cookie = await h.login();
  const make = scheduledAt => h.call('/api/admin/appointments', { method: 'POST', cookie, body: { ...contact, route: 'cleaning', scheduledAt } });
  assert.equal((await make(new Date(start).toISOString())).status, 409);
  const created = await make('2026-09-23T16:00:00Z');
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const a = created.data.appointment;
  const moved = await h.call(`/api/admin/appointments/${a.id}`, { method: 'PATCH', cookie, body: { revision: a.revision, scheduledAt: new Date(start).toISOString() } });
  assert.equal(moved.status, 409);
  assert.equal((await h.store.appointment(a.id)).scheduledAt, '2026-09-23T16:00:00.000Z');
});

test('legacy after-hours approvals cannot create short-notice or disabled same-day appointments', async t => {
  for (const [name, now, arrivalAt] of [
    ['short notice', baseTime, baseTime + 6 * HOUR],
    ['same-day beyond twelve hours', baseTime - 13 * HOUR, baseTime],
  ]) await t.test(name, async t => {
    const h = await harness(t, { config: { emergencyLeadHours: 4, sameDay: { enabled: false, cutoffHour: 13, minNoticeHours: 3, requireNearby: true } } });
    h.advance(now - baseTime);
    const token = await h.prepare();
    const key = createHash('sha256').update(token).digest('hex');
    const data = await h.store.loadSession(key);
    // Seed a pending legacy record; the current emergency chat still directs people to the office.
    const a = { id: 'APR-legacy-afterhours', kind: 'after_hours', session: key, status: 'pending', holdId: null,
      requestedAt: now, expiresAt: now + 30 * 60_000, service: 'Legacy after-hours request' };
    await h.store.insertApproval(a);
    await h.store.saveSession(key, { ...data, approvalId: a.id, stage: 'approval', afterHours: true });
    const cookie = await h.login();
    const denied = await h.call(`/api/admin/approvals/${a.id}`, { method: 'POST', cookie, body: { decision: 'approve', approverName: 'Test', arrivalAt, technicianId: 'tech-ryan' } });
    assert.equal(denied.status, 409);
    assert.match(denied.data.error, /12 hours/);
    assert.equal(h.jobber.jobs.length, 0);
    assert.equal((await h.store.appointments()).length, 0);
  });
});
