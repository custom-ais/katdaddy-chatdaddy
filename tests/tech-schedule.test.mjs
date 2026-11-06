// Technician work schedules and time off kept in ChatDaddy: BOB only offers a tech when the whole
// visit is on their shift, and Jobber is still read fresh before holding and booking.

import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, serviceQuote } from "../shared/domain.mjs";
import { openSlots } from "../server/schedule-rules.mjs";
import { onShift, businessWeek, weekSummary, validWorkWeek, validTimeOff, cleanTimeOff, timeOffLabel } from "../shared/tech-schedule.mjs";
import { harness, contact } from "./helpers.mjs";

const NOW = Date.parse("2026-09-21T20:00:00Z"); // Mon Sep 21, 1:00 PM Arizona
const config = { ...DEFAULT_CONFIG, serviceZips: ["85326"], pricesAcknowledged: true, scheduleAcknowledged: true, bookingEnabled: true, bufferMinutes: 15, activeTechnicianIds: ["tech-ryan", "tech-andrew"] };
const RYAN = { id: "tech-ryan", name: "Ryan", status: "available", jobberUserId: "J-RYAN" };
const ANDREW = { id: "tech-andrew", name: "Andrew", status: "available", jobberUserId: "J-ANDREW" };
const week = (days) => [0, 1, 2, 3, 4, 5, 6].map((i) => days[i] ? { on: true, start: days[i][0], end: days[i][1] } : { on: false, start: "09:00", end: "17:00" });
const MON_FRI_8_4 = week({ 1: ["08:00", "16:00"], 2: ["08:00", "16:00"], 3: ["08:00", "16:00"], 4: ["08:00", "16:00"], 5: ["08:00", "16:00"] });
const open = (technicians, date) => openSlots({ config, technicians, blocks: [], drive: new Map(), durationMins: serviceQuote("cleaning", config).durationMins, now: NOW, date })
  .map((s) => `${s.scheduledAt.slice(11, 16)} ${s.technicianId.slice(5)}`);
// Tue Sep 22 starts 9, 11, 1, 3 Arizona = 16:00, 18:00, 20:00, 22:00 UTC; a cleaning is 90 minutes.

test("no schedule set: the tech works whenever the business is open", () => {
  assert.deepEqual(open([RYAN], "2026-09-22"), ["16:00 ryan", "18:00 ryan", "20:00 ryan", "22:00 ryan"]);
  assert.equal(weekSummary(null), "Business hours");
});

test("the whole visit has to fit inside the tech's hours for that weekday", () => {
  const ryan = { ...RYAN, workWeek: MON_FRI_8_4 };
  assert.deepEqual(open([ryan], "2026-09-22"), ["16:00 ryan", "18:00 ryan", "20:00 ryan"], "3 PM would run to 4:30, past his 4 PM end");
  assert.deepEqual(open([ryan], "2026-09-26"), [], "Saturday is off");
  assert.deepEqual(open([ryan, ANDREW], "2026-09-22").at(-1), "22:00 andrew", "the 3 PM goes to whoever is on");
  assert.deepEqual(open([ryan, ANDREW], "2026-09-26"), ["17:00 andrew", "19:00 andrew"]);
  assert.equal(weekSummary(MON_FRI_8_4), "Mon–Fri 8am–4pm");
  assert.equal(weekSummary(week({ 1: ["08:00", "16:00"], 2: ["08:00", "16:00"], 6: ["09:30", "13:00"] })), "Mon–Tue 8am–4pm, Sat 9:30am–1pm");
});

test("time off: all day, or a window of hours on each day of the range", () => {
  const away = { ...RYAN, timeOff: [{ id: "off-1", from: "2026-09-22", to: "2026-09-23", start: "", end: "", note: "Vacation" }] };
  assert.deepEqual(open([away], "2026-09-22"), []);
  assert.deepEqual(open([away], "2026-09-23"), []);
  assert.equal(open([away], "2026-09-24").length, 4, "back the next day");
  const dentist = { ...RYAN, timeOff: [{ id: "off-2", from: "2026-09-22", to: "2026-09-22", start: "12:00", end: "14:00", note: "" }] };
  assert.deepEqual(open([dentist], "2026-09-22"), ["16:00 ryan", "22:00 ryan"], "11 AM runs into noon and 1 PM starts inside it");
  assert.deepEqual(open([dentist, ANDREW], "2026-09-22"), ["16:00 ryan", "18:00 andrew", "20:00 andrew", "22:00 ryan"]);
  assert.equal(onShift(dentist, { date: "2026-09-22", start: Date.parse("2026-09-22T21:00:00Z"), end: Date.parse("2026-09-22T22:30:00Z") }), true, "2 PM, right after it ends");
  assert.equal(timeOffLabel(dentist.timeOff[0]), "Tue, Sep 22, 12pm–2pm");
  assert.equal(timeOffLabel(away.timeOff[0]), "Tue, Sep 22 – Wed, Sep 23, all day");
});

