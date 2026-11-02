// Emergency pitch and after-hours option, upsell rules, the recent-service discount, BOB's
// explanation of his pick, and the confirmation email's upgrades.

import test from "node:test";
import assert from "node:assert/strict";
import { initialSession, turn, airflowSummary } from "../shared/conversation.mjs";
import { DEFAULT_CONFIG, INITIAL_FAQS, serviceQuote } from "../shared/domain.mjs";
import { foldDiscounts } from "../server/jobber.mjs";
import { confirmationEmail, emailUpsells } from "../server/messages.mjs";
import { harness, contact } from "./helpers.mjs";

const config = { ...DEFAULT_CONFIG, serviceZips: ["85326"], pricesAcknowledged: true };
const run = (steps, s = initialSession(), cfg = config) => { let r; for (const m of steps) { r = turn(m, s, cfg, INITIAL_FAQS); s = r.session; } return r; };
const emergency = ["Emergency Clog / Overheating", "No, it's turned off now", "Possible nest or blockage", "85326", "1-Story Home", "Electric Dryer"];

test("the emergency offer leads with Ultimate and offers the on-call tech; yes goes to the team", () => {
  const offer = run(emergency);
  assert.deepEqual(offer.card.picks.map((p) => p.family), ["ultimate", "premium"]);
  assert.match(offer.reply, /most comprehensive package.*clears the exterior termination.*DryerFlex.*3-year parts and labor warranty.*\$50 off that removal/s);
  assert.ok(offer.options.includes("Check after-hours availability"));
  const yes = run(["Check after-hours availability"], offer.session);
  assert.equal(yes.action, "request");
  assert.equal(yes.session.afterHours, true);
  assert.match(yes.reply, /on-call technician\. The after-hours premium is \$199 on top of Ultimate Protection \(\$299\)\..*Nothing is booked until they confirm\./s);
});

test("asking for something sooner once a service is chosen offers after-hours; otherwise it doesn't", () => {
  const accepted = run([...emergency, "Premium 1-2-3 · $179", "Standard Floor Setup", "Accept"]).session;
  const sooner = run(["do you have anything sooner?"], { ...accepted, stage: "slots" });
  assert.match(sooner.reply, /^The times shown are our soonest regular openings\. We do have an on-call technician.*\$199 in addition to the regular charges/s);
  assert.deepEqual(sooner.options, ["Check after-hours availability", "Keep regular times"]);
  const keep = run(["Keep regular times"], sooner.session);
  assert.equal(keep.session.stage, "slots", "back to the regular times");
  const early = run(["Dryer Vent Cleaning", "anything sooner?"]);
  assert.doesNotMatch(early.reply, /on-call/, "not before the service is chosen");
});

test("no upgrades on emergency, nest or restoration visits; Ultimate gets only the fog", () => {
  assert.equal(run([...emergency, "Ultimate Protection · $299", "Standard Floor Setup", "Accept"]).session.upsell, null, "emergency path");
  const nest = run(["There's a bird nest in my dryer vent", "85326", "Have Dryer Installed", "1-Story Home", "Electric Dryer", "Nest Removal + Cleaning · $389", "Accept"]);
  assert.equal(nest.session.upsell, null, "nest");
  const base = ["Dryer Vent Cleaning", "85326", "Have Dryer", "No", "1-Story Home", "Electric Dryer", "Standard Floor Setup", "Dries in one normal cycle", "No signs"];
  assert.deepEqual(Object.keys(run([...base, "Ultimate Protection · $299", "Accept"]).session.upsell), ["fogging"]);
});

test("a new or recently serviced dryer gets $20 off, said when they answer, and Jobber gets no negative line", () => {
  const home = { hasDryer: "Yes", stories: "1-story", power: "Electric", mount: "Standard", recentService: "Yes" };
  const q = serviceQuote("cleaning", DEFAULT_CONFIG, { package: "premium", property: home });
  assert.deepEqual(q.lineItems.map((l) => [l.name, l.cents]), [["Premium 1-2-3 See-It-Clean", 17900], ["New or recently serviced dryer discount", -2000]]);
  assert.equal(q.priceCents, 15900);
  assert.match(run(["Dryer Vent Cleaning", "85326", "Have Dryer", "Yes"]).reply, /^Thanks, a new or recently serviced dryer\. That takes \$20 off your cleaning\./);
  const folded = foldDiscounts(q.lineItems);
  assert.deepEqual(folded.map((l) => [l.name, l.cents]), [["Premium 1-2-3 See-It-Clean", 15900]]);
  assert.match(folded[0].description, /Includes New or recently serviced dryer discount: -\$20\./);
  assert.ok(folded.every((l) => l.cents >= 0));
});

