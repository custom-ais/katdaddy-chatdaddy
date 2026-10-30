// Rulebook (Oct 20 architecture) and scheduling-workbook rules, end to end through the API.

import test from "node:test";
import assert from "node:assert/strict";
import { harness, contact } from "./helpers.mjs";
import { routeScore } from "../server/route-score.mjs";
import { territoryFor, WEST_VALLEY_ZIPS } from "../shared/territory.mjs";
import { candidateStarts } from "../server/schedule-rules.mjs";
import { DEFAULT_CONFIG } from "../shared/domain.mjs";

// ---- phone verification --------------------------------------------------------------

test("times stay locked until the customer enters the text code", async (t) => {
  const h = await harness(t);
  const token = await h.accept();
  const r = await h.call("/api/contact", { method: "POST", token, body: contact });
  assert.equal(r.data.verification.sent, true);
  assert.equal(r.data.verification.to, "(•••) •••-1234");
  assert.equal(r.data.session.stage, "verify");
  assert.ok(!JSON.stringify(r.data).includes(h.lastCode()), "the code is never sent back to the page");
  const early = await h.call("/api/availability", { token });
  assert.equal(early.status, 409);
  const wrong = await h.call("/api/verify/check", { method: "POST", token, body: { code: "000000" === h.lastCode() ? "111111" : "000000" } });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error, /4 tries left/);
  const ok = await h.call("/api/verify/check", { method: "POST", token, body: { code: h.lastCode() } });
  assert.equal(ok.status, 200);
  assert.equal((await h.call("/api/availability", { token })).status, 200);
});

test("a code can't be reused, guessed forever, or carried over to a new phone number", async (t) => {
  const h = await harness(t);
  const token = await h.accept();
  await h.call("/api/contact", { method: "POST", token, body: contact });
  const code = h.lastCode();
  for (let i = 0; i < 5; i++) await h.call("/api/verify/check", { method: "POST", token, body: { code: code === "999999" ? "888888" : "999999" } });
  assert.equal((await h.call("/api/verify/check", { method: "POST", token, body: { code } })).status, 429, "locked after five wrong tries");
  h.advance(31_000);
  await h.call("/api/verify/send", { method: "POST", token, body: {} });
  assert.equal((await h.call("/api/verify/check", { method: "POST", token, body: { code: h.lastCode() } })).status, 200);
  assert.equal((await h.call("/api/verify/check", { method: "POST", token, body: { code: h.lastCode() } })).status, 409, "single use");
  const changed = await h.call("/api/contact", { method: "POST", token, body: { ...contact, phone: "6235550000" } });
  assert.equal(changed.data.session.stage, "verify", "a new phone number needs its own code");
  assert.equal((await h.call("/api/availability", { token })).status, 409);
});

test("codes expire after ten minutes", async (t) => {
  const h = await harness(t);
  const token = await h.accept();
  await h.call("/api/contact", { method: "POST", token, body: contact });
  h.advance(10 * 60_000 + 1);
  assert.equal((await h.call("/api/verify/check", { method: "POST", token, body: { code: h.lastCode() } })).status, 410);
});

test("with verification required and no LeadConnector, online booking turns itself off", async (t) => {
  const h = await harness(t, { lc: { configured: false } });
  assert.equal((await h.call("/api/public/config")).data.bookingEnabled, false);
});

// ---- uncertain Jobber results ----------------------------------------------------------

