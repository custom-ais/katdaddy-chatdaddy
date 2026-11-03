// Revenue pacing: a weekly/monthly minimum steers which open times BOB offers first.

import test from "node:test";
import assert from "node:assert/strict";
import { weekStartOf, paceTargets, revenuePace, paceBonus, PACE_WEIGHTS } from "../server/revenue-pace.mjs";
import { orderSlots } from "../server/schedule-rules.mjs";
import { DEFAULT_CONFIG, validateConfig } from "../shared/domain.mjs";
import { harness, baseTime } from "./helpers.mjs";

const DAY = 86_400_000;
const at = (iso) => Date.parse(iso);
// Monday Sep 21 2026, 1 PM Arizona.
const now = at("2026-09-21T13:00:00-07:00");
const monthly = { enabled: true, period: "month", targetCents: 1_000_000, outsideJobCents: 0 };

test("a $10,000 month is $2,500 a week and $500 a weekday; weeks start Monday in Arizona", () => {
  assert.deepEqual(paceTargets(monthly), { weeklyCents: 250_000, dailyCents: 50_000 });
  assert.deepEqual(paceTargets({ period: "week", targetCents: 300_000 }), { weeklyCents: 300_000, dailyCents: 60_000 });
  assert.equal(weekStartOf(at("2026-09-27T20:00:00-07:00")), at("2026-09-21T00:00:00-07:00"), "Sunday night is still that week");
  assert.equal(weekStartOf(at("2026-09-28T00:30:00-07:00")), at("2026-09-28T00:00:00-07:00"));
});

test("booked revenue counts BOB's bookings at their price and the office's Jobber jobs at the job value", () => {
  const appointments = [
    { status: "confirmed", price: 299, scheduledAt: "2026-09-22T16:00:00Z", jobber: { visitId: "V1" } },
    { status: "completed", price: 179, scheduledAt: "2026-09-21T16:00:00Z" },
    { status: "cancelled", price: 500, scheduledAt: "2026-09-23T16:00:00Z" },
    { status: "confirmed", price: 179, scheduledAt: "2026-09-29T16:00:00Z" }, // next week
  ];
  const visits = [{ id: "V1", start: at("2026-09-22T16:00:00Z") }, { id: "V2", start: at("2026-09-24T16:00:00Z") }, { id: "V3", start: at("2026-09-25T00:00:00Z"), allDay: true }];
  const pace = revenuePace({ appointments, visits, pacing: monthly, now });
  assert.equal(pace.jobCents, 21900, "BOB's average job: (299 + 179 + 179) / 3");
  assert.equal(pace.weeks.length, 3);
  assert.equal(pace.weeks[0].bookedCents, 29900 + 17900 + 21900, "V1 is BOB's own booking; V2 counts at the average; all-day visits don't");
  assert.equal(pace.weeks[0].jobs, 3);
  assert.equal(pace.weeks[1].bookedCents, 17900);
  assert.equal(pace.weeks[0].met, false);
  assert.equal(revenuePace({ appointments, visits, pacing: { ...monthly, outsideJobCents: 25000 }, now }).weeks[0].bookedCents, 29900 + 17900 + 25000, "the office's job value when set");
});

const slot = (iso, extra = {}) => ({ start: at(iso), routeScore: 0, nearby: false, ...extra });

test("a week behind its minimum fills first, this week most, and weekdays under their share a bit more", () => {
  const pace = revenuePace({ appointments: [], pacing: monthly, now });
  const thisWeek = paceBonus(slot("2026-09-23T09:00:00-07:00"), pace);
  const nextWeek = paceBonus(slot("2026-09-30T09:00:00-07:00"), pace);
  const later = paceBonus(slot("2026-10-07T09:00:00-07:00"), pace);
  assert.equal(thisWeek, PACE_WEIGHTS.fillWeek + PACE_WEIGHTS.fillDay);
  assert.ok(thisWeek > nextWeek && nextWeek > later && later > 0);
  assert.equal(paceBonus(slot("2026-09-26T10:00:00-07:00"), pace), PACE_WEIGHTS.fillWeek, "Saturday has no weekday share");
  assert.equal(paceBonus(slot("2026-10-20T09:00:00-07:00"), pace), 0, "beyond the three-week window");
});

