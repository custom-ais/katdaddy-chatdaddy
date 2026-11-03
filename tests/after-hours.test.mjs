// After-hours emergency service handled in the chat: BOB collects the details, the request goes to the
// client's account admin (email, and a text once the terms and campaign cover it), the customer waits
// in the chat, and the admin accepts with an arrival time or says they can't make it.

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { initialSession, turn } from "../shared/conversation.mjs";
import { DEFAULT_CONFIG, INITIAL_FAQS } from "../shared/domain.mjs";
import { createOwnerConsent } from "../server/owner-consent.mjs";
import { OWNER_SMS_CONSENT_VERSION } from "../shared/owner-sms-consent.mjs";
import { harness, contact, baseTime } from "./helpers.mjs";

const config = { ...DEFAULT_CONFIG, serviceZips: ["85326"], pricesAcknowledged: true };
const run = (steps, s = initialSession()) => { let r; for (const m of steps) { r = turn(m, s, config, INITIAL_FAQS); s = r.session; } return r; };
const emergency = ["Emergency Clog / Overheating", "No, it's turned off now", "Possible nest or blockage", "85326", "1-Story Home", "Electric Dryer"];
const ownerPhone = "6235550100";
const sendgrid = () => ({ configured: true, calls: [], async sendEmail(to, m) { this.calls.push({ to, ...m }); return { status: "accepted", messageId: "sg-1" }; } });

