// Urgency changes route proximity only; it never changes service, price or booking notice.
// Use intake answers, not a requested date, package name, arbitrary notes or client flag.
export function isUrgentBooking(session = {}) {
  const property = session?.property || {};
  // Duct-only intake describes a previous dryer's performance, not a current breakdown.
  if (property.hasDryer === "No") return false;
  if (property.dryerWorking === "Not working" || session?.heatSign === true) return true;
  if (Array.isArray(property.symptoms) && property.symptoms.some((symptom) => ["not_working", "overheat", "error"].includes(symptom))) return true;
  // Older conversations may have stored only the selected triage labels.
  return Array.isArray(property.triage) && property.triage.some((answer) => [
    "Overheating or shutting off",
    "Showing an error code (D80 / D90 / D95)",
  ].includes(answer));
}
