// Availability took 20–30 s in production (week of Nov 2 2026): one lookup made ~240 database round
// trips, mostly one at a time (a cache read and write per drive-time pair, a status read and write
// per Google call). These tests keep the batching that brought it to ~55 without changing results.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createPgliteDb } from "../server/db.mjs";
import { createStore } from "../server/store.mjs";
import { createGeo } from "../server/geo.mjs";
import { createJobber } from "../server/jobber.mjs";
import { createIntegrationStatus } from "../server/integration-status.mjs";
import { createIntegrationControls, controlProviders } from "../server/integration-controls.mjs";
import { createScheduler } from "../server/schedule.mjs";
import { DEFAULT_CONFIG } from "../shared/domain.mjs";

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("kvGetMany / kvSetMany read and write many keys in one round trip each", async (t) => {
  const db = await createPgliteDb();
  t.after(() => db.close());
  let now = 1_000_000;
  let queries = 0;
  const store = createStore({ ...db, query: (text, params) => (queries++, db.query(text, params)) }, { clock: () => now });
  await store.kvSetMany([["a", { n: 1 }], ["b", "two"], ["a", { n: 3 }], ["c", null]], 60);
  assert.equal(queries, 1);
  const got = await store.kvGetMany(["a", "b", "missing", "a"]);
  assert.equal(queries, 2);
  assert.deepEqual(Object.fromEntries(got), { a: { n: 3 }, b: "two" }, "a repeated key keeps its last value; missing keys are absent");
  assert.equal((await store.kvGetMany(["c"])).get("c"), null);
  assert.equal(await store.kvGet("b"), "two", "the single-key read sees batch writes");
  now += 61_000;
  assert.equal((await store.kvGetMany(["a", "b"])).size, 0, "expired keys are not returned");
  queries = 0;
  assert.equal((await store.kvGetMany([])).size, 0);
  await store.kvSetMany([], 60);
  assert.equal(queries, 0, "empty batches never reach the database");
  await store.kvSetMany([["quote's", { street: "1 O'Neil St" }]], 60);
  now -= 61_000;
  assert.deepEqual((await store.kvGetMany(["quote's"])).get("quote's"), { street: "1 O'Neil St" });
});

test("drive times: one cache read, one cache write, Google requests overlapped but capped", async () => {
  const calls = { get: 0, getMany: 0, set: 0, setMany: 0 }, saved = new Map();
  const cache = {
    kvGet: async (k) => (calls.get++, saved.get(k) ?? null),
    kvSet: async (k, v) => (calls.set++, saved.set(k, v)),
    kvGetMany: async (keys) => (calls.getMany++, new Map(keys.filter((k) => saved.has(k)).map((k) => [k, saved.get(k)]))),
    kvSetMany: async (entries) => { calls.setMany++; for (const [k, v] of entries) saved.set(k, v); },
  };
  let inFlight = 0, peak = 0, requests = 0;
  const fetchImpl = async (url, init) => {
    requests++; inFlight++; peak = Math.max(peak, inFlight);
    await sleep(15);
    inFlight--;
    const body = JSON.parse(init.body);
    return json(body.destinations.map((_, d) => ({ originIndex: 0, destinationIndex: d, condition: "ROUTE_EXISTS", duration: `${600 + d * 60}s`, distanceMeters: 5000 })));
  };
  const geo = createGeo({ cache, googleKey: "test-key", fetchImpl, clock: () => 5_000 });
  const customer = { lat: 33.6, lng: -112.4 };
  const jobs = Array.from({ length: 20 }, (_, i) => ({ lat: 33.5 + i / 1000, lng: -112.3 - i / 1000 }));
  const pairs = [...jobs.map((j) => ({ from: j, to: customer })), ...jobs.map((j) => ({ from: customer, to: j }))];
  const minutes = await geo.driveMinutes(pairs);
  assert.equal(requests, 21, "one request per job's starting point plus one for the customer's 20 destinations");
  assert.ok(peak > 1 && peak <= 6, `requests overlap, at most 6 at once (peak ${peak})`);
  assert.deepEqual(minutes.slice(0, 20), Array(20).fill(10), "each job -> customer is its own request's first destination");
  assert.deepEqual(minutes.slice(20), jobs.map((_, d) => 10 + d), "customer -> each job keeps its destination order");
  // The single get/set is the connection-status record, written once for the whole batch.
  assert.deepEqual(calls, { get: 1, getMany: 1, set: 1, setMany: 1 });
  // The same lookup again is answered from the cache in one read, with no Google request.
  assert.deepEqual(await geo.driveMinutes(pairs), minutes);
  assert.equal(requests, 21);
  assert.equal(calls.getMany, 2);
  // fresh skips the cache read (final checks before booking).
  await geo.driveMinutes(pairs.slice(0, 2), { fresh: true });
  assert.equal(calls.getMany, 2);
});

