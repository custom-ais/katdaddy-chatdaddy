import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { harness, contact, FLOWS } from './helpers.mjs';

const date = '2026-09-22';
const early = `${date}T18:00:00.000Z`; // Tuesday 11 AM Arizona, after the 9–10:30 visit.
const dayQuery = `?date=${date}`;
const sessionKey = token => createHash('sha256').update(token).digest('hex');
const visit = (id = 'earlier-visit', start = `${date}T16:00:00Z`, end = `${date}T17:30:00Z`) => ({
  id, start: Date.parse(start), end: Date.parse(end), allDay: false,
  jobberUserIds: ['J-RYAN'], address: '200 Near Rd, Buckeye, AZ 85326',
});

async function acceptSymptom(h, symptom = "It's showing an airflow error code") {
  const token = await h.fresh();
  let response;
  for (const message of FLOWS.cleaning(contact.zip)) {
    response = await h.chat(token, message === 'Dries in one normal cycle' ? symptom : message);
  }
  assert.equal(response.action, 'contact', response.reply);
  return token;
}

async function prepareSymptom(h, symptom) {
  const token = await acceptSymptom(h, symptom);
  await h.contactAndVerify(token);
  return token;
}

for (const [answer, savedSymptom] of [
  ["It's showing an airflow error code", 'error'],
  ['Dryer is overheating or shutting off', 'overheat'],
]) {
  test(`${savedSymptom}: existing intake opens a feasible earlier route through final booking`, async t => {
    const h = await harness(t);
    h.jobber.visits.push(visit());
    h.geo.driveMinutes = async pairs => pairs.map(() => 22);
    const routine = await h.prepare();
    const urgent = await prepareSymptom(h, answer);
    assert.ok((await h.store.loadSession(sessionKey(urgent))).property.symptoms.includes(savedSymptom));

    assert.deepEqual(await h.slots(routine, dayQuery), [], 'routine keeps the strict 20-minute drive cap');
    const forged = await h.call('/api/holds', {
      method: 'POST', token: routine, body: { scheduledAt: early, urgent: true, urgency: 'high' },
    });
    assert.equal(forged.status, 409, 'an arbitrary client flag cannot widen routine routing');
    const urgentSlots = await h.slots(urgent);
    assert.equal(urgentSlots[0].scheduledAt, early, 'earliest feasible urgent time precedes later route-scored days');
    assert.equal(urgentSlots[0].sameDay, false);
    const held = await h.hold(urgent, early);
    assert.equal(held.status, 201, JSON.stringify(held.data));
    const confirmed = await h.confirm(urgent, held.data.hold);
    assert.equal(confirmed.status, 201, JSON.stringify(confirmed.data));
    assert.equal(confirmed.data.receipt.scheduledAt, early);
    assert.equal(h.jobber.jobs.length, 1);
    assert.equal((await h.store.config()).maxDriveBetweenJobsMin, 20, 'urgency never mutates the saved routine rules');
  });
}

test('urgent routing keeps a strict 25-minute cap and fails closed on unknown travel', async t => {
  const h = await harness(t);
  h.jobber.visits.push(visit());
  const token = await prepareSymptom(h);
  for (const [minutes, allowed] of [[24.999, true], [25, false], [null, false]]) {
    h.geo.driveMinutes = async pairs => pairs.map(() => minutes);
    const slots = await h.slots(token, dayQuery);
    assert.equal(slots.some(slot => slot.scheduledAt === early), allowed, `${minutes} minutes`);
    const held = await h.hold(token, early);
    assert.equal(held.status, allowed ? 201 : 409, JSON.stringify(held.data));
    await h.store.releaseHolds(sessionKey(token));
  }
});

test('urgent availability still requires the real travel time and buffer before and after the visit', async t => {
  const h = await harness(t);
  h.geo.driveMinutes = async pairs => pairs.map(() => 22);
  const token = await prepareSymptom(h);
  h.jobber.visits.push(visit('before', `${date}T16:00:00Z`, `${date}T17:45:00Z`));
  assert.ok(!(await h.slots(token, dayQuery)).some(slot => slot.scheduledAt === early), '15-minute previous gap cannot fit 22-minute travel or 30-minute buffer');
  h.jobber.visits[0].end = Date.parse(`${date}T17:30:00Z`);
  h.jobber.visits.push(visit('after', `${date}T19:30:00Z`, `${date}T21:00:00Z`));
  assert.ok(!(await h.slots(token, dayQuery)).some(slot => slot.scheduledAt === early), '15-minute next gap after the 75-minute service is too short');
  h.jobber.visits[1].start = Date.parse(`${date}T20:00:00Z`);
  assert.ok((await h.slots(token, dayQuery)).some(slot => slot.scheduledAt === early), '30-minute previous and 45-minute next gaps are feasible');
});

