// Settings → Upsells at checkout: which add-on offers show on the review screen (and in the
// confirmation email), what they say, and the bundle deal. Prices stay in the Services table.

import test from "node:test";
import assert from "node:assert/strict";
import { serviceQuote, DEFAULT_CONFIG, INITIAL_FAQS, validateConfig, withConfigDefaults } from "../shared/domain.mjs";
import { DEFAULT_UPSELLS } from "../shared/catalog.mjs";
import { initialSession, turn } from "../shared/conversation.mjs";
import { emailUpsells } from "../server/messages.mjs";
import { harness, contact } from "./helpers.mjs";

const home = { hasDryer: "Yes", stories: "1-story", power: "Electric", mount: "Standard" };
const base = ["Dryer Vent Cleaning", "85326", "Have Dryer", "No", "1-Story Home", "Electric Dryer", "Standard Floor Setup", "Dries in one normal cycle", "No signs"];
const withUpsells = (upsells) => withConfigDefaults({ ...DEFAULT_CONFIG, serviceZips: ["85326"], pricesAcknowledged: true, upsells });
const offer = (cfg) => { let s = initialSession(), r; for (const m of [...base, "Premium 1-2-3 · $179", "Accept"]) { r = turn(m, s, cfg, INITIAL_FAQS); s = r.session; } return r.session.upsell; };
const fogLine = (cfg) => serviceQuote("cleaning", cfg, { package: "premium", property: home, addOns: { dryerflex: true, fogging: true } }).lineItems.find((l) => l.id === "addon-fogging");
const appt = { id: "DVS-T1", customerName: "Jane Doe", package: "Premium 1-2-3 See-It-Clean", packageId: "premium", route: "cleaning", lineItems: [{ id: "premium-1", name: "Premium 1-2-3 See-It-Clean", cents: 17900 }], price: 179, scheduledAt: "2026-11-10T10:00:00-07:00", property: home };

test("by default the offer carries the office's current wording, and saved settings missing a field get the default", () => {
  const up = offer(withUpsells(undefined));
  assert.equal(up.dryerflex.title, "DryerFlex hose upgrade");
  assert.equal(up.dryerflex.badge, "Online booking special");
  assert.deepEqual(up.dryerflex.points.length, 4);
  assert.equal(up.dryerflex.points[0], "Backed by our 3-year warranty");
  assert.equal(up.dryerflex.learnMore, "https://www.dryerflex.com");
  assert.equal(up.dryerflex.wasCents, 9900);
  assert.equal(up.fogging.title, "Sanitizing fog treatment");
  assert.match(up.fogging.description, /antimicrobial fogging/);
  assert.equal(up.bundleSavingsCents, 2000);
  assert.match(up.ultimate.pitch, /exterior termination cleanout/);
  // A config saved with only one upsell field keeps every other default.
  const partial = withConfigDefaults({ upsells: { dryerflexTitle: "Flex hose" } }).upsells;
  assert.deepEqual(partial, { ...DEFAULT_UPSELLS, dryerflexTitle: "Flex hose" });
  assert.deepEqual(validateConfig({ ...DEFAULT_CONFIG }).filter((e) => /upsell|DryerFlex/i.test(e)), []);
});

test("edited wording, the regular price and the deal amount reach the offer and the price", () => {
  const cfg = withUpsells({ dryerflexTitle: "Flex hose", dryerflexBadge: "", dryerflexPoints: "Lasts for years\n\n  Never kinks  \n", dryerflexWasCents: 0, dryerflexLink: "", foggingTitle: "Vent fog", foggingDescription: "Freshens the line.", bundleSavingsCents: 1500, ultimatePitch: "the works" });
  const up = offer(cfg);
  assert.deepEqual({ title: up.dryerflex.title, badge: up.dryerflex.badge, points: up.dryerflex.points }, { title: "Flex hose", badge: "", points: ["Lasts for years", "Never kinks"] });
  assert.equal(up.dryerflex.wasCents, undefined, "no crossed-out price at $0");
  assert.equal(up.dryerflex.learnMore, undefined, "blank link hides it");
  assert.equal(up.dryerflex.cents, 7900, "the price still comes from the Services table");
  assert.deepEqual([up.fogging.title, up.fogging.description], ["Vent fog", "Freshens the line."]);
  assert.equal(up.bundleSavingsCents, 1500);
  assert.equal(up.ultimate.pitch, "the works");
  assert.equal(fogLine(cfg).cents, 7900 - 1500, "the booked price uses the same deal");
  const email = emailUpsells(appt, cfg);
  assert.deepEqual(email.map((u) => [u.key, u.title]), [["dryerflex", "Flex hose"], ["fogging", "Vent fog"], ["ultimate", "Upgrade to Ultimate Protection"]]);
  assert.equal(email[0].text, "Lasts for years. Never kinks.");
  assert.equal(email[0].learnMore, undefined);
  assert.equal(email[2].text, "Adds the works.");
});