test("a cache without batch methods still works one key at a time", async () => {
  const m = new Map();
  const cache = { kvGet: async (k) => m.get(k) ?? null, kvSet: async (k, v) => void m.set(k, v) };
  const fetchImpl = async (url, init) => json(JSON.parse(init.body).destinations.map((_, d) => ({ destinationIndex: d, condition: "ROUTE_EXISTS", duration: "300s", distanceMeters: 1609 })));
  const geo = createGeo({ cache, googleKey: "test-key", fetchImpl, clock: () => 5_000 });
  const a = { lat: 33.5, lng: -112.3 }, b = { lat: 33.6, lng: -112.4 };
  assert.deepEqual(await geo.driveMinutes([{ from: a, to: b }, { from: b, to: a }]), [5, 5]);
  assert.equal([...m.keys()].filter((k) => k.startsWith("drive:")).length, 2);
  const roads = await geo.roadRoutes([{ from: a, to: b }]);
  assert.equal(Math.round(roads[0].miles), 1);
});

test("repeat Google successes update the status record at most once a minute; failures always", async () => {
  const values = new Map(); let now = 10_000, writes = 0;
  const cache = { kvGet: async (k) => structuredClone(values.get(k)), kvSet: async (k, v) => { writes++; values.set(k, structuredClone(v)); } };
  const status = createIntegrationStatus({ cache, provider: "test", revision: "r", operations: ["routes"], clock: () => now });
  for (let i = 0; i < 25; i++) await status.recordSuccess("routes");
  assert.equal(writes, 1, "25 successes in a row: one write");
  now += 30_000; await status.recordFailure("routes", "Denied");
  assert.equal(writes, 2, "a failure is always written");
  assert.equal((await status.snapshot()).status, "error");
  await status.recordSuccess("routes");
  assert.equal(writes, 3, "the first success after a failure is written");
  assert.equal((await status.snapshot()).status, "healthy");
  now += 59_000; await status.recordSuccess("routes");
  assert.equal(writes, 3);
  now += 1_000; await status.recordSuccess("routes");
  assert.equal(writes, 4, "a minute later the success is written again, keeping the panel fresh");
  // Concurrent successes (overlapped Google requests) write once.
  now += 60_000; await Promise.all(Array.from({ length: 6 }, () => status.recordSuccess("routes")));
  assert.equal(writes, 5);
});

