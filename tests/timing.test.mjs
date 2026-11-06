// Where a booking's time goes: the per-request tally (database, Jobber and its rate-limit waits,
// Google, email, texts, named steps), its Server-Timing header and log line, and two savings: the
// Jobber token is read once per request, and Jobber's team list is reused for a few minutes.

import test from "node:test";
import assert from "node:assert/strict";
import { withTiming, measure, note, step, timingSummary, serverTimingHeader, oncePerRequest, forgetPerRequest } from "../server/timing.mjs";
import { timedDb } from "../server/runtime.mjs";
import { createJobber } from "../server/jobber.mjs";
import { harness, contact } from "./helpers.mjs";

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test("the tally counts calls and time by kind and by step, only inside a request", async () => {
  assert.equal(await measure("db", async () => 7), 7, "outside a request it just runs");
  assert.equal(timingSummary(), null);
  const summary = await withTiming(async () => {
    await measure("db", () => pause(5));
    await measure("db", () => pause(5));
    await step("recheck", () => measure("jobber", () => pause(10)));
    note("jobber_wait", 1500);
    await assert.rejects(measure("google", async () => { throw new Error("down"); }), /down/);
    return timingSummary();
  });
  assert.equal(summary.db.n, 2);
  assert.ok(summary.db.ms >= 8);
  assert.equal(summary.jobber.n, 1);
  assert.deepEqual(summary.jobber_wait, { n: 1, ms: 1500 });
  assert.equal(summary.google.n, 1, "a failed call still counts");
  assert.ok(summary.steps.recheck >= 9);
  assert.ok(summary.ms >= summary.steps.recheck);
  const header = serverTimingHeader(summary);
  assert.match(header, /^total;dur=\d+, step\.recheck;dur=\d+/);
  assert.match(header, /db;desc="2 calls";dur=\d+/);
  assert.match(header, /jobber_wait;desc="1 call";dur=1500/);
});

test("once per request: shared inside one request, read again in the next", async () => {
  let reads = 0;
  const read = () => oncePerRequest("k", async () => ++reads);
  await withTiming(async () => {
    assert.deepEqual(await Promise.all([read(), read(), read()]), [1, 1, 1]);
    forgetPerRequest("k");
    assert.equal(await read(), 2, "forgotten after a change");
  });
  await withTiming(async () => assert.equal(await read(), 3, "a new request reads again"));
  assert.equal(await read(), 4, "outside a request: every time");
});

test("every database query, including inside a transaction, is timed", async () => {
  const raw = { query: async () => [{ ok: 1 }], tx: async (fn) => fn({ query: async () => [{ ok: 2 }] }), close: async () => {} };
  const db = timedDb(raw);
  const summary = await withTiming(async () => {
    assert.deepEqual(await db.query("select 1"), [{ ok: 1 }]);
    assert.deepEqual(await db.tx((t) => t.query("select 2")), [{ ok: 2 }]);
    return timingSummary();
  });
  assert.equal(summary.db.n, 2);
  assert.equal(typeof db.close, "function");
});

function jobber({ users = [{ id: "USER-RYAN", name: { full: "Ryan Test" } }] } = {}) {
  const calls = [];
  let loads = 0;
  const start = Date.parse("2026-11-02T18:00:00Z"), end = start + 3600_000;
  const visit = { id: "VISIT", startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString() };
  const responses = {
    BobUsers: () => ({ users: { nodes: users, pageInfo: { hasNextPage: false } } }),
    BobVisits: () => ({ visits: { nodes: [{ ...visit, allDay: false, assignedUsers: { nodes: [{ id: "USER-RYAN" }], pageInfo: { hasNextPage: false } } }], pageInfo: { hasNextPage: false } } }),
    BobJobCreate: () => ({ jobCreate: { job: { id: "JOB", jobNumber: 101, jobberWebUri: "https://example.com/job/101" }, userErrors: [] } }),
    BobVisitCreate: () => ({ visitCreate: { createdVisits: [visit], userErrors: [] } }),
  };
  const cache = new Map();
  const api = createJobber({
    store: { kvGet: async (k) => cache.get(k), kvSet: async (k, v) => cache.set(k, v) },
    env: { JOBBER_CLIENT_ID: "fake-client", JOBBER_CLIENT_SECRET: "fake-secret", JOBBER_REDIRECT_URI: "https://example.com/callback" },
    tokens: { load: async () => { loads++; return { accessToken: "fake-access", refreshToken: "fake-refresh", expiresAt: Date.now() + 3600_000 }; } },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body), operation = body.query.match(/(?:query|mutation)\s+(\w+)/)[1];
      calls.push(operation);
      return new Response(JSON.stringify({ data: responses[operation]() }), { status: 200 });
    },
  });
  return { api, calls, loads: () => loads, start, end, users };
}

