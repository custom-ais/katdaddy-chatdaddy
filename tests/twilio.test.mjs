import test from "node:test";
import assert from "node:assert/strict";
import { createTwilio } from "../server/twilio.mjs";
import { createIntegrationControls } from "../server/integration-controls.mjs";
import { createOwnerConsent } from "../server/owner-consent.mjs";
import { OWNER_SMS_CONSENT_VERSION } from "../shared/owner-sms-consent.mjs";

const sid = (prefix, digit = "a") => prefix + digit.repeat(32);
const env = { TWILIO_ACCOUNT_SID: sid("AC"), TWILIO_API_KEY_SID: sid("SK"), TWILIO_API_KEY_SECRET: "fake-test-secret", TWILIO_VERIFY_SERVICE_SID: sid("VA"), TWILIO_MESSAGING_SERVICE_SID: sid("MG"), TWILIO_SMS_SENDER_APPROVED: "true" };
const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
function harness(data = { sid: sid("VE"), status: "pending" }, overrides = {}) {
  const calls = [];
  const twilio = createTwilio({ env: { ...env, ...overrides }, fetchImpl: async (url, init) => { calls.push({ url, ...init, form: new URLSearchParams(init.body) }); return reply(data); } });
  return { twilio, calls };
}

for (const [channel, to] of [["sms", "+16235550100"], ["email", "customer@example.com"]]) {
  test(`Verify ${channel} uses the selected destination and attached service`, async () => {
    const { twilio, calls } = harness();
    assert.deepEqual(await twilio.sendVerification({ to, channel }), { sid: sid("VE"), status: "pending" });
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.url, `https://verify.twilio.com/v2/Services/${sid("VA")}/Verifications`);
    assert.deepEqual(Object.fromEntries(call.form), { To: to, Channel: channel });
    assert.equal(call.headers.Authorization, `Basic ${Buffer.from(`${sid("SK")}:fake-test-secret`).toString("base64")}`);
    assert.equal(call.redirect, "error");
    assert.ok(call.signal instanceof AbortSignal);
    assert.equal(JSON.stringify(twilio).includes("secret"), false);
  });
}

test("verification checks bind to the stored VE SID, not a new destination", async () => {
  const { twilio, calls } = harness({ sid: sid("VE"), status: "approved" });
  assert.deepEqual(await twilio.checkVerification({ sid: sid("VE"), code: "123456", to: "attacker@example.com" }), { sid: sid("VE"), status: "approved" });
  assert.equal(calls[0].url.endsWith("/VerificationCheck"), true);
  assert.deepEqual(Object.fromEntries(calls[0].form), { VerificationSid: sid("VE"), Code: "123456" });
});

test("pending is not treated as successful verification", async () => {
  const { twilio } = harness();
  assert.equal((await twilio.checkVerification({ sid: sid("VE"), code: "123456" })).status, "pending");
});

test("a mismatched verification SID or unexpected provider status fails closed", async () => {
  for (const result of [{ sid: sid("VE", "b"), status: "approved" }, { sid: sid("VE"), status: "surprise" }]) {
    await assert.rejects(harness(result).twilio.checkVerification({ sid: sid("VE"), code: "123456" }), { code: "TWILIO_BAD_RESPONSE" });
  }
  await assert.rejects(harness({ sid: sid("VE"), status: "approved" }).twilio.sendVerification({ to: "customer@example.com", channel: "email" }), { code: "TWILIO_BAD_RESPONSE" });
});

test("unconfigured or malformed configuration never calls the provider", async () => {
  for (const overrides of [{ TWILIO_ACCOUNT_SID: "" }, { TWILIO_API_KEY_SID: "bad" }, { TWILIO_API_KEY_SECRET: "" }, { TWILIO_VERIFY_SERVICE_SID: "VA../../evil" }]) {
    const { twilio, calls } = harness(undefined, overrides);
    assert.equal(twilio.verifyConfigured, false);
    await assert.rejects(twilio.sendVerification({ to: "+16235550100", channel: "sms" }), { code: "TWILIO_NOT_CONFIGURED" });
    assert.equal(calls.length, 0);
  }
});

test("invalid channels, destinations and codes never reach Twilio", async () => {
  const { twilio, calls } = harness();
  for (const data of [{ channel: "call", to: "+16235550100" }, { channel: "sms", to: "6235550100" }, { channel: "email", to: "bad" }]) await assert.rejects(twilio.sendVerification(data), { code: "INVALID_VERIFICATION_DESTINATION" });
  await assert.rejects(twilio.checkVerification({ sid: sid("VE"), code: "123&To=bad" }), { code: "INVALID_VERIFICATION_CODE" });
  await assert.rejects(twilio.checkVerification({ sid: "VEbad", code: "123456" }), { code: "INVALID_VERIFICATION_CODE" });
  assert.equal(calls.length, 0);
});

