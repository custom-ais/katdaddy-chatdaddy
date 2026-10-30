// DVS West Valley service catalog (from ChatDaddy-Services_For_Jobber.csv, Oct 29 2026).
// Names match the Jobber Products & Services list exactly so booked line items line up.
// Prices and minutes are editable in BOB's admin; these are the starting values.

import { restrictionScore } from "./airflow.mjs";

// Package wording follows the website's pricing cards (dryerventsquadaz.com, Oct 30 2026).
const PREMIUM = "Live camera inspection before cleaning, lint screen and dryer cavity cleaning, full-path rotary brush cleaning from the appliance to the termination, sealed HEPA-filter vacuum system with no blow-back into the home, post-clean camera verification";
const ULTIMATE = "Everything in Premium 1-2-3 See-It-Clean, plus exterior termination cleanout for maximum airflow, DryerFlex transition upgrade with professional installation, before-and-after photo documentation, 3-year warranty on parts and labor, complimentary 4-pack of reusable wool dryer balls. Complete clogs and nest removals are excluded from the package but receive $50 off if removal is needed";
const INSPECTION = "Full visual inspection of the entire dryer vent system, in-duct camera inspection with photo documentation, airflow velocity testing to detect restriction, exterior termination (hood or roof) inspection, marked-up photo report with expert recommendations, itemized repair estimate if needed. The inspection fee applies toward approved repairs";
const EXPRESS = "Vent-only cleaning with no appliance present, live camera inspection during service";
const POST = "Vent cleaning plus disconnect and reconnect dryer, before-and-after photos, airflow verification; does not include lint screen, lint cavity, or dryer drum cleaning";

const s = (id, family, variant, name, description, category, dollars, minutes) => ({
  id, family, variant, name, description, category, priceCents: Math.round(dollars * 100), minutes, active: true,
});

export const SERVICE_CATALOG = [
  s("premium-1", "premium", "1-story", "Premium 1-2-3 See-It-Clean", PREMIUM, "Cleaning", 179, 60),
  s("premium-2", "premium", "2-story", "Premium 1-2-3 See-It-Clean (2 Story)", `${PREMIUM}—First floor laundry room.`, "Cleaning", 219, 90),
  s("premium-2up", "premium", "2-story-upstairs", "Premium 1-2-3 See-It-Clean (2 Story, Upstairs)", `${PREMIUM}—Second floor laundry room.`, "Cleaning", 199, 75),
  s("ultimate-1", "ultimate", "1-story", "Ultimate Protection", `${ULTIMATE}.`, "Cleaning", 299, 120),
  s("ultimate-2", "ultimate", "2-story", "Ultimate Protection (2 Story)", `${ULTIMATE}—First floor laundry room.`, "Cleaning", 339, 135),
  s("ultimate-2up", "ultimate", "2-story-upstairs", "Ultimate Protection (2 Story, Upstairs)", `${ULTIMATE}—Second floor laundry room.`, "Cleaning", 319, 135),
  s("inspection-1", "inspection", "1-story", "Dryer Vent Safety Inspection", `${INSPECTION}.`, "Inspection", 119, 60),
  s("inspection-2", "inspection", "2-story", "Dryer Vent Safety Inspection (2 Story)", `${INSPECTION}—First floor laundry room.`, "Inspection", 139, 75),
  s("inspection-2up", "inspection", "2-story-upstairs", "Dryer Vent Safety Inspection (2 Story, Upstairs)", `${INSPECTION}—Second floor laundry room.`, "Inspection", 129, 75),
  s("express-1", "express", "1-story", "Express Vent Cleaning", `${EXPRESS}.`, "Cleaning", 149, 45),
  s("express-2", "express", "2-story", "Express Vent Cleaning (2 Story)", `${EXPRESS}—First floor laundry room.`, "Cleaning", 189, 60),
  s("express-2up", "express", "2-story-upstairs", "Express Vent Cleaning (2 Story, upstairs)", `${EXPRESS}—Second floor laundry room.`, "Cleaning", 169, 45),
  s("postservice-1", "postservice", "1-story", "Post-Service Vent Cleaning (1-Story)", POST, "Cleaning", 159, 60),
  s("postservice-2", "postservice", "2-story", "Post-Service Vent Cleaning (2-Story)", POST, "Cleaning", 199, 90),
  s("postservice-2up", "postservice", "2-story-upstairs", "Post-Service Vent Cleaning (2-Story, upstairs)", POST, "Cleaning", 179, 75),
  s("nest", "nest", "any", "Nest Removal Plus Cleaning", "Nest removal plus full vent cleaning, before-and-after photos, and airflow verification", "Restoration", 389, 90),
  s("restoration", "restoration", "any", "Full System Restoration", "Includes nest or pest removal, sanitation fogging, DryerFlex Transition Hose Upgrade, full system reset, before-and-after photos, and airflow verification, set of four wool dryer lint balls", "Restoration", 599, 150),
  s("addon-fogging", "addon", "fogging", "Sanitation Fogging Add-On", "Antimicrobial fogging treatment", "Add-Ons", 79, 15),
  s("addon-gas", "addon", "gas", "Gas Appliance Safety Procedure", "Shut off the gas, safely disconnect and reconnect the dryer, and perform a gas leak test before leaving", "Add-Ons", 49, 15),
  s("addon-tool", "addon", "tool", "Tool Retrieval", "Foreign object removal from vent system", "Add-Ons", 69, 30),
  s("addon-pedestal", "addon", "pedestal", "Fixed Pedestal Setup", "Extra labor for a dryer on a fixed pedestal: moving the raised dryer and pedestal out together without tipping, reaching the vent connection, and setting it back securely", "Add-Ons", 20, 10),
  s("addon-stacked", "addon", "stacked", "Stacked Washer/Dryer Setup", "Stacked washer and dryer moved with air sleds so the pair slides out safely and goes back into place", "Add-Ons", 45, 15),
  s("emergency", "emergency", "any", "Emergency Same-Day Clog Relief", "Urgent blockage removal, airflow restoration, live camera inspection during service, and airflow verification", "Emergency", 349, 75),
];

