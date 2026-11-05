// An emergency customer's details reach the approver / on-call technician by text as soon as they're
// entered, whatever happens with the booking, and the request is kept in the Inbox. The 2 p.m. cutoff
// note waits for the scheduling step instead of appearing before the safety questions.
import test from "node:test";
import assert from "node:assert/strict";
import { harness, contact } from "./helpers.mjs";
import { notifyEmergencyContact, isEmergency } from "../server/emergency-alert.mjs";

const APPROVER = { name: "Ryan", phone: "6235550111", email: "" };
const EMERGENCY = ["Emergency Clog / Overheating", "No, it's turned off now", "Possible nest or blockage", contact.zip, "1-Story Home", "Electric Dryer", "Premium 1-2-3 · $179", "Standard Floor Setup", "Accept"];
const alerts = (twilio) => twilio.calls.filter(([kind, , text]) => kind === "sms" && /^BOB emergency request:/.test(text));

async function toContactStep(h, steps = EMERGENCY) {
  const token = await h.fresh();
  let r;
  for (const m of steps) r = await h.chat(token, m);
  assert.equal(r.action, "contact", `expected the contact step, got: ${r.reply}`);
  return { token, last: r };
}

test("emergency: the approver gets the customer's details the moment they're entered, once, and the Inbox keeps it", async (t) => {
  const h = await harness(t, { config: { approver: APPROVER } });
  const { token } = await toContactStep(h);
  assert.equal(alerts(h.twilio).length, 0, "nothing before the contact details");
  const r = await h.call("/api/contact", { method: "POST", token, body: contact });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const sent = alerts(h.twilio);
  assert.equal(sent.length, 1);
  const [, to, text] = sent[0];
  assert.equal(to, "+16235550111");
  assert.match(text, /^BOB emergency request: Booking Test, \(623\) 555-1234, 100 W Test St, Buckeye, AZ 85326\. Premium 1-2-3 See-It-Clean\./);
  assert.match(text, /Not booked yet; please call them\. Inbox: .*\/admin\?tab=inbox$/);
  const [request] = (await h.store.requests()).filter((x) => x.kind === "emergency");
  assert.equal(request.name, "Booking Test");
  assert.equal(request.notification.status, "accepted");
  assert.match(request.message, /hasn't booked yet\. Call them\./);
  assert.equal(r.data.session.emergencyAlertId, request.id);
  // Editing the details (or a retry) doesn't text again.
  const again = await h.call("/api/contact", { method: "POST", token, body: { ...contact, notes: "Gate code 1234" } });
  assert.equal(again.status, 200);
  assert.equal(alerts(h.twilio).length, 1);
  assert.equal((await h.store.requests()).filter((x) => x.kind === "emergency").length, 1);
});

test("ordinary bookings never send the emergency text", async (t) => {
  const h = await harness(t, { config: { approver: APPROVER } });
  const token = await h.accept("cleaning");
  const r = await h.call("/api/contact", { method: "POST", token, body: contact });
  assert.equal(r.status, 200);
  assert.equal(alerts(h.twilio).length, 0);
  assert.equal((await h.store.requests()).filter((x) => x.kind === "emergency").length, 0);
});

test("a text that can't go out never blocks the customer; the Inbox shows the failure", async (t) => {
  const h = await harness(t, { config: { approver: APPROVER } });
  const { token } = await toContactStep(h);
  h.twilio.failSms = true;
  const r = await h.call("/api/contact", { method: "POST", token, body: contact });
  assert.equal(r.status, 200, "the contact step still succeeds");
  const [request] = (await h.store.requests()).filter((x) => x.kind === "emergency");
  assert.equal(request.notification.status, "failed");
  assert.match(request.notification.error, /sms down/);
});

test("after 2 p.m. the cutoff note is not shown up front; the session carries it to scheduling and the text says so", async (t) => {
  const h = await harness(t, { config: { approver: APPROVER } });
  h.advance(2 * 3_600_000); // harness starts Monday 1:00 PM Arizona; now 3:00 PM
  const token = await h.fresh();
  const first = await h.chat(token, EMERGENCY[0]);
  assert.doesNotMatch(first.reply, /2 p\.m\. cutoff/, "not before the safety questions");
  assert.equal(first.session.emergencyAfterCutoff, true);
  let r;
  for (const m of EMERGENCY.slice(1)) r = await h.chat(token, m);
  assert.equal(r.action, "contact");
  assert.equal(r.session.emergencyAfterCutoff, true, "kept for the scheduling message");
  await h.call("/api/contact", { method: "POST", token, body: contact });
  const [[, , text]] = alerts(h.twilio);
  assert.match(text, /Came in after the 2 p\.m\. same-day cutoff\./);
});

test("unit: no phone, an hourly limit, and only emergency conversations", async () => {
  const requests = new Map(), sent = [];
  let allowed = true;
  const store = {
    requestByIdem: async (k) => requests.get(k), lock: async () => true, unlock: async () => {}, rateHit: async () => allowed,
    insertRequest: async (r, s, k) => requests.set(k, r), updateRequest: async () => {}, technicians: async () => [{ id: "tech-ryan", phone: "" }],
  };
  const data = (extra = {}) => ({ intent: "emergency", package: "premium", contact: { ...contact, phone: "+16235551234" }, history: [], ...extra });
  const base = { store, sendStaffSms: async (m) => (sent.push(m), { messageId: "SM1" }), now: Date.parse("2026-11-05T20:00:00Z") };
  assert.equal(isEmergency({ intent: "cleaning" }), false);
  assert.equal(isEmergency({ intent: "cleaning", afterHours: true }), true);
  assert.equal(await notifyEmergencyContact({ ...base, config: {}, data: data({ intent: "cleaning" }), session: "s0" }), null);
  const noPhone = await notifyEmergencyContact({ ...base, config: { approver: { name: "", phone: "" } }, data: data(), session: "s1" });
  assert.equal(noPhone.notification.status, "failed");
  assert.match(noPhone.notification.error, /approver phone/);
  assert.equal(sent.length, 0);
  allowed = false;
  assert.equal(await notifyEmergencyContact({ ...base, config: { approver: APPROVER }, data: data(), session: "s2" }), null, "over the hourly limit: nothing sent");
  assert.equal(sent.length, 0);
});
