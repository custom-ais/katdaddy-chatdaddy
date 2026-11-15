import test from "node:test";
import assert from "node:assert/strict";
import { harness, contact } from "./helpers.mjs";
import { classify, COMMERCIAL_WELCOME, COMMERCIAL_SWITCH, COMMERCIAL_NOTED } from "../shared/conversation.mjs";
import { describeActivity } from "../shared/activity-text.mjs";

// ChatDaddy never books commercial jobs. On the commercial side of the website, or once a customer
// says the job is commercial, BOB only collects contact details and needs for the team, and the
// server refuses every booking step for that conversation.

const mailer = () => {
  const api = { configured: true, calls: [], async sendEmail(to, message) { api.calls.push({ to, ...message }); return { status: "accepted", messageId: `m-${api.calls.length}` }; } };
  return api;
};
const BOOKING_STEPS = (token) => [
  ["GET", "/api/availability", undefined],
  ["POST", "/api/contact", contact],
  ["POST", "/api/verify/send", { channel: "sms" }],
  ["POST", "/api/holds", { scheduledAt: "2026-09-23T16:00:00.000Z" }],
  ["POST", "/api/holds/extras", { addOns: {} }],
  ["POST", "/api/bookings", { holdId: "HOLD-x", idempotencyKey: "commercial-booking-000001", approved: true }],
  ["POST", "/api/approvals", { holdId: "HOLD-x" }],
  ["GET", "/api/approvals/after-hours", undefined],
  ["POST", "/api/approvals/after-hours", {}],
  ["POST", "/api/chat/back", {}],
].map(([method, path, body]) => ({ method, path, body, token }));

test("the commercial side of the website only collects details and needs, and nothing can be booked", async (t) => {
  const sendgrid = mailer();
  const h = await harness(t, { sendgrid, config: { email: "office@example.test" }, env: { BOOKING_EMAIL_PROVIDER: "sendgrid" } });
  const cookie = await h.login();
  const started = await h.call("/api/session", { method: "POST", body: { audience: "commercial" } });
  assert.equal(started.status, 201);
  const { token, session } = started.data;
  assert.equal(session.commercial, "page");
  assert.equal(session.stage, "review", "the request form shows right away");
  assert.deepEqual(session.history, [{ role: "assistant", text: COMMERCIAL_WELCOME }]);

  // Whatever they type (even a package name or "book it"), BOB points to the form.
  for (const message of ["Book a Cleaning", "Premium 1-2-3 · $179", "We have 40 units and the dryers take forever"]) {
    const r = await h.chat(token, message);
    assert.equal(r.reply, COMMERCIAL_NOTED, message);
    assert.equal(r.action, "request");
    assert.deepEqual(r.options, []);
  }
  // "Start over" keeps a commercial-page chat commercial.
  assert.equal((await h.chat(token, "start over")).action, "request");

  for (const step of BOOKING_STEPS(token)) {
    const r = await h.call(step.path, { method: step.method, token, body: step.body });
    assert.equal(r.status, 409, `${step.method} ${step.path}: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.code, "COMMERCIAL_REQUEST_ONLY", `${step.method} ${step.path}`);
  }

  const sent = await h.call("/api/requests", { method: "POST", token, body: { ...contact, message: "Business / property: Sunset Apartments\n\nAnnual cleaning for 40 units", preference: "phone", idempotencyKey: "commercial-request-0000001" } });
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  const [request] = (await h.call("/api/admin/data", { cookie })).data.requests;
  assert.equal(request.kind, "commercial");
  assert.match(request.message, /^COMMERCIAL REQUEST\. Contact the customer to discuss the job and quote it\.\n\nBusiness \/ property: Sunset Apartments/);
  assert.ok(request.transcript.some((m) => /40 units/.test(m.text)), "what they typed goes to the team with the request");

  const office = sendgrid.calls.filter((c) => /^Commercial request:/.test(c.subject || ""));
  assert.equal(office.length, 1, "the office gets one email about it");
  assert.equal(office[0].to, "office@example.test");
  assert.match(office[0].text, /Annual cleaning for 40 units/);

  const items = (await h.call("/api/admin/activity", { cookie })).data.items;
  assert.equal(describeActivity(items.find((e) => e.kind === "conversation.started")).title, "A customer opened BOB on the commercial side of the website");
  assert.equal(describeActivity(items.find((e) => e.kind === "request.sent")).title, "Commercial customer sent a request to the office");
  assert.ok(items.some((e) => e.kind === "conversation.message" && e.details.text === COMMERCIAL_WELCOME), "BOB's opening is part of the conversation");
  assert.equal(await h.count("appointments"), 0);
  assert.equal(await h.count("holds"), 0);
});

test("a home-service chat that turns out to be commercial stops booking, even at the time-picking step", async (t) => {
  const h = await harness(t);
  const cookie = await h.login();
  const token = await h.prepare(); // service accepted, contact verified: ready to pick a time
  assert.ok((await h.slots(token)).length > 0);
  const r = await h.chat(token, "Actually this is for our HOA clubhouse laundry");
  assert.equal(r.reply, COMMERCIAL_SWITCH);
  assert.equal(r.action, "request");
  assert.equal(r.session.commercial, "said");
  assert.equal(r.session.serviceAccepted, false);
  assert.equal((await h.chat(token, "Can I still book Tuesday?")).reply, COMMERCIAL_NOTED);

  const held = await h.call("/api/availability", { token });
  assert.equal(held.status, 409);
  assert.equal(held.data.code, "COMMERCIAL_REQUEST_ONLY");
  const items = (await h.call("/api/admin/activity", { cookie })).data.items;
  assert.equal(describeActivity(items.find((e) => e.kind === "conversation.commercial")).title, "BOB stopped booking: the customer said it's a commercial job");

  // Said by mistake? Starting over gives a fresh home-service chat.
  const fresh = await h.chat(token, "start over");
  assert.equal(fresh.session.commercial, undefined);
  assert.notEqual(fresh.action, "request");
});

test("gas, smoke and fire warnings still come first in a commercial chat", async (t) => {
  const h = await harness(t);
  const { token } = (await h.call("/api/session", { method: "POST", body: { audience: "commercial" } })).data;
  const r = await h.chat(token, "I smell gas in the laundry room");
  assert.equal(r.action, "emergency");
  assert.match(r.reply, /Leave the building immediately and call 911/);
});

test("commercial words, but not a resident's own apartment", () => {
  for (const text of ["It's for our HOA", "We manage apartments in Goodyear", "apartment complex laundry room", "a 12-unit multifamily building", "multi-unit property", "I'm the property manager", "our laundromat", "This is for a commercial property"]) {
    assert.equal(classify(text).route, "commercial", text);
  }
  for (const text of ["I live in an apartment", "My apartment dryer is slow", "Dryer Vent Cleaning", "my house has two dryers"]) {
    assert.notEqual(classify(text).route, "commercial", text);
  }
});

test("a home-service chat is unchanged: it still books", async (t) => {
  const h = await harness(t);
  const r = await h.book();
  assert.equal(r.status, 201, JSON.stringify(r.data));
});
