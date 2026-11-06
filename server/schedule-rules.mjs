// Pure scheduling rules (no network, no database) so they can be unit-tested.
//
// A "block" is anything occupying a technician: a Jobber visit, another customer's
// five-minute hold, or a BOB appointment not yet visible in Jobber.
//   { id, kind, start, end, allDay, techIds: string[] | null, location: {lat,lng} | null }
// techIds null = blocks every technician (e.g. an unassigned Jobber visit).

import { phoenixDate, dateTime } from "../shared/domain.mjs";
import { bookingNoticeAllows, bookingNoticeHours } from "../shared/booking-notice.mjs";
import { onShift, offShiftReason, weekSummary } from "../shared/tech-schedule.mjs";
import { emergencySameDayEligible } from "./activity.mjs";
import { routeScore } from "./route-score.mjs";
import { paceBonus } from "./revenue-pace.mjs";

const MIN = 60_000;
// Only route proximity changes for urgent problems; measured travel and buffers still apply.
export const URGENT_ROUTE_EXTRA_MINUTES = 5;

const phoenixHour = (ms) => Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Phoenix", hour: "numeric", hourCycle: "h23" }).format(new Date(ms)));

/**
 * Candidate start times, applying BOB's hours, Sundays, closing time, notice and horizon.
 * Two optional lanes from the scheduling workbook, both off unless switched on:
 *   sameDay  — today, before the cutoff hour, with at least 12 hours' notice (must sit next to a booked job)
 *   overflow — a weekday 5 PM start for short, nearby, higher-ticket visits (needs approval)
 */
export function candidateStarts({ config, durationMins, now, date = "", ticketCents = 0 }) {
  const out = [];
  const today = phoenixDate(new Date(now));
  const sd = config.sameDay || {};
  const ov = config.overflow || {};
  for (let offset = 0; offset <= config.horizonDays; offset++) {
    const d = phoenixDate(new Date(now + offset * 86_400_000));
    if (date && d !== date) continue;
    if (d === today && sd.enabled !== true) continue;
    if (d === today && Number.isFinite(config.emergencyRequestedAt) && !emergencySameDayEligible(config.emergencyRequestedAt, d)) continue;
    if (config.blockedDates.includes(d)) continue;
    const weekday = new Date(`${d}T12:00:00-07:00`).getUTCDay();
    if (weekday === 0) continue;
    const times = weekday === 6 ? config.saturdayStarts : config.weekdayStarts;
    const close = dateTime(d, weekday === 6 ? config.saturdayClose : config.weekdayClose).getTime();
    const sameDayOpen = sd.enabled && d === today && phoenixHour(now) < sd.cutoffHour;
    for (const time of times) {
      const start = dateTime(d, time).getTime();
      const end = start + durationMins * MIN;
      if (!bookingNoticeAllows(config, start, now)) continue;
      if (start > now + config.horizonDays * 86_400_000) continue;
      if (end > close) continue;
      if (start >= now + bookingNoticeHours(config.leadHours) * 3_600_000) out.push({ date: d, start, end });
      else if (sameDayOpen && start >= now + bookingNoticeHours(sd.minNoticeHours) * 3_600_000) out.push({ date: d, start, end, sameDay: true });
    }
    if (ov.enabled && weekday !== 6 && durationMins <= ov.maxDurationMins && ticketCents >= ov.minTicketCents) {
      const start = dateTime(d, ov.start).getTime();
      if (bookingNoticeAllows(config, start, now, config.leadHours) && start >= close && start <= now + config.horizonDays * 86_400_000) {
        out.push({ date: d, start, end: start + durationMins * MIN, overflow: true });
      }
    }
  }
  return out;
}

/** Does this block occupy this technician? */
export function blockBelongsTo(block, tech) {
  if (block.techIds === null) return true;
  if (block.techIds.includes(tech.id)) return true;
  // A tech not linked to a Jobber user is treated as the whole crew for Jobber visits.
  return block.kind === "jobber" && !tech.jobberUserId;
}

function touchesDate(block, date) {
  // Timed overnight commitments occupy every day they intersect, just like all-day blocks.
  const first = phoenixDate(new Date(block.start));
  const last = phoenixDate(new Date(Math.max(block.start, (block.end || block.start) - 1)));
  return date >= first && date <= last;
}

/**
 * Evaluate one technician for one candidate.
 * drive: Map blockId -> { toNew, fromNew } in minutes (null = unknown).
 */
