import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { harness, contact } from "./helpers.mjs";
import { EMAIL_PRIVACY, EMAIL_REQUIRED } from "../shared/email-privacy.mjs";

// Customers must give an email to book or send a request (it's where the confirmation and replies
// go), and BOB says plainly it's never used for marketing, given or sold.

test("the promise is plain: only for the booking or request, never marketing, never given or sold", () => {
  assert.match(EMAIL_PRIVACY, /only use it for your booking or request/);
  assert.match(EMAIL_PRIVACY, /never used for marketing/);
  assert.match(EMAIL_PRIVACY, /never give or sell it to anyone/);
  assert.match(EMAIL_REQUIRED, /^Enter your email address\. /);
});

test("booking contact details need an email, and a real one", async (t) => {
  const h = await harness(t);
  const token = await h.accept();
  const missing = await h.call("/api/contact", { method: "POST", token, body: { ...contact, email: "" } });
  assert.equal(missing.status, 400);
  assert.equal(missing.data.error, EMAIL_REQUIRED);
  const blank = await h.call("/api/contact", { method: "POST", token, body: { ...contact, email: "   " } });
  assert.equal(blank.status, 400);
  const bad = await h.call("/api/contact", { method: "POST", token, body: { ...contact, email: "not-an-email" } });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, "Enter a valid email address.");
  const ok = await h.call("/api/contact", { method: "POST", token, body: contact });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
});

test("a request to the office (regular or commercial) needs an email too", async (t) => {
  const h = await harness(t);
  for (const audience of [undefined, "commercial"]) {
    const { token } = (await h.call("/api/session", { method: "POST", body: audience ? { audience } : {} })).data;
    const body = { name: "Jane Doe", phone: "6235550188", message: "Please call me.", preference: "phone" };
    const missing = await h.call("/api/requests", { method: "POST", token, body: { ...body, idempotencyKey: `email-required-${audience || "home"}-01` } });
    assert.equal(missing.status, 400, audience);
    assert.equal(missing.data.error, EMAIL_REQUIRED);
    const sent = await h.call("/api/requests", { method: "POST", token, body: { ...body, email: "jane@example.test", idempotencyKey: `email-required-${audience || "home"}-02` } });
    assert.equal(sent.status, 201, JSON.stringify(sent.data));
  }
});

test("the office can still enter an appointment without an email", async (t) => {
  const h = await harness(t);
  const cookie = await h.login();
  const r = await h.call("/api/admin/appointments", { method: "POST", cookie, body: { ...contact, email: "", route: "cleaning", scheduledAt: "2026-09-23T16:00:00Z" } });
  assert.ok([200, 201].includes(r.status), JSON.stringify(r.data));
});

test("the chat and the request form ask for it with the promise, and there's no Skip", async () => {
  const bot = await readFile(new URL("../src/customer/BookingBot.tsx", import.meta.url), "utf8");
  assert.match(bot, /case 'email': return .*What's your email address\?.*\$\{EMAIL_PRIVACY\}`;/, "the email question carries the promise");
  assert.doesNotMatch(bot, /step === 'email' \? \['Skip'\]/, "no Skip button on the email question");
  assert.match(bot, /An email address is needed to book/, "typing skip explains why it's needed");
  assert.match(bot, /contactStep === 'email' \? `🔒 \$\{EMAIL_PRIVACY_SHORT\}`/, "the promise sits under the text box while it's asked");
  assert.match(bot, /Email<input className=\{input\} type="email" required/, "the request form's email is required");
  assert.match(bot, /\{EMAIL_PRIVACY\}<\/span><\/label>/, "with the promise under it");
  assert.doesNotMatch(bot, /Email \(optional\)/);
});
