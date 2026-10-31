import { dateTime, phoenixDate } from '../shared/domain.mjs';

/** Schedule availability, not a GPS/location claim. Never writes back into manual status. */
export async function technicianAvailability({ config, technicians, appointments, jobber, now }) {
  const day = phoenixDate(new Date(now));
  const weekday = new Date(`${day}T12:00:00-07:00`).getUTCDay();
  const starts = [...(weekday === 6 ? config.saturdayStarts : config.weekdayStarts)].sort();
  const open = starts.length ? dateTime(day, starts[0]).getTime() : Infinity;
  const close = dateTime(day, weekday === 6 ? config.saturdayClose : config.weekdayClose).getTime();
  let visits = [], calendarError = false;
  if (config.scheduleSource === 'Jobber') {
    try {
      const midnight = Date.parse(`${day}T00:00:00-07:00`);
      // Include visits that began yesterday and run into today.
      visits = await jobber.readVisits(midnight - 86400000, midnight + 86400000);
    } catch { calendarError = true; }
  }
  return technicians.map((tech) => {
    const info = (state, reason, until = null) => ({ ...tech, availability: { state, reason, until, checkedAt: now, source: config.scheduleSource } });
    if (tech.status === 'off_duty') return info('off_duty', 'Marked off duty by the office.');
    if (!config.activeTechnicianIds.includes(tech.id)) return info('off_duty', 'Not taking online bookings.');
    const local = appointments.filter((a) => a.technicianId === tech.id && !['cancelled', 'failed', 'rescheduled', 'completed'].includes(a.status));
    if (local.some((a) => a.status === 'in_progress')) return info('busy', 'A BOB visit is marked in progress.');
    if (config.blockedDates.includes(day) || weekday === 0 || now < open || now >= close) return info('off_duty', 'Outside the configured working hours.');
    if (config.scheduleSource === 'Jobber' && (!tech.jobberUserId || calendarError)) return info('unknown', calendarError ? 'Jobber calendar could not be refreshed.' : 'Link this technician to a Jobber user to verify availability.');
    const blocks = [
      ...visits.filter((v) => !v.jobberUserIds.length || v.jobberUserIds.includes(tech.jobberUserId)),
      ...local.filter((a) => config.scheduleSource !== 'Jobber' || !a.jobber?.visitId).map((a) => ({ start: Date.parse(a.scheduledAt), end: Date.parse(a.scheduledAt) + a.durationMins * 60000 })),
    ];
    const active = blocks.filter((b) => b.start <= now && b.end > now);
    if (active.length) return info('busy', 'A scheduled visit occupies this time.', Math.max(...active.map((b) => b.end)));
    const next = blocks.filter((b) => b.start > now).sort((a, b) => a.start - b.start)[0];
    return info('available', 'No current calendar conflict. New visits still require a live slot and travel-time check.', Math.min(next?.start || close, close));
  });
}