test('urgent final booking remeasures travel and rejects a route that no longer fits', async t => {
  const h = await harness(t);
  h.jobber.visits.push(visit());
  let minutes = 22;
  const measurements = [];
  h.geo.driveMinutes = async (pairs, options) => {
    measurements.push(options);
    return pairs.map(() => minutes);
  };
  const token = await prepareSymptom(h);
  assert.ok((await h.slots(token, dayQuery)).some(slot => slot.scheduledAt === early));
  const held = await h.hold(token, early);
  assert.equal(held.status, 201, JSON.stringify(held.data));
  minutes = 25;
  const confirmed = await h.confirm(token, held.data.hold);
  assert.equal(confirmed.status, 409, JSON.stringify(confirmed.data));
  assert.equal(measurements.at(-1).fresh, true);
  assert.equal(h.jobber.jobs.length, 0);
  assert.deepEqual(await h.store.appointments(), []);
});

test('urgent bookings retain capacity and closed-date restrictions', async t => {
  const h = await harness(t, { config: { maxJobsPerDay: 1 } });
  h.jobber.visits.push(visit());
  h.geo.driveMinutes = async pairs => pairs.map(() => 22);
  const token = await prepareSymptom(h);
  assert.deepEqual(await h.slots(token, dayQuery), [], 'one existing job fills the configured company capacity');
  const config = await h.store.config();
  await h.store.set('config', { ...config, maxJobsPerDay: 4, blockedDates: [date] });
  assert.deepEqual(await h.slots(token, dayQuery), [], 'a closed date remains closed');
  assert.equal((await h.hold(token, early)).status, 409);
});

test('urgent symptoms do not widen the base drive limit or service-area coverage', async t => {
  const h = await harness(t, { config: { baseAddress: '1 Base Way', maxDriveFromBaseMin: 20 } });
  h.geo.driveMinutes = async pairs => pairs.map(() => 22);
  const token = await acceptSymptom(h);
  const base = await h.call('/api/contact', { method: 'POST', token, body: contact });
  assert.equal(base.status, 409, JSON.stringify(base.data));
  h.geo.driveMinutes = async pairs => pairs.map(() => 10);
  const outside = await h.call('/api/contact', { method: 'POST', token, body: { ...contact, zip: '90210' } });
  assert.equal(outside.status, 409, JSON.stringify(outside.data));
  assert.equal(h.jobber.jobs.length, 0);
});

test('the production 15-minute buffer never substitutes for a longer measured 22-minute drive', async t => {
  const h = await harness(t, { config: { bufferMinutes: 15 } });
  h.geo.driveMinutes = async pairs => pairs.map(() => 22);
  const token = await prepareSymptom(h);
  h.jobber.visits.push(visit('before', `${date}T16:00:00Z`, `${date}T17:39:00Z`));
  assert.ok(!(await h.slots(token, dayQuery)).some(slot => slot.scheduledAt === early), '21 minutes after the prior visit meets the buffer but not the drive');
  h.jobber.visits[0].end = Date.parse(`${date}T17:38:00Z`);
  assert.ok((await h.slots(token, dayQuery)).some(slot => slot.scheduledAt === early), 'exactly 22 minutes after the prior visit fits');
  h.jobber.visits.push(visit('after', `${date}T19:36:00Z`, `${date}T21:10:00Z`));
  assert.ok(!(await h.slots(token, dayQuery)).some(slot => slot.scheduledAt === early), '21 minutes before the next visit still cannot fit the drive');
  h.jobber.visits[1].start = Date.parse(`${date}T19:37:00Z`);
  assert.ok((await h.slots(token, dayQuery)).some(slot => slot.scheduledAt === early), 'exactly 22 minutes before the next visit fits');
});