test("a Jobber timeout is held for the office: not confirmed, not retried, time stays protected", async (t) => {
  const h = await harness(t);
  const token = await h.prepare("cleaning", { ...contact, smsConsent: true });
  const slot = (await h.slots(token))[0].scheduledAt;
  const held = await h.hold(token, slot);
  h.jobber.failNext = "timeout";
  const r = await h.confirm(token, held.data.hold);
  assert.equal(r.status, 202);
  assert.equal(r.data.receipt.status, "action_needed");
  const again = await h.confirm(token, held.data.hold);
  assert.equal(again.data.receipt.id, r.data.receipt.id, "a retry returns the same pending visit");
  assert.equal(h.jobber.jobs.length, 0);
  assert.ok(!h.lc.calls.some((c) => c[0] === "sms"), "no confirmation text");
  const other = await h.prepare("cleaning", { ...contact, name: "Second Person", phone: "6235550001" });
  assert.ok(!(await h.slots(other)).some((s) => s.scheduledAt === slot), "the uncertain time isn't offered again");

  const cookie = await h.login();
  const [a] = await h.store.appointments();
  assert.equal(a.jobberState, "uncertain");
  const missing = await h.call(`/api/admin/appointments/${a.id}/resolve`, { method: "POST", cookie, body: { outcome: "in_jobber" } });
  assert.equal(missing.status, 400, "the office must give the Jobber job number it found");
  const found = await h.call(`/api/admin/appointments/${a.id}/resolve`, { method: "POST", cookie, body: { outcome: "in_jobber", jobNumber: "4521" } });
  assert.equal(found.status, 200);
  const [done] = await h.store.appointments().then((x) => x.filter((y) => y.id === a.id));
  assert.equal(done.status, "confirmed");
  assert.equal(done.jobber.jobNumber, 4521);
  assert.ok(h.lc.calls.some((c) => c[0] === "sms"), "confirmation goes out once the office confirms it");
});

test("an uncertain visit the office can't find in Jobber is released", async (t) => {
  const h = await harness(t);
  const token = await h.prepare();
  const held = await h.hold(token, (await h.slots(token))[0].scheduledAt);
  h.jobber.failNext = "timeout";
  await h.confirm(token, held.data.hold);
  const cookie = await h.login(), [a] = await h.store.appointments();
  await h.call(`/api/admin/appointments/${a.id}/resolve`, { method: "POST", cookie, body: { outcome: "not_in_jobber" } });
  assert.equal((await h.store.appointments())[0].status, "failed");
});

// ---- FAQs ---------------------------------------------------------------------------------

test("draft FAQs stay off the public page and out of the bot until approved", async (t) => {
  const h = await harness(t);
  const pub = await h.call("/api/public/config");
  assert.ok(!pub.data.faqs.some((f) => /warranty/i.test(f.question)));
  const cookie = await h.login();
  const faqs = await h.store.get("faqs");
  const r = await h.call("/api/admin/faqs", { method: "POST", cookie, body: { faqs: faqs.map((f) => (f.id === "faq-28" ? { ...f, status: "approved" } : f)) } });
  assert.equal(r.status, 200);
  assert.ok((await h.call("/api/public/config")).data.faqs.some((f) => /warranty/i.test(f.question)));
  const bad = await h.call("/api/admin/faqs", { method: "POST", cookie, body: { faqs: [{ ...faqs[0], status: "maybe" }] } });
  assert.equal(bad.status, 400);
});

// ---- route scoring, same-day and 5 PM overflow (scheduling workbook) ---------------------

test("territory map covers the West Valley ZIPs with zones and micro-zones", () => {
  assert.ok(WEST_VALLEY_ZIPS.includes("85326") && WEST_VALLEY_ZIPS.includes("85374") && WEST_VALLEY_ZIPS.includes("85396"));
  assert.ok(!WEST_VALLEY_ZIPS.includes("85251"), "Scottsdale is not West Valley");
  assert.equal(territoryFor("85396", "Verrado").micro, "WV-VERRADO");
  assert.equal(territoryFor("85374").zone, 5);
  assert.equal(territoryFor("90210"), null);
});

test("route score: same micro-zone and a close neighbor beat an isolated stop across zones", () => {
  const at = (h) => Date.parse(`2026-09-22T${String(h + 7).padStart(2, "0")}:00:00Z`);
  const job = { start: at(9), end: at(10), location: { lat: 33.4, lng: -112.58 }, zip: "85326" };
  const near = routeScore({ candidate: { start: at(11), end: at(12) }, jobs: [job], place: { location: { lat: 33.405, lng: -112.585 }, zip: "85326" } });
  const far = routeScore({ candidate: { start: at(11), end: at(12) }, jobs: [job], place: { location: { lat: 33.64, lng: -112.36 }, zip: "85374" } });
  assert.ok(near.parts.some(([l]) => l === "Same micro-zone"));
  assert.ok(near.parts.some(([l]) => l === "Midday stack"));
  assert.ok(far.parts.some(([l]) => /Isolated stop/.test(l)));
  assert.ok(far.parts.some(([l]) => l === "New zone before 1 PM"));
  assert.ok(near.score > far.score + 30);
});

