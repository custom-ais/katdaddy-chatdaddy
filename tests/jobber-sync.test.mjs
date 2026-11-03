// Jobber tracking: cancellations, moves, completions and invoices flow back into BOB, cancelled
// ChatDaddy bookings drop out of billing, and the operator is told.

import test from "node:test";
import assert from "node:assert/strict";
import { harness, contact, baseTime } from "./helpers.mjs";
import { billingSummary, syncJobber, VALUES_KEY } from "../server/jobber-sync.mjs";
import { revenuePace } from "../server/revenue-pace.mjs";

const mailer = () => ({ configured: true, calls: [], async sendEmail(to, m) { this.calls.push({ to, ...m }); return { status: "accepted", messageId: `m${this.calls.length}` }; } });

async function masterCookie(h) {
  const { createAdminAuth } = await import("../server/admin-auth.mjs");
  const password = "Synthetic-local-account-password-2026";
  const auth = createAdminAuth({ store: h.store, clock: h.store.clock });
  const claim = await auth.prepareOwnerBootstrap({ email: "owner@example.test", name: "Synthetic Owner" });
  assert.equal((await h.call("/api/admin/owner-bootstrap/accept", { method: "POST", body: { token: claim.token, password } })).status, 200);
  const login = await h.call("/api/admin/login", { method: "POST", body: { email: "owner@example.test", password } });
  await auth.activateNamedMode({ ownerId: claim.user.id });
  return login.cookie;
}
async function bookOne(h, who = contact) {
  const r = await h.book("cleaning", who);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return (await h.store.appointments()).find((a) => a.id === (r.data.receipt?.id || r.data.appointment?.id)) || (await h.store.appointments())[0];
}