test('an urgent held visit is rejected at final confirmation when new technician time off overlaps it', async t => {
  const h = await harness(t, { config: { bufferMinutes: 15 } });
  h.jobber.visits.push(visit());
  h.geo.driveMinutes = async pairs => pairs.map(() => 22);
  const token = await prepareSymptom(h);
  const held = await h.hold(token, early);
  assert.equal(held.status, 201, JSON.stringify(held.data));
  await h.store.set('technicians', (await h.store.technicians()).map(tech => tech.id === 'tech-ryan' ? {
    ...tech, timeOff: [{ id: 'new-time-off', from: date, to: date, start: '12:00', end: '13:00', note: '' }],
  } : tech));
  const confirmed = await h.confirm(token, held.data.hold);
  assert.equal(confirmed.status, 409, JSON.stringify(confirmed.data));
  assert.equal(h.jobber.jobs.length, 0);
  assert.deepEqual(await h.store.appointments(), []);
});

test('urgent booking preserves additional Jobber assignments and counts the mirrored visit only once', async t => {
  const h = await harness(t, { config: { bufferMinutes: 15, maxJobsPerDay: 3, alsoAssignJobberUserIds: ['J-ANDREW'] } });
  h.jobber.visits.push(visit());
  h.geo.driveMinutes = async pairs => pairs.map(() => 22);
  const token = await prepareSymptom(h);
  const held = await h.hold(token, early);
  assert.equal(held.status, 201, JSON.stringify(held.data));
  const confirmed = await h.confirm(token, held.data.hold);
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.data));
  assert.equal(h.jobber.jobs[0].jobberUserId, 'J-RYAN');
  assert.deepEqual(h.jobber.jobs[0].alsoAssign, ['J-ANDREW']);
  assert.deepEqual(h.jobber.visits.at(-1).jobberUserIds, ['J-RYAN', 'J-ANDREW']);
  assert.equal((await h.store.appointments())[0].status, 'confirmed');
  const another = await prepareSymptom(h);
  assert.ok((await h.slots(another, dayQuery)).some(slot => slot.scheduledAt > early), 'two visits leave capacity for a third; the local and Jobber copies are not double counted');
});

for (const urgent of [false, true]) {
  test(`${urgent ? 'urgent' : 'routine'} booking keeps disabled same-day and the exact 12-hour boundary through final validation`, async t => {
    const h = await harness(t, { config: { leadHours: 12, sameDay: { enabled: false, cutoffHour: 13, minNoticeHours: 3, requireNearby: true } } });
    h.advance(-13 * 3_600_000); // Monday midnight Arizona, before any sessions are created.
    const token = urgent ? await prepareSymptom(h) : await h.prepare();
    assert.deepEqual(await h.slots(token, '?date=2026-09-21'), [], 'even a same-day time 13 hours away is unavailable');
    assert.equal((await h.hold(token, '2026-09-21T20:00:00Z')).status, 409);
    h.advance(21 * 3_600_000); // Monday 9 PM Arizona: Tuesday 9 AM is exactly 12 hours away.
    await h.contactAndVerify(token); // Contact verification has its own expiry after this elapsed time.
    const boundary = `${date}T16:00:00.000Z`;
    assert.ok((await h.slots(token, dayQuery)).some(slot => slot.scheduledAt === boundary));
    const held = await h.hold(token, boundary);
    assert.equal(held.status, 201, JSON.stringify(held.data));
    h.advance(1);
    assert.ok(!(await h.slots(token, dayQuery)).some(slot => slot.scheduledAt === boundary));
    const confirmed = await h.confirm(token, held.data.hold);
    assert.equal(confirmed.status, 409, JSON.stringify(confirmed.data));
    assert.equal(h.jobber.jobs.length, 0);
    assert.deepEqual(await h.store.appointments(), []);
  });
}

