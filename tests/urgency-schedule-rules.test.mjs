import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../shared/domain.mjs';
import { evaluateTech, openSlots, orderSlots } from '../server/schedule-rules.mjs';
import { createScheduler } from '../server/schedule.mjs';

const now = Date.parse('2026-09-21T13:00:00-07:00');
const at = time => Date.parse(`2026-09-22T${time}:00-07:00`);
const tech = { id: 'tech-ryan', name: 'Ryan', status: 'available', jobberUserId: 'J-RYAN' };
const config = { ...DEFAULT_CONFIG, horizonDays: 5 };
const candidate = { date: '2026-09-22', start: at('11:00'), end: at('12:30') };
const block = (id, start, end, extra = {}) => ({ id, start: at(start), end: at(end), kind: 'jobber', techIds: [tech.id], ...extra });
const prev = block('previous', '09:00', '10:30');
const next = block('next', '13:00', '14:30');
const evaluate = (minutes, extra = {}) => evaluateTech({
  config, candidate, tech, blocks: [prev, next], urgent: true,
  drive: new Map([[prev.id, { toNew: minutes, fromNew: minutes }], [next.id, { toNew: minutes, fromNew: minutes }]]),
  ...extra,
});

test('urgent routes allow strictly under 25 minutes while routine remains strictly under 20', () => {
  assert.equal(evaluate(19.99, { urgent: false }).ok, true);
  assert.equal(evaluate(20, { urgent: false }).ok, false);
  assert.equal(evaluate(20).ok, true);
  assert.equal(evaluate(24.99).ok, true);
  assert.equal(evaluate(25).ok, false);
  assert.equal(evaluate(22, { urgent: 'true' }).ok, false, 'only a server-derived boolean enables expansion');
  assert.equal(config.maxDriveBetweenJobsMin, 20, 'shared config is never mutated');
  assert.equal(evaluate(15, { config: { ...config, maxDriveBetweenJobsMin: 10 } }).ok, false, 'expansion follows the saved baseline');
});

test('urgency preserves measured travel in each direction, minimum buffer, and overlaps', () => {
  assert.equal(evaluate(22, { blocks: [{ ...prev, end: at('10:31') }] }).reason, 'no_gap_after_previous');
  assert.equal(evaluate(22, { blocks: [{ ...next, start: at('12:59') }] }).reason, 'no_gap_before_next');
  assert.equal(evaluate(24, { config: { ...config, bufferMinutes: 10 }, blocks: [{ ...prev, end: at('10:37') }] }).reason, 'no_gap_after_previous');
  assert.equal(evaluate(24, { config: { ...config, bufferMinutes: 10 }, blocks: [{ ...next, start: at('12:53') }] }).reason, 'no_gap_before_next');
  assert.equal(evaluate(22, { blocks: [{ ...prev, end: at('11:01') }] }).reason, 'overlap');
  for (const value of [null, NaN, -1]) assert.equal(evaluate(value).reason, 'unknown_location');
  assert.equal(evaluate(22, { drive: new Map([[prev.id, { toNew: 22 }]]) }).reason, 'unknown_location');
  assert.equal(evaluate(22, { drive: new Map([[prev.id, { toNew: 22 }], [next.id, { fromNew: 25 }]]) }).reason, 'too_far_from_next');
});

test('anytime visits retain both-direction routing checks and urgent jobs obey capacity and technician availability', () => {
  const anytime = { ...prev, start: at('00:00'), end: at('23:59'), allDay: true };
  assert.equal(evaluate(24, { blocks: [anytime] }).ok, true);
  assert.equal(evaluate(25, { blocks: [anytime] }).reason, 'too_far_from_anytime_visit');
  assert.equal(evaluate(22, { blocks: [anytime], drive: new Map([[prev.id, { toNew: 22, fromNew: null }]]) }).reason, 'unknown_location');
  const args = { config, technicians: [tech], blocks: [prev], drive: new Map([[prev.id, { toNew: 22, fromNew: 22 }]]), durationMins: 90, now, date: candidate.date, urgent: true };
  assert.ok(openSlots(args).length);
  assert.deepEqual(openSlots({ ...args, config: { ...config, maxJobsPerDay: 1 } }), []);
  assert.ok(openSlots({ ...args, technicians: [{ ...tech, status: 'off_duty' }] }).length, 'off duty today does not remove future working days');
  assert.deepEqual(openSlots({ ...args, config: { ...config, activeTechnicianIds: [] } }), []);
  assert.deepEqual(openSlots({ ...args, config: { ...config, blockedDates: [candidate.date] } }), []);
});

