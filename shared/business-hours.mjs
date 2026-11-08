// The parts of the business hours setting that have no other imports, so shared/domain.mjs can
// validate them without importing shared/tech-schedule.mjs (which imports domain.mjs).
// See shared/tech-schedule.mjs for how BOB uses them.

export const ARRIVAL_SPACINGS = [30, 60, 90, 120, 180, 240];
const OPEN_DAY = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
export const minutes = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
export const hhmm = (n) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

/** Whether Settings has saved its own business hours (7 days), rather than the older start-time lists. */
export const hasOwnHours = (config) => Array.isArray(config?.openWeek) && config.openWeek.length === 7;

/** Saved business hours are 7 entries of "" or "HH:MM-HH:MM" (opening before closing), at least one day open. [] = not set. */
export function validOpenWeek(list) {
  if (Array.isArray(list) && list.length === 0) return true;
  return Array.isArray(list) && list.length === 7 && list.every((d) => d === "" || (typeof d === "string" && OPEN_DAY.test(d) && d.slice(0, 5) < d.slice(6)))
    && list.some((d) => d !== "");
}