test("behind: a so-so time this week comes before a good route fit next week (the drive limits still apply)", () => {
  const pace = revenuePace({ appointments: [], pacing: monthly, now });
  const order = orderSlots([slot("2026-09-30T09:00:00-07:00", { routeScore: 10, nearby: true }), slot("2026-09-24T13:00:00-07:00", { routeScore: 0 })], { now, routeScoring: true, pace });
  assert.equal(new Date(order[0].start).toISOString(), "2026-09-24T20:00:00.000Z");
});

test("met: this week keeps its openings for stops near the route, and a far-out customer sees next week first", () => {
  const appointments = Array.from({ length: 9 }, (_, i) => ({ status: "confirmed", price: 299, scheduledAt: new Date(at("2026-09-22T16:00:00Z") + (i % 4) * DAY).toISOString() }));
  const pace = revenuePace({ appointments, pacing: monthly, now });
  assert.equal(pace.weeks[0].met, true, "9 × $299 is over $2,500");
  const far = slot("2026-09-24T13:00:00-07:00", { routeScore: 5, nearby: false });
  const near = slot("2026-09-24T09:00:00-07:00", { routeScore: 5, nearby: true });
  assert.equal(paceBonus(far, pace), PACE_WEIGHTS.metWeekFarStop);
  assert.equal(paceBonus(near, pace), 0, "a stop next to the day's route stays up");
  const order = orderSlots([far, slot("2026-09-30T09:00:00-07:00", { routeScore: 0 })], { now, routeScoring: true, pace });
  assert.equal(new Date(order[0].start).toISOString(), "2026-09-30T16:00:00.000Z", "the far stop goes to next week");
});

test("without pacing the order is unchanged (route fit, then time)", () => {
  const a = slot("2026-09-30T09:00:00-07:00", { routeScore: 10 }), b = slot("2026-09-24T13:00:00-07:00", { routeScore: 0 });
  assert.deepEqual(orderSlots([b, a], { now, routeScoring: true }).map((s) => s.start), [a.start, b.start]);
});

test("the setting is checked, and a target is required when pacing is on", () => {
  const base = { ...DEFAULT_CONFIG };
  assert.ok(!validateConfig({ ...base, revenuePacing: monthly }).some((e) => /revenue target/i.test(e)));
  assert.ok(validateConfig({ ...base, revenuePacing: { ...monthly, period: "year" } }).some((e) => /revenue target/i.test(e)));
  assert.ok(validateConfig({ ...base, revenuePacing: { ...monthly, targetCents: 0 } }).some((e) => /revenue target amount/i.test(e)));
  assert.ok(!validateConfig({ ...base, revenuePacing: { ...monthly, enabled: false, targetCents: 0 } }).some((e) => /revenue target/i.test(e)));
});

test("the office sees this week and the next two against the minimum, and availability still works with pacing on", async (t) => {
  const h = await harness(t, { config: { pricesAcknowledged: true, revenuePacing: monthly } });
  await h.book("cleaning");
  const cookie = await h.login();
  const r = await h.call("/api/admin/revenue-pace?period=week&target=300000", { cookie });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.pace.weeklyTargetCents, 300000, "previews the values being edited");
  assert.equal(r.data.pace.weeks.length, 3);
  assert.equal(r.data.pace.weeks[0].start, weekStartOf(baseTime));
  assert.ok(r.data.pace.weeks.some((w) => w.bookedCents > 0), "the booking counts");
  const token = await h.prepare("cleaning");
  assert.ok((await h.slots(token)).length > 0);
});
