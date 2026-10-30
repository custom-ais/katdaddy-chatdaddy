import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, serviceQuote, travelFeeFor, bookingQuote, validateConfig } from "../shared/domain.mjs";
import { openSlots, orderSlots, evaluateTech, blockBelongsTo } from "../server/schedule-rules.mjs";

const NOW = Date.parse("2026-09-21T20:00:00Z"); // Mon 1:00 PM Arizona
const config = {
  ...DEFAULT_CONFIG,
  serviceZips: ["85326"],
  pricesAcknowledged: true,
  scheduleAcknowledged: true,
  bookingEnabled: true,
  bufferMinutes: 15,
  activeTechnicianIds: ["tech-ryan"],
};
const RYAN = { id: "tech-ryan", name: "Ryan", status: "available", jobberUserId: "J-RYAN" };
const ANDREW = { id: "tech-andrew", name: "Andrew", status: "available", jobberUserId: "J-ANDREW" };
const at = (iso) => Date.parse(iso);
const visit = (id, startIso, mins, extra = {}) => ({
  id, kind: "jobber", start: at(startIso), end: at(startIso) + mins * 60_000, allDay: false, techIds: null, location: { lat: 1, lng: 1 }, ...extra,
});
const run = ({ blocks = [], drive = new Map(), technicians = [RYAN], cfg = config, date = "2026-09-22", route = "cleaning" } = {}) =>
  openSlots({ config: cfg, technicians, blocks, drive, durationMins: serviceQuote(route, cfg).durationMins, now: NOW, date });
const labels = (slots) => slots.map((s) => s.scheduledAt.slice(11, 16));

// Tue Sep 22 weekday starts 09:00, 11:00, 13:00, 15:00 Arizona = 16:00, 18:00, 20:00, 22:00 UTC

test("empty day: all four windows, none flagged nearby", () => {
  const slots = run();
  assert.deepEqual(labels(slots), ["16:00", "18:00", "20:00", "22:00"]);
  assert.ok(slots.every((s) => !s.nearby));
});

test("nearby Jobber visit: neighbors stay open and are flagged nearby", () => {
  const v = visit("j:1", "2026-09-22T18:00:00Z", 90); // 11:00–12:30
  const slots = run({ blocks: [v], drive: new Map([["j:1", { toNew: 6, fromNew: 7 }]]) });
  assert.deepEqual(labels(slots), ["16:00", "20:00", "22:00"]);
  assert.ok(slots.find((s) => s.scheduledAt.includes("20:00")).nearby);
});

test("20-minute rule: a far visit closes the slots around it", () => {
  const v = visit("j:1", "2026-09-22T18:00:00Z", 90);
  const slots = run({ blocks: [v], drive: new Map([["j:1", { toNew: 34, fromNew: 33 }]]) });
  assert.deepEqual(labels(slots), []);
});

test("20-minute rule means under 20: 20 is rejected, 19 is allowed", () => {
  const v = visit("j:1", "2026-09-22T18:00:00Z", 90);
  const candidate = { date: "2026-09-22", start: at("2026-09-22T20:00:00Z"), end: at("2026-09-22T21:30:00Z") };
  const r20 = evaluateTech({ candidate, tech: RYAN, blocks: [v], drive: new Map([["j:1", { toNew: 20, fromNew: 20 }]]), config });
  const r19 = evaluateTech({ candidate, tech: RYAN, blocks: [v], drive: new Map([["j:1", { toNew: 19, fromNew: 19 }]]), config });
  assert.equal(r20.ok, false);
  assert.equal(r20.reason, "too_far_from_previous");
  assert.equal(r19.ok, true);
});

test("drive time (or the travel buffer, whichever is longer) must fit between jobs", () => {
  const v = visit("j:1", "2026-09-22T18:00:00Z", 110); // ends 12:50
  const candidate = { date: "2026-09-22", start: at("2026-09-22T20:00:00Z"), end: at("2026-09-22T21:30:00Z") };
  const r = evaluateTech({ candidate, tech: RYAN, blocks: [v], drive: new Map([["j:1", { toNew: 12, fromNew: 12 }]]), config });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_gap_after_previous");
});