export function evaluateTech({ candidate, tech, blocks, drive, config, urgent = false }) {
  const baselineCap = config.maxDriveBetweenJobsMin;
  const cap = baselineCap + (urgent === true && Number.isFinite(baselineCap) && baselineCap > 0 ? URGENT_ROUTE_EXTRA_MINUTES : 0);
  const buffer = config.bufferMinutes;
  const mine = blocks.filter((b) => blockBelongsTo(b, tech) && touchesDate(b, candidate.date));
  const timed = mine.filter((b) => !b.allDay);

  if (timed.some((b) => b.start < candidate.end && b.end > candidate.start)) return { ok: false, reason: "overlap" };

  const legs = [];
  const prev = timed.filter((b) => b.end <= candidate.start).sort((a, b) => b.end - a.end)[0];
  if (prev) {
    const d = drive.get(prev.id)?.toNew ?? null;
    if (!Number.isFinite(d) || d < 0) return { ok: false, reason: "unknown_location" };
    if (!(d < cap)) return { ok: false, reason: "too_far_from_previous", minutes: d };
    if (prev.end + Math.max(d, buffer) * MIN > candidate.start) return { ok: false, reason: "no_gap_after_previous", minutes: d };
    legs.push(d);
  }
  const next = timed.filter((b) => b.start >= candidate.end).sort((a, b) => a.start - b.start)[0];
  if (next) {
    const d = drive.get(next.id)?.fromNew ?? null;
    if (!Number.isFinite(d) || d < 0) return { ok: false, reason: "unknown_location" };
    if (!(d < cap)) return { ok: false, reason: "too_far_from_next", minutes: d };
    if (candidate.end + Math.max(d, buffer) * MIN > next.start) return { ok: false, reason: "no_gap_before_next", minutes: d };
    legs.push(d);
  }
  for (const b of mine.filter((x) => x.allDay)) {
    const info = drive.get(b.id);
    const d = info && info.toNew != null && info.fromNew != null ? Math.max(info.toNew, info.fromNew) : null;
    if (!Number.isFinite(d) || d < 0) return { ok: false, reason: "unknown_location" };
    if (!(d < cap)) return { ok: false, reason: "too_far_from_anytime_visit", minutes: d };
    legs.push(d);
  }
  const nearest = legs.length ? Math.min(...legs) : null;
  return {
    ok: true,
    nearestMin: nearest,
    nearby: nearest != null && nearest <= Math.min(15, cap),
    score: legs.length ? legs.reduce((a, b) => a + b, 0) / legs.length : 1000,
  };
}

/** Company-wide daily cap (BOB's "Maximum jobs per day"). */
export function dayIsFull({ date, blocks, config }) {
  const starting = blocks.filter((b) => phoenixDate(new Date(b.start)) === date);
  return starting.length >= config.maxJobsPerDay;
}

/**
 * All open slots, best technician per slot.
 * place: the customer { location, zip, neighborhood } for route scoring.
 */
/**
 * A tech's live status (Available, On the way, On a job, Off duty) says who is out right now, so
 * "Off duty" only keeps them off today's openings. Any other day is decided by their own calendar
 * for that day.
 */
export const offToday = (tech, date, now) => tech.status === "off_duty" && date === phoenixDate(new Date(now));

export function openSlots({ config, technicians, blocks, drive, durationMins, now, date = "", place = null, ticketCents = 0, urgent = false }) {
  const techs = technicians.filter((t) => config.activeTechnicianIds.includes(t.id));
  const slots = [];
  for (const candidate of candidateStarts({ config, durationMins, now, date, ticketCents })) {
    // The 5 PM overflow visit is the one exception to the daily cap ("4 standard + 1 overflow").
    if (!candidate.overflow && dayIsFull({ date: candidate.date, blocks, config })) continue;
    if (candidate.overflow && blocks.some((b) => b.overflow && phoenixDate(new Date(b.start)) === candidate.date)) continue;
    let best = null;
    for (const tech of techs) {
      if (offToday(tech, candidate.date, now)) continue;
      // Their work schedule and time off in Settings: the whole visit has to fall on shift.
      if (!onShift(tech, candidate)) continue;
      const result = evaluateTech({ candidate, tech, blocks, drive, config, urgent });
      if (!result.ok) continue;
      const needsNearby = (candidate.sameDay && config.sameDay?.requireNearby) || (candidate.overflow && config.overflow?.requireNearby);
      if (needsNearby && !result.nearby) continue;
      if (candidate.overflow && result.nearestMin == null) continue; // never a 5 PM visit on an empty day
      const jobs = blocks.filter((b) => !b.allDay && blockBelongsTo(b, tech) && phoenixDate(new Date(b.start)) === candidate.date);
      const route = config.routeScoring !== false && place ? routeScore({ candidate, jobs, place }) : { score: 0, parts: [] };
      const better =
        !best ||
        (config.routeScoring !== false && route.score !== best.route.score ? route.score > best.route.score : result.score < best.result.score);
      if (better) best = { tech, result, route };
    }
    if (!best) continue;
    slots.push({
      scheduledAt: new Date(candidate.start).toISOString(),
      start: candidate.start,
      end: candidate.end,
      technicianId: best.tech.id,
      technicianName: best.tech.name,
      jobberUserId: best.tech.jobberUserId || "",
      nearby: best.result.nearby,
      nearestJobMin: best.result.nearestMin,
      routeScore: best.route.score,
      routeParts: best.route.parts,
      ...(candidate.overflow ? { overflow: true } : {}),
      ...(candidate.sameDay ? { sameDay: true } : {}),
    });
  }
  return slots;
}