test("the best route fit is offered first and flagged", async (t) => {
  const h = await harness(t);
  h.jobber.visits.push({ id: "V-near", start: Date.parse("2026-09-25T16:00:00Z"), end: Date.parse("2026-09-25T17:30:00Z"), allDay: false, jobberUserIds: [], address: "200 Near Rd, Buckeye, AZ 85326" });
  const token = await h.prepare();
  const [first] = await h.slots(token);
  assert.equal(first.scheduledAt.slice(0, 10), "2026-09-25");
  assert.equal(first.bestFit, true);
});

test("same-day and 5 PM lanes are off by default", () => {
  const now = Date.parse("2026-09-22T15:00:00Z"); // 8 AM Arizona
  const starts = candidateStarts({ config: DEFAULT_CONFIG, durationMins: 60, now, ticketCents: 50000 });
  assert.ok(!starts.some((s) => s.sameDay || s.overflow));
});

test("same-day: only before the cutoff, with short notice, next to a booked job", async (t) => {
  const h = await harness(t, { config: { sameDay: { enabled: true, cutoffHour: 15, minNoticeHours: 2, requireNearby: true } } });
  h.advance(Date.parse("2026-09-22T15:00:00Z") - Date.parse("2026-09-21T20:00:00Z")); // Tue 8 AM Arizona
  h.jobber.visits.push({ id: "V-today", start: Date.parse("2026-09-22T16:00:00Z"), end: Date.parse("2026-09-22T17:00:00Z"), allDay: false, jobberUserIds: [], address: "200 Near Rd, Buckeye, AZ 85326" });
  const token = await h.prepare();
  const today = await h.slots(token, "?date=2026-09-22");
  assert.ok(today.length > 0 && today.every((s) => s.sameDay));
  const far = await h.prepare("cleaning", { ...contact, name: "Far Away", phone: "6235550002", address: "50 Edge Blvd" });
  assert.deepEqual(await h.slots(far, "?date=2026-09-22"), [], "not next to the booked job, so no same-day");
});

test("5 PM overflow: short, nearby, high enough ticket — and it needs approval", async (t) => {
  const h = await harness(t, {
    config: { overflow: { enabled: true, start: "17:00", maxDurationMins: 90, minTicketCents: 22000, requireNearby: true }, approver: { name: "Ryan", phone: "", email: "" } },
  });
  h.jobber.visits.push({ id: "V-pm", start: Date.parse("2026-09-23T22:00:00Z"), end: Date.parse("2026-09-23T23:30:00Z"), allDay: false, jobberUserIds: [], address: "200 Near Rd, Buckeye, AZ 85326" });
  // Premium 1-2-3 1-story is $179: under the $220 ticket rule, so no 5 PM.
  const cheap = await h.prepare();
  assert.ok(![...(await h.slots(cheap, "?date=2026-09-23")), ...(await h.slots(cheap, "?date=2026-09-23&cursor=3"))].some((s) => s.overflow));
  // Ultimate 1-story is 120 minutes and the cleaning + assessment visit is 120 minutes → too long.
  // Use Premium 1-2-3 1-story with a gas dryer and normal drying: $179 + $49 = $228, 75 minutes
  // (2-cycle drying would add 15 minutes of difficulty time).
  const token = await h.fresh();
  for (const m of ["Dryer Vent Cleaning", "85326", "Have Dryer", "No", "1-Story", "Gas", "Standard", "Dries in one normal cycle", "No signs", "Premium 1-2-3 · $228", "Accept & Continue"]) await h.chat(token, m);
  await h.contactAndVerify(token);
  const day = [...(await h.slots(token, "?date=2026-09-23")), ...(await h.slots(token, "?date=2026-09-23&cursor=3"))];
  const pm = day.find((s) => s.overflow);
  assert.ok(pm, JSON.stringify(day));
  assert.equal(pm.scheduledAt, "2026-09-24T00:00:00.000Z");
  assert.equal(pm.approval, true);
  const held = await h.hold(token, pm.scheduledAt);
  assert.equal(held.data.hold.approvalRequired, true);
  assert.equal((await h.confirm(token, held.data.hold)).data.code, "APPROVAL_REQUIRED");
});