test("a hidden offer is left out of the review screen, the email, and the deal", () => {
  const noFlex = withUpsells({ dryerflexEnabled: false });
  const up = offer(noFlex);
  assert.equal(up.dryerflex, undefined);
  assert.equal(up.bundleSavingsCents, undefined, "no deal without both offers");
  assert.ok(up.fogging && up.ultimate);
  assert.equal(fogLine(noFlex).cents, 7900, "no bundle price either");
  assert.deepEqual(emailUpsells(appt, noFlex).map((u) => u.key), ["fogging", "ultimate"]);

  const noDeal = withUpsells({ bundleEnabled: false });
  assert.equal(offer(noDeal).bundleSavingsCents, undefined);
  assert.equal(fogLine(noDeal).cents, 7900);
  assert.equal(fogLine(noDeal).name, "Sanitation Fogging Add-On", "no bundle wording on the line item");

  const noUltimate = withUpsells({ ultimateEnabled: false, foggingEnabled: false });
  assert.deepEqual(Object.keys(offer(noUltimate)).sort(), ["dryerflex"]);
  assert.deepEqual(emailUpsells(appt, noUltimate).map((u) => u.key), ["dryerflex"]);

  const none = withUpsells({ dryerflexEnabled: false, foggingEnabled: false, ultimateEnabled: false });
  assert.equal(offer(none), null);
  assert.deepEqual(emailUpsells(appt, none), []);
});

test("Settings checks the upsell wording, link and amounts", () => {
  const errors = (upsells) => validateConfig({ ...DEFAULT_CONFIG, upsells: { ...DEFAULT_UPSELLS, ...upsells } }).filter((e) => /upsell|DryerFlex/i.test(e));
  assert.deepEqual(errors({}), []);
  assert.deepEqual(errors({ dryerflexLink: "" }), [], "a blank link is allowed");
  assert.equal(errors({ dryerflexTitle: "  " }).length, 1);
  assert.equal(errors({ dryerflexLink: "javascript:alert(1)" }).length, 1);
  assert.equal(errors({ dryerflexLink: "http://www.dryerflex.com" }).length, 1, "https only");
  assert.equal(errors({ dryerflexBadge: "x".repeat(41) }).length, 1);
  assert.equal(errors({ ultimatePitch: "" }).length, 1);
  assert.equal(errors({ bundleSavingsCents: -100 }).length, 1);
  assert.equal(errors({ dryerflexWasCents: 12.5 }).length, 1);
  assert.equal(errors({ foggingEnabled: "yes" }).length, 1);
});

test("an owner edits upsells in Settings, and the next customer sees the change; hidden add-ons can't be added", async (t) => {
  const h = await harness(t, { config: { pricesAcknowledged: true } });
  const cookie = await h.login();
  const before = await h.call("/api/admin/data", { cookie });
  assert.equal(before.status, 200);
  assert.equal(before.data.config.upsells.dryerflexTitle, "DryerFlex hose upgrade", "Settings loads the current wording");
  const version = before.data.config.version;
  const saved = await h.call("/api/admin/config", { method: "PATCH", cookie, body: { version, upsells: { dryerflexEnabled: false, foggingTitle: "Vent fog" } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const stored = (await h.store.config()).upsells;
  assert.equal(stored.dryerflexEnabled, false);
  assert.equal(stored.foggingTitle, "Vent fog");
  assert.equal(stored.ultimatePitch, DEFAULT_UPSELLS.ultimatePitch, "untouched fields are kept");
  const bad = await h.call("/api/admin/config", { method: "PATCH", cookie, body: { version: (await h.store.config()).version, upsells: { dryerflexLink: "javascript:alert(1)" } } });
  assert.equal(bad.status, 400);

  // The public chat config no longer lists DryerFlex as an add-on.
  const session = await h.call("/api/session", { method: "POST", body: {} });
  assert.deepEqual(session.data.config.addOns.map((a) => a.key), ["fogging", "toolRetrieval"]);

  const token = await h.accept("cleaning");
  await h.contactAndVerify(token, { ...contact, addOns: { dryerflex: true, fogging: true } });
  const held = await h.hold(token, (await h.slots(token))[0].scheduledAt);
  assert.equal(held.status, 201, JSON.stringify(held.data));
  assert.ok(!held.data.hold.quote.lineItems.some((l) => l.id === "addon-dryerflex"), "a hidden offer isn't taken from the details form");
  const extras = await h.call("/api/holds/extras", { method: "POST", token, body: { holdId: held.data.hold.id, dryerflex: true, fogging: true } });
  assert.equal(extras.status, 200, JSON.stringify(extras.data));
  assert.equal(extras.data.extras.dryerflex, false, "or on the review screen");
  assert.deepEqual(extras.data.hold.quote.lineItems.map((l) => [l.id, l.cents]), [["premium-1", 17900], ["addon-fogging", 7900]]);
});
