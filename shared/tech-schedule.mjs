// Each technician's work schedule and time off, kept in ChatDaddy (Settings → Scheduling & team →
// Technicians). BOB only offers a tech for a visit that fits inside their hours for that weekday and
// doesn't touch their time off. Jobber is still read fresh before every hold and booking, so a visit
// in Jobber blocks the time too.
//
// workWeek: null = works whenever the business is open (the default), or 7 days, Sunday first:
//   [{ on: true, start: "08:00", end: "16:00" }, ...]
// timeOff: [{ id, from: "YYYY-MM-DD", to: "YYYY-MM-DD", start: "" | "HH:MM", end: "" | "HH:MM", note }]
//   (no start/end = the whole day; with them, that window on each day in the range).

import { dateTime } from "./domain.mjs";

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const realDay = (d) => DAY.test(d) && !Number.isNaN(Date.parse(`${d}T12:00:00Z`)) && new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) === d;
export const MAX_TIME_OFF = 100;

/** A 7-day schedule matching the business hours, as the starting point for a custom one. */
export function businessWeek(config) {
  const first = (list, fallback) => (Array.isArray(list) && list.length ? [...list].sort()[0] : fallback);
  const weekday = { on: true, start: first(config?.weekdayStarts, "09:00"), end: config?.weekdayClose || "17:00" };
  const saturday = { on: Array.isArray(config?.saturdayStarts) && config.saturdayStarts.length > 0, start: first(config?.saturdayStarts, "10:00"), end: config?.saturdayClose || "14:00" };
  return [{ on: false, start: "09:00", end: "17:00" }, weekday, weekday, weekday, weekday, weekday, saturday].map((d) => ({ ...d }));
}

export function validWorkWeek(week) {
  if (week == null) return true;
  return Array.isArray(week) && week.length === 7 && week.every((d) => d && typeof d === "object" && typeof d.on === "boolean"
    && HHMM.test(d.start) && HHMM.test(d.end) && (!d.on || d.start < d.end));
}

export function validTimeOffEntry(t) {
  if (!t || typeof t !== "object" || Array.isArray(t)) return false;
  if (typeof t.id !== "string" || !/^[-a-zA-Z0-9]{1,40}$/.test(t.id)) return false;
  if (!realDay(t.from) || !realDay(t.to) || t.from > t.to) return false;
  if (Date.parse(`${t.to}T12:00:00Z`) - Date.parse(`${t.from}T12:00:00Z`) > 366 * 86_400_000) return false;
  const start = t.start || "", end = t.end || "";
  if (Boolean(start) !== Boolean(end)) return false;
  if (start && (!HHMM.test(start) || !HHMM.test(end) || start >= end)) return false;
  return t.note == null || (typeof t.note === "string" && t.note.length <= 120);
}

export const validTimeOff = (list) => list == null || (Array.isArray(list) && list.length <= MAX_TIME_OFF && list.every(validTimeOffEntry)
  && new Set(list.map((t) => t.id)).size === list.length);

/** Only the known fields, for storage and for the dashboard. Time off that has ended is dropped. */
export function cleanWorkWeek(week) {
  return Array.isArray(week) && week.length === 7 ? week.map((d) => ({ on: Boolean(d.on), start: String(d.start), end: String(d.end) })) : null;
}
export function cleanTimeOff(list, today = "") {
  return (Array.isArray(list) ? list : [])
    .filter((t) => !today || t.to >= today)
    .map((t) => ({ id: t.id, from: t.from, to: t.to, start: t.start || "", end: t.end || "", note: String(t.note || "").slice(0, 120) }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.start.localeCompare(b.start));
}

/**
 * Why the tech isn't on shift for the whole visit, or null when they are: outside their hours for
 * that weekday (when they have a schedule), or on time off. candidate: { date, start, end } (ms).
 */
export function offShiftReason(tech, candidate) {
  const { date, start, end } = candidate;
  const week = tech?.workWeek;
  if (Array.isArray(week) && week.length === 7) {
    const index = new Date(`${date}T12:00:00-07:00`).getUTCDay();
    const day = week[index];
    if (!day?.on) return `day off in work schedule (${WEEKDAYS[index]})`;
    if (start < dateTime(date, day.start).getTime() || end > dateTime(date, day.end).getTime()) return `outside work hours (${WEEKDAYS[index]} ${day.start}-${day.end})`;
  }
  for (const off of Array.isArray(tech?.timeOff) ? tech.timeOff : []) {
    if (!(off.from <= date && date <= off.to)) continue;
    const label = `time off ${off.from}${off.to !== off.from ? ` to ${off.to}` : ""}`;
    if (!off.start || !off.end) return `${label}, all day`;
    if (start < dateTime(date, off.end).getTime() && end > dateTime(date, off.start).getTime()) return `${label}, ${off.start}-${off.end}`;
  }
  return null;
}

/** Whether the tech is on shift for the whole visit (see offShiftReason). */
export const onShift = (tech, candidate) => offShiftReason(tech, candidate) === null;

const clock = (t) => {
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
};
/** "Business hours", or "Mon–Fri 8am–4pm, Sat 9am–1pm". */
export function weekSummary(week) {
  if (!Array.isArray(week) || week.length !== 7) return "Business hours";
  const order = [1, 2, 3, 4, 5, 6, 0];
  const groups = [];
  for (const i of order) {
    const d = week[i];
    if (!d.on) continue;
    const label = `${clock(d.start)}–${clock(d.end)}`;
    const last = groups.at(-1);
    if (last && last.label === label && order.indexOf(i) === order.indexOf(last.to) + 1) last.to = i;
    else groups.push({ from: i, to: i, label });
  }
  if (!groups.length) return "Not working any day";
  const short = (i) => WEEKDAYS[i].slice(0, 3);
  return groups.map((g) => `${short(g.from)}${g.to !== g.from ? `–${short(g.to)}` : ""} ${g.label}`).join(", ");
}
export const timeOffLabel = (t) => {
  const fmt = (d) => new Date(`${d}T12:00:00-07:00`).toLocaleDateString("en-US", { timeZone: "America/Phoenix", weekday: "short", month: "short", day: "numeric" });
  const days = t.from === t.to ? fmt(t.from) : `${fmt(t.from)} – ${fmt(t.to)}`;
  return t.start ? `${days}, ${clock(t.start)}–${clock(t.end)}` : `${days}, all day`;
};
