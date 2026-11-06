// The Custom-AIs booking report: one email per confirmed ChatDaddy booking with running counts,
// revenue and commission for the week, month and year (Arizona time).

import test from "node:test";
import assert from "node:assert/strict";
import { bookingTotals, bookingReportEmail, BOOKING_REPORT_TO, COMMISSION_CENTS } from "../server/booking-report.mjs";
import { harness, contact } from "./helpers.mjs";

const appt = (id, createdAt, price, extra = {}) => ({ id, createdAt, price, source: "ai_bot", status: "confirmed", ...extra });

test("counts, revenue and commission follow Arizona weeks (Monday start), months and years", () => {
  assert.equal(BOOKING_REPORT_TO, "bookings@custom-ais.com");
  assert.equal(COMMISSION_CENTS, 1200);
  const list = [
    appt("A", "2026-10-30T18:00:00Z", 179), // Fri Oct 30: last month, same year
    appt("B", "2026-11-02T06:30:00Z", 299), // Sun Nov 1, 11:30 PM Arizona: previous week, this month
    appt("C", "2026-11-03T17:00:00Z", 224), // Tue Nov 3
    appt("X1", "2026-11-03T18:00:00Z", 500, { status: "failed" }),
    appt("X2", "2026-11-03T18:00:00Z", 500, { status: "cancelled" }),
    appt("X3", "2026-11-03T18:00:00Z", 500, { status: "action_needed" }),
    appt("X4", "2026-11-03T18:00:00Z", 500, { source: "office" }),
    appt("D", "2026-11-04T16:00:00Z", 349, { status: "completed" }),
    appt("L", "2026-11-05T16:00:00Z", 179), // booked after the one being reported
    appt("Y", "2025-12-31T20:00:00Z", 179), // last year
  ];
  const t = bookingTotals(list, list.find((a) => a.id === "D"));
  assert.equal(t.weekStart, "2026-11-02");
  assert.deepEqual(t.week, { number: 2, revenueCents: 22400 + 34900, commissionCents: 2400 }, "C and D; B was Sunday night in Arizona");
  assert.deepEqual(t.month, { number: 3, revenueCents: 29900 + 22400 + 34900, commissionCents: 3600 });
  assert.deepEqual(t.year, { number: 4, revenueCents: 17900 + 29900 + 22400 + 34900, commissionCents: 4800 });
  assert.equal(t.jobCents, 34900);
  assert.equal(t.yearLabel, "2026");
  assert.equal(bookingTotals(list, list.find((a) => a.id === "D"), { commissionCents: 1500 }).month.commissionCents, 4500);
});

