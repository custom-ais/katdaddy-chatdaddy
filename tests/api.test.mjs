import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPgliteDb } from "../server/db.mjs";
import { createStore } from "../server/store.mjs";
import { harness, contact, FLOWS } from "./helpers.mjs";

// ---- original BOB behaviour (ported from the SQLite version) -----------------------

test("public configuration never exposes customer records", async (t) => {
  const h = await harness(t);
  const r = await h.call("/api/public/config");
  assert.equal(r.status, 200);
  assert.equal(r.data.appointments, undefined);
  assert.equal(r.data.bundlePriceCents, 24800);
  assert.equal(r.data.phone, "");
});
test("admin records require authentication", async (t) => {
  const h = await harness(t);
  assert.equal((await h.call("/api/admin/data")).status, 401);
});
test("chat requires a real conversation token", async (t) => {
  const h = await harness(t);
  assert.equal((await h.call("/api/chat", { method: "POST", body: { message: "Hi" } })).status, 401);
});
test("cross-origin writes are rejected", async (t) => {
  const h = await harness(t);
  assert.equal((await h.call("/api/session", { method: "POST", body: {}, headers: { Origin: "https://untrusted.example" } })).status, 403);
});
test("write without verification header is rejected", async (t) => {
  const h = await harness(t);
  assert.equal((await h.call("/api/session", { method: "POST", body: {}, headers: { "X-BOB-Request": "0" } })).status, 403);
});
test("private setup code is required", async (t) => {
  const h = await harness(t);
  assert.equal((await h.call("/api/admin/setup", { method: "POST", body: { setupToken: "wrong", password: "A-long-enough-password" } })).status, 403);
});
test("short management passwords are rejected", async (t) => {
  const h = await harness(t);
  assert.equal((await h.call("/api/admin/setup", { method: "POST", body: { setupToken: "test-only-setup-token", password: "short" } })).status, 400);
});
test("admin setup, login, and private snapshot", async (t) => {
  const h = await harness(t);
  const cookie = await h.login();
  const r = await h.call("/api/admin/data", { cookie });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.appointments, []);
  assert.equal(r.data.auth, undefined);
  assert.equal(r.data.heldLocksCount, 0);
  assert.equal(r.data.integrations.jobber.connected, true);
});
test("management setup cannot be overwritten", async (t) => {
  const h = await harness(t);
  await h.login();
  assert.equal((await h.call("/api/admin/setup", { method: "POST", body: { setupToken: "test-only-setup-token", password: "Another-long-password" } })).status, 409);
});
test("disabled configuration refuses real booking availability", async (t) => {
  const h = await harness(t, { ready: false });
  const token = await h.fresh();
  await h.chat(token, "Dryer Vent Cleaning");
  const r = await h.chat(token, "85326");
  assert.equal(r.action, "request");
  assert.equal((await h.hold(token, "2026-09-22T16:00:00Z")).status, 409);
});
test("contact cannot be submitted before service acceptance", async (t) => {
  const h = await harness(t);
  const token = await h.fresh();
  assert.equal((await h.call("/api/contact", { method: "POST", token, body: contact })).status, 409);
});
test("invalid contact cannot be booked", async (t) => {
  const h = await harness(t);
  const token = await h.accept();
  assert.equal((await h.call("/api/contact", { method: "POST", token, body: { ...contact, phone: "bad" } })).status, 400);
});
test("server rejects unapproved ZIP in address form", async (t) => {
  const h = await harness(t);
  const token = await h.prepare();
  assert.equal((await h.call("/api/contact", { method: "POST", token, body: { ...contact, zip: "90210" } })).status, 409);
});
test("complete cleaning workflow returns a genuine booking", async (t) => {
  const h = await harness(t);
  const token = await h.prepare();
  const slots = await h.slots(token);
  assert.equal(slots.length, 3);
  const held = await h.hold(token, slots[0].scheduledAt);
  assert.equal(held.status, 201);
  const r = await h.confirm(token, held.data.hold);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.match(r.data.receipt.id, /^DVS-/);
  assert.equal(r.data.receipt.priceCents, 17900);
  const appts = await h.store.appointments();
  assert.equal(appts.length, 1);
  assert.equal(appts[0].airflowReadings, undefined);
});
test("complete standalone assessment workflow uses $119", async (t) => {
  const h = await harness(t);
  const r = await h.book("assessment");
  assert.equal(r.data.receipt.priceCents, 11900);
  assert.equal(r.data.receipt.durationMins, 60);
});
test("complete combined workflow is the cleaning package plus the assessment at 50% off, for both services' time", async (t) => {
  const h = await harness(t);
  const r = await h.book("bundle");
  assert.equal(r.status, 201);
  assert.equal(r.data.receipt.priceCents, 17900 + 5950);
  assert.equal(r.data.receipt.durationMins, 60 + 60);
  assert.deepEqual(h.jobber.jobs[0].lineItems.map((i) => [i.name, i.cents]), [["Premium 1-2-3 See-It-Clean", 17900], ["Comprehensive Repair Assessment (50% off with cleaning)", 5950]]);
  assert.equal((await h.store.appointments())[0].assessmentAccepted, true);
});
test("customer cannot alter price, technician, or route in booking payload", async (t) => {
  const h = await harness(t);
  const token = await h.prepare("bundle");
  const held = await h.hold(token, (await h.slots(token))[0].scheduledAt);
  const r = await h.confirm(token, held.data.hold, { priceCents: 0, price: 0, route: "free", technicianId: "fake" });
  assert.equal(r.data.receipt.priceCents, 23850);
  const [a] = await h.store.appointments();
  assert.equal(a.technicianId, "tech-ryan");
  assert.equal(a.route, "bundle");
});
test("final explicit approval is required", async (t) => {
  const h = await harness(t);
  const token = await h.prepare();
  const held = await h.hold(token, (await h.slots(token))[0].scheduledAt);
  assert.equal((await h.confirm(token, held.data.hold, { approved: false })).status, 400);
  assert.equal((await h.store.appointments()).length, 0);
});
test("only selected slot is held", async (t) => {
  const h = await harness(t);
  const token = await h.prepare();
  const slots = await h.slots(token);
  assert.equal(await h.count("holds"), 0);
  await h.hold(token, slots[0].scheduledAt);
  assert.equal(await h.count("holds"), 1);
});
test("a second selected time releases the previous hold", async (t) => {
  const h = await harness(t);
  const token = await h.prepare();
  const slots = await h.slots(token);
  await h.hold(token, slots[0].scheduledAt);
  await h.hold(token, slots[1].scheduledAt);
  assert.equal(await h.count("holds"), 1);
});
test("two competing customers cannot hold the same single-technician slot", async (t) => {
  const h = await harness(t);
  const a = await h.prepare(), b = await h.prepare();
  const slot = (await h.slots(a))[0].scheduledAt;
  const results = await Promise.all([h.hold(a, slot), h.hold(b, slot)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
});
test("expired hold cannot be confirmed", async (t) => {
  const h = await harness(t);
  const token = await h.prepare();
  const held = await h.hold(token, (await h.slots(token))[0].scheduledAt);
  h.advance(301_000);
  assert.equal((await h.confirm(token, held.data.hold)).status, 409);
  assert.equal((await h.store.appointments()).length, 0);
});
test("one customer cannot confirm another customer’s hold", async (t) => {
  const h = await harness(t);
  const a = await h.prepare(), b = await h.prepare();
  const held = await h.hold(a, (await h.slots(a))[0].scheduledAt);
  assert.equal((await h.confirm(b, held.data.hold)).status, 409);
});
test("idempotent retries create exactly one appointment", async (t) => {
  const h = await harness(t);
  const token = await h.prepare();
  const held = await h.hold(token, (await h.slots(token))[0].scheduledAt), idempotencyKey = randomUUID();
  const first = await h.confirm(token, held.data.hold, { idempotencyKey });
  const second = await h.confirm(token, held.data.hold, { idempotencyKey });
  assert.equal(first.data.receipt.id, second.data.receipt.id);
  assert.equal((await h.store.appointments()).length, 1);
  assert.equal(h.jobber.jobs.length, 1, "only one Jobber job");
});
test("a new idempotency key still cannot duplicate the same conversation’s booking", async (t) => {
  const h = await harness(t);
  const token = await h.prepare();
  const held = await h.hold(token, (await h.slots(token))[0].scheduledAt);
  const a = await h.confirm(token, held.data.hold), b = await h.confirm(token, held.data.hold);
  assert.equal(a.data.receipt.id, b.data.receipt.id);
  assert.equal((await h.store.appointments()).length, 1);
});
test("quote changes invalidate old final-approval holds", async (t) => {
  const h = await harness(t);
  const token = await h.prepare();
  const held = await h.hold(token, (await h.slots(token))[0].scheduledAt);
  const c = await h.store.config();
  await h.store.set("config", { ...c, version: c.version + 1, cleaningPriceCents: 20900 });
  assert.equal((await h.confirm(token, held.data.hold)).status, 409);
  assert.equal((await h.store.appointments()).length, 0);
});
test("coverage changes invalidate old hold", async (t) => {
  const h = await harness(t);
  const token = await h.prepare();
  const held = await h.hold(token, (await h.slots(token))[0].scheduledAt);
  await h.store.set("config", { ...(await h.store.config()), serviceZips: [] });
  assert.equal((await h.confirm(token, held.data.hold)).status, 409);
});
test("safety report releases a pending hold", async (t) => {
  const h = await harness(t);
  const token = await h.prepare();
  const held = await h.hold(token, (await h.slots(token))[0].scheduledAt);
  await h.chat(token, "I smell gas");
  assert.equal(await h.count("holds"), 0);
  assert.equal((await h.confirm(token, held.data.hold)).status, 409);
});
test("callback request saves to inbox without inventing an appointment", async (t) => {
  const h = await harness(t);
  const token = await h.fresh();
  await h.chat(token, "Request a callback");
  const r = await h.call("/api/requests", { method: "POST", token, body: { ...contact, message: "Please call about my vent.", idempotencyKey: randomUUID() } });
  assert.equal(r.status, 201);
  assert.equal(r.data.request.status, "submitted");
  assert.match(r.data.request.id, /^REQ-/);
  assert.equal((await h.store.requests()).length, 1);
  assert.equal((await h.store.appointments()).length, 0);
});
test("callback retry is idempotent", async (t) => {
  const h = await harness(t);
  const token = await h.fresh(), body = { ...contact, message: "Please call me.", idempotencyKey: randomUUID() };
  const a = await h.call("/api/requests", { method: "POST", token, body });
  const b = await h.call("/api/requests", { method: "POST", token, body });
  assert.equal(a.data.request.id, b.data.request.id);
  assert.equal((await h.store.requests()).length, 1);
});
test("notifications not configured are explicitly recorded", async (t) => {
  const h = await harness(t, { lc: { configured: false }, config: { requirePhoneVerification: false } });
  const r = await h.book();
  assert.match(r.data.receipt.notification, /not been confirmed sent/);
  assert.equal((await h.db.query("select status from bob.events"))[0].status, "not_configured");
});
test("settings use optimistic concurrency", async (t) => {
  const h = await harness(t);
  const cookie = await h.login(), c = await h.store.config();
  const a = await h.call("/api/admin/config", { method: "PATCH", cookie, body: { ...c, cleaningPriceCents: 19900 } });
  const b = await h.call("/api/admin/config", { method: "PATCH", cookie, body: { ...c, cleaningPriceCents: 21900 } });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(b.status, 409);
  assert.equal((await h.store.config()).cleaningPriceCents, 19900);
});
test("bundle price stays fixed even through settings", async (t) => {
  const h = await harness(t);
  const cookie = await h.login();
  const r = await h.call("/api/admin/config", { method: "PATCH", cookie, body: { ...(await h.store.config()), bundlePriceCents: 1 } });
  assert.equal(r.status, 200);
  assert.equal(r.data.config.bundlePriceCents, 24800);
});
test("public cannot edit FAQs", async (t) => {
  const h = await harness(t);
  assert.equal((await h.call("/api/admin/faqs", { method: "POST", body: { faqs: [] } })).status, 401);
});
test("admin can add a verified FAQ", async (t) => {
  const h = await harness(t);
  const cookie = await h.login();
  const r = await h.call("/api/admin/faqs", { method: "POST", cookie, body: { faqs: [{ id: "one", question: "Test question?", answer: "Approved answer.", category: "Service", keywords: ["test question"] }] } });
  assert.equal(r.status, 200);
  assert.equal((await h.store.get("faqs")).length, 1);
});
test("admin can mark a request resolved", async (t) => {
  const h = await harness(t);
  const token = await h.fresh();
  const r = await h.call("/api/requests", { method: "POST", token, body: { ...contact, message: "Please call.", idempotencyKey: randomUUID() } });
  const cookie = await h.login();
  assert.equal((await h.call("/api/admin/requests/" + r.data.request.id, { method: "PATCH", cookie, body: { status: "resolved" } })).status, 200);
  assert.equal((await h.store.requests())[0].status, "resolved");
});
test("admin office booking uses the same schedule checks", async (t) => {
  const h = await harness(t);
  const cookie = await h.login();
  const r = await h.call("/api/admin/appointments", { method: "POST", cookie, body: { ...contact, route: "bundle", scheduledAt: "2026-09-22T16:00:00Z" } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.appointment.price, 238.5, "Premium 1-2-3 by default, plus the assessment at 50% off");
  assert.equal(r.data.appointment.jobber.jobNumber, 101, "office booking lands in Jobber");
  assert.equal((await h.call("/api/admin/appointments", { method: "POST", cookie, body: { ...contact, route: "cleaning", scheduledAt: "2026-09-22T18:00:00Z" } })).status, 409);
});
test("failed reschedule preserves original appointment", async (t) => {
  const h = await harness(t);
  await h.book();
  const cookie = await h.login(), [a] = await h.store.appointments();
  const changed = await h.call("/api/admin/appointments/" + a.id, { method: "PATCH", cookie, body: { revision: a.revision, scheduledAt: "2026-09-27T16:00:00Z" } });
  assert.equal(changed.status, 409);
  assert.equal((await h.store.appointments())[0].scheduledAt, a.scheduledAt);
});
test("a Jobber visit is cancelled in Jobber, not from BOB", async (t) => {
  const h = await harness(t);
  await h.book();
  const cookie = await h.login(), [a] = await h.store.appointments();
  const r = await h.call("/api/admin/appointments/" + a.id, { method: "PATCH", cookie, body: { revision: a.revision, status: "cancelled" } });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /cancel it in Jobber/);
  const done = await h.call("/api/admin/appointments/" + a.id, { method: "PATCH", cookie, body: { revision: a.revision, status: "completed", airflowReadings: { beforeCfm: 40, afterCfm: 130 } } });
  assert.equal(done.status, 200, "status and readings are still tracked in BOB");
});
test("admin cancellation requires current revision", async (t) => {
  const h = await harness(t, { config: { scheduleSource: "BOB" } });
  await h.book();
  const cookie = await h.login(), [a] = await h.store.appointments();
  let r = await h.call("/api/admin/appointments/" + a.id, { method: "PATCH", cookie, body: { revision: 0, status: "cancelled" } });
  assert.equal(r.status, 409);
  r = await h.call("/api/admin/appointments/" + a.id, { method: "PATCH", cookie, body: { revision: 1, status: "cancelled" } });
  assert.equal(r.status, 200);
  assert.equal((await h.store.appointments())[0].status, "cancelled");
});
test("stored records survive a restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "bob-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const h = await harness(t, { dataDir: dir });
  await h.book();
  await h.db.close();
  const db = await createPgliteDb(dir);
  assert.equal((await createStore(db).appointments()).length, 1);
  await db.close();
});
test("reloading a session returns its existing confirmation", async (t) => {
  const h = await harness(t);
  const token = await h.prepare();
  const held = await h.hold(token, (await h.slots(token))[0].scheduledAt);
  const r = await h.confirm(token, held.data.hold);
  const restored = await h.call("/api/session", { token });
  assert.equal(restored.data.receipt.id, r.data.receipt.id);
});
test("admin logout removes access", async (t) => {
  const h = await harness(t);
  const cookie = await h.login();
  await h.call("/api/admin/logout", { method: "POST", cookie, body: {} });
  assert.equal((await h.call("/api/admin/data", { cookie })).status, 401);
});
test("password change invalidates existing sessions", async (t) => {
  const h = await harness(t);
  const cookie = await h.login();
  const r = await h.call("/api/admin/password", { method: "POST", cookie, body: { currentPassword: "Test-only-strong-password-2026", newPassword: "Test-only-new-password-2026" } });
  assert.equal(r.status, 200);
  assert.equal((await h.call("/api/admin/data", { cookie })).status, 401);
});
test("security response headers are present", async (t) => {
  const h = await harness(t);
  const r = await h.call("/api/health");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("cache-control"), "no-store");
  const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  const csp = (src) => vercel.headers.find((x) => x.source === src).headers.find((x) => x.key === "Content-Security-Policy").value;
  assert.match(csp("/(.*)"), /object-src 'none'/);
  assert.match(csp("/admin(.*)"), /frame-ancestors 'none'/);
});
test("office can enter an existing commitment while public booking stays disabled", async (t) => {
  const h = await harness(t);
  const cookie = await h.login();
  await h.store.set("config", { ...(await h.store.config()), bookingEnabled: false });
  const r = await h.call("/api/admin/appointments", { method: "POST", cookie, body: { ...contact, route: "cleaning", scheduledAt: "2026-09-23T16:00:00Z" } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.config.bookingEnabled, false);
});
test("expired conversations use the same clock as session creation", async (t) => {
  const h = await harness(t);
  const token = await h.fresh();
  h.advance(86_400_001);
  assert.equal((await h.call("/api/session", { token })).status, 401);
});

// ---- Jobber scheduling ------------------------------------------------------------

test("a booking becomes a Jobber client, property, job and scheduled visit", async (t) => {
  const h = await harness(t);
  await h.store.set("technicians", [{ id: "tech-ryan", name: "Ryan Boucher", status: "available", jobberUserId: "J-RYAN" }]);
  const r = await h.book("cleaning", { ...contact, email: "test@example.com" });
  assert.equal(r.status, 201);
  const [job] = h.jobber.jobs;
  assert.equal(job.title, "Premium 1-2-3 See-It-Clean");
  assert.deepEqual(job.lineItems.map((i) => [i.name, i.cents]), [["Premium 1-2-3 See-It-Clean", 17900]]);
  assert.equal(job.jobberUserId, "J-RYAN");
  assert.equal(new Date(job.start).toISOString(), r.data.receipt.scheduledAt);
  assert.equal(job.end - job.start, 60 * 60_000, "Premium 1-2-3 1-story is 60 minutes in the catalog");
  assert.match(job.instructions, /Phone verified by text code/);
  assert.match(job.instructions, /Booked by BOB/);
  assert.deepEqual(h.jobber.clients[0].address, { street1: "100 W Test St", city: "Buckeye", zip: "85326" });
  const [a] = await h.store.appointments();
  assert.equal(a.jobber.jobNumber, 101);
  assert.equal(a.status, "confirmed");
});

test("a far-away Jobber visit closes the windows around it (20-minute rule)", async (t) => {
  const h = await harness(t);
  h.jobber.visits.push({ id: "V-far", start: Date.parse("2026-09-22T18:00:00Z"), end: Date.parse("2026-09-22T19:30:00Z"), allDay: false, jobberUserIds: [], address: "900 Far Ave, Surprise, AZ 85374" });
  const token = await h.prepare();
  assert.deepEqual(await h.slots(token, "?date=2026-09-22"), []);
  assert.ok((await h.slots(token, "?date=2026-09-23")).length > 0, "other days unaffected");
});

test("route clustering: a day BOB is already nearby is offered first", async (t) => {
  const h = await harness(t);
  h.jobber.visits.push({ id: "V-near", start: Date.parse("2026-09-24T18:00:00Z"), end: Date.parse("2026-09-24T19:30:00Z"), allDay: false, jobberUserIds: [], address: "200 Near Rd, Buckeye, AZ 85326" });
  const token = await h.prepare();
  const [first] = await h.slots(token);
  assert.equal(first.nearby, true);
  assert.equal(first.scheduledAt.slice(0, 10), "2026-09-24");
});

test("the next customer on the same street is clustered next to the first", async (t) => {
  const h = await harness(t);
  const first = await h.book();
  const neighbor = await h.prepare("cleaning", { ...contact, name: "Next Door", phone: "6235550000", address: "120 W Test St" });
  const [slot] = await h.slots(neighbor);
  assert.equal(slot.nearby, true);
  assert.equal(slot.scheduledAt.slice(0, 10), first.data.receipt.scheduledAt.slice(0, 10));
  assert.notEqual(slot.scheduledAt, first.data.receipt.scheduledAt);
});

test("Jobber job failure leaves nothing booked and the hold intact", async (t) => {
  const h = await harness(t);
  const token = await h.prepare();
  const held = await h.hold(token, (await h.slots(token))[0].scheduledAt);
  h.jobber.failNext = "job";
  const r = await h.confirm(token, held.data.hold);
  assert.equal(r.status, 502);
  assert.deepEqual((await h.store.appointments()).map((a) => a.status), ["failed"], "kept for the record, not active");
  assert.equal(await h.count("holds"), 1);
  const retry = await h.confirm(token, held.data.hold);
  assert.equal(retry.status, 201, "customer can retry while the hold lasts");
});

test("a job created without its visit is kept for the office as action needed", async (t) => {
  const h = await harness(t);
  const token = await h.prepare();
  const held = await h.hold(token, (await h.slots(token))[0].scheduledAt);
  h.jobber.failNext = "visit";
  const r = await h.confirm(token, held.data.hold);
  assert.equal(r.status, 202, "not confirmed: handed to the office");
  assert.equal(r.data.pending, true);
  assert.match(r.data.receipt.notification, /not confirmed yet/);
  const [a] = await h.store.appointments();
  assert.equal(a.status, "action_needed");
  assert.equal(a.jobberState, "visit_failed");
  assert.equal(a.jobber.jobNumber, 101);
  assert.ok(!h.lc.calls.some((c) => c[0] === "sms" || c[0] === "email"), "no confirmation for an unconfirmed visit");
});

test("disconnected Jobber turns online confirmation off instead of guessing", async (t) => {
  const h = await harness(t, { jobber: { connected: false } });
  assert.equal((await h.call("/api/public/config")).data.bookingEnabled, false);
  const token = await h.accept();
  await h.contactAndVerify(token);
  const r = await h.call("/api/availability", { token });
  assert.equal(r.data.enabled, false);
});

test("package, 2-story upstairs home, gas dryer and fogging flow through to the receipt and Jobber", async (t) => {
  const h = await harness(t);
  const token = await h.fresh();
  for (const m of ["Dryer Vent Cleaning", "85326", "Have Dryer", "No", "2-Story", "2nd Floor", "Gas", "Standard", "Takes about 2 cycles", "No signs", "Premium 1-2-3 · $199", "Accept & Continue"]) await h.chat(token, m);
  const r = await h.contactAndVerify(token, { ...contact, addOns: { fogging: true } });
  assert.equal(r.data.quote.totalCents, 19900 + 4900 + 7900);
  assert.equal(r.data.quote.durationMins, 75 + 15 + 15 + 15, "package + gas + fogging + 15 min difficulty for 2-cycle drying");
  const held = await h.hold(token, (await h.slots(token))[0].scheduledAt);
  const done = await h.confirm(token, held.data.hold);
  assert.equal(done.status, 201, JSON.stringify(done.data));
  assert.equal(done.data.receipt.priceCents, 32700);
  assert.deepEqual(h.jobber.jobs[0].lineItems.map((l) => l.name), [
    "Premium 1-2-3 See-It-Clean (2 Story, Upstairs)", "Gas Appliance Safety Procedure", "Sanitation Fogging Add-On",
  ]);
  assert.equal(h.jobber.jobs[0].end - h.jobber.jobs[0].start, 120 * 60_000, "the Jobber visit includes the difficulty time");
});

test("emergency clog relief is offered inside normal notice, but books only after a named approval", async (t) => {
  const h = await harness(t, { config: { emergencyLeadHours: 1, leadHours: 24, approver: { name: "Seth", phone: "6235559999", email: "" } } });
  const token = await h.prepare("emergency");
  const [first] = await h.slots(token);
  assert.ok(Date.parse(first.scheduledAt) - Date.parse("2026-09-21T20:00:00Z") < 24 * 3_600_000, "offered inside the normal 24h notice");
  assert.equal(first.approval, true);
  const held = await h.hold(token, first.scheduledAt);
  assert.equal(held.data.hold.approvalRequired, true);
  const direct = await h.confirm(token, held.data.hold);
  assert.equal(direct.status, 409);
  assert.equal(direct.data.code, "APPROVAL_REQUIRED");
  const asked = await h.call("/api/approvals", { method: "POST", token, body: { holdId: held.data.hold.id, approved: true } });
  assert.equal(asked.status, 201, JSON.stringify(asked.data));
  assert.equal(asked.data.approval.status, "pending");
  assert.equal(asked.data.approval.approverName, "Seth");
  const text = h.lc.calls.find((c) => c[0] === "sms");
  assert.match(text[2], /BOB approval needed/);
  assert.equal(await h.count("appointments"), 0, "nothing is booked while waiting");
  const cookie = await h.login();
  const nameless = await h.call(`/api/admin/approvals/${asked.data.approval.id}`, { method: "POST", cookie, body: { decision: "approve", approverName: "" } });
  assert.equal(nameless.status, 400, "the approver must be named");
  const ok = await h.call(`/api/admin/approvals/${asked.data.approval.id}`, { method: "POST", cookie, body: { decision: "approve", approverName: "Seth" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.result.status, "booked");
  const [a] = await h.store.appointments();
  assert.equal(a.approval.by, "Seth");
  assert.equal(a.status, "confirmed");
  const status = await h.call("/api/approvals/current", { token });
  assert.equal(status.data.approval.status, "booked");
  assert.equal(status.data.receipt.id, a.id);
  assert.equal(h.jobber.jobs.length, 1);
});

test("a declined or expired approval books nothing and frees the time", async (t) => {
  const h = await harness(t, { config: { emergencyLeadHours: 1 } });
  const ask = async () => {
    const token = await h.prepare("emergency");
    const held = await h.hold(token, (await h.slots(token))[0].scheduledAt);
    const r = await h.call("/api/approvals", { method: "POST", token, body: { holdId: held.data.hold.id, approved: true } });
    return { token, id: r.data.approval.id };
  };
  const cookie = await h.login();
  const first = await ask();
  await h.call(`/api/admin/approvals/${first.id}`, { method: "POST", cookie, body: { decision: "decline", approverName: "Seth" } });
  assert.equal((await h.call("/api/approvals/current", { token: first.token })).data.approval.status, "declined");
  assert.equal(await h.count("holds"), 0);
  const second = await ask();
  h.advance(31 * 60_000);
  assert.equal((await h.call("/api/approvals/current", { token: second.token })).data.approval.status, "expired");
  const late = await h.call(`/api/admin/approvals/${second.id}`, { method: "POST", cookie, body: { decision: "approve", approverName: "Seth" } });
  assert.equal(late.status, 409);
  assert.equal(await h.count("appointments"), 0);
});

// ---- geo rules -------------------------------------------------------------------

test("an address beyond the max drive from base is sent to the team", async (t) => {
  const h = await harness(t, { config: { baseAddress: "1 Base Way, Buckeye, AZ 85326", maxDriveFromBaseMin: 30 } });
  const token = await h.accept();
  const r = await h.call("/api/contact", { method: "POST", token, body: { ...contact, address: "50 Edge Blvd" } });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, "OUT_OF_AREA");
});

test("an address that can't be found is rejected with a clear message", async (t) => {
  const h = await harness(t);
  const token = await h.accept();
  const r = await h.call("/api/contact", { method: "POST", token, body: { ...contact, address: "77 Nowhere Ln" } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /couldn't find/);
});

test("travel fee tier is added to the quote, receipt and Jobber line items", async (t) => {
  const h = await harness(t, {
    config: { baseAddress: "1 Base Way, Buckeye, AZ 85326", travelFeeTiers: [{ upToMin: 10, feeCents: 0 }, { upToMin: 60, feeCents: 2500 }] },
  });
  const r = await h.book();
  assert.equal(r.data.receipt.travelFeeCents, 2500);
  assert.equal(r.data.receipt.priceCents, 20400);
  assert.deepEqual(h.jobber.jobs[0].lineItems.map((i) => i.cents), [17900, 2500]);
});

// ---- LeadConnector confirmations ---------------------------------------------------

test("LeadConnector sends a text only with consent, plus an email when given", async (t) => {
  const h = await harness(t);
  const r = await h.book("cleaning", { ...contact, smsConsent: true, email: "test@example.com" });
  const kinds = h.lc.calls.map((c) => c[0]);
  assert.deepEqual(kinds.filter((k) => k !== "note"), ["upsert", "sms", "email"]);
  assert.match(h.lc.calls.find((c) => c[0] === "sms")[2], /Reply STOP/);
  assert.match(r.data.receipt.notification, /confirmation text and a confirmation email/);
  assert.deepEqual(h.lc.calls[0][1].tags, ["bob-booked"]);
});

test("no SMS consent means no text", async (t) => {
  const h = await harness(t);
  const r = await h.book("cleaning", { ...contact, smsConsent: false, email: "test@example.com" });
  assert.ok(!h.lc.calls.some((c) => c[0] === "sms"));
  assert.match(r.data.receipt.notification, /confirmation email/);
});

test("a LeadConnector failure never undoes a confirmed booking", async (t) => {
  const h = await harness(t);
  const token = await h.prepare("cleaning", { ...contact, smsConsent: true });
  h.lc.failSms = true;
  const held = await h.hold(token, (await h.slots(token))[0].scheduledAt);
  const r = await h.confirm(token, held.data.hold);
  assert.equal(r.status, 201);
  const [a] = await h.store.appointments();
  assert.equal(a.status, "confirmed");
  assert.equal(a.notifications.sms, "failed");
});

test("team requests land in LeadConnector with a note", async (t) => {
  const h = await harness(t);
  const token = await h.fresh();
  await h.call("/api/requests", { method: "POST", token, body: { ...contact, message: "Vent cap is loose.", idempotencyKey: randomUUID() } });
  assert.deepEqual(h.lc.calls[0][1].tags, ["bob-request"]);
  assert.match(h.lc.calls.find((c) => c[0] === "note")[2], /Vent cap is loose/);
});

// ---- admin integrations --------------------------------------------------------------

test("Jobber connect requires admin, uses a one-time state, and the callback checks it", async (t) => {
  const h = await harness(t, { jobber: { connected: false } });
  assert.equal((await h.call("/api/admin/jobber/connect")).status, 401);
  const cookie = await h.login();
  const go = await h.call("/api/admin/jobber/connect", { cookie });
  assert.equal(go.status, 302);
  const state = new URL(go.headers.get("location")).searchParams.get("state");
  const bad = await h.call(`/api/jobber/callback?code=x&state=forged`);
  assert.match(bad.headers.get("location"), /jobber=failed/);
  const good = await h.call(`/api/jobber/callback?code=x&state=${state}`);
  assert.match(good.headers.get("location"), /jobber=connected/);
  const replay = await h.call(`/api/jobber/callback?code=x&state=${state}`);
  assert.match(replay.headers.get("location"), /jobber=failed/, "state is single-use");
});

test("technicians can be linked to Jobber users, one Jobber user each", async (t) => {
  const h = await harness(t);
  const cookie = await h.login();
  const users = await h.call("/api/admin/jobber/users", { cookie });
  assert.equal(users.data.users.length, 2);
  const techs = await h.store.technicians();
  const ok = await h.call("/api/admin/technicians", { method: "POST", cookie, body: { technicians: techs.map((t, i) => ({ ...t, jobberUserId: i ? "J-ANDREW" : "J-RYAN" })) } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.technicians[0].jobberUserId, "J-RYAN");
  const dup = await h.call("/api/admin/technicians", { method: "POST", cookie, body: { technicians: techs.map((t) => ({ ...t, jobberUserId: "J-RYAN" })) } });
  assert.equal(dup.status, 400);
});

test("rescheduling a Jobber visit from BOB is refused with a pointer to Jobber", async (t) => {
  const h = await harness(t);
  await h.book();
  const cookie = await h.login(), [a] = await h.store.appointments();
  const r = await h.call("/api/admin/appointments/" + a.id, { method: "PATCH", cookie, body: { revision: a.revision, scheduledAt: "2026-09-23T16:00:00Z" } });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /Jobber/);
});

test("admin geo check reports drive time, fee and ZIP approval", async (t) => {
  const h = await harness(t, { config: { baseAddress: "1 Base Way, Buckeye, AZ 85326", travelFeeTiers: [{ upToMin: 60, feeCents: 1500 }] } });
  const cookie = await h.login();
  const r = await h.call("/api/admin/geo/check", { method: "POST", cookie, body: { address: "100 W Test St, Buckeye, AZ 85326" } });
  assert.equal(r.data.ok, true);
  assert.equal(r.data.travelFeeCents, 1500);
  assert.equal(r.data.zipApproved, true);
  assert.ok(r.data.driveFromBaseMin > 0);
});

// ---- address lookup outages ----------------------------------------------------------
test("an address lookup outage gets a clear, retryable message instead of the generic error", async (t) => {
  const h = await harness(t);
  const token = await h.accept();
  h.geo.geocode = async () => { throw Object.assign(new Error("Address lookup unavailable. Census address lookup returned 502"), { code: "GEO_UNAVAILABLE" }); };
  const r = await h.call("/api/contact", { method: "POST", token, body: contact });
  assert.equal(r.status, 503);
  assert.equal(r.data.code, "ADDRESS_LOOKUP_UNAVAILABLE");
  assert.match(r.data.error, /couldn't check that address just now/);
});
test("a failed drive-time check from the base address doesn't stop the booking", async (t) => {
  const h = await harness(t, { config: { baseAddress: "1 Base Way, Buckeye, AZ 85326" } });
  const token = await h.accept();
  const real = h.geo.geocode;
  h.geo.geocode = async (a) => { if (/Base Way/.test(a)) throw Object.assign(new Error("Address lookup unavailable."), { code: "GEO_UNAVAILABLE" }); return real(a); };
  const r = await h.call("/api/contact", { method: "POST", token, body: contact });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.session.travelFeeCents, 0);
});
test("an unexpected server error is shown to the office in Connections", async (t) => {
  const h = await harness(t);
  const token = await h.accept();
  h.geo.geocode = async () => { throw new Error("Something unexpected"); };
  const r = await h.call("/api/contact", { method: "POST", token, body: contact });
  assert.equal(r.status, 500);
  assert.match(r.data.error, /could not be completed/);
  const data = await h.call("/api/admin/data", { cookie: await h.login() });
  assert.equal(data.data.integrations.lastError.path, "POST /api/contact");
  assert.equal(data.data.integrations.lastError.message, "Something unexpected");
});
