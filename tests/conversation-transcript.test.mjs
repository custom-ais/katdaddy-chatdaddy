import test from "node:test";
import assert from "node:assert/strict";
import { harness, contact } from "./helpers.mjs";
import { describeActivity } from "../shared/activity-text.mjs";

// The office reads whole conversations in BOB activity: every message the customer typed or tapped,
// every reply and the buttons it offered, everything the chat window showed outside a chat turn
// (contact questions and answers), and each booking step. Verification codes never appear.

test("a booked conversation can be read start to finish in BOB activity", async (t) => {
  const h = await harness(t);
  const cookie = await h.login();
  const token = await h.accept();
  h.advance(1000); // the test clock stands still unless moved; real steps are seconds apart
  // What the chat window shows during the contact step is sent from the page.
  const sent = await h.call("/api/transcript", { method: "POST", token, body: { entries: [
    { role: "assistant", text: "What's your name?" },
    { role: "user", text: "Pat Synthetic" },
    { role: "assistant", text: "Best number for the technician to call?" },
    { role: "user", text: "(623) 555-0100" },
    { event: "went_back" },
    { role: "user", text: "1234" },
  ] } });
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  assert.equal(sent.data.recorded, 6);
  h.advance(1000);
  await h.contactAndVerify(token);
  h.advance(1000);
  const held = await h.hold(token, (await h.slots(token))[0].scheduledAt);
  assert.equal(held.status, 201, JSON.stringify(held.data));
  h.advance(1000);
  const booked = await h.confirm(token, held.data.hold);
  assert.equal(booked.status, 201, JSON.stringify(booked.data));

  const items = (await h.call("/api/admin/activity", { cookie })).data.items;
  const session = items.find((e) => e.kind === "conversation.message" && e.details?.text === "Pat Synthetic")?.sessionId;
  assert.ok(session, "the page's messages are saved under the conversation");
  const convo = items.filter((e) => e.sessionId === session).reverse();
  const kinds = convo.map((e) => e.kind);

  assert.ok(kinds.includes("conversation.started"));
  const typed = convo.filter((e) => e.kind === "conversation.message" && e.details.role === "user" && e.details.source !== "chat_window");
  const replies = convo.filter((e) => e.kind === "conversation.message" && e.details.role === "assistant" && e.details.source !== "chat_window");
  assert.ok(typed.length >= 3 && replies.length === typed.length, "every chat turn and its reply");
  assert.ok(typed.some((e) => e.details.text === contact.zip), "a ZIP code typed in the chat is kept (only 4-digit codes are hidden)");
  assert.ok(replies.some((e) => e.details.options?.length), "the buttons offered with a reply are saved");
  assert.ok(replies.some((e) => e.details.shown?.length), "the package cards shown are saved");

  const fromPage = convo.filter((e) => e.details?.source === "chat_window").map((e) => e.kind === "conversation.went_back" ? "<back>" : `${e.details.role}: ${e.details.text}`);
  assert.deepEqual(fromPage, [
    "assistant: What's your name?", "user: Pat Synthetic", "assistant: Best number for the technician to call?", "user: (623) 555-0100", "<back>", "user: [verification code omitted]",
  ], "page messages keep their order, and a bare code is hidden");

  const held1 = convo.find((e) => e.kind === "booking.time_held");
  assert.equal(held1?.details.scheduledAt, held.data.hold.scheduledAt);
  const done = convo.find((e) => e.kind === "booking.confirmed");
  assert.equal(done?.details.appointmentId, booked.data.receipt.id);
  assert.ok(kinds.indexOf("booking.time_held") < kinds.indexOf("booking.confirmed"));
  assert.match(describeActivity(done).title, /^Customer booked a visit/);

  // Saving a transcript batch adds no behind-the-scenes request record of its own.
  assert.ok(!items.some((e) => e.kind === "request.finished" && e.details?.path === "/api/transcript"));
  // The customer's verification code is nowhere in activity.
  assert.doesNotMatch(JSON.stringify(convo.filter((e) => e.kind !== "conversation.started")), /"1234"/);
});

test("transcript saves are checked and limited to the customer's own conversation", async (t) => {
  const h = await harness(t);
  const token = await h.fresh();
  for (const body of [{}, { entries: [] }, { entries: [{ role: "admin", text: "hi" }] }, { entries: [{ role: "user", text: "  " }] }, { entries: Array.from({ length: 26 }, () => ({ role: "user", text: "x" })) }]) {
    const r = await h.call("/api/transcript", { method: "POST", token, body });
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
  }
  const noSession = await h.call("/api/transcript", { method: "POST", body: { entries: [{ role: "user", text: "hello" }] } });
  assert.equal(noSession.status, 401);
  const long = await h.call("/api/transcript", { method: "POST", token, body: { entries: [{ role: "assistant", text: "y".repeat(9000), options: ["A", 3, "B"] }] } });
  assert.equal(long.status, 201);
  const cookie = await h.login();
  const saved = (await h.call("/api/admin/activity", { cookie })).data.items.find((e) => e.details?.source === "chat_window");
  assert.equal(saved.details.text.length, 4000);
  assert.deepEqual(saved.details.options, ["A", "B"]);
});

test("a message to the office is part of the conversation", async (t) => {
  const h = await harness(t);
  const cookie = await h.login();
  const token = await h.accept();
  const r = await h.call("/api/requests", { method: "POST", token, body: { ...contact, message: "Please call me about the noise", preference: "phone", idempotencyKey: "req-transcript-0000000001" } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const items = (await h.call("/api/admin/activity", { cookie })).data.items;
  const sent = items.find((e) => e.kind === "request.sent");
  assert.equal(sent?.details.message, "Please call me about the noise");
  assert.ok(sent.sessionId, "filed under the conversation");
  assert.equal(describeActivity(sent).title, "Customer sent a message to the office");
});
