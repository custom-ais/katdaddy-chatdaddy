// The Emergency path (safety, then the office by phone; no same-day or after-hours booking), upsell rules, the recent-service discount, BOB's
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
const cleaningBase = ["Dryer Vent Cleaning", "85326", "Have Dryer", "No", "1-Story Home", "Electric Dryer", "Standard Floor Setup", "Dries in one normal cycle", "No signs"];

test("the Emergency button: safety first, then the office by phone; no same-day or after-hours offer", () => {
  const r = run(["Emergency", "Yes, everyone is safe", "No, it's turned off now"]);
  assert.equal(r.action, "call_office");
  assert.equal(r.phone, "(623) 294-1826");
  assert.equal(r.card, undefined, "no package offer");
  assert.doesNotMatch(r.reply, /after-hours|on-call|same-day|\$199|\$349/i);
  const typed = run(["Check after-hours availability"], r.session);
  assert.match(typed.reply, /call our office at \*\*\(623\) 294-1826\*\*/);
  assert.ok(!typed.session.afterHours, "after-hours can't be requested online");
  const office = run(["Emergency", "Yes, everyone is safe", "No, it's turned off now"], initialSession(), { ...config, phone: "(623) 555-0123" });
  assert.match(office.reply, /\*\*\(623\) 555-0123\*\*/, "the office phone in Settings is used when set");
});

test("asking for something sooner once a service is chosen gives the office's number; otherwise it doesn't", () => {
  const accepted = run([...cleaningBase, "Premium 1-2-3 · $179", "Accept"]).session;
  const sooner = run(["do you have anything sooner?"], { ...accepted, stage: "slots" });
  assert.match(sooner.reply, /^The times shown are our soonest openings\. If you need help sooner, please call our office at \*\*\(623\) 294-1826\*\*\./);
  assert.doesNotMatch(sooner.reply, /on-call|after-hours|\$199/);
  assert.equal(sooner.session.stage, "slots", "still on the regular times");
  assert.ok(!sooner.session.afterHours);
  const early = run(["Dryer Vent Cleaning", "anything sooner?"]);
  assert.doesNotMatch(early.reply, /call our office/, "not before the service is chosen");
});

test("no upgrades on nest or restoration visits; Ultimate gets only the fog", () => {
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


test("the opening menu is in the office's order; Something Else offers help choosing, questions, or the team", async () => {
  const { WELCOME } = await import("../shared/conversation.mjs");
  assert.deepEqual(WELCOME, ["Book a Cleaning", "Repairs, Reroutes & Upgrades", "Emergency", "Pest / Nest Removal", "Something Else"]);
  assert.equal(run(["Emergency"]).session.intent, "emergency");
  assert.equal(run(["Emergency Clog / Overheating"]).session.intent, "emergency", "the earlier label still works");
  assert.equal(run(["Book a Cleaning"]).session.intent, "cleaning");
  assert.equal(run(["Repairs, Reroutes & Upgrades"]).session.intent, "repair");
  assert.equal(run(["Pest / Nest Removal"]).session.intent, "nest");
  assert.equal(run(["Standard Vent Cleaning"]).session.intent, "cleaning", "older labels still work");
  const other = run(["Something Else"]);
  assert.deepEqual(other.options, ["Help Me Choose a Cleaning", "Ask a question", "Talk to the team"]);
  assert.equal(run(["Help Me Choose a Cleaning"], other.session).session.help, true);
  assert.equal(run(["Talk to the team"], other.session).action, "request");
});
