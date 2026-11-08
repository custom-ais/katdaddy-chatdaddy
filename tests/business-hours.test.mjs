// Business hours (Settings → Scheduling & team → Business hours): each day open or closed with its
// opening and closing time, and a start time offered every so often from opening. Until they're
// saved, the older start-time lists apply unchanged. Also: removing a technician.

import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, validateConfig } from "../shared/domain.mjs";
import { businessWeek, dayHours, openWeekdays, arrivalSpacing, startTimesSummary, scheduleGaps, toOpenWeek, validOpenWeek } from "../shared/tech-schedule.mjs";
import { candidateStarts } from "../server/schedule-rules.mjs";
import { projectConfig, applyConfigPatch } from "../server/admin-authorization.mjs";
import { harness, contact, baseTime } from "./helpers.mjs";

const NOW = baseTime; // Monday Sep 21 2026, 1 PM Arizona
const base = { ...DEFAULT_CONFIG, leadHours: 12, sameDay: { ...DEFAULT_CONFIG.sameDay, enabled: false } };
const starts = (config, date, durationMins = 120) => candidateStarts({ config, durationMins, now: NOW, date })
  .map((c) => new Date(c.start).toLocaleTimeString("en-US", { timeZone: "America/Phoenix", hour: "numeric", minute: "2-digit" }) + (c.overflow ? " overflow" : ""));
// Sunday 10–2, Mon/Tue/Thu 9–5, Wednesday closed, Friday 9–3, Saturday 10–2.
const OWN = ["10:00-14:00", "09:00-17:00", "09:00-17:00", "", "09:00-17:00", "09:00-15:00", "10:00-14:00"];

test("until business hours are saved, the start-time lists work exactly as before", () => {
  assert.deepEqual(starts(base, "2026-09-27"), [], "closed Sundays");
  assert.deepEqual(starts(base, "2026-09-23"), ["9:00 AM", "11:00 AM", "1:00 PM", "3:00 PM"]);
  assert.deepEqual(starts(base, "2026-09-26"), ["10:00 AM", "12:00 PM"]);
  assert.deepEqual(businessWeek(base).map((d) => (d.on ? `${d.start}-${d.end}` : "")), ["", "09:00-17:00", "09:00-17:00", "09:00-17:00", "09:00-17:00", "09:00-17:00", "10:00-14:00"]);
  assert.equal(arrivalSpacing({ ...base, arrivalEveryMins: undefined }), 120, "the gap in the Mon–Fri list");
  assert.deepEqual(openWeekdays(base), [1, 2, 3, 4, 5, 6]);
  assert.equal(startTimesSummary(base), "Mon–Fri 09:00, 11:00, 13:00, 15:00; Sat 10:00, 12:00; closed Sun");
  // Saving the default week from the editor gives the same start times.
  const same = { ...base, openWeek: toOpenWeek(businessWeek(base)), arrivalEveryMins: 120 };
  for (let i = 0; i < 7; i++) assert.deepEqual(dayHours(same, i), dayHours(base, i), `weekday ${i}`);
});

test("saved hours: open days, closing times and the start-time spacing decide the offered times", () => {
  const c = { ...base, openWeek: OWN, arrivalEveryMins: 90 };
  assert.deepEqual(starts(c, "2026-09-27"), ["10:00 AM", "11:30 AM"], "Sunday is open now; 1 PM + 2 hours would run past 2 PM");
  assert.deepEqual(starts(c, "2026-09-27", 60), ["10:00 AM", "11:30 AM", "1:00 PM"], "a 1-hour visit fits at 1 PM");
  assert.deepEqual(starts(c, "2026-09-23"), [], "Wednesday closed");
  assert.deepEqual(starts(c, "2026-09-25"), ["9:00 AM", "10:30 AM", "12:00 PM"], "Friday closes at 3");
  assert.deepEqual(starts({ ...c, arrivalEveryMins: 60 }, "2026-09-22"), ["9:00 AM", "10:00 AM", "11:00 AM", "12:00 PM", "1:00 PM", "2:00 PM", "3:00 PM"]);
  assert.deepEqual(openWeekdays(c), [0, 1, 2, 4, 5, 6]);
  assert.equal(startTimesSummary({ ...c, arrivalEveryMins: 120 }), "Mon–Tue 09:00, 11:00, 13:00, 15:00; Thu 09:00, 11:00, 13:00, 15:00; Fri 09:00, 11:00, 13:00; Sat–Sun 10:00, 12:00; closed Wed");
  // The 5 PM overflow start stays Mon–Fri, and never on a closed day.
  const ov = { ...c, arrivalEveryMins: 120, overflow: { ...DEFAULT_CONFIG.overflow, enabled: true, start: "17:00", maxDurationMins: 120, minTicketCents: 0 } };
  const withOverflow = (date) => candidateStarts({ config: ov, durationMins: 90, now: NOW, date, ticketCents: 50000 }).filter((s) => s.overflow).length;
  assert.equal(withOverflow("2026-09-22"), 1, "Tuesday");
  assert.equal(withOverflow("2026-09-23"), 0, "closed Wednesday");
  assert.equal(withOverflow("2026-09-27"), 0, "not on Sundays, even when open");
  // Technicians on business hours follow them; one with Sundays off leaves Sunday uncovered.
  const ryan = { id: "tech-ryan", name: "Ryan", workWeek: null, timeOff: [] };
  assert.deepEqual(scheduleGaps({ technicians: [ryan], config: { ...c, activeTechnicianIds: ["tech-ryan"] }, today: "2026-09-21" }).weekdays, []);
  const weekdaysOnly = { ...ryan, workWeek: businessWeek(base) };
  assert.deepEqual(scheduleGaps({ technicians: [weekdaysOnly], config: { ...c, activeTechnicianIds: ["tech-ryan"] }, today: "2026-09-21" }).weekdays, [0]);
});

