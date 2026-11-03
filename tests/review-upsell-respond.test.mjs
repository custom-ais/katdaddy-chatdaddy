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

test("the after-hours email is branded and its Yes button books it from a no-login page", async (t) => {
  const mail = { configured: true, calls: [], async sendEmail(to, m) { this.calls.push({ to, ...m }); return { status: "accepted" }; } };
  const h = await harness(t, { sendgrid: mail, env: { BOOKING_EMAIL_PROVIDER: "sendgrid" }, config: { pricesAcknowledged: true, approver: { name: "Seth", phone: "", email: "oncall@example.test" } } });
  const { token, approval } = await afterHoursRequest(h);
  const email = mail.calls.find((c) => c.to === "oncall@example.test");
  assert.match(email.html, /Dryer Vent Squad · West Valley/);
  assert.match(email.html, /After-hours emergency request/);
  assert.match(email.html, /Can you get there tonight\?/);
  const yes = linkFrom(email.html, "Yes, I can go"), no = linkFrom(email.html, "No, can't make it");
  assert.equal(yes.pathname, "/respond");
  assert.equal(yes.searchParams.get("a"), approval.id);
  assert.equal(yes.searchParams.get("c"), "yes");
  assert.equal(no.searchParams.get("c"), "no");
  assert.match(email.text, /YES, I can go \(pick the arrival time\): \S+\/respond\?a=APR-/);

  const sig = yes.searchParams.get("s");
  assert.equal((await h.call(`/api/approvals/respond?a=${approval.id}&s=wrong`)).status, 404, "a bad signature is refused");
  const view = await h.call(`/api/approvals/respond?a=${approval.id}&s=${sig}`);
  assert.equal(view.status, 200, JSON.stringify(view.data));
  assert.equal(view.data.request.status, "pending", "opening the link changes nothing");
  assert.ok(view.data.technicians.some((x) => x.id === "tech-ryan"));
  assert.equal(view.data.approverName, "Seth");

  const ok = await h.call("/api/approvals/respond", { method: "POST", body: { a: approval.id, s: sig, decision: "approve", arrivalAt: baseTime + 6 * 3600_000, technicianId: "tech-ryan", name: "Seth" } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.request.status, "booked");
  assert.equal(ok.data.request.technicianName, "Ryan Boucher");
  const current = await h.call("/api/approvals/current", { token });
  assert.ok(current.data.receipt, "the customer's chat shows the confirmation");
  const saved = await h.store.approval(approval.id);
  assert.equal(saved.decision.via, "email_link");
  assert.equal(saved.decision.by, "Seth");

  const twice = await h.call("/api/approvals/respond", { method: "POST", body: { a: approval.id, s: sig, decision: "decline" } });
  assert.equal(twice.status, 409);
  assert.match(twice.data.error, /already answered/);
});

test("the No button tells the customer and offers regular times; links stop working once the request closes", async (t) => {
  const mail = { configured: true, calls: [], async sendEmail(to, m) { this.calls.push({ to, ...m }); return { status: "accepted" }; } };
  const h = await harness(t, { sendgrid: mail, env: { BOOKING_EMAIL_PROVIDER: "sendgrid" }, config: { pricesAcknowledged: true, approver: { name: "Seth", phone: "", email: "oncall@example.test" } } });
  const first = await afterHoursRequest(h);
  const no = linkFrom(mail.calls.at(-1).html, "No, can't make it");
  const r = await h.call("/api/approvals/respond", { method: "POST", body: { a: first.approval.id, s: no.searchParams.get("s"), decision: "decline" } });
  assert.equal(r.data.request.status, "declined");
  assert.equal((await h.call("/api/approvals/current", { token: first.token })).data.approval.status, "declined");

  const second = await afterHoursRequest(h);
  const yes = linkFrom(mail.calls.at(-1).html, "Yes, I can go");
  h.advance(31 * 60_000);
  const late = await h.call("/api/approvals/respond", { method: "POST", body: { a: second.approval.id, s: yes.searchParams.get("s"), decision: "approve", arrivalAt: baseTime + 7 * 3600_000, technicianId: "tech-ryan" } });
  assert.equal(late.status, 409);
  assert.match(late.data.error, /already closed/);
});