test('standalone rescheduling retains saved urgent symptoms and does not trust a manual urgency label', async t => {
  const h = await harness(t, { config: { scheduleSource: 'BOB', bufferMinutes: 15 } });
  const cookie = await h.login();
  let minutes = 22;
  h.geo.driveMinutes = async pairs => pairs.map(() => minutes);
  const previous = await h.call('/api/admin/appointments', {
    method: 'POST', cookie,
    body: { ...contact, address: '200 Near Rd', route: 'cleaning', scheduledAt: `${date}T16:00:00Z`, sendConfirmation: false },
  });
  assert.equal(previous.status, 201, JSON.stringify(previous.data));

  const token = await prepareSymptom(h);
  const held = await h.hold(token, early);
  assert.equal(held.status, 201, JSON.stringify(held.data));
  const booked = await h.confirm(token, held.data.hold);
  assert.equal(booked.status, 201, JSON.stringify(booked.data));
  const urgentId = booked.data.receipt.id;
  const urgent = await h.store.appointment(urgentId);
  assert.ok(urgent.property.symptoms.includes('error'));
  const moved = await h.call(`/api/admin/appointments/${urgentId}`, {
    method: 'PATCH', cookie, body: { revision: urgent.revision, scheduledAt: `${date}T20:00:00Z` },
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  const saved = await h.store.appointment(urgentId);
  assert.equal(saved.scheduledAt, `${date}T20:00:00.000Z`, 'saved error symptoms retain the wider route limit on a move');

  minutes = 25;
  const tooFar = await h.call(`/api/admin/appointments/${urgentId}`, {
    method: 'PATCH', cookie, body: { revision: saved.revision, scheduledAt: `${date}T22:00:00Z` },
  });
  assert.equal(tooFar.status, 409, JSON.stringify(tooFar.data));
  assert.equal((await h.store.appointment(urgentId)).scheduledAt, saved.scheduledAt, 'rejected movement retains the original appointment');

  minutes = 22;
  const routineToken = await h.prepare();
  const routineTime = '2026-09-23T16:00:00.000Z';
  const routineHold = await h.hold(routineToken, routineTime);
  assert.equal(routineHold.status, 201, JSON.stringify(routineHold.data));
  const routineBooking = await h.confirm(routineToken, routineHold.data.hold);
  assert.equal(routineBooking.status, 201, JSON.stringify(routineBooking.data));
  const routineId = routineBooking.data.receipt.id;
  const routine = await h.store.appointment(routineId);
  assert.deepEqual(routine.property.symptoms, ['normal']);
  const labelled = await h.call(`/api/admin/appointments/${routineId}`, {
    method: 'PATCH', cookie, body: { revision: routine.revision, urgency: 'high' },
  });
  assert.equal(labelled.status, 200, JSON.stringify(labelled.data));
  const labelledRoutine = await h.store.appointment(routineId);
  assert.equal(labelledRoutine.urgency, 'high');
  const routineMove = await h.call(`/api/admin/appointments/${routineId}`, {
    method: 'PATCH', cookie, body: { revision: labelledRoutine.revision, scheduledAt: `${date}T22:00:00Z` },
  });
  assert.equal(routineMove.status, 409, JSON.stringify(routineMove.data));
  assert.equal((await h.store.appointment(routineId)).scheduledAt, routineTime, 'the manual label cannot widen routine route limits');
  assert.equal(h.jobber.jobs.length, 0, 'standalone bookings never create Jobber jobs');
});

test('correcting an error-code answer removes urgent openings and invalidates the earlier held booking', async t => {
  const h = await harness(t, { config: { bufferMinutes: 15 } });
  h.jobber.visits.push(visit());
  h.geo.driveMinutes = async pairs => pairs.map(() => 22);
  const token = await prepareSymptom(h);
  assert.ok((await h.slots(token, dayQuery)).some(slot => slot.scheduledAt === early));
  const held = await h.hold(token, early);
  assert.equal(held.status, 201, JSON.stringify(held.data));

  const correction = await h.chat(token, 'Correction: there are no error codes; it dries in one normal cycle');
  assert.equal(correction.session.stage, 'slots', correction.reply);
  const current = await h.store.loadSession(sessionKey(token));
  assert.ok(!current.property.symptoms.includes('error'), 'the saved affirmative error-code report is cleared');
  const refreshed = await h.call(`/api/availability${dayQuery}`, { token });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.data));
  assert.ok(!refreshed.data.slots.some(slot => slot.scheduledAt === early), 'the current routine answer restores the strict 20-minute route limit');
  const confirmed = await h.confirm(token, held.data.hold);
  assert.equal(confirmed.status, 409, JSON.stringify(confirmed.data));
  assert.equal(h.jobber.jobs.length, 0);
  assert.deepEqual(await h.store.appointments(), []);
});
