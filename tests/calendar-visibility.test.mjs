// BOB must see everything on the Jobber calendar it books against: visits for team members
// no BOB tech is linked to (BidBee bookings under another login), request assessments, and
// short/default-length visits, which count as at least the standard visit length.
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../shared/domain.mjs";
import { createScheduler } from "../server/schedule.mjs";

// Mon Nov 2 2026, 6 PM Arizona: the evening before the screenshot's Tuesday.
const NOW = Date.parse("2026-11-03T01:00:00Z");
const DAY = "2026-11-03";
const config = {
  ...DEFAULT_CONFIG,
  scheduleSource: "Jobber",
  activeTechnicianIds: ["tech-ryan"],
  // Higher than the default 4 so these tests isolate visibility from the daily cap.
  maxJobsPerDay: 10,
};
const RYAN = { id: "tech-ryan", name: "Ryan", status: "available", jobberUserId: "J-RYAN" };
const ANDREW = { id: "tech-andrew", name: "Andrew", status: "available", jobberUserId: "J-ANDREW" };
const PLACE = { lat: 33.6, lng: -112.4 };
// Arizona is UTC-7 all year.
const az = (hhmm) => Date.parse(`${DAY}T${hhmm}:00-07:00`);
const item = (id, hhmm, mins, jobberUserIds = [], extra = {}) => ({ id, title: id, start: az(hhmm), end: az(hhmm) + mins * 60_000, allDay: false, jobberUserIds, address: "1 Main St, Surprise, AZ 85388", ...extra });

function scheduler({ visits = [], assessments = [], appointments = [] } = {}) {
  const store = {
    activeAppointments: async () => appointments,
    activeHolds: async () => [],
    appointments: async () => appointments,
  };
  const jobber = {
    readVisits: async (from, to) => visits.filter((v) => v.start >= from && v.start < to),
    readAssessments: async (from, to) => assessments.filter((v) => v.start >= from && v.start < to),
  };
  const geo = { geocode: async () => PLACE, driveMinutes: async (pairs) => pairs.map(() => 8) };
  return createScheduler({ store, jobber, geo });
}
// The screenshot's booking: Premium 1-2-3 See-It-Clean, 1-story ($179), 60 minutes.
const open = async (s, { cfg = config, technicians = [RYAN], durationMins = 60 } = {}) =>
  (await s.slots({ config: cfg, technicians, durationMins, location: PLACE, now: NOW, date: DAY })).map((x) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Phoenix", hour: "numeric", minute: "2-digit" }).format(new Date(x.start)));

test("the screenshot's Tuesday: BidBee 9 AM and the 4 PM visit under another Jobber login close 9 AM and 3 PM", async () => {
  const s = scheduler({
    visits: [
      item("bidbee-9am", "09:00", 60, ["J-SC"]), // BidBee appointment [BOOK-…], assigned to "SC"
      item("premium-11am", "11:00", 60, ["J-RYAN"]),
      item("premium-1pm", "13:00", 60, ["J-RYAN"]),
      item("sc-85388-4pm", "16:00", 60, ["J-SC"]), // "SC - 85388"
    ],
  });
  assert.deepEqual(await open(s), [], "every weekday start on this Tuesday collides with something on the calendar");
});

test("a visit for an unlinked Jobber user blocks the tech just like an unassigned one", async () => {
  for (const users of [[], ["J-SOMEONE-ELSE"]]) {
    const s = scheduler({ visits: [item("v", "09:00", 60, users)] });
    // 9:00 is taken; the visit counts as 90 minutes (to 10:30) plus the 30-minute gap, so 11:00 still fits.
    assert.deepEqual(await open(s), ["11:00 AM", "1:00 PM", "3:00 PM"], `assigned to ${JSON.stringify(users)}`);
  }
});

test("a visit for another linked BOB tech still leaves this tech free (two-truck shops)", async () => {
  const s = scheduler({ visits: [item("v", "09:00", 60, ["J-ANDREW"])] });
  const cfg = { ...config, activeTechnicianIds: ["tech-ryan"] };
  assert.deepEqual(await open(s, { cfg, technicians: [RYAN, ANDREW] }), ["9:00 AM", "11:00 AM", "1:00 PM", "3:00 PM"]);
});

test("request assessments (BidBee's request bookings) block like visits", async () => {
  const s = scheduler({ assessments: [item("assessment-1", "15:00", 60, ["J-SC"])] });
  assert.deepEqual(await open(s), ["9:00 AM", "11:00 AM", "1:00 PM"]);
});

test("short or default-length calendar items count as at least the standard visit length", async () => {
  // A 30-minute entry at noon: by Jobber's times 1 PM fits (12:30 + 30 min gap). As a standard
  // 90-minute visit it runs to 1:30, so 1 PM is not offered.
  const visits = [item("short", "12:00", 30, [])];
  assert.deepEqual(await open(scheduler({ visits }), { cfg: { ...config, minVisitMinutes: 0 } }), ["9:00 AM", "1:00 PM", "3:00 PM"]);
  assert.deepEqual(await open(scheduler({ visits })), ["9:00 AM", "3:00 PM"]);
});

test("BOB's own verified booking keeps its real length", async () => {
  const visit = item("VIS1", "09:00", 60, ["J-RYAN"]);
  const appointment = { id: "A1", status: "confirmed", jobberVisitId: "VIS1", start: visit.start, end: visit.end, tech: "tech-ryan", address: visit.address, location: PLACE };
  const cfg = { ...config, minVisitMinutes: 120 };
  assert.deepEqual(await open(scheduler({ visits: [visit], appointments: [appointment] }), { cfg }), ["11:00 AM", "1:00 PM", "3:00 PM"]);
  // The same visit without BOB's matching booking is someone else's, so it takes the full 120 minutes.
  assert.deepEqual(await open(scheduler({ visits: [visit] }), { cfg }), ["1:00 PM", "3:00 PM"]);
});

test("every calendar item counts toward the daily cap", async () => {
  const s = scheduler({
    visits: [item("a", "09:00", 60, ["J-SC"]), item("b", "13:00", 60, ["J-RYAN"])],
    assessments: [item("c", "16:00", 60, [])],
  });
  assert.deepEqual(await open(s, { cfg: { ...config, maxJobsPerDay: 3 } }), []);
});