/**
 * Why a day has no openings, for the server log: every candidate start, every technician's reason
 * (or "ok"), whether the daily cap is reached, and what's already on the calendar that day (where it
 * came from, its time, whose it is, and whether BOB could place it on the map). No names or addresses.
 */
export function explainDay({ config, technicians, blocks, drive, durationMins, now, date, ticketCents = 0, urgent = false }) {
  const at = (ms) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Phoenix", hour: "numeric", minute: "2-digit" }).format(ms);
  const source = (b) => (b.kind === "jobber" ? (b.source === "assessment" ? "jobber request" : b.own ? "jobber visit booked by BOB" : "jobber visit") : b.kind === "appointment" ? "BOB booking record" : b.kind);
  const candidates = candidateStarts({ config, durationMins, now, date, ticketCents });
  return {
    date, durationMins, candidates: candidates.length,
    dayFull: dayIsFull({ date, blocks, config }), maxJobsPerDay: config.maxJobsPerDay,
    // Each technician as BOB has them saved: taking online bookings, weekly schedule, time off (dates only).
    technicians: Object.fromEntries(technicians.map((t) => [t.id, {
      online: config.activeTechnicianIds.includes(t.id), status: t.status || "", schedule: weekSummary(t.workWeek),
      timeOff: (Array.isArray(t.timeOff) ? t.timeOff : []).map((o) => `${o.from}${o.to !== o.from ? ` to ${o.to}` : ""}${o.start ? ` ${o.start}-${o.end}` : " all day"}`),
    }])),
    onCalendar: blocks.filter((b) => touchesDate(b, date)).map((b) => ({
      from: source(b), time: b.allDay ? "all day" : `${at(b.start)}-${at(b.end)}`, techs: b.techIds || "everyone",
      onMap: Boolean(b.location), drive: drive.get(b.id) || null,
    })),
    times: candidates.map((c) => ({
      time: at(c.start),
      techs: Object.fromEntries(technicians.map((tech) => {
        if (!config.activeTechnicianIds.includes(tech.id)) return [tech.id, "not taking online bookings"];
        if (offToday(tech, c.date, now)) return [tech.id, "off duty today"];
        const offShift = offShiftReason(tech, c);
        if (offShift) return [tech.id, offShift];
        const r = evaluateTech({ candidate: c, tech, blocks, drive, config, urgent });
        return [tech.id, r.ok ? "ok" : `${r.reason}${r.minutes != null ? ` (${r.minutes} min)` : ""}`];
      })),
    })),
  };
}

/**
 * Route clustering. With route scoring on, the next two weeks are ranked by route fit
 * (ties go to the earlier time) and later dates follow in order. Otherwise slots next to
 * nearby jobs in the next two weeks come first.
 * pace (revenue pacing, see revenue-pace.mjs) adds points for weeks under the office's minimum and
 * takes them from far-out stops in weeks that already reached it.
 */
export function orderSlots(slots, { now, nearbyFirst, routeScoring = false, pace = null, urgent = false }) {
  // Present urgent customers with the earliest feasible opening; routine ranking stays intact.
  if (urgent === true) return [...slots].sort((a, b) => a.start - b.start);
  const soon = now + 14 * 86_400_000;
  if (routeScoring || pace) {
    const score = (s) => (routeScoring ? s.routeScore ?? 0 : s.nearby ? 6 : 0) + paceBonus(s, pace);
    for (const s of slots) if (pace) s.paceBonus = paceBonus(s, pace);
    const near = slots.filter((s) => s.start <= soon).sort((a, b) => score(b) - score(a) || a.start - b.start);
    return [...near, ...slots.filter((s) => s.start > soon)];
  }
  if (!nearbyFirst) return slots;
  const rank = (s) => (s.nearby && s.start <= soon ? 0 : 1);
  return [...slots].sort((a, b) => rank(a) - rank(b) || a.start - b.start);
}