test("a visit whose address can't be located blocks its neighbors", () => {
  const v = visit("j:1", "2026-09-22T18:00:00Z", 90, { location: null });
  assert.deepEqual(labels(run({ blocks: [v] })), []);
});

test("an 'anytime' Jobber visit far away closes the day", () => {
  const v = { id: "j:any", kind: "jobber", start: at("2026-09-22T07:00:00Z"), end: at("2026-09-23T07:00:00Z"), allDay: true, techIds: null, location: { lat: 1, lng: 1 } };
  assert.deepEqual(labels(run({ blocks: [v], drive: new Map([["j:any", { toNew: 30, fromNew: 31 }]]) })), []);
});

test("technician mapping: a visit assigned to Andrew doesn't block Ryan", () => {
  const v = visit("j:1", "2026-09-22T18:00:00Z", 90, { techIds: ["tech-andrew"] });
  assert.equal(blockBelongsTo(v, RYAN), false);
  assert.equal(blockBelongsTo(v, ANDREW), true);
  assert.equal(blockBelongsTo({ ...v, techIds: null }, RYAN), true, "unassigned visit blocks everyone");
  assert.equal(blockBelongsTo({ ...v, techIds: [] }, { ...RYAN, jobberUserId: "" }), true, "unlinked tech is the whole crew");
});

test("two technicians: picks the one who can take it with the shortest drive", () => {
  const cfg = { ...config, activeTechnicianIds: ["tech-ryan", "tech-andrew"] };
  const far = visit("j:r", "2026-09-22T18:00:00Z", 90, { techIds: ["tech-ryan"] });
  const near = visit("j:a", "2026-09-22T18:00:00Z", 90, { techIds: ["tech-andrew"] });
  const drive = new Map([["j:r", { toNew: 40, fromNew: 40 }], ["j:a", { toNew: 5, fromNew: 5 }]]);
  const one = run({ cfg, technicians: [RYAN, ANDREW], blocks: [far, near], drive }).find((s) => s.scheduledAt.includes("20:00"));
  assert.equal(one.technicianId, "tech-andrew");
  assert.equal(one.jobberUserId, "J-ANDREW");
  assert.equal(one.nearby, true);
});

test("route clustering: nearby slots in the next two weeks are offered first", () => {
  const v = visit("j:1", "2026-09-24T18:00:00Z", 90); // Thursday
  const all = openSlots({ config, technicians: [RYAN], blocks: [v], drive: new Map([["j:1", { toNew: 5, fromNew: 5 }]]), durationMins: 90, now: NOW });
  const ordered = orderSlots(all, { now: NOW, nearbyFirst: true });
  assert.ok(ordered[0].nearby);
  assert.equal(ordered[0].scheduledAt.slice(0, 10), "2026-09-24");
  const plain = orderSlots(all, { now: NOW, nearbyFirst: false });
  assert.equal(plain[0].scheduledAt.slice(0, 10), "2026-09-22");
});

test("travel fee tiers by drive time; empty tiers = no fee; beyond last tier = out of area", () => {
  const cfg = { ...config, travelFeeTiers: [{ upToMin: 30, feeCents: 0 }, { upToMin: 45, feeCents: 2500 }] };
  assert.equal(travelFeeFor(12, cfg), 0);
  assert.equal(travelFeeFor(40, cfg), 2500);
  assert.equal(travelFeeFor(50, cfg), null);
  assert.equal(travelFeeFor(50, config), 0);
  assert.equal(travelFeeFor(null, cfg), 0);
  const q = bookingQuote("bundle", cfg, { package: "premium", property: { stories: "1-story", hasDryer: "Yes" }, travelFeeCents: 2500 });
  assert.equal(q.priceCents, 17900 + 5950);
  assert.equal(q.totalCents, 17900 + 5950 + 2500);
});

test("settings validation covers the new geo rules", () => {
  assert.deepEqual(validateConfig({ ...config }), []);
  assert.ok(validateConfig({ ...config, maxDriveBetweenJobsMin: 0 }).length);
  assert.ok(validateConfig({ ...config, travelFeeTiers: [{ upToMin: 30 }] }).length);
  assert.ok(validateConfig({ ...config, scheduleSource: "Google" }).length);
});