/** How each package is presented in chat. Order = menu order. */
export const PACKAGES = {
  premium: { label: "Premium 1-2-3", short: "Premium 1-2-3 See-It-Clean", badge: "Most popular", pitch: "professional cleaning from the appliance to the exterior termination, with live camera proof before and after, full-path rotary brushing and a sealed HEPA vacuum" },
  ultimate: { label: "Ultimate Protection", short: "Ultimate Protection", badge: "Most protection", pitch: "everything in Premium 1-2-3, plus exterior termination cleanout, a DryerFlex transition upgrade, before-and-after photos, a 3-year parts and labor warranty, and wool dryer balls" },
  inspection: { label: "Safety Inspection", short: "Dryer Vent Safety Inspection", badge: "Detailed report", pitch: "a full inspection with in-duct camera photos, airflow velocity testing and a marked-up photo report; the fee applies toward approved repairs" },
  express: { label: "Express", short: "Express Vent Cleaning", pitch: "vent-only cleaning with a live camera inspection, for when no dryer is installed" },
  postservice: { label: "Post-Service", short: "Post-Service Vent Cleaning", pitch: "vent cleaning with dryer disconnect and reconnect, before-and-after photos, and airflow verification (no lint screen, cavity, or drum cleaning)" },
  nest: { label: "Nest Removal + Cleaning", short: "Nest Removal Plus Cleaning", pitch: "nest removal plus a full vent cleaning, before-and-after photos, and airflow verification" },
  restoration: { label: "Full System Restoration", short: "Full System Restoration", pitch: "nest or pest removal, sanitation fogging, a DryerFlex hose upgrade, a full system reset, before-and-after photos, airflow verification, and wool dryer balls" },
  emergency: { label: "Emergency Same-Day", short: "Emergency Same-Day Clog Relief", pitch: "urgent blockage removal and airflow restoration with a live camera inspection and airflow verification" },
};
/** Packages retired on Oct 30 2026 when the online packages were matched to the website. */
export const RETIRED_FAMILIES = new Set(["essential", "performance", "total"]);
export const TIERS = ["premium", "ultimate"];
export const MORE = ["inspection", "express", "postservice", "nest", "restoration", "emergency"];
const VARIANT_FAMILIES = new Set(["premium", "ultimate", "inspection", "express", "postservice"]);
const APPLIANCE_FREE = new Set(["express", "inspection"]); // no dryer to disconnect
// Setup surcharges (pedestal, stacked) apply to the core packages, per the assistant rules manual.
const SETUP_FAMILIES = new Set(["premium", "ultimate", "postservice"]);

