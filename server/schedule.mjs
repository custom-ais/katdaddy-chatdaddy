// Live availability: Jobber's calendar + BOB's holds/bookings + drive-time rules.

import { phoenixDate } from "../shared/domain.mjs";
import { openSlots, orderSlots } from "./schedule-rules.mjs";
import { zipOf } from "./route-score.mjs";

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
      // In Jobber mode, anything BOB put into Jobber is already on the Jobber board.
      if (config.scheduleSource === "Jobber" && a.jobberVisitId) continue;
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

  async function driveMap(list, point) {
    const located = list.filter((b) => b.location);
    const minutes = await geo.driveMinutes([
      ...located.map((b) => ({ from: b.location, to: point })),
      ...located.map((b) => ({ from: point, to: b.location })),
    ]);
    const map = new Map();
    located.forEach((b, i) => map.set(b.id, { toNew: minutes[i], fromNew: minutes[located.length + i] }));
    return map;
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
    const drive = await driveMap(list, location);
    const place = { location, zip, neighborhood };
    const found = openSlots({ config, technicians, blocks: list, drive, durationMins, now, date, place, ticketCents });
    return date ? found : orderSlots(found, { now, nearbyFirst: config.nearbyFirst, routeScoring: config.routeScoring !== false });
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
      const preferred = technicians.find((t) => t.id === preferTech);
      if (preferred && match[0].technicianId !== preferTech) {
        const only = await slots({
          config: { ...config, activeTechnicianIds: [preferTech] },
          technicians, durationMins, leadHours, emergencyRequestedAt, location, zip, neighborhood, ticketCents, now, date, excludeSession, ignoreAppointmentId, fresh: false,
        });
        const mine = only.find((s) => s.start === start);
        if (mine) return mine;
      }
    }
    return match[0];
  }

  return { blocks, slots, check };
}
