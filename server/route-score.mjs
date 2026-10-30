// Route-fit score for an open time, using the weights from the DVS scheduling workbook
// (parameters.csv, "Primary/Secondary Route Weights" and "Penalty Weights").
//
// Only the parts BOB can compute reliably are used: distance to the technician's other
// jobs that day, the territory map (micro-zone, corridor, zone), and the time of day.
// Revenue weights are left out — every option shown to one customer has the same ticket,
// so they can't change the order. The score only ranks times; the hard rules (hours,
// drive time between jobs, capacity) decide whether a time is offered at all.

import { haversineMiles } from "./geo.mjs";
import { territoryFor } from "../shared/territory.mjs";

export const WEIGHTS = {
  sameMicroZone: 20,
  sameNeighborhood: 14,
  sameCorridor: 8,
  dominantZone: 6,
  distance0to3: 10,
  distance3to5: 6,
  distance5to8: 3,
  middayStack: 8,
  density: 6,
  verrado: 3,
  prasada: 2,
  zoneDistancePerZone: -2,
  newZoneBefore1pm: -12,
  thirdZone: -18,
  isolatedStop: -10,
  fringeZip: -4,
  missingTerritory: -6,
  standardSlot: 1, // 9 AM and 3 PM
  middaySlot: 2, // 11 AM and 1 PM
  overflowSlot: -1, // 5 PM
};

const hourOf = (ms) => Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Phoenix", hour: "numeric", hourCycle: "h23" }).format(new Date(ms)));
export const zipOf = (address) => (String(address || "").match(/\b(8\d{4})(?:-\d{4})?\b(?!.*\b8\d{4}\b)/) || [])[1] || "";

/**
 * @param candidate { start, end, overflow? }
 * @param jobs      the technician's other timed jobs that day: { start, end, location, zip, neighborhood? }
 * @param place     the customer: { location: {lat,lng}, zip, neighborhood? }
 * @returns { score, parts: [[label, points]] }
 */
export function routeScore({ candidate, jobs, place }) {
  const parts = [];
  const add = (label, points) => points && parts.push([label, points]);
  const hour = hourOf(candidate.start);
  if (candidate.overflow) add("5 PM overflow", WEIGHTS.overflowSlot);
  else if (hour === 11 || hour === 13) add("Midday slot", WEIGHTS.middaySlot);
  else add("Standard slot", WEIGHTS.standardSlot);

  const mine = territoryFor(place.zip, place.neighborhood);
  if (!mine) add("ZIP not in territory map", WEIGHTS.missingTerritory);
  else if (mine.fringe) add("Fringe ZIP", WEIGHTS.fringeZip);

  const located = jobs.filter((j) => j.location);
  if (located.length && place.location) {
    const miles = Math.min(...located.map((j) => haversineMiles(place.location, j.location)));
    if (miles <= 3) add("Within 3 miles of a booked job", WEIGHTS.distance0to3);
    else if (miles <= 5) add("Within 5 miles of a booked job", WEIGHTS.distance3to5);
    else if (miles <= 8) add("Within 8 miles of a booked job", WEIGHTS.distance5to8);
    else add("Isolated stop (over 8 miles)", WEIGHTS.isolatedStop);

    // Midday stacking: an 11 or 1 o'clock visit right next to a nearby job.
    if ((hour === 11 || hour === 13) && located.some((j) => haversineMiles(place.location, j.location) <= 5 && (Math.abs(j.end - candidate.start) <= 150 * 60_000 || Math.abs(candidate.end - j.start) <= 150 * 60_000))) {
      add("Midday stack", WEIGHTS.middayStack);
    }
  }

  if (mine && jobs.length) {
    const theirs = jobs.map((j) => territoryFor(j.zip, j.neighborhood)).filter(Boolean);
    if (theirs.length) {
      if (mine.neighborhood && theirs.some((t) => t.neighborhood === mine.neighborhood)) add("Same neighborhood", WEIGHTS.sameNeighborhood);
      if (mine.micro && theirs.some((t) => t.micro === mine.micro)) add("Same micro-zone", WEIGHTS.sameMicroZone);
      else if (mine.corridor && theirs.some((t) => t.corridor === mine.corridor)) add("Same corridor", WEIGHTS.sameCorridor);
      if (mine.micro === "WV-VERRADO" && theirs.some((t) => t.micro === "WV-VERRADO")) add("Verrado stacking", WEIGHTS.verrado);
      if (mine.micro === "WV-PRASADA" && theirs.some((t) => t.micro === "WV-PRASADA")) add("Prasada stacking", WEIGHTS.prasada);

      const counts = new Map();
      for (const t of theirs) counts.set(t.zone, (counts.get(t.zone) || 0) + 1);
      const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      if (dominant === mine.zone) add("Dominant zone", WEIGHTS.dominantZone);
      if ((counts.get(mine.zone) || 0) >= 2) add("Zone density", WEIGHTS.density);
      if (!counts.has(mine.zone)) {
        const gap = Math.min(...[...counts.keys()].map((z) => Math.abs(z - mine.zone)));
        add(`${gap} zone${gap === 1 ? "" : "s"} away`, WEIGHTS.zoneDistancePerZone * gap);
        if (hour < 13) add("New zone before 1 PM", WEIGHTS.newZoneBefore1pm);
        if (counts.size + 1 >= 3) add("Third zone in one day", WEIGHTS.thirdZone);
      }
    }
  }
  return { score: parts.reduce((n, [, p]) => n + p, 0), parts };
}
