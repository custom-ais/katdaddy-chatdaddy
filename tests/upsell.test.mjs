// End-of-booking upsell: DryerFlex ($79, regular $99), the sanitizing fog, $20 off both, and the
// Ultimate upgrade for Premium.

import test from "node:test";
import assert from "node:assert/strict";
import { serviceQuote, DEFAULT_CONFIG, INITIAL_FAQS } from "../shared/domain.mjs";
import { initialSession, turn } from "../shared/conversation.mjs";
import { harness, contact } from "./helpers.mjs";

const home = { hasDryer: "Yes", stories: "1-story", power: "Electric", mount: "Standard" };
const lines = (pkg, addOns, property = home, route = "cleaning") => serviceQuote(route, DEFAULT_CONFIG, { package: pkg, property, addOns }).lineItems.map((l) => [l.name, l.cents]);

test("DryerFlex is a $79 add-on, and with the sanitizing fog the fog line drops $20", () => {
  assert.deepEqual(lines("premium", { dryerflex: true }), [["Premium 1-2-3 See-It-Clean", 17900], ["DryerFlex Transition Hose Upgrade", 7900]]);
  assert.deepEqual(lines("premium", { dryerflex: true, fogging: true }), [["Premium 1-2-3 See-It-Clean", 17900], ["DryerFlex Transition Hose Upgrade", 7900], ["Sanitation Fogging Add-On (bundle price with DryerFlex)", 5900]]);
  assert.deepEqual(lines("premium", { fogging: true }), [["Premium 1-2-3 See-It-Clean", 17900], ["Sanitation Fogging Add-On", 7900]], "no deal without DryerFlex");
  assert.deepEqual(lines("ultimate", { dryerflex: true, fogging: true }), [["Ultimate Protection", 29900], ["Sanitation Fogging Add-On", 7900]], "Ultimate already includes DryerFlex, so no deal either");
  assert.ok(!lines("premium", { dryerflex: true }, { ...home, hasDryer: "No" }).some(([n]) => /DryerFlex/.test(n)), "no dryer, no hose");
  assert.equal(lines("premium", { dryerflex: true, fogging: true }, home, "bundle").at(-1)[0], "Repair Assessment (with cleaning)", "Cleaning + Assessment gets the add-ons too");
  assert.ok(lines("premium", { dryerflex: true, fogging: true }, home, "bundle").some(([n, c]) => /bundle price/.test(n) && c === 5900));
});

const config = { ...DEFAULT_CONFIG, serviceZips: ["85326"], pricesAcknowledged: true };
const run = (steps, cfg = config) => { let s = initialSession(), r; for (const m of steps) { r = turn(m, s, cfg, INITIAL_FAQS); s = r.session; } return r; };
const base = ["Dryer Vent Cleaning", "85326", "Have Dryer", "No", "1-Story Home", "Electric Dryer", "Standard Floor Setup", "Dries in one normal cycle", "No signs"];

test("the offer is priced for the home and package, and left out when it can't apply", () => {
  const premium = run([...base, "Premium 1-2-3 · $179", "Accept"]).session.upsell;
  assert.deepEqual(premium.dryerflex && [premium.dryerflex.cents, premium.dryerflex.wasCents], [7900, 9900]);
  assert.equal(premium.fogging.cents, 7900);
  assert.equal(premium.bundleSavingsCents, 2000);
  assert.equal(premium.ultimate.extraCents, 12000);
  const ultimate = run([...base, "Ultimate Protection · $299", "Accept"]).session.upsell;
  assert.equal(ultimate.dryerflex, undefined, "Ultimate includes DryerFlex");
  assert.equal(ultimate.ultimate, undefined);
  assert.equal(ultimate.fogging.cents, 7900);
  assert.equal(run([...base, "Premium 1-2-3", "Accept"], { ...config, pricesAcknowledged: false }).session.upsell, null, "no prices, no promo");
});

test("the contact step takes DryerFlex and the fog, or the Ultimate upgrade, into the quote", async (t) => {
  const h = await harness(t, { config: { pricesAcknowledged: true } });
  const book = async (extra) => {
    const token = await h.accept("cleaning");
    const r = await h.call("/api/contact", { method: "POST", token, body: { ...contact, ...extra } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    await h.contactAndVerify(token, { ...contact, ...extra });
    const held = await h.hold(token, (await h.slots(token))[0].scheduledAt);
    assert.equal(held.status, 201, JSON.stringify(held.data));
    return held.data.hold.quote;
  };
  const both = await book({ addOns: { dryerflex: true, fogging: true } });
  assert.deepEqual(both.lineItems.map((l) => l.cents), [17900, 7900, 5900]);
  assert.equal(both.totalCents, 31700);
  const up = await book({ upgrade: "ultimate", addOns: { dryerflex: true, fogging: true } });
  assert.deepEqual(up.lineItems.map((l) => [l.name, l.cents]), [["Ultimate Protection", 29900], ["Sanitation Fogging Add-On", 7900]], "upgraded, and DryerFlex comes with it");
});
