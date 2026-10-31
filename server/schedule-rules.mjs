// Pure scheduling rules (no network, no database) so they can be unit-tested.
//
// A "block" is anything occupying a technician: a Jobber visit, another customer's
// five-minute hold, or a BOB appointment not yet visible in Jobber.
//   { id, kind, start, end, allDay, techIds: string[] | null, location: {lat,lng} | null }
// techIds null = blocks every technician (e.g. an unassigned Jobber visit).

import { phoenixDate, dateTime } from "../shared/domain.mjs";
import { emergencySameDayEligible } from "./activity.mjs";
import { routeScore } from "./route-score.mjs";

const MIN = 60_000;

const phoenixHour = (ms) => Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Phoenix", hour: "numeric", hourCycle: "h23" }).format(new Date(ms)));

/**
 * Candidate start times, applying BOB's hours, Sundays, closing time, notice and horizon.
 * Two optional lanes from the scheduling workbook, both off unless switched on:
 *   sameDay  — today, before the cutoff hour, with shorter notice (must sit next to a booked job)
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
      if (start > now + config.horizonDays * 86_400_000) continue;
      if (end > close) continue;
      if (start >= now + config.leadHours * 3_600_000) out.push({ date: d, start, end });
      else if (sameDayOpen && start >= now + sd.minNoticeHours * 3_600_000) out.push({ date: d, start, end, sameDay: true });
    }
    if (ov.enabled && weekday !== 6 && durationMins <= ov.maxDurationMins && ticketCents >= ov.minTicketCents) {
      const start = dateTime(d, ov.start).getTime();
      if (start >= close && start >= now + config.leadHours * 3_600_000 && start <= now + config.horizonDays * 86_400_000) {
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
  if (!block.allDay) return phoenixDate(new Date(block.start)) === date;
  const first = phoenixDate(new Date(block.start));
  const last = phoenixDate(new Date(Math.max(block.start, (block.end || block.start) - 1)));
  return date >= first && date <= last;
}

/**
 * Evaluate one technician for one candidate.
 * drive: Map blockId -> { toNew, fromNew } in minutes (null = unknown).
 */
export function evaluateTech({ candidate, tech, blocks, drive, config }) {
  const cap = config.maxDriveBetweenJobsMin;
  const buffer = config.bufferMinutes;
  const mine = blocks.filter((b) => blockBelongsTo(b, tech) && touchesDate(b, candidate.date));
  const timed = mine.filter((b) => !b.allDay);

  if (timed.some((b) => b.start < candidate.end && b.end > candidate.start)) return { ok: false, reason: "overlap" };

  const legs = [];
  const prev = timed.filter((b) => b.end <= candidate.start).sort((a, b) => b.end - a.end)[0];
  if (prev) {
    const d = drive.get(prev.id)?.toNew ?? null;
    if (d == null) return { ok: false, reason: "unknown_location" };
    if (!(d < cap)) return { ok: false, reason: "too_far_from_previous", minutes: d };
    if (prev.end + Math.max(d, buffer) * MIN > candidate.start) return { ok: false, reason: "no_gap_after_previous", minutes: d };
    legs.push(d);
  }
  const next = timed.filter((b) => b.start >= candidate.end).sort((a, b) => a.start - b.start)[0];
  if (next) {
    const d = drive.get(next.id)?.fromNew ?? null;
    if (d == null) return { ok: false, reason: "unknown_location" };
    if (!(d < cap)) return { ok: false, reason: "too_far_from_next", minutes: d };
    if (candidate.end + Math.max(d, buffer) * MIN > next.start) return { ok: false, reason: "no_gap_before_next", minutes: d };
    legs.push(d);
  }
  for (const b of mine.filter((x) => x.allDay)) {
    const info = drive.get(b.id);
    const d = info && info.toNew != null && info.fromNew != null ? Math.max(info.toNew, info.fromNew) : null;
    if (d == null) return { ok: false, reason: "unknown_location" };
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
export function openSlots({ config, technicians, blocks, drive, durationMins, now, date = "", place = null, ticketCents = 0 }) {
  const techs = technicians.filter((t) => config.activeTechnicianIds.includes(t.id) && t.status !== "off_duty");
  const slots = [];
  for (const candidate of candidateStarts({ config, durationMins, now, date, ticketCents })) {
    // The 5 PM overflow visit is the one exception to the daily cap ("4 standard + 1 overflow").
    if (!candidate.overflow && dayIsFull({ date: candidate.date, blocks, config })) continue;
    if (candidate.overflow && blocks.some((b) => b.overflow && phoenixDate(new Date(b.start)) === candidate.date)) continue;
    let best = null;
    for (const tech of techs) {
      const result = evaluateTech({ candidate, tech, blocks, drive, config });
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
 * Route clustering. With route scoring on, the next two weeks are ranked by route fit
 * (ties go to the earlier time) and later dates follow in order. Otherwise slots next to
 * nearby jobs in the next two weeks come first.
 */
export function orderSlots(slots, { now, nearbyFirst, routeScoring = false }) {
  const soon = now + 14 * 86_400_000;
  if (routeScoring) {
    const near = slots.filter((s) => s.start <= soon).sort((a, b) => (b.routeScore ?? 0) - (a.routeScore ?? 0) || a.start - b.start);
    return [...near, ...slots.filter((s) => s.start > soon)];
  }
  if (!nearbyFirst) return slots;
  const rank = (s) => (s.nearby && s.start <= soon ? 0 : 1);
  return [...slots].sort((a, b) => rank(a) - rank(b) || a.start - b.start);
}
