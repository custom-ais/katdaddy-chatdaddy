// Live availability: Jobber's calendar + BOB's holds/bookings + drive-time rules.

import { phoenixDate } from "../shared/domain.mjs";
import { openSlots, orderSlots } from "./schedule-rules.mjs";
import { zipOf } from "./route-score.mjs";
import { pacingOn, revenuePace, weekStartOf, PACE_WEEKS } from "./revenue-pace.mjs";
import { VALUES_KEY } from "./jobber-sync.mjs";

async function pool(items, limit, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

export function createScheduler({ store, jobber, geo }) {
  /** Everything occupying the crew between two instants. */
  async function blocks({ config, technicians, from, to, excludeSession = "", ignoreAppointmentId = null, fresh = false }) {
    const out = [];
    if (config.scheduleSource === "Jobber") {
      const byJobberUser = new Map(technicians.filter((t) => t.jobberUserId).map((t) => [t.jobberUserId, t.id]));
      for (const v of await jobber.readVisits(from, to, { fresh })) {
        out.push({
          id: `j:${v.id}`,
          kind: "jobber",
          start: v.start,
          end: v.end,
          allDay: v.allDay,
          // Unassigned visit blocks everyone; assigned visits block the mapped BOB techs.
          techIds: v.jobberUserIds.length ? v.jobberUserIds.map((u) => byJobberUser.get(u)).filter(Boolean) : null,
          address: v.address,
          location: null,
        });
      }
    }
    for (const a of await store.activeAppointments(from, to, ignoreAppointmentId)) {
      // Only a verified confirmed appointment observed on the current Jobber board
      // can replace its local reservation. Uncertain/readback-mismatched visits
      // must continue protecting the intended technician and interval.
      if (config.scheduleSource === "Jobber" && a.status === "confirmed" && a.jobberVisitId && out.some(b => b.id === `j:${a.jobberVisitId}` && !b.allDay && b.start === a.start && b.end === a.end && b.techIds?.length === 1 && b.techIds[0] === a.tech)) continue;
      out.push({ id: `a:${a.id}`, kind: "appointment", start: a.start, end: a.end, allDay: false, techIds: [a.tech], address: a.address, location: a.location, overflow: Boolean(a.overflow) });
    }
    for (const h of await store.activeHolds(from, to, excludeSession)) {
      out.push({ id: `h:${h.id}`, kind: "hold", start: h.start, end: h.end, allDay: false, techIds: [h.tech], address: h.address, location: h.location, overflow: Boolean(h.overflow) });
    }
    for (const b of out) b.zip ||= zipOf(b.address);
    const unlocated = out.filter((b) => !b.location && b.address);
    await pool(unlocated, 6, async (b) => {
      try {
        const g = await geo.geocode(b.address);
        if (g) b.location = { lat: g.lat, lng: g.lng };
      } catch (error) {
        console.warn("[schedule] could not locate", b.id, error.message);
      }
    });
    return out;
  }

  async function driveMap(list, point, fresh) {
    const located = list.filter((b) => b.location);
    const minutes = await geo.driveMinutes([
      ...located.map((b) => ({ from: b.location, to: point })),
      ...located.map((b) => ({ from: point, to: b.location })),
    ], { fresh });
    const map = new Map();
    located.forEach((b, i) => map.set(b.id, { toNew: minutes[i], fromNew: minutes[located.length + i] }));
    return map;
  }

  /**
   * Booked revenue against the office's minimum for this week and the next two. Jobber visits are read
   * on week boundaries so the lookup is shared (cached) between customers. Null when pacing is off or
   * the numbers can't be read: pacing only changes the order, so it never blocks availability.
   */
  async function pace({ config, now, fresh = false }) {
    if (!pacingOn(config)) return null;
    try {
      const from = weekStartOf(now), to = from + PACE_WEEKS * 7 * 86_400_000;
      const visits = config.scheduleSource === "Jobber" ? await jobber.readVisits(from, to, { fresh }) : [];
      return revenuePace({ appointments: await store.appointments(), visits, values: (await store.kvGet(VALUES_KEY)) || {}, pacing: config.revenuePacing, now });
    } catch (error) {
      console.warn("[schedule] revenue pacing unavailable:", error.message);
      return null;
    }
  }

  /**
   * Open slots for a located customer.
   * date: "YYYY-MM-DD" to search one day; empty = whole horizon (nearby-first when enabled).
   */
  async function slots({ config, technicians, durationMins, leadHours, emergencyRequestedAt = null, location, zip = "", neighborhood = "", ticketCents = 0, now, date = "", excludeSession = "", ignoreAppointmentId = null, fresh = false }) {
    if (leadHours != null) config = { ...config, leadHours };
    if (emergencyRequestedAt != null) config = { ...config, emergencyRequestedAt };
    const from = date ? Date.parse(`${date}T00:00:00-07:00`) - 86_400_000 : now - 86_400_000;
    const to = date ? Date.parse(`${date}T00:00:00-07:00`) + 2 * 86_400_000 : now + (config.horizonDays + 2) * 86_400_000;
    const list = await blocks({ config, technicians, from, to, excludeSession, ignoreAppointmentId, fresh });
    const drive = await driveMap(list, location, fresh);
    const place = { location, zip, neighborhood };
    const found = openSlots({ config, technicians, blocks: list, drive, durationMins, now, date, place, ticketCents });
    if (date) return found;
    return orderSlots(found, { now, nearbyFirst: config.nearbyFirst, routeScoring: config.routeScoring !== false, pace: await pace({ config, now, fresh }) });
  }

  /** Re-check one start time. Prefers the given tech when several can take it. */
  async function check({ config, technicians, durationMins, leadHours, emergencyRequestedAt = null, location, zip = "", neighborhood = "", ticketCents = 0, now, iso, preferTech, excludeSession = "", ignoreAppointmentId = null, fresh = true }) {
    const start = Date.parse(iso);
    if (!Number.isFinite(start)) return null;
    const date = phoenixDate(new Date(start));
    const found = await slots({ config, technicians, durationMins, leadHours, emergencyRequestedAt, location, zip, neighborhood, ticketCents, now, date, excludeSession, ignoreAppointmentId, fresh });
    const match = found.filter((s) => s.start === start);
    if (!match.length) return null;
    if (preferTech) {
      // openSlots returns the best tech per start; re-run for the preferred tech if it differs.
      const preferred = technicians.find((t) => t.id === preferTech && config.activeTechnicianIds.includes(t.id) && t.status !== "off_duty");
      if (preferred && match[0].technicianId !== preferTech) {
        const only = await slots({
          config: { ...config, activeTechnicianIds: [preferTech] },
          technicians, durationMins, leadHours, emergencyRequestedAt, location, zip, neighborhood, ticketCents, now, date, excludeSession, ignoreAppointmentId, fresh,
        });
        const mine = only.find((s) => s.start === start);
        if (mine) return mine;
      }
    }
    return match[0];
  }

  return { blocks, slots, check, pace };
}
