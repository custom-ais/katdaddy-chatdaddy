// Airflow estimate from the customer's answers, shared by the chat (gauge, recommendation)
// and pricing (visit length). It's an estimate: the technician measures real airflow.
//
// Cycles set the base: 1 normal cycle ≈ clear, about 2 cycles ≈ half efficiency, 3 or more ≈ severe.
// An airflow error code, slow drying on a dryer bought or serviced in the last 90 days (so the
// vent is the likely cause), and a stacked or pedestal setup (transition hose often crushed)
// push it up.

export function restrictionScore(p = {}) {
  const sym = p.symptoms || [];
  const slow = sym.includes("two") || sym.includes("three");
  let score = sym.includes("three") ? 72 : sym.includes("two") ? 50 : sym.includes("normal") ? 12 : 25;
  if (sym.includes("error")) score = Math.max(score, 66);
  if (p.recentService === "Yes" && slow) score += 10;
  if (p.mount === "Stacked" || p.mount === "Pedestal") score += 5;
  return Math.max(5, Math.min(95, score));
}

export const restrictionLevel = (score) => (score < 34 ? "clear" : score < 67 ? "restricted" : "severe");

/** Extra minutes for a harder cleaning: a restricted vent takes longer, a severe one longer still. */
export const DIFFICULTY_MINUTES = { clear: 0, restricted: 15, severe: 30 };
export function difficultyMinutes(p = {}) {
  if (!Array.isArray(p.symptoms)) return 0; // nothing known yet
  return DIFFICULTY_MINUTES[restrictionLevel(restrictionScore(p))] || 0;
}
