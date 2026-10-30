// The same booking flows, with the store talking SQL through Supabase's REST API
// (public.bob_exec) instead of a direct connection.

import test from "node:test";
import assert from "node:assert/strict";
import { harness, contact } from "./helpers.mjs";
import { inline, literal } from "../server/db.mjs";

test("parameters become quoted literals in one pass", () => {
  assert.equal(literal(null), "NULL");
  assert.equal(literal("it's"), "'it''s'");
  assert.equal(literal({ a: "b'" }), `'{"a":"b''"}'`);
  assert.equal(inline("a=$1 and b=$2", ["$2", 7]), "a='$2' and b='7'");
  assert.throws(() => inline("a=$3", [1]));
});

test("a full booking works over the REST adapter", async (t) => {
  const h = await harness(t, { rest: true });
  assert.equal(h.db.kind, "supabase-rest");
  const r = await h.book("cleaning", { ...contact, name: "O'Brien Test", notes: "Gate $1 code 'A'" });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const [a] = await h.store.appointments();
  assert.equal(a.customerName, "O'Brien Test");
  assert.equal(a.notes, "Gate $1 code 'A'");
  assert.equal(await h.count("holds"), 0);
});

test("locks, rate limits and idempotency behave the same over REST", async (t) => {
  const h = await harness(t, { rest: true });
  assert.equal(await h.store.lock("x", 30), true);
  assert.equal(await h.store.lock("x", 30), false);
  await h.store.unlock("x");
  assert.equal(await h.store.lock("x", 30), true);
  for (let i = 0; i < 3; i++) assert.equal(await h.store.rateHit("k", 3, 60_000), true);
  assert.equal(await h.store.rateHit("k", 3, 60_000), false);
  const a = await h.prepare(), b = await h.prepare();
  const slot = (await h.slots(a))[0].scheduledAt;
  const results = await Promise.all([h.hold(a, slot), h.hold(b, slot)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
});

test("Jobber tokens go in ChatDaddy's chatdaddy_jobber_tokens table when it exists", async (t) => {
  const { createPgliteDb } = await import("../server/db.mjs");
  const { createStore } = await import("../server/store.mjs");
  const { createJobber } = await import("../server/jobber.mjs");
  const db = await createPgliteDb();
  t.after(() => db.close());
  await db.exec(`create table public.chatdaddy_jobber_tokens (id smallint primary key default 1 check (id = 1), access_token text not null, refresh_token text not null, expires_at timestamptz, updated_at timestamptz not null default now())`);
  const store = createStore(db);
  await store.init();
  const jwt = (exp) => `x.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.y`;
  const fetchImpl = async () => new Response(JSON.stringify({ access_token: jwt(Math.floor(Date.now() / 1000) + 3600), refresh_token: "r1" }), { status: 200 });
  const jobber = createJobber({ store, env: { JOBBER_CLIENT_ID: "a", JOBBER_CLIENT_SECRET: "b", JOBBER_REDIRECT_URI: "https://x/api/jobber/callback" }, fetchImpl });
  assert.equal(await jobber.connected(), false);
  await jobber.exchangeCode("code");
  assert.equal(await jobber.connected(), true);
  const [row] = await db.query("select refresh_token from public.chatdaddy_jobber_tokens where id=1");
  assert.equal(row.refresh_token, "r1");
  assert.equal(await store.kvGet("jobber:tokens"), null, "not duplicated in BOB's kv");
  await jobber.disconnect();
  assert.equal(await jobber.connected(), false);
});
