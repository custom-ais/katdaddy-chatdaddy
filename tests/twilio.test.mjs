// Twilio module: webhook signatures (checked against Twilio's own SDK), texts, Verify, SendGrid.

import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import twilioSdk from "twilio";
import { createTwilio, twilioSignature, validTwilioSignature, hintFor } from "../server/twilio.mjs";
import { TWILIO_ENV, fakeSid } from "./helpers.mjs";

test("webhook signatures match Twilio's SDK for any parameters, URL ports and repeated fields", () => {
  const rand = () => randomBytes(1 + (randomBytes(1)[0] % 12)).toString("base64").replace(/=/g, "");
  for (let i = 0; i < 200; i++) {
    const token = rand() + rand();
    const params = {};
    for (let k = 0; k < 1 + (i % 9); k++) params[`${rand()}${k}`] = i % 7 === 0 && k === 0 ? [rand(), rand(), "same", "same"] : `${rand()} +é&=${k}`;
    const url = [`https://bob.example.com/api/twilio/inbound`, `https://bob.example.com:443/api/twilio/status?x=${i}`, `https://bob.example.com/api/twilio/status?a=1&b=two%20words`][i % 3];
    const sig = twilioSdk.getExpectedTwilioSignature(token, url, params);
    assert.equal(twilioSignature(token, url, params), sig);
    // What Twilio signed with the port is accepted without it, and the other way round, like the SDK.
    const other = url.includes(":443") ? url.replace(":443", "") : url.replace("bob.example.com", "bob.example.com:443");
    assert.equal(validTwilioSignature(token, sig, other, params), twilioSdk.validateRequest(token, sig, other, params));
    assert.equal(validTwilioSignature(token, sig, other, params), true);
  }
});

test("a forged, altered or unsigned webhook is refused", () => {
  const params = { MessageSid: "SM1", MessageStatus: "delivered" };
  const url = "https://bob.example.com/api/twilio/status";
  const sig = twilioSignature("secret-token", url, params);
  assert.equal(validTwilioSignature("secret-token", sig, url, params), true);
  assert.equal(validTwilioSignature("secret-token", sig, url, { ...params, MessageStatus: "failed" }), false);
  assert.equal(validTwilioSignature("secret-token", sig, "https://evil.example.com/api/twilio/status", params), false);
  assert.equal(validTwilioSignature("other-token", sig, url, params), false);
  assert.equal(validTwilioSignature("secret-token", "", url, params), false);
  assert.equal(validTwilioSignature("", sig, url, params), false);
  // Any one of several possible URLs may match (the request's own and PUBLIC_ORIGIN's).
  assert.equal(validTwilioSignature("secret-token", sig, ["https://x.vercel.app/api/twilio/status", url], params), true);
});

function net(responses) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      const r = responses.shift();
      return typeof r === "function" ? r(url, init) : r;
    },
  };
}

test("a text goes through the Messaging Service with the status callback, using the API key when there is one", async () => {
  const n = net([new Response(JSON.stringify({ sid: "SMabc", status: "accepted" }), { status: 201 })]);
  const tw = createTwilio({ env: { ...TWILIO_ENV, TWILIO_API_KEY_SID: " SKkey ", TWILIO_API_KEY_SECRET: "keysecret", TWILIO_FROM_NUMBER: "+16235550100" }, fetchImpl: n.fetchImpl });
  assert.equal(tw.smsConfigured, true);
  const r = await tw.sendSms("+16235551234", "Hello", { statusCallback: "https://bob.example.com/api/twilio/status" });
  assert.deepEqual(r, { sid: "SMabc", status: "accepted" });
  const { url, init } = n.calls[0];
  assert.equal(url, `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ENV.TWILIO_ACCOUNT_SID}/Messages.json`);
  assert.equal(init.headers.Authorization, `Basic ${Buffer.from("SKkey:keysecret").toString("base64")}`);
  const body = Object.fromEntries(init.body);
  assert.deepEqual(body, { To: "+16235551234", Body: "Hello", MessagingServiceSid: TWILIO_ENV.TWILIO_MESSAGING_SERVICE_SID, StatusCallback: "https://bob.example.com/api/twilio/status" });
});

test("without a Messaging Service the From number is used, with the auth token as the password", async () => {
  const n = net([new Response(JSON.stringify({ sid: "SM1" }), { status: 201 })]);
  const tw = createTwilio({ env: { ...TWILIO_ENV, TWILIO_MESSAGING_SERVICE_SID: "", TWILIO_FROM_NUMBER: "+16235550100" }, fetchImpl: n.fetchImpl });
  await tw.sendSms("+16235551234", "Hi");
  assert.equal(Object.fromEntries(n.calls[0].init.body).From, "+16235550100");
  assert.equal(n.calls[0].init.headers.Authorization, `Basic ${Buffer.from(`${TWILIO_ENV.TWILIO_ACCOUNT_SID}:test-auth-token`).toString("base64")}`);
});

