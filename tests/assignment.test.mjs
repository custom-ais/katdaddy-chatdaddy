// Who BOB books: a tech's live status ("Off duty") only matters for today's openings, and Settings can
// put extra Jobber team members (the owner, the office) on every visit BOB books.

import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, serviceQuote, validateConfig } from "../shared/domain.mjs";
import { openSlots } from "../server/schedule-rules.mjs";
import { createJobber } from "../server/jobber.mjs";
import { harness, contact } from "./helpers.mjs";

const NOW = Date.parse("2026-09-21T10:00:00Z"); // Mon Sep 21, 3:00 AM Arizona: 3 PM meets the 12-hour minimum
const config = { ...DEFAULT_CONFIG, serviceZips: ["85326"], pricesAcknowledged: true, scheduleAcknowledged: true, bookingEnabled: true, bufferMinutes: 15, leadHours: 12, sameDay: { ...DEFAULT_CONFIG.sameDay, enabled: true, minNoticeHours: 12 }, activeTechnicianIds: ["tech-ryan", "tech-andrew"] };
const RYAN = { id: "tech-ryan", name: "Ryan", status: "available", jobberUserId: "J-RYAN" };
const ANDREW = { id: "tech-andrew", name: "Andrew", status: "available", jobberUserId: "J-ANDREW" };
const open = (technicians, date, cfg = config) => openSlots({ config: cfg, technicians, blocks: [], drive: new Map(), durationMins: serviceQuote("cleaning", cfg).durationMins, now: NOW, date })
  .map((s) => [s.scheduledAt.slice(11, 16), s.technicianId]);

test("Off duty keeps a tech off today's openings only; other days follow their calendar", () => {
  const off = { ...RYAN, status: "off_duty" };
  assert.deepEqual(open([RYAN], "2026-09-21"), [["22:00", "tech-ryan"]], "today's 3 PM is open while he's available");
  assert.deepEqual(open([off], "2026-09-21"), [], "off duty: nothing today");
  assert.deepEqual(open([off], "2026-09-22").map(([t]) => t), ["16:00", "18:00", "20:00", "22:00"], "tomorrow is open again");
  assert.ok(open([off], "2026-09-22").every(([, tech]) => tech === "tech-ryan"));
  assert.deepEqual(open([off, ANDREW], "2026-09-21"), [["22:00", "tech-andrew"]], "today goes to whoever is on");
  for (const status of ["on_route", "on_job"]) assert.deepEqual(open([{ ...RYAN, status }], "2026-09-21"), [["22:00", "tech-ryan"]], `${status} still takes later work today`);
  // Only techs who take online bookings are ever offered, whatever their status.
  assert.deepEqual(open([RYAN, ANDREW], "2026-09-22", { ...config, activeTechnicianIds: ["tech-andrew"] }).map(([, tech]) => tech), ["tech-andrew", "tech-andrew", "tech-andrew", "tech-andrew"]);
});

const start = Date.parse("2026-11-02T18:00:00Z"), end = start + 3600_000;
const options = { propertyId: "PROPERTY", title: "Cleaning", instructions: "Test only", lineItems: [{ name: "Cleaning", cents: 19900 }], start, end, jobberUserId: "USER-RYAN" };
const visit = { id: "VISIT", startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString() };
function jobberApi(assigned) {
  const calls = [];
  const responses = {
    BobUsers: { users: { nodes: [{ id: "USER-RYAN", name: { full: "Ryan Test" } }, { id: "USER-SETH", name: { full: "Seth Owner" } }], pageInfo: { hasNextPage: false } } },
    BobJobCreate: { jobCreate: { job: { id: "JOB", jobNumber: 101, jobberWebUri: "https://example.com/job/101" }, userErrors: [] } },
    BobVisitCreate: { visitCreate: { createdVisits: [visit], userErrors: [] } },
    BobVisits: { visits: { nodes: [{ ...visit, allDay: false, assignedUsers: { nodes: assigned.map((id) => ({ id })), pageInfo: { hasNextPage: false } } }], pageInfo: { hasNextPage: false } } },
  };
  const cache = new Map();
  const api = createJobber({
    store: { kvGet: async (k) => cache.get(k), kvSet: async (k, v) => cache.set(k, v) },
    env: { JOBBER_CLIENT_ID: "fake-client", JOBBER_CLIENT_SECRET: "fake-secret", JOBBER_REDIRECT_URI: "https://example.com/callback" },
    tokens: { load: async () => ({ accessToken: "fake-access", refreshToken: "fake-refresh", expiresAt: Date.now() + 3600_000 }) },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body), operation = body.query.match(/(?:query|mutation)\s+(\w+)/)?.[1];
      calls.push({ operation, ...body });
      return new Response(JSON.stringify({ data: responses[operation] }), { status: 200 });
    },
  });
  return { api, calls };
}

