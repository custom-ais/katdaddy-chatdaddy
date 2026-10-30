// DVS West Valley service catalog (from ChatDaddy-Services_For_Jobber.csv, Oct 29 2026).
// Names match the Jobber Products & Services list exactly so booked line items line up.
// Prices and minutes are editable in BOB's admin; these are the starting values.

const SIC_ESSENTIAL = "Full vent cleaning, live camera inspection during service, airflow verification before and after, lint screen cleaning, lint cavity cleaning, dryer drum cleaning, surrounding dryer area cleaning";
const SIC_PERFORMANCE = "Everything in Essential plus before-and-after photos and DryerFlex transition hose upgrade";
const SIC_TOTAL = "Everything in Performance, plus termination cleanout, roof access when needed, significant airflow restriction correction, and reusable wool dryer balls. Complete clogs and nest removals are excluded from the package but receive $50 off if removal is needed";
const EXPRESS = "Vent-only cleaning with no appliance present, live camera inspection during service";
const POST = "Vent cleaning plus disconnect and reconnect dryer, before-and-after photos, airflow verification; does not include lint screen, lint cavity, or dryer drum cleaning";

const s = (id, family, variant, name, description, category, dollars, minutes) => ({
  id, family, variant, name, description, category, priceCents: Math.round(dollars * 100), minutes, active: true,
});

export const SERVICE_CATALOG = [
  s("essential-1", "essential", "1-story", "Essential See-It-Clean", SIC_ESSENTIAL, "Cleaning", 189, 60),
  s("essential-2", "essential", "2-story", "Essential See-It-Clean (2 Story)", "Full first floor vent cleaning, live camera inspection during service, airflow verification before and after, lint screen cleaning, lint cavity cleaning, dryer drum cleaning, surrounding dryer area cleaning.", "Cleaning", 229, 90),
  s("essential-2up", "essential", "2-story-upstairs", "Essential See-It-Clean (2 Story, Upstairs)", "Full second floor vent cleaning, live camera inspection during service, airflow verification before and after, lint screen cleaning, lint cavity cleaning, dryer drum cleaning, surrounding dryer area cleaning.", "Cleaning", 219, 75),
  s("performance-1", "performance", "1-story", "Performance See-It-Clean", SIC_PERFORMANCE, "Cleaning", 249, 90),
  s("performance-2", "performance", "2-story", "Performance See-It-Clean (2 Story)", `${SIC_PERFORMANCE}—First floor laundry room.`, "Cleaning", 289, 105),
  s("performance-2up", "performance", "2-story-upstairs", "Performance See-It-Clean (2 Story, Upstairs)", `${SIC_PERFORMANCE}—Second floor laundry room.`, "Cleaning", 269, 105),
  s("total-1", "total", "1-story", "Total System See-It-Clean", `${SIC_TOTAL}.`, "Cleaning", 349, 120),
  s("total-2", "total", "2-story", "Total System See-It-Clean (2 Story)", `${SIC_TOTAL}—First floor laundry room.`, "Cleaning", 389, 135),
  s("total-2up", "total", "2-story-upstairs", "Total System See-It-Clean (2 Story, upstairs)", `${SIC_TOTAL}—Second floor laundry room.`, "Cleaning", 369, 135),
  s("express-1", "express", "1-story", "Express Vent Cleaning", `${EXPRESS}.`, "Cleaning", 149, 45),
  s("express-2", "express", "2-story", "Express Vent Cleaning (2 Story)", `${EXPRESS}—First floor laundry room.`, "Cleaning", 179, 60),
  s("express-2up", "express", "2-story-upstairs", "Express Vent Cleaning (2 Story, upstairs)", `${EXPRESS}—Second floor laundry room.`, "Cleaning", 169, 45),
  s("postservice-1", "postservice", "1-story", "Post-Service Vent Cleaning (1-Story)", POST, "Cleaning", 159, 60),
  s("postservice-2", "postservice", "2-story", "Post-Service Vent Cleaning (2-Story)", POST, "Cleaning", 199, 90),
  s("postservice-2up", "postservice", "2-story-upstairs", "Post-Service Vent Cleaning (2-Story, upstairs)", POST, "Cleaning", 179, 75),
  s("nest", "nest", "any", "Nest Removal Plus Cleaning", "Nest removal plus full vent cleaning, before-and-after photos, and airflow verification", "Restoration", 389, 90),
  s("restoration", "restoration", "any", "Full System Restoration", "Includes nest or pest removal, sanitation fogging, DryerFlex Transition Hose Upgrade, full system reset, before-and-after photos, and airflow verification, set of four wool dryer lint balls", "Restoration", 599, 150),
  s("addon-fogging", "addon", "fogging", "Sanitation Fogging Add-On", "Antimicrobial fogging treatment", "Add-Ons", 79, 15),
  s("addon-gas", "addon", "gas", "Gas Appliance Safety Procedure", "Flat fee for safe gas dryer disconnect and reconnect", "Add-Ons", 49, 15),
  s("addon-tool", "addon", "tool", "Tool Retrieval", "Foreign object removal from vent system", "Add-Ons", 69, 30),
  s("emergency", "emergency", "any", "Emergency Same-Day Clog Relief", "Urgent blockage removal, airflow restoration, live camera inspection during service, and airflow verification", "Emergency", 349, 75),
];

