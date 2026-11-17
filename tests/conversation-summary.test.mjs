import test from "node:test";
import assert from "node:assert/strict";
import { harness, contact } from "./helpers.mjs";
import { summarizeConversation, conversationTitle } from "../shared/conversation-summary.mjs";

// The Activity page lists conversations, each titled with when it started and the service address,
// how it ended, and, for one that didn't book, where the customer stopped.

let t0 = Date.parse("2026-11-16T23:12:00Z"); // Mon, Nov 16, 4:12 PM Arizona
const rec = (kind, details = {}, extra = {}) => ({ id: `e${t0}`, kind, created: (t0 += 1000), level: "info", sessionId: "s1", details, ...extra });

test("a booked conversation: date, time, address, what was booked, and whether the customer was told", () => {
  t0 = Date.parse("2026-11-16T23:12:00Z");
  const items = [
    rec("conversation.started", { stage: "welcome", site: "https://dryerventsquadaz.com", host: "katdaddy-bookingbot.vercel.app" }),
    rec("conversation.message", { role: "user", text: "Dryer Vent Cleaning" }),
    rec("conversation.message", { role: "assistant", text: "What's the address?" }),
    rec("coverage.checked", { area: "in", address: "15420 W Bell Rd, Surprise, AZ 85374" }),
    rec("booking.time_held", { scheduledAt: "2026-11-18T16:00:00Z" }),
    rec("booking.confirmed", { appointmentId: "AP-1", scheduledAt: "2026-11-18T16:00:00Z", service: "Premium 1-2-3 See-It-Clean", totalCents: 17900, pending: false }),
    rec("confirmation.result", { appointmentId: "AP-1", sms: "skipped", smsReason: "no_consent", email: "skipped", emailReason: "no_email" }, { level: "warning" }),
  ];
  const s = summarizeConversation(items);
  assert.equal(conversationTitle(s), "Mon, Nov 16, 4:12 PM · 15420 W Bell Rd, Surprise, AZ 85374");
  assert.deepEqual(s.result, { kind: "booked", tone: "attention", title: "Booked: Premium 1-2-3 See-It-Clean for Wed, Nov 18, 9:00 AM" }, "booked, but nobody told the customer: worth a look");
  assert.equal(s.stopped, null);
  assert.deepEqual(s.confirmation, { sms: "skipped", smsReason: "no_consent", email: "skipped", emailReason: "no_email" });
  assert.equal(s.openedFrom, "dryerventsquadaz.com");
});

test("not booked: where the customer stopped, and BOB's last message", () => {
  t0 = Date.parse("2026-11-16T23:12:00Z");
  const contactStep = summarizeConversation([
    rec("conversation.started", { stage: "welcome" }),
    rec("conversation.message", { role: "user", text: "Dryer Vent Cleaning", stage: "welcome" }),
    rec("conversation.message", { role: "user", text: "85326", stage: "evaluating" }),
    rec("conversation.message", { role: "assistant", text: "What is your callback phone number?", stage: "contact", source: "chat_window" }),
  ]);
  assert.equal(contactStep.result.title, "Not booked");
  assert.equal(contactStep.stopped.where, "while entering contact details");
  assert.equal(contactStep.stopped.lastBot, "What is your callback phone number?");
  assert.equal(contactStep.address, "ZIP 85326", "a ZIP alone is better than nothing");

  const afterTime = summarizeConversation([
    rec("conversation.message", { role: "user", text: "4511 N 100th Ave, Phoenix", stage: "details" }),
    rec("booking.time_held", { scheduledAt: "2026-11-18T16:00:00Z" }),
    rec("request.finished", { path: "/api/holds", method: "POST", status: 201 }),
  ]);
  assert.equal(afterTime.stopped.where, "after picking a time, before confirming the booking");
  assert.equal(afterTime.address, "4511 N 100th Ave, Phoenix", "an address typed in the chat");

  const error = summarizeConversation([
    rec("conversation.message", { role: "user", text: "hi", stage: "verify" }),
    rec("request.finished", { path: "/api/verify/check", method: "POST", status: 400, error: "That code didn't match." }, { level: "warning" }),
  ]);
  assert.equal(error.stopped.where, 'after an error: "That code didn\'t match."');
});

test("other endings: office requests, commercial, safety stops, out of area, and chats nobody used", () => {
  t0 = Date.parse("2026-11-16T23:12:00Z");
  assert.equal(summarizeConversation([rec("conversation.message", { role: "user", text: "call me" }), rec("request.sent", { name: "Pat", message: "call me" })]).result.title, "Sent a request to the office");
  assert.equal(summarizeConversation([rec("conversation.started", { audience: "commercial" }), rec("request.sent", { name: "Pat", commercial: true })]).result.title, "Commercial request sent to the office");
  const commercialOnly = summarizeConversation([rec("conversation.started", { audience: "commercial" }), rec("conversation.message", { role: "user", text: "40 units", stage: "review" })]);
  assert.equal(commercialOnly.result.kind, "commercial");
  assert.equal(summarizeConversation([rec("conversation.message", { role: "user", text: "I smell gas", stage: "emergency" }), rec("conversation.message", { role: "assistant", text: "Leave the building", stage: "emergency" })]).result.kind, "safety");
  assert.equal(summarizeConversation([rec("conversation.message", { role: "user", text: "hello", stage: "out_of_area" })]).result.title, "Not booked: outside the service area");
  const unused = summarizeConversation([rec("conversation.started", { stage: "welcome", host: "katdaddy-bookingbot-onso900q2-seths-projects-e9e6cba0.vercel.app" })]);
  assert.equal(unused.result.kind, "empty");
  assert.match(unused.openedFrom, /Vercel deployment link, often an automatic check/);
  // Older records: a booking known only from its request.
  assert.equal(summarizeConversation([rec("request.finished", { path: "/api/bookings", method: "POST", status: 201 })]).result.kind, "booked");
});

test("the conversations endpoint returns each chat whole, with texts and emails about its booking", async (t) => {
  const h = await harness(t);
  const cookie = await h.login();
  const r = await h.book();
  assert.equal(r.status, 201, JSON.stringify(r.data));
  h.advance(1000);
  await h.call("/api/session", { method: "POST", body: { site: "https://dryerventsquadaz.com" } }); // opened, never used
  const { conversations, nextCursor } = (await h.call("/api/admin/conversations", { cookie })).data;
  assert.equal(nextCursor, null);
  assert.equal(conversations.length, 2);
  const [unused, booked] = conversations;
  assert.equal(summarizeConversation(unused.items).result.kind, "empty");
  assert.equal(summarizeConversation(unused.items).openedFrom, "dryerventsquadaz.com");
  const s = summarizeConversation(booked.items);
  assert.equal(s.result.kind, "booked");
  assert.match(s.address, /Test St/, "the checked address");
  assert.ok(booked.items.some((e) => e.kind === "confirmation.result" && e.details.appointmentId === r.data.receipt.id), "whether the customer was told");
  assert.ok(s.confirmation, "the summary says how the customer was told");
  assert.ok(booked.items.every((e, i, all) => i === 0 || all[i - 1].created <= e.created), "oldest first");
  void contact;
});

test("only people who can see BOB activity can list conversations", async (t) => {
  const h = await harness(t);
  const r = await h.call("/api/admin/conversations");
  assert.ok([401, 403].includes(r.status));
});