test("the Jobber visit gets the technician plus the people Settings adds, and is still verified", async () => {
  const warn = console.warn; console.warn = () => {};
  try {
    const h = jobberApi(["USER-RYAN", "USER-SETH"]);
    const result = await h.api.createScheduledJob({ ...options, alsoAssign: ["USER-SETH", "USER-GONE", "USER-RYAN", "USER-SETH"] });
    const schedule = h.calls.find((c) => c.operation === "BobVisitCreate").variables.input.visits[0].schedule;
    assert.deepEqual(schedule.teamMemberIdsToAssign, ["USER-RYAN", "USER-SETH"], "the tech first; no duplicates; someone no longer in Jobber is skipped");
    assert.equal(result.visit.assignmentVerified, true);
    assert.deepEqual(result.visit.assignedUserIds, ["USER-RYAN", "USER-SETH"]);

    // Jobber leaving the extra person off doesn't undo the booking: the tech and time are what count.
    const dropped = jobberApi(["USER-RYAN"]);
    assert.equal((await dropped.api.createScheduledJob({ ...options, alsoAssign: ["USER-SETH"] })).visit.assignmentVerified, true);

    // Without the setting nothing changes: one user lookup, the tech alone.
    const plain = jobberApi(["USER-RYAN"]);
    await plain.api.createScheduledJob(options);
    assert.deepEqual(plain.calls.map((c) => c.operation), ["BobUsers", "BobJobCreate", "BobVisitCreate", "BobVisits"]);
  } finally { console.warn = warn; }
});

test("verification still refuses a visit with someone else on it, or without the technician", async () => {
  const stranger = jobberApi(["USER-RYAN", "USER-STRANGER"]);
  await assert.rejects(stranger.api.verifyScheduledVisit({ visitId: "VISIT", start, end, jobberUserId: "USER-RYAN", alsoAssign: ["USER-SETH"] }), { code: "JOBBER_VISIT_UNVERIFIED" });
  const ownerOnly = jobberApi(["USER-SETH"]);
  await assert.rejects(ownerOnly.api.verifyScheduledVisit({ visitId: "VISIT", start, end, jobberUserId: "USER-RYAN", alsoAssign: ["USER-SETH"] }), { code: "JOBBER_VISIT_UNVERIFIED" });
  const both = jobberApi(["USER-SETH", "USER-RYAN"]);
  assert.equal((await both.api.verifyScheduledVisit({ visitId: "VISIT", start, end, jobberUserId: "USER-RYAN", alsoAssign: ["USER-SETH"] })).assignmentVerified, true);
});

test("Settings checks the list of extra people", () => {
  const errors = (ids) => validateConfig({ ...DEFAULT_CONFIG, alsoAssignJobberUserIds: ids }).filter((e) => /every BOB visit/.test(e));
  assert.deepEqual(errors([]), []);
  assert.deepEqual(errors(["Z2lkOi8vSm9iYmVyL1VzZXIvMTIz"]), []);
  assert.equal(errors(["a b"]).length, 1);
  assert.equal(errors(["X", "X"]).length, 1, "no duplicates");
  assert.equal(errors(Array.from({ length: 11 }, (_, i) => `U${i}`)).length, 1, "at most 10");
  assert.equal(errors("J-SETH").length, 1);
  assert.deepEqual(DEFAULT_CONFIG.alsoAssignJobberUserIds, [], "off unless chosen");
});

test("a booked visit carries the extra people, and still counts once on the calendar", async (t) => {
  // Andrew is a linked tech who doesn't take online bookings; he's added to every visit.
  const h = await harness(t, { config: { pricesAcknowledged: true, maxJobsPerDay: 2, alsoAssignJobberUserIds: ["J-ANDREW"] } });
  const booked = await h.book();
  assert.equal(booked.status, 201, JSON.stringify(booked.data));
  const job = h.jobber.jobs.at(-1);
  assert.equal(job.jobberUserId, "J-RYAN", "Ryan does the job");
  assert.deepEqual(job.alsoAssign, ["J-ANDREW"]);
  assert.deepEqual(h.jobber.visits.at(-1).jobberUserIds, ["J-RYAN", "J-ANDREW"]);
  const appt = (await h.store.appointments()).at(-1);
  assert.equal(appt.status, "confirmed", "verified with both on the visit");

  // With a 2-a-day cap, that day still has room: BOB's booking and its Jobber visit are one job, not two.
  const day = appt.scheduledAt.slice(0, 10);
  const token = await h.prepare("cleaning", { ...contact, name: "Second Customer" });
  const sameDay = (await h.slots(token, `?date=${day}`)).filter((s) => s.scheduledAt.slice(0, 10) === day);
  assert.ok(sameDay.length > 0, "the day isn't counted as full");
  assert.ok(!sameDay.some((s) => s.scheduledAt === appt.scheduledAt), "Ryan's booked time is taken");
});