/** Which home version applies. Unknown details price as the 2-story first-floor version (the highest). */
export function homeVariant(property = {}) {
  if (property.stories === "1-story") return { variant: "1-story", certain: true };
  if (property.stories === "2-story" && property.laundryFloor === "2nd floor") return { variant: "2-story-upstairs", certain: true };
  if (property.stories === "2-story" && property.laundryFloor === "1st floor") return { variant: "2-story", certain: true };
  return { variant: "2-story", certain: false };
}

/**
 * No dryer installed and an estimated airflow restriction of 50% or more: the Premium visit, not
 * Express. The time normally spent cleaning the dryer goes into the clogged vent instead.
 */
export const NO_DRYER_PREMIUM_AT = 50;
export const noDryerNeedsPremium = (property = {}) =>
  property.hasDryer === "No" && Array.isArray(property.symptoms) && property.symptoms.length > 0 && restrictionScore(property) >= NO_DRYER_PREMIUM_AT;

/** No dryer installed turns a See-It-Clean or Post-Service visit into Express (vent only), unless the vent is badly restricted. */
export function effectiveFamily(pkg, property = {}) {
  const legacy = { essential: "premium", performance: "premium", total: "ultimate" }; // bookings and links from before Oct 30
  const named = legacy[pkg] || pkg;
  const family = PACKAGES[named] ? named : "premium";
  if (property.hasDryer === "No" && ["premium", "ultimate", "postservice"].includes(family)) {
    // Ultimate's DryerFlex upgrade needs a dryer, so a badly restricted vent with no dryer is Premium.
    return family !== "postservice" && noDryerNeedsPremium(property) ? "premium" : "express";
  }
  // Express is vent-only; with a dryer installed the visit is the Premium package.
  if (property.hasDryer === "Yes" && family === "express") return "premium";
  return family;
}

export const findService = (services, family, variant) =>
  services.find((x) => x.family === family && x.variant === variant && x.active !== false) ||
  services.find((x) => x.family === family && x.active !== false) ||
  null;

/** "from" price for a package (its lowest active version). */
export function fromPrice(services, family) {
  const prices = services.filter((x) => x.family === family && x.active !== false).map((x) => x.priceCents);
  return prices.length ? Math.min(...prices) : null;
}

export function lineForService(services, family, property) {
  const { variant, certain } = VARIANT_FAMILIES.has(family) ? homeVariant(property) : { variant: "any", certain: true };
  const item = findService(services, family, variant);
  if (!item) return null;
  return { id: item.id, name: item.name, description: item.description, cents: item.priceCents, mins: item.minutes, certain };
}

export function addOnLines(services, { family, route, property = {}, addOns = {} }) {
  const lines = [];
  const add = (variant) => {
    const item = findService(services, "addon", variant);
    if (item && item.variant === variant) lines.push({ id: item.id, name: item.name, description: item.description, cents: item.priceCents, mins: item.minutes, certain: true });
  };
  // Add-ons belong to cleaning visits (a cleaning + assessment visit gets them through its cleaning
  // package). An assessment by itself is quoted without extras.
  if (route !== "cleaning") return lines;
  // The dryer is disconnected for every cleaning except vent-only Express (and there's none to move without one).
  const appliance = property.hasDryer !== "No";
  if (appliance && property.power === "Gas" && !APPLIANCE_FREE.has(family)) add("gas");
  if (appliance && property.mount === "Pedestal" && SETUP_FAMILIES.has(family)) add("pedestal");
  if (appliance && property.mount === "Stacked" && SETUP_FAMILIES.has(family)) add("stacked");
  if (addOns.fogging && family !== "restoration") add("fogging"); // Restoration already includes fogging
  if (addOns.toolRetrieval) add("tool");
  return lines;
}