test("the stored Jobber token is read once per request, not before every Jobber call", async () => {
  const j = jobber();
  const options = { propertyId: "PROPERTY", title: "Cleaning", lineItems: [{ name: "Cleaning", cents: 19900 }], start: j.start, end: j.end, jobberUserId: "USER-RYAN" };
  await withTiming(() => j.api.createScheduledJob(options));
  assert.deepEqual(j.calls, ["BobUsers", "BobJobCreate", "BobVisitCreate", "BobVisits"]);
  assert.equal(j.loads(), 1, "four Jobber calls, one token read");
  const outside = jobber();
  await outside.api.createScheduledJob(options);
  assert.ok(outside.loads() > 1, "outside a request nothing is shared");
});

test("Jobber's team list is reused for a few minutes, and looked up again before refusing a technician", async () => {
  const j = jobber();
  await j.api.verifyAssignment("USER-RYAN");
  await j.api.verifyAssignment("USER-RYAN");
  assert.deepEqual(j.calls, ["BobUsers"], "the second booking reuses the list");
  j.users.push({ id: "USER-NEW", name: { full: "New Hire" } });
  assert.equal((await j.api.verifyAssignment("USER-NEW")).id, "USER-NEW", "someone added since is found");
  assert.deepEqual(j.calls, ["BobUsers", "BobUsers"]);
  await assert.rejects(j.api.verifyAssignment("USER-GONE"), { code: "JOBBER_ASSIGNMENT_INVALID" });
  assert.deepEqual(j.calls, ["BobUsers", "BobUsers", "BobUsers"], "one fresh look before refusing");
  assert.equal(j.calls.length, 3);
  assert.equal((await j.api.listUsers()).length, 2, "Settings still gets the live list");
  assert.equal(j.calls.length, 4);
});

test("a booking reports where its time went: header, log line, and BOB activity", async (t) => {
  const h = await harness(t, { config: { pricesAcknowledged: true } });
  const logs = [];
  const log = console.log;
  console.log = (...args) => { if (String(args[0]).startsWith("[timing]")) logs.push(args.join(" ")); else log(...args); };
  t.after(() => { console.log = log; });
  const token = await h.prepare("cleaning", contact);
  const slots = await h.slots(token);
  const held = await h.hold(token, slots[0].scheduledAt);
  const r = await h.confirm(token, held.data.hold);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const header = r.headers.get("server-timing");
  assert.match(header, /^total;dur=\d+/);
  for (const name of ["step.recheck", "step.jobber", "step.jobber.team", "step.jobber.client", "step.jobber.visit", "step.confirmations"]) assert.match(header, new RegExp(`${name.replace(/\./g, "\\.")};dur=\\d+`), name);
  assert.ok(logs.some((l) => /^\[timing\] POST \/api\/bookings 201 \d+ms \{/.test(l)), logs.join("\n"));
  assert.ok(logs.some((l) => l.startsWith("[timing] GET /api/availability 200")), "openings lookups too");
  const cookie = await h.login();
  const activity = (await h.call("/api/admin/activity", { cookie })).data.items;
  const finished = activity.find((e) => e.kind === "request.finished" && e.details?.path === "/api/bookings");
  assert.ok(finished?.details?.timing?.steps?.recheck >= 0, "kept in BOB activity");
  const chat = await h.call("/api/session", { method: "POST", body: {} });
  assert.equal(chat.status, 201);
  assert.equal(chat.headers.get("server-timing"), null, "only booking-flow endpoints");
});

test("Jobber reads that find the login expiring at the same moment share one renewal, with no waiting", async () => {
  const kv = new Map(), locks = new Set();
  let saved = { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: Date.now() + 30_000, savedAt: 1 }; // inside the 2-minute renewal margin
  const posts = [], used = [];
  const api = createJobber({
    store: {
      kvGet: async (k) => kv.get(k), kvSet: async (k, v) => kv.set(k, v),
      lock: async (k) => (locks.has(k) ? false : (locks.add(k), true)), unlock: async (k) => { locks.delete(k); },
    },
    env: { JOBBER_CLIENT_ID: "fake-client", JOBBER_CLIENT_SECRET: "fake-secret", JOBBER_REDIRECT_URI: "https://example.com/callback" },
    tokens: { load: async () => saved, save: async (t) => { saved = t; }, clear: async () => { saved = null; } },
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/api/oauth/token")) {
        posts.push(String(init.body));
        await pause(20);
        return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }), { status: 200 });
      }
      used.push(init.headers.Authorization);
      return new Response(JSON.stringify({ data: { users: { nodes: [{ id: "USER-RYAN", name: { full: "Ryan" } }], pageInfo: { hasNextPage: false } } } }), { status: 200 });
    },
  });
  const summary = await withTiming(async () => {
    await Promise.all([api.listUsers(), api.listUsers(), api.listUsers()]);
    await api.listUsers(); // later calls in the same request use the new login without renewing again
    return timingSummary();
  });
  assert.equal(posts.length, 1, "one renewal");
  assert.equal(summary.jobber_wait, undefined, "nobody waited on the lock");
  assert.deepEqual([...new Set(used)], ["Bearer new-access"]);
  assert.equal(saved.accessToken, "new-access");
  assert.equal(locks.size, 0, "the lock is released");
});