test("a booking whose Jobber visit is gone is cancelled, freed, left out of billing, and the operator is told", async (t) => {
  const mail = mailer();
  const h = await harness(t, { sendgrid: mail, env: { BOOKING_EMAIL_PROVIDER: "sendgrid", BOOKING_REPORT_EMAIL: "ops@example.test" } });
  const keep = await bookOne(h);
  const drop = await bookOne(h, { ...contact, name: "Second Customer", phone: "6235550188" });
  assert.ok(keep.jobber?.visitId && drop.jobber?.visitId, "both are in Jobber");
  h.jobber.visits = h.jobber.visits.filter((v) => v.id !== drop.jobber.visitId); // the office deleted the visit

  const cookie = await masterCookie(h);
  const r = await h.call("/api/admin/jobber/sync", { method: "POST", cookie, body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.sync.cancelled, [drop.id]);
  const after = await h.store.appointment(drop.id);
  assert.equal(after.status, "cancelled");
  assert.equal(after.cancelledBy, "jobber");
  assert.equal((await h.store.appointment(keep.id)).status, "confirmed");
  const freed = await h.store.activeAppointments(Date.parse(after.scheduledAt) - 1, Date.parse(after.scheduledAt) + 1);
  assert.ok(!freed.some((a) => a.id === drop.id), "its time is free again");

  const notice = mail.calls.find((c) => /cancelled in Jobber/.test(c.subject));
  assert.ok(notice, "the operator gets a cancellation email");
  assert.equal(notice.to, "ops@example.test");
  assert.match(notice.text, /not billable/);
  assert.match(notice.text, /1 billable × \$12 = \$12 · 1 cancelled of 2 booked/);
  await h.call("/api/admin/jobber/sync", { method: "POST", cookie, body: {} });
  assert.equal(mail.calls.filter((c) => /cancelled in Jobber/.test(c.subject)).length, 1, "only once");

  const billing = await h.call("/api/admin/billing", { cookie });
  assert.equal(billing.status, 200, JSON.stringify(billing.data));
  const month = billing.data.billing.find((b) => b.booked === 2) || billing.data.billing[0];
  assert.equal(month.billable, 1);
  assert.equal(month.cancelled, 1);
  assert.equal(month.billableCents, 1200);
  assert.equal(month.cancelledList[0].by, "jobber");
  assert.ok(billing.data.sync?.at, "and the last sync");

  // The revenue-target preview is a nested answer too: a named Master Admin gets it in full.
  const pace = await h.call("/api/admin/revenue-pace?period=month&target=1000000", { cookie });
  assert.equal(pace.status, 200, JSON.stringify(pace.data));
  assert.equal(pace.data.pace.weeklyTargetCents, 250000);
  assert.equal(pace.data.pace.weeks.length, 3);
});

test("a visit that comes back restores the booking; a moved visit moves it; a completed visit completes it; invoices attach", async (t) => {
  const h = await harness(t);
  const appt = await bookOne(h);
  const visit = h.jobber.visits.find((v) => v.id === appt.jobber.visitId);
  const hidden = h.jobber.visits.splice(h.jobber.visits.indexOf(visit), 1)[0];
  const run = () => syncJobber({ store: h.store, jobber: h.jobber, now: baseTime, horizonDays: 45 });
  await h.store.appointment(appt.id);
  // Two other bookings keep the "most bookings missing" guard from holding the cancellation.
  await bookOne(h, { ...contact, name: "Other One", phone: "6235550111" });
  await bookOne(h, { ...contact, name: "Other Two", phone: "6235550122" });
  assert.deepEqual((await run()).cancelled, [appt.id]);

  h.jobber.visits.push({ ...hidden, start: hidden.start + 86_400_000, end: hidden.end + 86_400_000 });
  const back = await run();
  assert.deepEqual(back.restored, [appt.id]);
  assert.deepEqual(back.rescheduled, [appt.id]);
  const moved = await h.store.appointment(appt.id);
  assert.equal(moved.status, "confirmed");
  assert.equal(Date.parse(moved.scheduledAt), hidden.start + 86_400_000);
  assert.equal(Date.parse(moved.rescheduledFrom), hidden.start);

  h.jobber.visits.find((v) => v.id === appt.jobber.visitId).complete = true;
  h.jobber.invoices.push({ id: "INV1", number: "1001", status: "awaiting_payment", issuedAt: baseTime - 3_600_000, totalCents: 17900, jobId: appt.jobber.jobId, jobNumber: appt.jobber.jobNumber });
  h.jobber.invoices.push({ id: "INV2", number: "1002", status: "voided", issuedAt: baseTime - 3_600_000, totalCents: 99900, jobId: appt.jobber.jobId });
  const done = await run();
  assert.deepEqual(done.completed, [appt.id]);
  const finished = await h.store.appointment(appt.id);
  assert.equal(finished.status, "completed");
  assert.deepEqual({ ...finished.invoice, issuedAt: undefined }, { number: "1001", status: "awaiting_payment", issuedAt: undefined, totalCents: 17900 }, "voided invoices don't count");
  assert.equal(done.invoices.thisMonth.totalCents + done.invoices.lastMonth.totalCents, 17900);
});

test("if most bookings vanish from Jobber at once (wrong account, partial list), nothing is cancelled", async (t) => {
  const h = await harness(t);
  for (const [i, phone] of ["6235550101", "6235550102", "6235550103"].entries()) await bookOne(h, { ...contact, name: `Customer ${i}`, phone });
  h.jobber.visits = [];
  const r = await syncJobber({ store: h.store, jobber: h.jobber, now: baseTime, horizonDays: 45 });
  assert.deepEqual(r.cancelled, []);
  assert.equal(r.held.missing, 3);
  assert.ok((await h.store.appointments()).every((a) => a.status === "confirmed"));
});

test("billing counts BOB's bookings by visit month: cancelled and still-unresolved ones aren't billable", () => {
  const now = Date.parse("2026-11-15T12:00:00-07:00");
  const a = (id, status, day, extra = {}) => ({ id, status, source: "ai_bot", scheduledAt: `2026-11-${day}T16:00:00Z`, customerName: id, ...extra });
  const b = billingSummary([a("A", "confirmed", "03"), a("B", "completed", "04", { invoice: { totalCents: 29900 } }), a("C", "cancelled", "05", { cancelledBy: "jobber" }), a("D", "action_needed", "06"), { ...a("E", "confirmed", "07"), source: "office" }, a("F", "confirmed", "20")], { now, commissionCents: 1200 });
  assert.equal(b.month, "November 2026");
  assert.deepEqual([b.booked, b.billable, b.cancelled, b.pending, b.completed], [5, 3, 1, 1, 1]);
  assert.equal(b.billableCents, 3600);
  assert.equal(b.invoicedCents, 29900);
});

test("revenue pacing counts office-booked Jobber jobs at their real value after a sync", () => {
  const now = Date.parse("2026-09-21T13:00:00-07:00");
  const visits = [{ id: "V9", start: Date.parse("2026-09-22T16:00:00Z") }];
  const pacing = { enabled: true, period: "week", targetCents: 250000, outsideJobCents: 0 };
  assert.equal(revenuePace({ visits, values: { V9: 45000 }, pacing, now }).weeks[0].bookedCents, 45000);
  assert.equal(revenuePace({ visits, pacing, now }).weeks[0].bookedCents, 20000, "without a value: the default job");
  assert.equal(typeof VALUES_KEY, "string");
});

test("the daily cron runs the sync only with the cron secret", async (t) => {
  const h = await harness(t, { env: { CRON_SECRET: "test-cron-secret-1234" } });
  assert.equal((await h.call("/api/cron/jobber-sync")).status, 401);
  assert.equal((await h.call("/api/cron/jobber-sync", { headers: { Authorization: "Bearer wrong-secret-12345678" } })).status, 401);
  const ok = await h.call("/api/cron/jobber-sync", { headers: { Authorization: "Bearer test-cron-secret-1234" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.ok, true);
  const closed = await harness(t);
  assert.equal((await closed.call("/api/cron/jobber-sync", { headers: { Authorization: "Bearer " } })).status, 401, "no secret configured: closed");
});