test('urgent appointments retain technician working hours, time off and current-day off-duty restrictions', () => {
  const args = { config, technicians: [tech], blocks: [prev], drive: new Map([[prev.id, { toNew: 22, fromNew: 22 }]]), durationMins: 90, now, date: candidate.date, urgent: true };
  const workWeek = Array.from({ length: 7 }, () => ({ on: true, start: '09:00', end: '12:00' }));
  assert.deepEqual(openSlots({ ...args, technicians: [{ ...tech, workWeek }] }), [], 'the 11 AM visit would run beyond the technician shift');
  const timeOff = [{ id: 'away', from: candidate.date, to: candidate.date, start: '', end: '' }];
  assert.deepEqual(openSlots({ ...args, technicians: [{ ...tech, timeOff }] }), []);
  const partial = [{ ...timeOff[0], start: '12:00', end: '14:00' }];
  const found = openSlots({ ...args, technicians: [{ ...tech, timeOff: partial }] });
  assert.ok(!found.some(slot => slot.start === candidate.start), 'the 11 AM visit overlaps partial time off');
  assert.ok(found.some(slot => slot.start === at('15:00')));
  assert.deepEqual(openSlots({ ...args, now: at('00:00'), config: { ...config, sameDay: { ...config.sameDay, enabled: true } }, technicians: [{ ...tech, status: 'off_duty' }] }), [], 'off duty still blocks today even for urgent problems');
});

test('urgent ordering exposes earliest feasible slots without changing routine ranking or reserving any', () => {
  const early = { start: now + 24 * 3600000, routeScore: 0, nearby: false };
  const later = { start: now + 48 * 3600000, routeScore: 20, nearby: true };
  const slots = [later, early];
  assert.deepEqual(orderSlots(slots, { now, nearbyFirst: true, routeScoring: true }), [later, early]);
  assert.deepEqual(orderSlots(slots, { now, nearbyFirst: true, routeScoring: true, urgent: true }), [early, later]);
  assert.deepEqual(slots, [later, early]);
});

test('urgent and routine slots share the inclusive twelve-hour boundary', () => {
  const start = at('09:00');
  for (const urgent of [false, true]) {
    const args = { config: { ...config, leadHours: 0 }, technicians: [tech], blocks: [], drive: new Map(), durationMins: 90, date: candidate.date, urgent };
    assert.ok(openSlots({ ...args, now: start - 12 * 3600000 }).some(slot => slot.start === start));
    assert.ok(!openSlots({ ...args, now: start - 12 * 3600000 + 1 }).some(slot => slot.start === start));
  }
});

test('final scheduler rechecks retain urgent allowance when selecting a preferred technician', async () => {
  const other = { ...tech, id: 'tech-andrew', name: 'Andrew', jobberUserId: 'J-ANDREW' };
  const list = [tech, other].map(t => ({ id: t.id, start: prev.start, end: prev.end, allDay: false, jobberUserIds: [t.jobberUserId], address: 'Synthetic address' }));
  const freshness = [];
  const scheduler = createScheduler({
    store: { activeAppointments: async () => [], activeHolds: async () => [] },
    jobber: { readVisits: async () => list },
    geo: { geocode: async () => ({ lat: 33.4, lng: -112.5 }), driveMinutes: async (pairs, options) => { freshness.push(options.fresh); return pairs.map(() => 22); } },
  });
  const args = { config: { ...config, activeTechnicianIds: [tech.id, other.id] }, technicians: [tech, other], durationMins: 90, now, location: { lat: 33.5, lng: -112.6 }, iso: new Date(candidate.start).toISOString(), preferTech: other.id };
  assert.equal(await scheduler.check(args), null);
  const slot = await scheduler.check({ ...args, urgent: true });
  assert.equal(slot.technicianId, other.id);
  assert.ok(freshness.length >= 3 && freshness.every(Boolean), 'both general and preferred-tech checks use fresh routing');
  other.timeOff = [{ id: 'away', from: candidate.date, to: candidate.date, start: '', end: '' }];
  assert.equal((await scheduler.check({ ...args, urgent: true })).technicianId, tech.id, 'preferred retry cannot bypass time off');
  assert.equal(await scheduler.check({ ...args, config: { ...args.config, activeTechnicianIds: [other.id] }, urgent: true }), null);
});