test("schedules and time off are checked before saving", () => {
  assert.equal(validWorkWeek(null), true);
  assert.equal(validWorkWeek(MON_FRI_8_4), true);
  assert.equal(validWorkWeek(businessWeek(DEFAULT_CONFIG)), true);
  assert.equal(validWorkWeek(MON_FRI_8_4.slice(0, 6)), false, "all seven days");
  assert.equal(validWorkWeek(week({ 1: ["16:00", "08:00"] })), false, "start before end");
  assert.equal(validWorkWeek(week({ 1: ["8:00", "16:00"] })), false, "HH:MM");
  const entry = { id: "off-1", from: "2026-09-22", to: "2026-09-22", start: "", end: "", note: "" };
  assert.equal(validTimeOff([entry]), true);
  assert.equal(validTimeOff([{ ...entry, to: "2026-09-21" }]), false, "ends before it starts");
  assert.equal(validTimeOff([{ ...entry, from: "2026-02-30", to: "2026-02-30" }]), false, "a real date");
  assert.equal(validTimeOff([{ ...entry, start: "12:00" }]), false, "both times or neither");
  assert.equal(validTimeOff([{ ...entry, start: "14:00", end: "12:00" }]), false);
  assert.equal(validTimeOff([{ ...entry, to: "2027-12-31" }]), false, "up to a year at a time");
  assert.equal(validTimeOff([entry, entry]), false, "unique entries");
  assert.deepEqual(cleanTimeOff([{ ...entry, to: "2026-09-20", id: "old" }, entry], "2026-09-21").map((t) => t.id), ["off-1"], "past time off is dropped");
  const biz = businessWeek(DEFAULT_CONFIG);
  assert.deepEqual([biz[0].on, biz[1], biz[6]], [false, { on: true, start: "09:00", end: "17:00" }, { on: true, start: "10:00", end: "14:00" }], "starts from the business hours");
});

test("the office saves a tech's schedule in Settings, and the next customer only sees times they're on", async (t) => {
  const h = await harness(t, { config: { pricesAcknowledged: true } });
  const cookie = await h.login();
  const techs = (await h.call("/api/admin/data", { cookie })).data.technicians;
  const ryan = techs.find((x) => x.id === "tech-ryan");
  assert.equal(ryan.workWeek, null, "business hours by default");
  assert.deepEqual(ryan.timeOff, []);

  const timeOff = [
    { id: "off-past", from: "2026-09-01", to: "2026-09-02", start: "", end: "", note: "Already over" },
    { id: "off-tue", from: "2026-09-22", to: "2026-09-22", start: "", end: "", note: "Vacation" },
  ];
  const save = (list) => h.call("/api/admin/technicians", { method: "POST", cookie, body: { technicians: list } });
  const bad = await save(techs.map((x) => x.id === "tech-ryan" ? { ...x, workWeek: week({ 3: ["16:00", "08:00"] }) } : x));
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /work schedule/);
  assert.equal((await save(techs.map((x) => x.id === "tech-ryan" ? { ...x, timeOff: [{ ...timeOff[1], to: "2026-09-20" }] } : x))).status, 400);

  const saved = await save(techs.map((x) => x.id === "tech-ryan" ? { ...x, workWeek: MON_FRI_8_4, timeOff } : x));
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const back = saved.data.technicians.find((x) => x.id === "tech-ryan");
  assert.deepEqual(back.workWeek, MON_FRI_8_4);
  assert.deepEqual(back.timeOff.map((x) => x.id), ["off-tue"], "time off that already ended isn't kept");

  // Saving without the schedule fields (the dispatch page changing a status) keeps them.
  const status = await save(techs.map(({ workWeek, timeOff: _t, ...x }) => x.id === "tech-ryan" ? { ...x, status: "on_job" } : x));
  assert.equal(status.status, 200);
  const kept = (await h.store.technicians()).find((x) => x.id === "tech-ryan");
  assert.deepEqual([kept.status, kept.workWeek, kept.timeOff.map((x) => x.id)], ["on_job", MON_FRI_8_4, ["off-tue"]]);

  // Only Ryan takes online bookings: nothing on his day off, and nothing past his 4 PM end.
  const token = await h.prepare("cleaning", contact);
  const all = await h.slots(token);
  assert.ok(!all.some((s) => s.scheduledAt.startsWith("2026-09-22")), "no times on his day off");
  assert.ok(all.length > 0);
  for (const s of all) {
    const local = new Date(Date.parse(s.scheduledAt) - 7 * 3600_000);
    assert.ok(local.getUTCDay() >= 1 && local.getUTCDay() <= 5, `weekdays only: ${s.scheduledAt}`);
    assert.ok(local.getUTCHours() * 60 + local.getUTCMinutes() + 90 <= 16 * 60, `ends by 4 PM: ${s.scheduledAt}`);
  }
  // Holding still re-reads Jobber: a visit added there since the list loaded blocks the time.
  const first = all[0];
  h.jobber.visits.push({ id: "V-NEW", title: "Booked in Jobber", start: Date.parse(first.scheduledAt), end: Date.parse(first.scheduledAt) + 3600_000, allDay: false, jobberUserIds: ["J-RYAN"], address: "" });
  assert.equal((await h.hold(token, first.scheduledAt)).status, 409);
});