test("Twilio errors come back in plain words, with the error code", async () => {
  const n = net([new Response(JSON.stringify({ code: 30034, message: "Message from an Unregistered Number", status: 400 }), { status: 400 })]);
  const tw = createTwilio({ env: TWILIO_ENV, fetchImpl: n.fetchImpl });
  await assert.rejects(tw.sendSms("+16235551234", "Hi"), (e) => e.code === 30034 && /A2P 10DLC/.test(e.message) && /error 30034/.test(e.message));
  assert.match(hintFor(21610), /STOP/);
});

test("nothing is configured until the pieces are there, and secrets never show in describe()", () => {
  assert.equal(createTwilio({ env: {} }).configured, false);
  assert.equal(createTwilio({ env: { TWILIO_ACCOUNT_SID: "not-an-account", TWILIO_AUTH_TOKEN: "x", TWILIO_FROM_NUMBER: "+16235550100" } }).smsConfigured, false);
  const only = createTwilio({ env: { SENDGRID_API_KEY: "SG.x", SENDGRID_FROM_EMAIL: "a@b.co" } });
  assert.deepEqual([only.smsConfigured, only.verifyConfigured, only.emailConfigured], [false, false, true]);
  const tw = createTwilio({ env: { ...TWILIO_ENV, TWILIO_FROM_NUMBER: "+16235550100", TWILIO_VERIFY_SERVICE_SID: fakeSid("VA") } });
  const shown = JSON.stringify(tw.describe());
  for (const secret of ["test-auth-token", "SG.test-key", TWILIO_ENV.TWILIO_ACCOUNT_SID, "6235550100"]) assert.ok(!shown.includes(secret), `describe() leaks ${secret}`);
  assert.match(shown, /•••0100/);
});

test("Verify: Twilio sends the code; approved is true, a wrong or expired code is false", async () => {
  const VA = fakeSid("VA");
  const n = net([
    new Response(JSON.stringify({ sid: "VE1", status: "pending" }), { status: 201 }),
    new Response(JSON.stringify({ status: "approved" }), { status: 200 }),
    new Response(JSON.stringify({ status: "pending" }), { status: 200 }),
    new Response(JSON.stringify({ code: 20404, message: "not found", status: 404 }), { status: 404 }),
  ]);
  const tw = createTwilio({ env: { ...TWILIO_ENV, TWILIO_VERIFY_SERVICE_SID: VA }, fetchImpl: n.fetchImpl });
  assert.deepEqual(await tw.startVerification("+16235551234"), { sid: "VE1", status: "pending" });
  assert.equal(n.calls[0].url, `https://verify.twilio.com/v2/Services/${VA}/Verifications`);
  assert.deepEqual(Object.fromEntries(n.calls[0].init.body), { To: "+16235551234", Channel: "sms" });
  assert.equal(await tw.checkVerification("+16235551234", "123456"), true);
  assert.deepEqual(Object.fromEntries(n.calls[1].init.body), { To: "+16235551234", Code: "123456" });
  assert.equal(await tw.checkVerification("+16235551234", "000000"), false);
  assert.equal(await tw.checkVerification("+16235551234", "123456"), false, "404 = no pending code");
});

test("SendGrid email: plain text first, the office as reply-to, and the message id kept", async () => {
  const n = net([new Response(null, { status: 202, headers: { "X-Message-Id": "abc123" } })]);
  const tw = createTwilio({ env: { ...TWILIO_ENV, SENDGRID_FROM_NAME: "Dryer Vent Squad" }, fetchImpl: n.fetchImpl });
  const r = await tw.sendEmail({ to: "jane@example.com", toName: "Jane", subject: "You're booked", html: "<p>Hi</p>", text: "Hi", replyTo: "office@example.com", tags: { kind: "confirmation", ref: "DVS-1" } });
  assert.deepEqual(r, { id: "abc123" });
  const { url, init } = n.calls[0];
  assert.equal(url, "https://api.sendgrid.com/v3/mail/send");
  assert.equal(init.headers.Authorization, "Bearer SG.test-key");
  const body = JSON.parse(init.body);
  assert.deepEqual(body.personalizations, [{ to: [{ email: "jane@example.com", name: "Jane" }] }]);
  assert.deepEqual(body.from, { email: "bookings@example.com", name: "Dryer Vent Squad" });
  assert.deepEqual(body.reply_to, { email: "office@example.com" });
  assert.deepEqual(body.content.map((c) => c.type), ["text/plain", "text/html"]);
  assert.deepEqual(body.custom_args, { kind: "confirmation", ref: "DVS-1" });
});

test("a SendGrid refusal explains the usual cause", async () => {
  const n = net([new Response(JSON.stringify({ errors: [{ message: "The from address does not match a verified Sender Identity." }] }), { status: 403 })]);
  const tw = createTwilio({ env: TWILIO_ENV, fetchImpl: n.fetchImpl });
  await assert.rejects(tw.sendEmail({ to: "a@b.co", subject: "x", text: "y" }), /verified sender/);
});