/** How each package is presented in chat. Order = menu order. */
export const PACKAGES = {
  essential: { label: "Essential", short: "Essential See-It-Clean", pitch: "full vent cleaning with a live camera inspection, airflow checked before and after, plus the lint screen, lint cavity, drum, and dryer area" },
  performance: { label: "Performance", short: "Performance See-It-Clean", pitch: "everything in Essential, plus before-and-after photos and a DryerFlex transition hose upgrade" },
  total: { label: "Total System", short: "Total System See-It-Clean", pitch: "everything in Performance, plus termination cleanout, roof access when needed, airflow restriction correction, and wool dryer balls ($50 off clog or nest removal if needed)" },
  express: { label: "Express", short: "Express Vent Cleaning", pitch: "vent-only cleaning with a live camera inspection, for when no dryer is installed" },
  postservice: { label: "Post-Service", short: "Post-Service Vent Cleaning", pitch: "vent cleaning with dryer disconnect and reconnect, before-and-after photos, and airflow verification (no lint screen, cavity, or drum cleaning)" },
  nest: { label: "Nest Removal + Cleaning", short: "Nest Removal Plus Cleaning", pitch: "nest removal plus a full vent cleaning, before-and-after photos, and airflow verification" },
  restoration: { label: "Full System Restoration", short: "Full System Restoration", pitch: "nest or pest removal, sanitation fogging, a DryerFlex hose upgrade, a full system reset, before-and-after photos, airflow verification, and wool dryer balls" },
  emergency: { label: "Emergency Same-Day", short: "Emergency Same-Day Clog Relief", pitch: "urgent blockage removal and airflow restoration with a live camera inspection and airflow verification" },
};
export const TIERS = ["essential", "performance", "total"];
export const MORE = ["express", "postservice", "nest", "restoration", "emergency"];
const VARIANT_FAMILIES = new Set(["essential", "performance", "total", "express", "postservice"]);
const APPLIANCE_FREE = new Set(["express"]);

/** Which home version applies. Unknown details price as the 2-story first-floor version (the highest). */
export function homeVariant(property = {}) {
  if (property.stories === "1-story") return { variant: "1-story", certain: true };
  if (property.stories === "2-story" && property.laundryFloor === "2nd floor") return { variant: "2-story-upstairs", certain: true };
  if (property.stories === "2-story" && property.laundryFloor === "1st floor") return { variant: "2-story", certain: true };
  return { variant: "2-story", certain: false };
}

/** No dryer installed turns a See-It-Clean or Post-Service visit into Express (vent only). */
export function effectiveFamily(pkg, property = {}) {
  const family = PACKAGES[pkg] ? pkg : "essential";
  if (property.hasDryer === "No" && ["essential", "performance", "total", "postservice"].includes(family)) return "express";
  // Express is vent-only; with a dryer installed the visit is the Essential package.
  if (property.hasDryer === "Yes" && family === "express") return "essential";
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
  // Add-ons belong to cleaning visits. The $248 cleaning + assessment is a fixed total with
  // nothing stacked on it, and an assessment by itself is quoted without extras.
  if (route !== "cleaning") return lines;
  // The dryer is disconnected for every cleaning except vent-only Express.
  if (property.power === "Gas" && !APPLIANCE_FREE.has(family)) add("gas");
  if (addOns.fogging && family !== "restoration") add("fogging"); // Restoration already includes fogging
  if (addOns.toolRetrieval) add("tool");
  return lines;
}
