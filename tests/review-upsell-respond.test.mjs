// Upsells on the review screen (after the time is picked, before Confirm), and the after-hours email's
// one-tap Yes / No answers.

import test from "node:test";
import assert from "node:assert/strict";
import { harness, contact, baseTime } from "./helpers.mjs";

async function held(h) {
  const token = await h.accept("cleaning");
  await h.contactAndVerify(token, contact);
  const r = await h.hold(token, (await h.slots(token))[0].scheduledAt);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return { token, hold: r.data.hold };
}

test("add-ons picked on the review screen re-price the held time, and the booking carries them", async (t) => {
  const h = await harness(t, { config: { pricesAcknowledged: true } });
  const { token, hold } = await held(h);
  assert.deepEqual(hold.quote.lineItems.map((l) => l.cents), [17900], "Premium, nothing added yet");

  const both = await h.call("/api/holds/extras", { method: "POST", token, body: { holdId: hold.id, dryerflex: true, fogging: true } });
  assert.equal(both.status, 200, JSON.stringify(both.data));
  assert.deepEqual(both.data.hold.quote.lineItems.map((l) => [l.name, l.cents]), [["Premium 1-2-3 See-It-Clean", 17900], ["DryerFlex Transition Hose Upgrade", 7900], ["Sanitation Fogging Add-On (bundle price with DryerFlex)", 5900]]);
  assert.deepEqual(both.data.extras, { dryerflex: true, fogging: true, ultimate: false });

  const up = await h.call("/api/holds/extras", { method: "POST", token, body: { holdId: hold.id, dryerflex: true, fogging: true, ultimate: true } });
  assert.deepEqual(up.data.hold.quote.lineItems.map((l) => [l.name, l.cents]), [["Ultimate Protection", 29900], ["Sanitation Fogging Add-On", 7900]], "Ultimate includes DryerFlex");
  assert.deepEqual(up.data.extras, { dryerflex: false, fogging: true, ultimate: true });

  const back = await h.call("/api/holds/extras", { method: "POST", token, body: { holdId: hold.id, fogging: true } });
  assert.deepEqual(back.data.hold.quote.lineItems.map((l) => l.cents), [17900, 7900], "turning Ultimate off goes back to Premium");

  const booked = await h.confirm(token, back.data.hold);
  assert.equal(booked.status, 201, JSON.stringify(booked.data));
  const appt = (await h.store.appointments()).at(-1);
  assert.equal(appt.packageId, "premium");
  assert.deepEqual(appt.lineItems.map((l) => l.cents), [17900, 7900]);

  assert.equal((await h.call("/api/holds/extras", { method: "POST", token, body: { holdId: "HOLD-NOPE", fogging: true } })).status, 409);
});

async function afterHoursRequest(h) {
  const token = await h.fresh();
  for (const m of ["Emergency Clog / Overheating", "No, it's turned off now", "Possible nest or blockage", "85326", "1-Story Home", "Electric Dryer", "Check after-hours availability", "Standard Floor Setup"]) await h.chat(token, m);
  await h.contactAndVerify(token, contact);
  const sent = await h.call("/api/approvals/after-hours", { method: "POST", token, body: { approved: true } });
  assert.equal(sent.status, 201, JSON.stringify(sent.data));
  return { token, approval: sent.data.approval };
}
const linkFrom = (html, label) => {
  const m = html.match(new RegExp(`href="([^"]+)"[^>]*>${label}<`));
  return m && new URL(m[1].replace(/&amp;/g, "&"));
};


