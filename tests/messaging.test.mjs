// Texts and emails through Twilio: routing, phone codes, confirmations, office alerts,
// Twilio webhooks (delivery status and replies), day-before reminders, and the admin test send.

import test from "node:test";
import assert from "node:assert/strict";
import { harness, contact, fakeSid } from "./helpers.mjs";

const OFFICE = { phone: "6235550199", email: "office@example.com", bookings: true, requests: true, problems: true, replies: true };
const customer = { ...contact, smsConsent: true, email: "jane@example.com" };

/** Book the first opening on a given Arizona date (YYYY-MM-DD). */
async function bookOn(h, date, who = customer) {
  const token = await h.prepare("cleaning", who);
  const [slot] = await h.slots(token, `?date=${date}`);
  assert.ok(slot, `an opening on ${date}`);
  const held = await h.hold(token, slot.scheduledAt);
  assert.equal(held.status, 201, JSON.stringify(held.data));
  const r = await h.confirm(token, held.data.hold);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.receipt;
}

test("with Twilio set up, confirmations go through Twilio and LeadConnector still keeps the contact", async (t) => {
  const h = await harness(t, { twilio: {}, env: { PUBLIC_ORIGIN: "https://bob.example.com" } });
  const r = await h.book("cleaning", customer);
  assert.equal(r.status, 201);
  const [text] = h.net.texts();
  assert.equal(text.to, "+16235551234");
  assert.match(text.body, /you're booked with Dryer Vent Squad West Valley/);
  assert.equal(text.callback, "https://bob.example.com/api/twilio/status");
  assert.equal(h.net.emails()[0].to, "jane@example.com");
  assert.match(r.data.receipt.notification, /confirmation text and a confirmation email/);
  const kinds = h.lc.calls.map((c) => c[0]);
  assert.deepEqual(kinds, ["upsert", "note"], "LeadConnector: contact and note only, no duplicate messages");
  const [a] = await h.store.appointments();
  assert.equal(a.notifications.smsProvider, "twilio");
  assert.equal(a.notifications.emailProvider, "twilio");
});

test("the provider switch can send everything through LeadConnector instead", async (t) => {
  const h = await harness(t, { twilio: {}, config: { messagingProvider: "leadconnector" } });
  await h.book("cleaning", customer);
  assert.equal(h.net.calls.length, 0, "nothing went to Twilio");
  assert.deepEqual(h.lc.calls.map((c) => c[0]).filter((k) => k !== "note"), ["upsert", "sms", "email"]);
});

test("Twilio only, with no LeadConnector: phone codes still work, so booking stays open", async (t) => {
  const h = await harness(t, { twilio: {}, lc: { configured: false } });
  const config = (await h.call("/api/public/config")).data;
  assert.equal(config.bookingEnabled, true);
  const token = await h.accept("cleaning");
  const c = await h.call("/api/contact", { method: "POST", token, body: customer });
  assert.equal(c.data.verification.sent, true);
  const [code] = h.net.texts();
  assert.match(code.body, /verification code is \d{6}/);
  const v = await h.call("/api/verify/check", { method: "POST", token, body: { code: h.lastCode() } });
  assert.equal(v.status, 200);
});

test("Twilio Verify makes and checks the phone code", async (t) => {
  const h = await harness(t, { twilio: { TWILIO_VERIFY_SERVICE_SID: fakeSid("VA") } });
  const token = await h.accept("cleaning");
  const c = await h.call("/api/contact", { method: "POST", token, body: customer });
  assert.equal(c.data.verification.sent, true);
  assert.ok(h.net.calls.some((x) => x.url.endsWith("/Verifications")), "Verify sent the code");
  assert.equal(h.net.texts().length, 0, "BOB didn't text its own code");
  assert.ok(!h.lc.calls.some((x) => x[0] === "sms"));
  const wrong = await h.call("/api/verify/check", { method: "POST", token, body: { code: "111111" } });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error, /4 tries left/);
  const ok = await h.call("/api/verify/check", { method: "POST", token, body: { code: "123456" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.session.stage, "slots");
});

test("if Verify can't be reached, the try doesn't count and the customer can try again", async (t) => {
  const h = await harness(t, { twilio: { TWILIO_VERIFY_SERVICE_SID: fakeSid("VA") } });
  const token = await h.accept("cleaning");
  await h.call("/api/contact", { method: "POST", token, body: customer });
  h.net.fail = { kind: "check", status: 503, code: 20500, message: "down" };
  const r = await h.call("/api/verify/check", { method: "POST", token, body: { code: "123456" } });
  assert.equal(r.status, 502);
  h.net.fail = null;
  assert.equal((await h.call("/api/verify/check", { method: "POST", token, body: { code: "123456" } })).status, 200);
});

test("a blocked Twilio sender shows up in Settings, and a booking is still confirmed", async (t) => {
  const h = await harness(t, { twilio: {} });
  const token = await h.prepare("cleaning", customer);
  h.net.fail = { kind: "sms", status: 400, code: 30034 };
  const held = await h.hold(token, (await h.slots(token))[0].scheduledAt);
  const r = await h.confirm(token, held.data.hold);
  assert.equal(r.status, 201);
  const [a] = await h.store.appointments();
  assert.equal(a.status, "confirmed");
  assert.equal(a.notifications.sms, "failed");
  assert.equal(a.notifications.email, "sent");
  const cookie = await h.login();
  const data = (await h.call("/api/admin/data", { cookie })).data;
  assert.match(data.integrations.twilio.issue.message, /^Confirmation not sent: .*A2P 10DLC/);
  assert.equal(data.integrations.messaging.sms, "twilio");
  const failed = data.messages.find((m) => m.status === "failed");
  assert.equal(failed.errorCode, 30034);
});

test("one customer's STOP doesn't flag the Twilio connection", async (t) => {
  const h = await harness(t, { twilio: {} });
  const token = await h.prepare("cleaning", customer);
  h.net.fail = { kind: "sms", status: 400, code: 21610, message: "unsubscribed" };
  const held = await h.hold(token, (await h.slots(token))[0].scheduledAt);
  await h.confirm(token, held.data.hold);
  const cookie = await h.login();
  assert.equal((await h.call("/api/admin/data", { cookie })).data.integrations.twilio.issue, null);
});

test("the office gets a text and an email for each new online booking and request", async (t) => {
  const h = await harness(t, { twilio: {}, config: { officeAlerts: OFFICE } });
  const r = await h.book("cleaning", customer);
  const toOffice = h.net.texts().filter((x) => x.to === "+16235550199");
  assert.equal(toOffice.length, 1);
  assert.match(toOffice[0].body, new RegExp(`BOB booked ${r.data.receipt.id}: .* for Booking T\\. in Buckeye 85326`));
  const mail = h.net.emails().find((x) => x.to === "office@example.com");
  assert.match(mail.subject, /^BOB booked DVS-/);
  assert.equal(mail.replyTo, "jane@example.com", "replying to the alert reaches the customer");

  const token = await h.fresh();
  h.net.calls.length = 0;
  const req = await h.call("/api/requests", { method: "POST", token, body: { name: "Pat Lee", phone: "6235554444", email: "", zip: "85326", message: "Vent cap is loose", preference: "phone", idempotencyKey: "request-key-0000000001" } });
  assert.equal(req.status, 201);
  assert.match(h.net.texts()[0].body, /New BOB request REQ-.* from Pat L\. \(85326\) — prefers call \(623\) 555-4444\. "Vent cap is loose"/);
});

test("office alerts follow their switches and need a phone or email", async (t) => {
  const h = await harness(t, { twilio: {}, config: { officeAlerts: { ...OFFICE, bookings: false } } });
  await h.book("cleaning", customer);
  assert.equal(h.net.texts().filter((x) => x.to === "+16235550199").length, 0);
});

test("a booking that needs a Jobber check alerts the office instead of confirming", async (t) => {
  const h = await harness(t, { twilio: {}, config: { officeAlerts: OFFICE } });
  const token = await h.prepare("cleaning", customer);
  h.jobber.failNext = "visit";
  const held = await h.hold(token, (await h.slots(token))[0].scheduledAt);
  const r = await h.confirm(token, held.data.hold);
  assert.equal(r.status, 202);
  const texts = h.net.texts();
  assert.ok(!texts.some((x) => x.to === "+16235551234"), "no confirmation to the customer");
  assert.match(texts.find((x) => x.to === "+16235550199").body, /BOB needs a check on DVS-.*isn't confirmed yet/);
});

test("the approver's request goes through Twilio", async (t) => {
  const h = await harness(t, { twilio: {}, config: { emergencyLeadHours: 1, leadHours: 24, approver: { name: "Seth", phone: "6235559999", email: "seth@example.com" } } });
  const token = await h.accept("emergency");
  await h.contactAndVerify(token, customer);
  const held = await h.hold(token, (await h.slots(token))[0].scheduledAt);
  const asked = await h.call("/api/approvals", { method: "POST", token, body: { holdId: held.data.hold.id, approved: true } });
  assert.equal(asked.status, 201);
  assert.match(h.net.texts().find((x) => x.to === "+16235559999").body, /^BOB approval needed \(APR-/);
  assert.match(h.net.emails().find((x) => x.to === "seth@example.com").subject, /^BOB approval needed/);
});

// ---- webhooks --------------------------------------------------------------------------

test("delivery status from Twilio updates the message log; unsigned callbacks are refused", async (t) => {
  const h = await harness(t, { twilio: {} });
  await h.book("cleaning", customer);
  const cookie = await h.login();
  const sid = (await h.call("/api/admin/data", { cookie })).data.messages.find((m) => m.kind === "confirmation" && m.channel === "sms").id;
  const forged = await h.webhook("/api/twilio/status", { MessageSid: sid, MessageStatus: "undelivered" }, { signature: "bm90IGEgc2lnbmF0dXJl" });
  assert.equal(forged.status, 403);
  assert.equal((await h.webhook("/api/twilio/status", { MessageSid: sid, MessageStatus: "delivered", AccountSid: "AC1" })).status, 204);
  assert.equal((await h.webhook("/api/twilio/status", { MessageSid: sid, MessageStatus: "sent" })).status, 204, "a late 'sent' doesn't undo 'delivered'");
  const m = (await h.call("/api/admin/data", { cookie })).data.messages.find((x) => x.id === sid);
  assert.equal(m.status, "delivered");
});

test("an unregistered-sender failure reported later still shows up in Settings", async (t) => {
  const h = await harness(t, { twilio: {} });
  await h.book("cleaning", customer);
  const cookie = await h.login();
  const sid = (await h.call("/api/admin/data", { cookie })).data.messages.find((m) => m.channel === "sms").id;
  await h.webhook("/api/twilio/status", { MessageSid: sid, MessageStatus: "undelivered", ErrorCode: "30034" });
  assert.match((await h.call("/api/admin/data", { cookie })).data.integrations.twilio.issue.message, /^Texts are being blocked: .*A2P 10DLC/);
});

test("a customer's reply is passed to the office with their booking; the office's own texts aren't looped back", async (t) => {
  const h = await harness(t, { twilio: {}, config: { officeAlerts: OFFICE } });
  const r = await h.book("cleaning", customer);
  h.net.calls.length = 0;
  const reply = await h.webhook("/api/twilio/inbound", { MessageSid: "SMin1", From: "+16235551234", To: "+16235550100", Body: "Can we move it to Thursday?" });
  assert.equal(reply.status, 200);
  assert.match(reply.type, /xml/);
  assert.equal(reply.text, '<?xml version="1.0" encoding="UTF-8"?><Response></Response>', "no automatic answer");
  const fwd = h.net.texts().find((x) => x.to === "+16235550199");
  assert.match(fwd.body, new RegExp(`Text from Booking T\\. \\(${r.data.receipt.id},.*"Can we move it to Thursday\\?"`));
  assert.equal(h.net.emails().find((x) => x.to === "office@example.com").replyTo, "jane@example.com");

  h.net.calls.length = 0;
  await h.webhook("/api/twilio/inbound", { MessageSid: "SMin2", From: "+16235550199", To: "+16235550100", Body: "ok thanks" });
  assert.equal(h.net.calls.length, 0, "the office texting BOB's number isn't forwarded to the office");

  await h.webhook("/api/twilio/inbound", { MessageSid: "SMin3", From: "+16235551234", To: "+16235550100", Body: "Cancel" });
  assert.match(h.net.texts().at(-1).body, /opting out of texts.*If they meant the appointment, call them/);
  const cookie = await h.login();
  const log = (await h.call("/api/admin/data", { cookie })).data.messages;
  assert.equal(log.find((m) => m.id === "SMin1").preview, "Can we move it to Thursday?");
  assert.equal(log.find((m) => m.id === "SMin3").kind, "opt_out");
});

test("Twilio webhooks need the auth token", async (t) => {
  const h = await harness(t, { twilio: { TWILIO_AUTH_TOKEN: "" , TWILIO_API_KEY_SID: "SKx", TWILIO_API_KEY_SECRET: "y" } });
  assert.equal((await h.webhook("/api/twilio/inbound", { From: "+16235551234", Body: "hi" })).status, 503);
});

// ---- reminders --------------------------------------------------------------------------

const cron = (h, secret = "cron-secret") => h.call("/api/cron/reminders", { headers: { Authorization: `Bearer ${secret}` } });

test("day-before reminders: once per visit, only for tomorrow, only with consent", async (t) => {
  const h = await harness(t, { twilio: {}, env: { CRON_SECRET: "cron-secret" }, config: { reminders: { enabled: true } } });
  const wed = await bookOn(h, "2026-09-23");
  const noText = await bookOn(h, "2026-09-23", { ...customer, phone: "6235552222", smsConsent: false, email: "" });
  await bookOn(h, "2026-09-24", { ...customer, phone: "6235553333" });
  assert.equal((await cron(h, "wrong")).status, 401);
  h.advance(24 * 3_600_000); // Tuesday afternoon: tomorrow is Wednesday
  h.net.calls.length = 0;
  const run = await cron(h);
  assert.equal(run.status, 200);
  assert.equal(run.data.day, "2026-09-23");
  assert.equal(run.data.sent, 1);
  assert.deepEqual(run.data.skipped, [{ id: noText.id, reason: "no_consent_or_email" }]);
  const [text] = h.net.texts();
  assert.equal(text.to, "+16235551234");
  assert.match(text.body, new RegExp(`^Reminder from Dryer Vent Squad West Valley: .* tomorrow, Wednesday, Sep 23.*Ref ${wed.id}`));
  assert.match(h.net.emails()[0].subject, /^Reminder: /);
  const again = await cron(h);
  assert.equal(again.data.sent, 0, "a second run doesn't remind anyone twice");
  assert.equal(h.net.texts().length, 1);
});

test("a visit moved or removed in Jobber gets no reminder", async (t) => {
  const h = await harness(t, { twilio: {}, env: { CRON_SECRET: "cron-secret" }, config: { reminders: { enabled: true } } });
  const moved = await bookOn(h, "2026-09-23");
  const gone = await bookOn(h, "2026-09-23", { ...customer, phone: "6235552222", address: "120 W Test St" });
  h.jobber.visits[0].start += 2 * 3_600_000;
  h.jobber.visits.splice(1, 1);
  h.advance(24 * 3_600_000);
  h.net.calls.length = 0;
  const run = await cron(h);
  assert.equal(run.data.sent, 0);
  assert.deepEqual(run.data.skipped.map((s) => s.reason).sort(), ["moved_in_jobber", "not_in_jobber"]);
  assert.deepEqual(run.data.skipped.map((s) => s.id).sort(), [moved.id, gone.id].sort());
  assert.equal(h.net.texts().length, 0);
});

test("reminders are off until turned on; the office can still run them by hand", async (t) => {
  const h = await harness(t, { twilio: {}, env: { CRON_SECRET: "cron-secret" } });
  await bookOn(h, "2026-09-23");
  h.advance(24 * 3_600_000);
  h.net.calls.length = 0;
  assert.equal((await cron(h)).data.disabled, true);
  assert.equal(h.net.calls.length, 0);
  const cookie = await h.login();
  const run = await h.call("/api/admin/reminders/run", { method: "POST", cookie, body: {} });
  assert.equal(run.data.result.sent, 1);
  assert.equal(run.data.reminderRun.sent, 1);
});

test("the cron endpoint is closed without CRON_SECRET", async (t) => {
  const h = await harness(t, { twilio: {} });
  assert.equal((await cron(h)).status, 503);
});

// ---- admin ----------------------------------------------------------------------------

test("the office can send itself a test text and email", async (t) => {
  const h = await harness(t, { twilio: {} });
  const cookie = await h.login();
  const sms = await h.call("/api/admin/messaging/test", { method: "POST", cookie, body: { channel: "sms", to: "(623) 555-0199" } });
  assert.equal(sms.status, 200);
  assert.deepEqual(sms.data.result, { status: "sent", provider: "twilio", error: null });
  assert.match(h.net.texts()[0].body, /^Test from BOB/);
  const mail = await h.call("/api/admin/messaging/test", { method: "POST", cookie, body: { channel: "email", to: "office@example.com" } });
  assert.equal(mail.data.result.status, "sent");
  assert.match(h.net.emails()[0].text, /Twilio SendGrid is working/);
  assert.equal((await h.call("/api/admin/messaging/test", { method: "POST", cookie, body: { channel: "sms", to: "123" } })).status, 400);
  h.net.fail = { kind: "sms", status: 401, code: 20003 };
  const bad = await h.call("/api/admin/messaging/test", { method: "POST", cookie, body: { channel: "sms", to: "6235550199" } });
  assert.equal(bad.data.result.status, "failed");
  assert.match(bad.data.result.error, /credentials/);
});

test("settings validate the new messaging options", async (t) => {
  const h = await harness(t, { twilio: {} });
  const cookie = await h.login(), c = await h.store.config();
  const bad = await h.call("/api/admin/config", { method: "PATCH", cookie, body: { ...c, messagingProvider: "carrier-pigeon" } });
  assert.equal(bad.status, 400);
  const badOffice = await h.call("/api/admin/config", { method: "PATCH", cookie, body: { ...c, officeAlerts: { ...OFFICE, phone: "12" } } });
  assert.equal(badOffice.status, 400);
  const ok = await h.call("/api/admin/config", { method: "PATCH", cookie, body: { ...c, messagingProvider: "twilio", reminders: { enabled: true }, officeAlerts: OFFICE } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.config.messagingProvider, "twilio");
  assert.deepEqual(ok.data.integrations.messaging, { provider: "twilio", sms: "twilio", email: "twilio", code: "twilio" });
});

test("the message log and delivery receipts work over the Supabase REST adapter too", async (t) => {
  const h = await harness(t, { twilio: {}, rest: true });
  await h.book("cleaning", customer);
  const cookie = await h.login();
  const before = (await h.call("/api/admin/data", { cookie })).data.messages;
  assert.deepEqual(before.map((m) => `${m.channel}:${m.kind}`).sort(), ["email:confirmation", "sms:code", "sms:confirmation"]);
  const sid = before.find((m) => m.channel === "sms").id;
  assert.equal((await h.webhook("/api/twilio/status", { MessageSid: sid, MessageStatus: "delivered" })).status, 204);
  assert.equal((await h.call("/api/admin/data", { cookie })).data.messages.find((m) => m.id === sid).status, "delivered");
});