test("BOB says why he picked the package, then introduces it", () => {
  const ult = airflowSummary({ symptoms: ["three"], hasDryer: "Yes" });
  assert.match(ult, /^Each load is taking three times or more as long to dry.*A restriction that significant usually means lint is packed deep in the line.*That's why I recommend \*\*Ultimate Protection\*\*, our most comprehensive package/s);
  assert.match(airflowSummary({ symptoms: ["two"], mount: "Stacked", hasDryer: "Yes" }), /With a stacked setup, the transition hose behind the dryer is often kinked or crushed\./);
  assert.match(airflowSummary({ symptoms: ["two"], hasDryer: "Yes" }), /I recommend \*\*Premium 1-2-3 See-It-Clean\*\*: a full-path cleaning/);
});

test("the confirmation email offers the upgrades with working links", () => {
  const cfg = { ...DEFAULT_CONFIG, pricesAcknowledged: true, phone: "623-294-1826", email: "office@example.test" };
  const appt = { id: "DVS-T1", customerName: "Jane Doe", package: "Premium 1-2-3 See-It-Clean", packageId: "premium", route: "cleaning", lineItems: [{ id: "premium-1", name: "Premium 1-2-3 See-It-Clean", cents: 17900 }], price: 179, scheduledAt: "2026-11-10T17:00:00Z", address: "1 Main St", city: "Buckeye", zip: "85326", property: { hasDryer: "Yes", stories: "1-story" } };
  const { html, text } = confirmationEmail(appt, cfg);
  assert.deepEqual(emailUpsells(appt, cfg).map((u) => u.key), ["dryerflex", "fogging", "ultimate"]);
  assert.match(text, /DryerFlex hose upgrade: \$99 → \$79\..*backed by our 3-year warranty\. Learn more: https:\/\/www\.dryerflex\.com/s);
  const links = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
  assert.ok(links.includes("https://www.dryerflex.com"));
  assert.ok(links.includes("tel:+16232941826"), "phone links dial on any phone");
  assert.ok(links.some((l) => l.startsWith("mailto:office@example.test?subject=Add%20DryerFlex%20hose%20upgrade%20to%20my%20visit%20DVS-T1")));
  assert.equal(emailUpsells({ ...appt, lineItems: [...appt.lineItems, { id: "addon-dryerflex" }] }, cfg).some((u) => u.key === "dryerflex"), false, "not offered again once added");
  assert.equal(emailUpsells({ ...appt, packageId: "emergency", urgency: "high" }, cfg).length, 0);
});

test("an after-hours request is marked, priced and emailed to the on-call contact", async (t) => {
  const sendgrid = { configured: true, calls: [], async sendEmail(to, m) { this.calls.push({ to, ...m }); return { status: "accepted" }; } };
  const h = await harness(t, { sendgrid, env: { BOOKING_EMAIL_PROVIDER: "sendgrid" }, config: { pricesAcknowledged: true, approver: { name: "Seth", phone: "", email: "oncall@example.test" } } });
  const token = await h.fresh();
  for (const m of [...emergency.slice(0, 3), "85326", "1-Story Home", "Electric Dryer", "Check after-hours availability"]) await h.chat(token, m);
  const r = await h.call("/api/requests", { method: "POST", token, body: { name: contact.name, phone: contact.phone, email: "", zip: "85326", message: "After-hours emergency visit requested.", preference: "phone", idempotencyKey: "after-hours-request-0001" } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const [saved] = (await h.store.requests()).filter((x) => x.kind === "after_hours");
  assert.ok(saved, "saved as an after-hours request");
  assert.match(saved.message, /^AFTER-HOURS EMERGENCY REQUEST: Ultimate Protection \(\$299\) \+ after-hours premium \$199\./);
  const mail = sendgrid.calls.find((c) => c.to === "oncall@example.test");
  assert.ok(mail, "the on-call contact is emailed");
  assert.match(mail.subject, /^After-hours emergency request: /);
});

test("the opening menu is in the office's order; Something Else offers help choosing, questions, or the team", async () => {
  const { WELCOME } = await import("../shared/conversation.mjs");
  assert.deepEqual(WELCOME, ["Book a Cleaning", "Repairs, Reroutes & Upgrades", "Emergency Clog / Overheating", "Pest / Nest Removal", "Something Else"]);
  assert.equal(run(["Book a Cleaning"]).session.intent, "cleaning");
  assert.equal(run(["Repairs, Reroutes & Upgrades"]).session.intent, "repair");
  assert.equal(run(["Pest / Nest Removal"]).session.intent, "nest");
  assert.equal(run(["Standard Vent Cleaning"]).session.intent, "cleaning", "older labels still work");
  const other = run(["Something Else"]);
  assert.deepEqual(other.options, ["Help Me Choose a Cleaning", "Ask a question", "Talk to the team"]);
  assert.equal(run(["Help Me Choose a Cleaning"], other.session).session.help, true);
  assert.equal(run(["Talk to the team"], other.session).action, "request");
});