test("Settings checks the business hours", () => {
  const errors = (patch) => validateConfig({ ...DEFAULT_CONFIG, ...patch }).filter((e) => /business hours|start times are offered/.test(e));
  assert.deepEqual(errors({}), []);
  assert.deepEqual(errors({ openWeek: OWN, arrivalEveryMins: 90 }), []);
  assert.equal(errors({ openWeek: ["", "", "", "", "", "", ""] }).length, 1, "at least one day open");
  assert.equal(errors({ openWeek: ["17:00-09:00", "", "", "", "", "", ""] }).length, 1, "closing after opening");
  assert.equal(errors({ openWeek: OWN.slice(0, 6) }).length, 1, "seven days");
  assert.equal(errors({ openWeek: ["9-5", "", "", "", "", "", ""] }).length, 1);
  assert.equal(errors({ arrivalEveryMins: 45 }).length, 1);
  assert.equal(validOpenWeek([]), true, "not set yet");
});

test("staff with schedule access can read and save the business hours; others can't see them", () => {
  const member = (permissions) => ({ id: "m", role: "member", permissions, name: "Member" });
  const scheduler = member(["settings.schedule.view", "settings.schedule.manage"]);
  const c = { ...DEFAULT_CONFIG, openWeek: OWN, arrivalEveryMins: 90 };
  assert.deepEqual(projectConfig(c, scheduler).openWeek, OWN);
  assert.equal(projectConfig(c, scheduler).arrivalEveryMins, 90);
  assert.deepEqual(projectConfig(c, member(["settings.business.view"])).openWeek, []);
  const next = applyConfigPatch(scheduler, { openWeek: OWN, arrivalEveryMins: 60 }, DEFAULT_CONFIG);
  assert.deepEqual([next.openWeek, next.arrivalEveryMins], [OWN, 60]);
  assert.throws(() => applyConfigPatch(member(["settings.business.view", "settings.business.manage"]), { openWeek: OWN }, DEFAULT_CONFIG));
});

test("saving business hours changes the times customers are offered", async (t) => {
  const h = await harness(t, { config: { pricesAcknowledged: true } });
  const cookie = await h.login();
  const before = await h.call("/api/admin/data", { cookie });
  const r = await h.call("/api/admin/config", { method: "PATCH", cookie, body: { version: before.data.config.version, openWeek: OWN, arrivalEveryMins: 120 } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.config.openWeek, OWN);
  const token = await h.prepare("cleaning", contact);
  const sunday = (await h.slots(token, "?date=2026-09-27")).filter((s) => s.scheduledAt.startsWith("2026-09-27"));
  assert.ok(sunday.length > 0, "Sunday has openings now");
  assert.ok(sunday.every((s) => ["17:00", "19:00"].includes(s.scheduledAt.slice(11, 16))), JSON.stringify(sunday.map((s) => s.scheduledAt)));
  assert.deepEqual(await h.slots(token, "?date=2026-09-23"), [], "Wednesday closed");
  const bad = await h.call("/api/admin/config", { method: "PATCH", cookie, body: { version: r.data.config.version, openWeek: ["", "", "", "", "", "", ""] } });
  assert.equal(bad.status, 400);
});

test("removing a technician: gone from the team and the online list, and later settings saves still work", async (t) => {
  const h = await harness(t, { config: { pricesAcknowledged: true, activeTechnicianIds: ["tech-ryan", "tech-andrew"] } });
  const cookie = await h.login();
  const data = (await h.call("/api/admin/data", { cookie })).data;
  assert.ok(data.config.activeTechnicianIds.includes("tech-andrew"));
  const removed = await h.call("/api/admin/technicians", { method: "POST", cookie, body: { technicians: data.technicians.filter((x) => x.id !== "tech-andrew") } });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.deepEqual(removed.data.technicians.map((x) => x.id), data.technicians.map((x) => x.id).filter((id) => id !== "tech-andrew"));
  // The next settings save drops Andrew from the online list instead of failing.
  const next = await h.call("/api/admin/config", { method: "PATCH", cookie, body: { version: removed.data.config.version, maxJobsPerDay: 5 } });
  assert.equal(next.status, 200, JSON.stringify(next.data));
  assert.ok(!next.data.config.activeTechnicianIds.includes("tech-andrew"));
  // Naming a technician who never existed is still refused.
  const unknown = await h.call("/api/admin/config", { method: "PATCH", cookie, body: { version: next.data.config.version, activeTechnicianIds: [...next.data.config.activeTechnicianIds, "tech-nobody"] } });
  assert.equal(unknown.status, 400);
  // Booking still works with the rest of the team.
  const token = await h.prepare("cleaning", contact);
  assert.ok((await h.slots(token)).every((s) => s.technicianId !== "tech-andrew"));
});
