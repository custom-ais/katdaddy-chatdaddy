import test from "node:test";
import assert from "node:assert/strict";
import { initialSession, turn } from "../shared/conversation.mjs";
import { DEFAULT_CONFIG, INITIAL_FAQS, serviceQuote, bookingQuote } from "../shared/domain.mjs";
import { SERVICE_CATALOG } from "../shared/catalog.mjs";

const config = { ...DEFAULT_CONFIG, serviceZips: ["85326"], pricesAcknowledged: true, scheduleAcknowledged: true, bookingEnabled: true };
const say = (messages, cfg = config) => {
  let s = initialSession(), r;
  for (const m of messages) {
    r = turn(m, s, cfg, INITIAL_FAQS);
    s = r.session;
  }
  return r;
};
// Evaluation answers for a home with a dryer (zip, dryer, 12 months, stories, [floor], gas/electric, mount, symptoms, animals).
const home = (stories, floor, power, symptom = "Dries in one normal cycle") =>
  ["85326", "Have Dryer", "No", stories, ...(stories === "2-Story" ? [floor] : []), power, "Standard", symptom, "No signs"];

test("the package offer shows Premium 1-2-3 and Ultimate Protection with prices for this home", () => {
  const r = say(["Dryer Vent Cleaning", ...home("1-Story", null, "Electric")]);
  assert.deepEqual(r.options, ["Select Premium 1-2-3 ⭐ ($179)", "Select Ultimate Protection ($299)", "Compare Packages", "More services"]);
  assert.match(r.reply, /live camera inspection/);
  assert.equal(r.suggested, "Select Premium 1-2-3 ⭐ ($179)");
  // The card opens on the airflow estimate, then BOB's pick, then the other package.
  assert.equal(r.card.airflow.level, "clear");
  assert.deepEqual(r.card.picks.map((p) => [p.family, p.price, p.recommended]), [["premium", "$179", true], ["ultimate", "$299", false]]);
});

test("picking a package shows its details; Accept moves to contact", () => {
  const picked = say(["Dryer Vent Cleaning", ...home("1-Story", null, "Electric"), "Ultimate Protection · $299"]);
  assert.equal(picked.session.package, "ultimate");
  assert.equal(picked.session.serviceAccepted, false);
  assert.deepEqual(picked.options.slice(0, 1), ["Accept"]);
  const accepted = turn("Accept", picked.session, config, INITIAL_FAQS);
  assert.equal(accepted.action, "contact");
});

test("exact price comes from the home: 2-story, upstairs laundry, gas dryer", () => {
  const r = say(["Dryer Vent Cleaning", ...home("2-Story", "2nd Floor", "Gas"), "Premium 1-2-3 · $199"]);
  assert.match(r.reply, /\*\*Premium 1-2-3 See-It-Clean \(2 Story, Upstairs\) — \$248\*\*/, "the title shows the final calculated price");
  assert.match(r.reply, /Premium 1-2-3 See-It-Clean \(2 Story, Upstairs\): \$199/);
  assert.match(r.reply, /Gas Appliance Safety Procedure: \$49\n\*\*Total: \$248\*\*/);
});

test("1-story electric home gets the base price with no gas fee", () => {
  const r = say(["Dryer Vent Cleaning", ...home("1-Story", null, "Electric"), "Premium 1-2-3 · $179"]);
  assert.match(r.reply, /Premium 1-2-3 See-It-Clean — \$179/);
  assert.doesNotMatch(r.reply, /Gas Appliance/);
});

test("a package picked before the questions still asks them, then shows exact details", () => {
  const r = say(["Ultimate Protection", ...home("2-Story", "1st Floor", "Electric").filter((m) => m !== "Dries in one normal cycle")]);
  assert.equal(r.session.stage, "details");
  assert.match(r.reply, /Ultimate Protection \(2 Story\) — \$339/);
});

test("no dryer installed turns a See-It-Clean pick into Express", () => {
  const r = say(["Ultimate Protection", "85326", "No Dryer", "1-Story", "Side Wall Vent", "No signs"]);
  assert.match(r.reply, /Express Vent Cleaning/);
  assert.match(r.reply, /\$149/);
  assert.equal(r.session.package, "express");
});

test("birds or a nest offer Nest Removal and Full System Restoration", () => {
  const r = say(["There's a bird nest in my dryer vent", "85326", "Have Dryer Installed", "1-Story Home", "Electric Dryer"]);
  assert.deepEqual(r.options.slice(0, 2), ["Nest Removal + Cleaning · $389", "Full System Restoration · $599"]);
  assert.deepEqual(r.card.picks.map((p) => p.family), ["nest", "restoration"]);
  const picked = turn("Full System Restoration · $599", r.session, config, INITIAL_FAQS);
  assert.equal(picked.session.package, "restoration");
});

test("an urgent clog offers Emergency Same-Day Clog Relief", () => {
  const r = say(["My dryer vent is completely clogged, I need help asap", "No, it's turned off now", "Possible nest or blockage", "85326", "1-Story Home", "Electric Dryer"]);
  assert.equal(r.options[0], "Emergency Same-Day · $349");
  const regular = turn("Schedule regular cleaning", r.session, config, INITIAL_FAQS);
  assert.equal(regular.session.intent, "cleaning");
  assert.equal(regular.session.pending, "recentService", "answers already given are kept (\"my dryer\" means one is installed)");
});

test("More services lists the Safety Inspection, Express, Post-Service, Nest, Restoration and Emergency", () => {
  const r = say(["Dryer Vent Cleaning", "More services"]);
  assert.deepEqual(r.options, ["Safety Inspection · $119+", "Express · $149+", "Post-Service · $159+", "Nest Removal + Cleaning · $389", "Full System Restoration · $599", "Emergency Same-Day · $349", "Back to packages"]);
});

test("unreviewed prices are not shown in the package menu", () => {
  const r = say(["Dryer Vent Cleaning", ...home("1-Story", null, "Electric")], { ...config, pricesAcknowledged: false });
  assert.doesNotMatch(r.reply, /\$(179|299)/);
  assert.match(r.reply, /verify/);
});

test("the $119 assessment stays fixed, and is half off when added to a cleaning", () => {
  const gas = { power: "Gas", stories: "1-story", hasDryer: "Yes" };
  assert.equal(serviceQuote("assessment", config, { property: gas }).priceCents, 11900, "no gas fee on a standalone assessment");
  const both = serviceQuote("bundle", config, { package: "premium", property: gas });
  assert.equal(both.priceCents, 17900 + 4900 + 5950, "the cleaning keeps its gas fee; the assessment is $59.50");
  assert.equal(both.lineItems.find((l) => l.id === "assessment-with-cleaning").cents, 5950);
  const q = bookingQuote("cleaning", config, { package: "restoration", property: gas, addOns: { fogging: true, toolRetrieval: true }, travelFeeCents: 2500 });
  assert.deepEqual(q.lineItems.map((l) => l.id), ["restoration", "addon-gas", "addon-tool", "travel-fee"], "fogging already included in Restoration");
  assert.equal(q.totalCents, 59900 + 4900 + 6900 + 2500);
  assert.equal(q.durationMins, 150 + 15 + 30);
});
