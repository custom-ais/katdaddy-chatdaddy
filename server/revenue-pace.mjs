// Revenue pacing: steer which open times BOB offers first so each week reaches the office's minimum.
//
// The office sets a minimum per month or per week. A month target is split the way the office
// plans it: ÷ 4 for each week, and the week ÷ 5 for each weekday (Mon–Fri).
//
//   Week under its target  → that week's openings move up (more for the current week, less for the
//                            weeks after), and weekdays under their share move up a little more, so
//                            the week fills and spreads out. Drive limits still decide what's offered.
//   Week at or over target → only openings close to that day's route stay up; a far-out customer
//                            ranks lower there, so they see the next week first.
//
// It only changes the order. The hard rules (hours, drive time between jobs, jobs per day) are untouched.

import { phoenixDate } from "../shared/domain.mjs";

const TZ = "America/Phoenix";
const DAY = 86_400_000;
export const PACE_WEEKS = 3; // this week and the next two
// How much a week's shortfall can move an opening, in route-score points (route scores run roughly
// -40 to +60, so a good route fit next week still beats a poor one this week).
export const PACE_WEIGHTS = { fillWeek: 24, fillDay: 8, metWeekFarStop: -16 };
const COUNTED = new Set(["confirmed", "in_progress", "completed", "action_needed"]);
export const DEFAULT_JOB_CENTS = 20000;

/** Monday 00:00 Arizona time for the week containing ms (Arizona has no daylight saving). */
export function weekStartOf(ms) {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms).split("-").map(Number);
  const day = Date.UTC(y, m - 1, d);
  const monday = day - ((new Date(day).getUTCDay() + 6) % 7) * DAY;
  return monday + 7 * 3_600_000; // midnight in Arizona is 07:00 UTC
}

export const pacingOn = (config) => Boolean(config?.revenuePacing?.enabled) && config.revenuePacing.targetCents > 0;

/** The weekly and weekday targets from the office's setting. */
export function paceTargets(pacing = {}) {
  const weeklyCents = Math.round(pacing.period === "week" ? pacing.targetCents : pacing.targetCents / 4);
  return { weeklyCents, dailyCents: Math.round(weeklyCents / 5) };
}

/**
 * Booked revenue for this week and the next ones.
 * appointments: BOB's records ({ scheduledAt, price, status, jobber? }).
 * visits: Jobber visits in the window ({ id, start }); those not booked by BOB count at their job's
 * total from the last Jobber sync (values: visitId → cents), or at the job value.
 */
export function revenuePace({ appointments = [], visits = [], values = {}, pacing, now, weeks = PACE_WEEKS }) {
  const { weeklyCents, dailyCents } = paceTargets(pacing);
  const first = weekStartOf(now);
  const end = first + weeks * 7 * DAY;
  const recent = appointments.filter((a) => COUNTED.has(a?.status) && Number.isFinite(a.price) && a.price > 0 && Date.parse(a.scheduledAt) >= now - 90 * DAY);
  const average = recent.length ? Math.round(recent.reduce((n, a) => n + a.price * 100, 0) / recent.length) : DEFAULT_JOB_CENTS;
  const jobCents = pacing.outsideJobCents > 0 ? pacing.outsideJobCents : average;
  const list = Array.from({ length: weeks }, (_, i) => ({ start: first + i * 7 * DAY, bookedCents: 0, jobs: 0, days: {} }));
  const add = (ms, cents) => {
    if (!(ms >= first && ms < end)) return;
    const w = list[Math.floor((ms - first) / (7 * DAY))];
    w.bookedCents += cents;
    w.jobs += 1;
    const day = phoenixDate(new Date(ms));
    w.days[day] = (w.days[day] || 0) + cents;
  };
  const bobVisits = new Set();
  for (const a of appointments) {
    if (!COUNTED.has(a?.status)) continue;
    if (a.jobber?.visitId) bobVisits.add(a.jobber.visitId);
    add(Date.parse(a.scheduledAt), Math.round(Number(a.price || 0) * 100));
  }
  for (const v of visits) {
    if (v?.allDay || bobVisits.has(v?.id)) continue;
    add(v.start, Number.isInteger(values?.[v.id]) && values[v.id] > 0 ? values[v.id] : jobCents); // the job's real value when Jobber shares it
  }
  return {
    weeklyTargetCents: weeklyCents, dailyTargetCents: dailyCents, jobCents, jobCentsFrom: pacing.outsideJobCents > 0 ? "setting" : recent.length ? "average" : "default",
    weeks: list.map((w) => ({ ...w, met: w.bookedCents >= weeklyCents })),
  };
}

/** How many points pacing adds to (or takes from) one open time. */
export function paceBonus(slot, pace) {
  if (!pace || !(pace.weeklyTargetCents > 0)) return 0;
  const index = pace.weeks.findIndex((w) => w.start === weekStartOf(slot.start));
  if (index < 0) return 0;
  const week = pace.weeks[index];
  const gap = Math.max(0, pace.weeklyTargetCents - week.bookedCents) / pace.weeklyTargetCents;
  if (gap > 0) {
    const reach = index === 0 ? 1 : index === 1 ? 0.5 : 0.25;
    const day = phoenixDate(new Date(slot.start));
    const weekday = new Date(`${day}T12:00:00-07:00`).getUTCDay();
    const dayGap = weekday >= 1 && weekday <= 5 && pace.dailyTargetCents > 0 ? Math.max(0, pace.dailyTargetCents - (week.days[day] || 0)) / pace.dailyTargetCents : 0;
    return Math.round((PACE_WEIGHTS.fillWeek * gap + PACE_WEIGHTS.fillDay * dayGap) * reach);
  }
  // The week's minimum is in: keep its remaining openings for stops close to the route.
  return slot.nearby ? 0 : PACE_WEIGHTS.metWeekFarStop;
}