test("ordinary SMS requires an explicit approved sender, independently of Verify", async () => {
  for (const overrides of [{ TWILIO_SMS_SENDER_APPROVED: "false" }, { TWILIO_SMS_SENDER_APPROVED: "" }, { TWILIO_MESSAGING_SERVICE_SID: "" }]) {
    const { twilio, calls } = harness(undefined, overrides);
    assert.equal(twilio.verifyConfigured, true);
    assert.equal(twilio.messagingConfigured, false);
    await assert.rejects(twilio.sendSms("+16235550100", "Confirmation"), { code: "TWILIO_NOT_CONFIGURED" });
    assert.equal(calls.length, 0);
  }
  const { twilio, calls } = harness({ sid: sid("SM"), status: "accepted" });
  assert.deepEqual(await twilio.sendSms("+16235550100", "Confirmation"), { messageId: sid("SM"), status: "accepted" });
  assert.equal(calls[0].url, `https://api.twilio.com/2010-04-01/Accounts/${sid("AC")}/Messages.json`);
  assert.deepEqual(Object.fromEntries(calls[0].form), { To: "+16235550100", MessagingServiceSid: sid("MG"), Body: "Confirmation" });
});

test("provider and network errors are sanitized and never automatically retried", async () => {
  for (const mode of ["network", 400, 401, 404, 429, 500, "json"]) {
    let count = 0;
    const twilio = createTwilio({ env, fetchImpl: async () => {
      count++;
      if (mode === "network") throw new Error(`leak fake-test-secret customer@example.com`);
      if (mode === "json") return new Response("fake-test-secret", { status: 200 });
      return reply({ message: "fake-test-secret customer@example.com" }, mode);
    } });
    await assert.rejects(twilio.sendVerification({ to: "customer@example.com", channel: "email" }), (e) => {
      assert.equal(/fake-test-secret|customer@example.com/.test(String(e)), false);
      assert.ok(e.code.startsWith("TWILIO_"));
      return true;
    });
    assert.equal(count, 1);
  }
});

test('SMS dispatch guard is checked immediately before transport and failures never call or retry fetch',async()=>{
 let calls=0,checks=0;
 const twilio=createTwilio({env,fetchImpl:async()=>{calls++;return reply({sid:sid('SM'),status:'queued'});}});
 await assert.rejects(twilio.sendSms('+16235550100','Synthetic owner alert',{beforeSend:async()=>{checks++;throw new Error('private guard details');}}),{code:'TWILIO_UNAVAILABLE'});
 assert.equal(checks,1);assert.equal(calls,0);
});

test('real SMS transport observes consent revoked during the final integration read without forwarding callbacks to fetch',async()=>{
 const config={bookingOwnerSmsPhone:'+16235550100'};
 let receipt={active:true,phone:config.bookingOwnerSmsPhone,disclosureVersion:OWNER_SMS_CONSENT_VERSION};
 const consent=createOwnerConsent({store:{config:async()=>config,kvGet:async()=>receipt}});
 let checks=0,fetches=0,integrationReads=0,revokeAtRead=true;
 const beforeSend=async()=>{checks++;if(!await consent.allows(config.bookingOwnerSmsPhone))throw new Error('Synthetic owner consent revoked');};
 const controls=createIntegrationControls({store:{config:async()=>{integrationReads++;if(revokeAtRead)receipt={...receipt,active:false};return config;}}});
 const fetchImpl=controls.fetchFor('sms',async(...args)=>{fetches++;assert.equal(args.length,2);assert.equal(typeof args[0],'string');assert.equal(Object.hasOwn(args[1],'beforeSend'),false);return reply({sid:sid('SM'),status:'queued'});});
 const twilio=createTwilio({env,fetchImpl});
 await assert.rejects(twilio.sendSms(config.bookingOwnerSmsPhone,'Synthetic owner alert',{beforeSend}),{code:'TWILIO_UNAVAILABLE'});
 assert.equal(integrationReads,1);assert.equal(checks,2);assert.equal(fetches,0);assert.equal(receipt.active,false);
 revokeAtRead=false;receipt={...receipt,active:true};
 assert.deepEqual(await twilio.sendSms(config.bookingOwnerSmsPhone,'Synthetic owner alert',{beforeSend}),{messageId:sid('SM'),status:'queued'});
 assert.equal(fetches,1);assert.equal(integrationReads,2);assert.equal(checks,4);
});