test("BOB takes the after-hours request in the chat: the premium, any missing question, then the customer's details", () => {
  const r = run([...emergency, "Check after-hours availability"]);
  assert.match(r.reply, /^Okay, I'll check with our on-call technician\. The after-hours premium is \$199 on top of Ultimate Protection \(\$299\)\./);
  assert.equal(r.session.afterHours, true);
  assert.equal(r.session.package, "ultimate");
  assert.notEqual(r.action, "request", "no request form");
  const details = run(["Standard Floor Setup"], r.session);
  assert.equal(details.action, "contact");
  assert.match(details.reply, /Your after-hours request is ready: \*\*Ultimate Protection\*\* at \*\*\$299\*\*, plus the \*\*\$199\*\* after-hours premium\..*send it straight to our on-call technician\. Nothing is booked until they confirm\./s);
});

test("asking for something sooner at the times step turns on after-hours there; keeping regular times turns it off", () => {
  const accepted = run([...emergency, "Premium 1-2-3 · $179", "Standard Floor Setup", "Accept"]).session;
  const yes = run(["Check after-hours availability"], { ...accepted, stage: "slots" });
  assert.equal(yes.action, "resume");
  assert.equal(yes.session.afterHours, true);
  assert.equal(yes.session.stage, "slots");
  assert.match(yes.reply, /\$199 on top of Premium.*Review the request below and send it when you're ready\./s);
  assert.equal(run(["Keep regular times"], yes.session).session.afterHours, false);
});

async function afterHoursChat(h) {
  const token = await h.fresh();
  let r;
  for (const m of [...emergency, "Check after-hours availability", "Standard Floor Setup"]) r = await h.chat(token, m);
  assert.equal(r.action, "contact", r.reply);
  await h.contactAndVerify(token, { ...contact, email: "jane@example.test" });
  return token;
}

test("the request goes to the account admin, the customer waits, and accepting books it with the premium", async (t) => {
  const mail = sendgrid();
  const h = await harness(t, { sendgrid: mail, env: { BOOKING_EMAIL_PROVIDER: "sendgrid" }, config: { pricesAcknowledged: true, approver: { name: "Seth", phone: "", email: "oncall@example.test" } } });
  const token = await afterHoursChat(h);

  const summary = await h.call("/api/approvals/after-hours", { token });
  assert.equal(summary.status, 200, JSON.stringify(summary.data));
  assert.deepEqual(summary.data.quote.lineItems.map((l) => [l.name, l.cents]), [["Ultimate Protection", 29900], ["After-Hours Emergency Service", 19900]]);
  assert.equal(summary.data.quote.totalCents, 49800);

  assert.equal((await h.call("/api/approvals/after-hours", { method: "POST", token, body: {} })).status, 400, "the customer approves the summary first");
  const sent = await h.call("/api/approvals/after-hours", { method: "POST", token, body: { approved: true } });
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  assert.equal(sent.data.approval.kind, "after_hours");
  assert.equal(sent.data.approval.status, "pending");
  assert.equal(sent.data.approval.scheduledAt, null);
  const again = await h.call("/api/approvals/after-hours", { method: "POST", token, body: { approved: true } });
  assert.equal(again.data.approval.id, sent.data.approval.id, "a second tap doesn't send a second request");

  const email = mail.calls.find((c) => c.to === "oncall@example.test");
  assert.ok(email, "the approver is emailed");
  assert.match(email.subject, /^After-hours emergency request: Booking Test · Ultimate Protection \+ after-hours$/);
  assert.match(email.text, /Total: \$498\n/);
  assert.match(email.text, /\/admin\?approval=APR-/);
  assert.equal(h.twilio.calls.filter((c) => c[0] === "sms").length, 0, "no text until after-hours texts are turned on");
  const saved = await h.store.approval(sent.data.approval.id);
  assert.equal(saved.notified.smsReason, "emergency_texts_off");

  const cookie = await h.login();
  const arrivalAt = baseTime + 6 * 3600_000; // 7:00 PM Arizona
  const noTime = await h.call(`/api/admin/approvals/${saved.id}`, { method: "POST", cookie, body: { decision: "approve", approverName: "Seth", technicianId: "tech-ryan" } });
  assert.equal(noTime.status, 400);
  assert.match(noTime.data.error, /arrival time/);
  const ok = await h.call(`/api/admin/approvals/${saved.id}`, { method: "POST", cookie, body: { decision: "approve", approverName: "Seth", arrivalAt, technicianId: "tech-ryan" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.result.status, "booked", JSON.stringify(ok.data.result));

  const appt = await h.store.appointment(ok.data.result.appointmentId);
  assert.equal(appt.afterHours, true);
  assert.equal(appt.scheduledAt, new Date(arrivalAt).toISOString());
  assert.equal(appt.technicianId, "tech-ryan");
  assert.equal(appt.price, 498);
  assert.ok(appt.lineItems.some((l) => l.id === "addon-afterhours" && l.cents === 19900));
  const job = h.jobber.jobs.at(-1);
  assert.ok(job, "booked into Jobber");
  assert.match(job.instructions, /AFTER-HOURS EMERGENCY VISIT/);
  assert.equal(job.jobberUserId, "J-RYAN");

  const current = await h.call("/api/approvals/current", { token });
  assert.equal(current.data.approval.status, "booked");
  assert.equal(current.data.receipt.id, appt.id, "the customer's chat shows the confirmation");
});

test("can't make it, no answer, or the customer cancels: back to regular openings for the same service", async (t) => {
  const h = await harness(t, { config: { pricesAcknowledged: true } });
  const cookie = await h.login();

  const declined = await afterHoursChat(h);
  const a = (await h.call("/api/approvals/after-hours", { method: "POST", token: declined, body: { approved: true } })).data.approval;
  assert.equal((await h.call(`/api/admin/approvals/${a.id}`, { method: "POST", cookie, body: { decision: "decline", approverName: "Seth" } })).status, 200);
  assert.equal((await h.call("/api/approvals/current", { token: declined })).data.approval.status, "declined");
  const back = await h.call("/api/approvals/current/cancel", { method: "POST", token: declined, body: {} });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.equal(back.data.action, "slots");
  assert.equal(back.data.session.stage, "slots");
  assert.equal(back.data.session.afterHours, false);
  assert.match(back.data.reply, /^I'm sorry, our on-call technician can't make it tonight\. Here are our soonest regular openings for \*\*Ultimate Protection\*\*\./);
  const slots = await h.slots(declined);
  assert.ok(slots.length > 0, "regular times load");

  const cancelled = await afterHoursChat(h);
  await h.call("/api/approvals/after-hours", { method: "POST", token: cancelled, body: { approved: true } });
  const mine = await h.call("/api/approvals/current/cancel", { method: "POST", token: cancelled, body: {} });
  assert.match(mine.data.reply, /^Okay, I cancelled the after-hours request\./);

  const quiet = await afterHoursChat(h);
  const q = (await h.call("/api/approvals/after-hours", { method: "POST", token: quiet, body: { approved: true } })).data.approval;
  h.advance(31 * 60_000);
  assert.equal((await h.call("/api/approvals/current", { token: quiet })).data.approval.status, "expired");
  const late = await h.call("/api/approvals/current/cancel", { method: "POST", token: quiet, body: {} });
  assert.match(late.data.reply, /didn't answer in time/);
  const stale = await h.call(`/api/admin/approvals/${q.id}`, { method: "POST", cookie, body: { decision: "approve", approverName: "Seth", arrivalAt: baseTime + 7 * 3600_000, technicianId: "tech-ryan" } });
  assert.equal(stale.status, 409, "an expired request can't be accepted");
});

test("the account admin gets a text only with after-hours texts on and consent on the current terms", async (t) => {
  const h = await harness(t, { env: { SMS_OWNER_ALERTS_ONLY: "true", SMS_EMERGENCY_REQUESTS: "true" }, config: { pricesAcknowledged: true, bookingOwnerSmsPhone: ownerPhone, bookingOwnerSmsEnabled: true } });
  const consent = createOwnerConsent({ store: h.store, clock: h.store.clock });
  // Consent on the older (v2) terms: booking alerts yes, after-hours requests no.
  await h.store.kvSet("owner-sms-consent:current", { id: "r-v2", revision: 1, action: "grant", active: true, phone: "+16235550100", at: new Date(baseTime).toISOString(), disclosureVersion: "custom-ais-owner-alerts-v2", purposes: ["booking_success", "actionable_operational_failures"] });
  assert.equal(await consent.allows(ownerPhone), true, "v2 still covers booking alerts");
  assert.equal(await consent.allows(ownerPhone, "after_hours_emergency_requests"), false);
  assert.equal((await consent.snapshot()).effectiveActive, true);

  const first = await afterHoursChat(h);
  const a1 = (await h.call("/api/approvals/after-hours", { method: "POST", token: first, body: { approved: true } })).data.approval;
  assert.equal(h.twilio.calls.filter((c) => c[0] === "sms").length, 0);
  assert.equal((await h.store.approval(a1.id)).notified.smsReason, "owner_consent_required");

  await consent.record({ action: "grant", revision: 1, phone: ownerPhone, consent: true, disclosureVersion: OWNER_SMS_CONSENT_VERSION, idempotencyKey: randomUUID() }, "synthetic-owner-session");
  const second = await afterHoursChat(h);
  const a2 = (await h.call("/api/approvals/after-hours", { method: "POST", token: second, body: { approved: true } })).data.approval;
  const texts = h.twilio.calls.filter((c) => c[0] === "sms");
  assert.equal(texts.length, 1);
  assert.equal(texts[0][1], "+16235550100");
  assert.match(texts[0][2], /^Custom-AIs ChatDaddy alert: after-hours emergency request from Booking in Buckeye 85326: Ultimate Protection \+ after-hours \(\$498 total\)\. They're waiting in the chat\. Accept with an arrival time or decline: \S+\/admin\?approval=APR-\S+ Reply STOP to opt out\.$/);
  assert.doesNotMatch(texts[0][2], /555|Main St/, "no customer phone or street in the text");
  assert.equal((await h.store.approval(a2.id)).notified.sms, "sent");
});