test("an availability lookup over 20 calendar visits stays within a database round-trip budget", async (t) => {
  const raw = await createPgliteDb();
  t.after(() => raw.close());
  await raw.exec(await readFile(new URL("../supabase/chatdaddy_jobber_tokens.sql", import.meta.url), "utf8"));
  let counting = false; const kinds = new Map();
  const db = { ...raw, query: async (text, params) => {
    if (counting) {
      const k = /bob\.settings/.test(text) ? "settings" : /drive:/.test(JSON.stringify(params ?? [])) ? `drive ${/^\s*select/i.test(text) ? "read" : "write"}` : /diag:/.test(String(params?.[0])) ? "status" : "other";
      kinds.set(k, (kinds.get(k) || 0) + 1);
    }
    return raw.query(text, params);
  } };
  const store = createStore(db);
  const technicians = [{ id: "tech-ryan", name: "Ryan", status: "available", jobberUserId: "J-RYAN" }];
  await store.set("config", { ...DEFAULT_CONFIG, bookingEnabled: true, pricesAcknowledged: true, scheduleAcknowledged: true, scheduleSource: "Jobber", activeTechnicianIds: ["tech-ryan"] });
  await store.set("technicians", technicians);
  await raw.query("insert into public.chatdaddy_jobber_tokens(id,access_token,refresh_token,expires_at) values(1,'a','r',now()+interval '1 hour')");
  const NOW = Date.parse("2026-11-02T22:00:00Z");
  const start = (i) => NOW + 86_400_000 * (1 + Math.floor(i / 2)) + ((i % 2) * 4 + 16) * 3_600_000;
  const visits = Array.from({ length: 20 }, (_, i) => ({ id: `V${i}`, title: "Visit", startAt: new Date(start(i)).toISOString(), endAt: new Date(start(i) + 3_600_000).toISOString(), allDay: false, assignedUsers: { nodes: [{ id: "J-RYAN" }], pageInfo: { hasNextPage: false } }, job: { id: `J${i}`, jobNumber: i, property: { address: { street1: `${100 + i} W Test St`, city: "Surprise", province: "AZ", postalCode: "85388" } } } }));
  const jobberFetch = async (url, init) => {
    const op = JSON.parse(init.body).query.match(/query\s+(\w+)/)?.[1];
    if (op === "BobVisits") return json({ data: { visits: { nodes: visits, pageInfo: { hasNextPage: false } } } });
    if (op === "BobAssessments") return json({ data: { requests: { nodes: [], pageInfo: { hasNextPage: false } } } });
    throw new Error(`unexpected ${op}`);
  };
  const point = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return { lat: 33.4 + (h % 1000) / 10000, lng: -112.4 - ((h >> 10) % 1000) / 10000 }; };
  const googleFetch = async (url, init) => {
    if (String(url).includes("/geocode/")) { const a = new URL(url).searchParams.get("address"); return json({ status: "OK", results: [{ geometry: { location: point(a) }, formatted_address: a, address_components: [{ types: ["street_number"], long_name: "1" }] }] }); }
    return json(JSON.parse(init.body).destinations.map((_, d) => ({ destinationIndex: d, condition: "ROUTE_EXISTS", duration: "600s", distanceMeters: 8000 })));
  };
  const controls = createIntegrationControls({ store });
  const { jobber, geo } = controlProviders({
    controls,
    jobber: createJobber({ store, env: { JOBBER_CLIENT_ID: "c", JOBBER_CLIENT_SECRET: "s", JOBBER_REDIRECT_URI: "https://example.com/cb" }, fetchImpl: controls.fetchFor("jobber", jobberFetch) }),
    geo: createGeo({ cache: store, googleKey: "test-key", fetchImpl: controls.fetchFor("maps", googleFetch) }),
  });
  for (const v of visits) { const a = v.job.property.address; await geo.geocode(`${a.street1}, ${a.city}, ${a.province} ${a.postalCode}`); }
  const scheduler = createScheduler({ store, jobber, geo });
  counting = true;
  const slots = await scheduler.slots({ config: await store.config(), technicians, durationMins: 60, leadHours: 12, location: { lat: 33.61, lng: -112.42 }, now: NOW });
  counting = false;
  assert.ok(slots.length > 0);
  const total = [...kinds.values()].reduce((a, b) => a + b, 0);
  assert.equal(kinds.get("drive read"), 1, "drive times: one cache read");
  assert.equal(kinds.get("drive write"), 1, "drive times: one cache write");
  assert.ok((kinds.get("status") || 0) <= 2, `status records: at most a read and a write (${kinds.get("status")})`);
  assert.ok(total <= 70, `database round trips for one lookup: ${total} (was ~240 before batching)`);
});