test("the report email has the counts, commission, revenue, job and customer", () => {
  const a = {
    id: "DVS-TEST1", createdAt: "2026-11-04T16:00:00Z", price: 224, source: "ai_bot", status: "confirmed",
    customerName: "Jane <Doe>", phone: "+16235550100", phoneVerified: true, email: "jane@example.test", address: "19245 W Jackson St", city: "Buckeye", zip: "85326",
    package: "Premium 1-2-3 See-It-Clean", lineItems: [{ name: "Premium 1-2-3 See-It-Clean", cents: 17900 }, { name: "Stacked Washer/Dryer Setup", cents: 4500 }],
    scheduledAt: "2026-11-10T17:00:00Z", durationMins: 75, technicianName: "Ryan", jobber: { jobNumber: 101 },
    property: { stories: "1-story", power: "Electric", mount: "Stacked", symptoms: ["two"] }, concerns: ["Takes forever to dry"], smsConsent: true,
  };
  const totals = { commissionCents: 1200, jobCents: 22400, weekStart: "2026-11-02", yearLabel: "2026", week: { number: 2, revenueCents: 57300, commissionCents: 2400 }, month: { number: 3, revenueCents: 87200, commissionCents: 3600 }, year: { number: 40, revenueCents: 812300, commissionCents: 48000 } };
  const { subject, html, text } = bookingReportEmail(a, totals, { businessName: "Dryer Vent Squad West Valley" });
  assert.equal(subject, "ChatDaddy booking #3 in November: Jane <Doe> · Premium 1-2-3 See-It-Clean ($224)");
  for (const body of [text, html]) {
    assert.match(body, /\$872/, "the month's running revenue");
    assert.match(body, /DVS-TEST1/);
    assert.match(body, /Tuesday, Nov 10, 2026 · 10:00 AM \(arrival window 9:30–10:30 AM\) · Arizona time/);
    assert.match(body, /#101/);
    assert.match(body, /\(623\) 555-0100 \(verified\)/);
    assert.match(body, /Takes about 2 cycles/);
    assert.match(body, /jane@example\.test/);
    assert.match(body, /19245 W Jackson St, Buckeye, AZ 85326/);
    assert.match(body, /Stacked Washer\/Dryer Setup/);
  }
  assert.match(text, /This week \(from Nov 2\): booking #2 · revenue \$573 · commission \$24/);
  assert.match(text, /November: booking #3 · revenue \$872 · commission \$36 \(3 × \$12\)/);
  assert.match(text, /2026: booking #40 · revenue \$8,123 · commission \$480/);
  assert.match(text, /Job value: \$224/);
  assert.match(html, /3 × \$12 = \$36/);
  assert.match(html, /Jane &lt;Doe&gt;/, "customer text is escaped in HTML");
  assert.doesNotMatch(html, /Jane <Doe>/);
});

function mailer() {
  const api = { configured: true, calls: [], async sendEmail(to, message) { api.calls.push({ to, ...message }); return { status: "accepted", messageId: `m-${api.calls.length}` }; } };
  return api;
}
const reports = (sendgrid) => sendgrid.calls.filter((c) => c.to === "bookings@custom-ais.com");

test("every confirmed ChatDaddy booking emails bookings@custom-ais.com once, numbered in order", async (t) => {
  const sendgrid = mailer();
  const h = await harness(t, { sendgrid, env: { BOOKING_EMAIL_PROVIDER: "sendgrid", BOOKING_REPORT_EMAIL: undefined } });
  const first = await h.book("cleaning", { ...contact, email: "one@example.test" });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const second = await h.book("cleaning", { ...contact, name: "Second Customer", email: "two@example.test" });
  assert.equal(second.status, 201, JSON.stringify(second.data));
  const sent = reports(sendgrid);
  assert.equal(sent.length, 2, "the default recipient is bookings@custom-ais.com");
  assert.match(sent[0].subject, /^ChatDaddy booking #1 in /);
  assert.match(sent[1].subject, /^ChatDaddy booking #2 in .*Second Customer/);
  assert.match(sent[1].text, /commission \$24 \(2 × \$12\)/);
  assert.match(sent[1].text, /revenue \$358/, "running revenue: two $179 cleanings");
  const kv = await h.store.kvGet(`email-notification:booking_report:${second.data.receipt.id}`);
  assert.equal(kv.status, "accepted");
});

test("office-entered appointments don't send the report, and BOOKING_REPORT_EMAIL can change or stop it", async (t) => {
  const sendgrid = mailer();
  const h = await harness(t, { sendgrid, env: { BOOKING_EMAIL_PROVIDER: "sendgrid", BOOKING_REPORT_EMAIL: "reports@example.test" } });
  const cookie = await h.login();
  const office = await h.call("/api/admin/appointments", { method: "POST", cookie, body: { ...contact, route: "cleaning", scheduledAt: "2026-09-23T16:00:00Z" } });
  assert.equal(office.status, 201, JSON.stringify(office.data));
  assert.equal(sendgrid.calls.filter((c) => c.to === "reports@example.test").length, 0, "only ChatDaddy bookings are reported");
  assert.equal((await h.book("cleaning")).status, 201);
  assert.equal(sendgrid.calls.filter((c) => c.to === "reports@example.test").length, 1);

  const quiet = mailer();
  const off = await harness(t, { sendgrid: quiet, env: { BOOKING_EMAIL_PROVIDER: "sendgrid", BOOKING_REPORT_EMAIL: "off" } });
  assert.equal((await off.book("cleaning")).status, 201);
  assert.equal(quiet.calls.filter((c) => /ChatDaddy booking/.test(c.subject)).length, 0);
});

test("the report doesn't depend on customer email confirmations, and a booking still succeeds if it fails", async (t) => {
  const sendgrid = mailer();
  const h = await harness(t, { sendgrid, env: { BOOKING_EMAIL_PROVIDER: "sendgrid", BOOKING_REPORT_EMAIL: undefined }, config: { emailConfirmations: false } });
  assert.equal((await h.book("cleaning", { ...contact, email: "customer@example.test" })).status, 201);
  assert.equal(sendgrid.calls.filter((c) => c.to === "customer@example.test").length, 0, "customer emails stay off");
  assert.equal(reports(sendgrid).length, 1);

  const broken = { configured: true, async sendEmail() { throw Object.assign(new Error("down"), { uncertain: true }); } };
  const h2 = await harness(t, { sendgrid: broken, env: { BOOKING_EMAIL_PROVIDER: "sendgrid", BOOKING_REPORT_EMAIL: undefined } });
  const r = await h2.book("cleaning");
  assert.equal(r.status, 201, "a failed report never undoes a booking");
});

test("only the Master Admin can send a test report, and it says whether SendGrid accepted it", async (t) => {
  const { createAdminAuth } = await import("../server/admin-auth.mjs");
  const password = "Synthetic-local-account-password-2026";
  const sendgrid = mailer();
  const h = await harness(t, { sendgrid, env: { BOOKING_EMAIL_PROVIDER: "sendgrid", BOOKING_REPORT_EMAIL: undefined } });
  const legacy = await h.login();
  const auth = createAdminAuth({ store: h.store, clock: h.store.clock });
  const claim = await auth.prepareOwnerBootstrap({ email: "owner@example.test", name: "Synthetic Owner" });
  assert.equal((await h.call("/api/admin/owner-bootstrap/accept", { method: "POST", body: { token: claim.token, password } })).status, 200);
  const login = await h.call("/api/admin/login", { method: "POST", body: { email: "owner@example.test", password } });
  await auth.activateNamedMode({ ownerId: claim.user.id });
  const master = login.cookie;
  const issued = await h.call("/api/admin/users/invite", { method: "POST", cookie: master, body: { email: "office@example.test", name: "Office", permissions: ["appointments.view", "settings.connections.view"] } });
  await h.call("/api/admin/invite/accept", { method: "POST", body: { token: issued.data.token, password } });
  const member = (await h.call("/api/admin/login", { method: "POST", body: { email: "office@example.test", password } })).cookie;

  assert.equal((await h.call("/api/admin/booking-report/test", { method: "POST", cookie: member, body: {} })).status, 403, "office users can't send it");
  assert.equal((await h.call("/api/admin/booking-report/test", { method: "POST", cookie: legacy, body: {} })).status, 401, "the old shared password no longer works once named accounts are on");
  const r = await h.call("/api/admin/booking-report/test", { method: "POST", cookie: master, body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data, { status: "accepted", to: "bookings@custom-ais.com" });
  const [mail] = reports(sendgrid);
  assert.match(mail.subject, /^\[TEST\] ChatDaddy booking #1 in /);
  assert.match(mail.text, /No appointment was booked/);
  assert.equal((await h.store.appointments()).length, 0, "a test books nothing");

  const bare = await harness(t, { env: { BOOKING_REPORT_EMAIL: undefined } });
  const auth2 = createAdminAuth({ store: bare.store, clock: bare.store.clock });
  await bare.login();
  const claim2 = await auth2.prepareOwnerBootstrap({ email: "owner@example.test", name: "Synthetic Owner" });
  await bare.call("/api/admin/owner-bootstrap/accept", { method: "POST", body: { token: claim2.token, password } });
  const login2 = await bare.call("/api/admin/login", { method: "POST", body: { email: "owner@example.test", password } });
  await auth2.activateNamedMode({ ownerId: claim2.user.id });
  const none = await bare.call("/api/admin/booking-report/test", { method: "POST", cookie: login2.cookie, body: {} });
  assert.deepEqual(none.data, { status: "not_configured", to: "bookings@custom-ais.com" }, "no SendGrid: says so instead of pretending");
});
