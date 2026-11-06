// When a requested day has no openings, BOB logs why: each candidate time, each technician's
// reason, the daily cap, and what's already on the calendar that day (no names or addresses).

import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, serviceQuote } from "../shared/domain.mjs";
import { explainDay, openSlots } from "../server/schedule-rules.mjs";
import { harness, contact } from "./helpers.mjs";

const NOW = Date.parse("2026-09-21T20:00:00Z"); // Mon Sep 21, 1:00 PM Arizona
const config = { ...DEFAULT_CONFIG, serviceZips: ["85326"], pricesAcknowledged: true, scheduleAcknowledged: true, bookingEnabled: true, bufferMinutes: 15, activeTechnicianIds: ["tech-ryan"] };
const RYAN = { id: "tech-ryan", name: "Ryan", status: "available", jobberUserId: "J-RYAN" };
const ANDREW = { id: "tech-andrew", name: "Andrew", status: "available", jobberUserId: "J-ANDREW" };
const at = (iso) => Date.parse(iso);

test("each time on an empty day names the reason for each technician", () => {
  // One visit 11-12 on Tue Sep 22 that BOB can't place on the map: every time next to it is closed.
  const visit = { id: "j:1", kind: "jobber", start: at("2026-09-22T18:00:00Z"), end: at("2026-09-22T19:00:00Z"), allDay: false, techIds: ["tech-ryan"], location: null };
  const durationMins = serviceQuote("cleaning", config).durationMins;
  const args = { config, technicians: [RYAN, ANDREW], blocks: [visit], drive: new Map(), durationMins, now: NOW, date: "2026-09-22" };
  assert.deepEqual(openSlots(args), []);
  const why = explainDay(args);
  assert.equal(why.candidates, 4);
  assert.equal(why.dayFull, false);
  assert.deepEqual(why.onCalendar, [{ from: "jobber visit", time: "11:00 AM-12:00 PM", techs: ["tech-ryan"], onMap: false, drive: null }]);
  assert.deepEqual(why.times.map((t) => [t.time, t.techs["tech-ryan"]]), [["9:00 AM", "unknown_location"], ["11:00 AM", "overlap"], ["1:00 PM", "unknown_location"], ["3:00 PM", "unknown_location"]]);
  assert.ok(why.times.every((t) => t.techs["tech-andrew"] === "not taking online bookings"));
  assert.doesNotMatch(JSON.stringify(why), /Main St|Buckeye|@/, "no names or addresses");
});

test("schedules, time off and the daily cap show up as reasons too", () => {
  const durationMins = serviceQuote("cleaning", config).durationMins;
  const off = { ...RYAN, timeOff: [{ id: "off-1", from: "2026-09-22", to: "2026-09-22", start: "", end: "", note: "" }] };
  const why = explainDay({ config, technicians: [off], blocks: [], drive: new Map(), durationMins, now: NOW, date: "2026-09-22" });
  assert.ok(why.times.every((t) => t.techs["tech-ryan"] === "outside work schedule or time off"));
  const full = explainDay({ config: { ...config, maxJobsPerDay: 1 }, technicians: [RYAN], blocks: [{ id: "a:1", kind: "appointment", start: at("2026-09-22T16:00:00Z"), end: at("2026-09-22T17:30:00Z"), allDay: false, techIds: ["tech-ryan"], location: { lat: 1, lng: 1 } }], drive: new Map(), durationMins, now: NOW, date: "2026-09-22" });
  assert.equal(full.dayFull, true);
  assert.equal(full.onCalendar[0].from, "BOB booking record");
  const sunday = explainDay({ config, technicians: [RYAN], blocks: [], drive: new Map(), durationMins, now: NOW, date: "2026-09-27" });
  assert.equal(sunday.candidates, 0, "closed days have no candidate times");
});

test("a customer's empty day writes one [slots] line to the server log", async (t) => {
  const h = await harness(t, { config: { pricesAcknowledged: true, blockedDates: ["2026-09-23"] } });
  const lines = [];
  const log = console.log;
  console.log = (...a) => { const s = a.join(" "); if (s.startsWith("[slots]")) lines.push(s); else log(...a); };
  t.after(() => { console.log = log; });
  const token = await h.prepare("cleaning", contact);
  assert.deepEqual(await h.slots(token, "?date=2026-09-23"), []);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[slots\] no openings 2026-09-23 \{"date":"2026-09-23",.*"candidates":0/);
  assert.ok((await h.slots(token, "?date=2026-09-22")).length > 0);
  assert.equal(lines.length, 1, "days with openings log nothing");
});
