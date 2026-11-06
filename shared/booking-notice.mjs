import { phoenixDate } from './domain.mjs';

// Texting is not ready for short-notice visits. Every booking path uses this floor,
// including legacy emergency settings, office bookings and after-hours approvals.
export const MIN_BOOKING_NOTICE_HOURS = 12;
export const bookingNoticeHours = (hours) => Math.max(MIN_BOOKING_NOTICE_HOURS, Number(hours) || 0);

export function bookingNoticeAllows(config, start, now, hours = MIN_BOOKING_NOTICE_HOURS) {
  if (!Number.isFinite(start) || !Number.isFinite(now) || start < now + bookingNoticeHours(hours) * 3_600_000) return false;
  return config.sameDay?.enabled === true || phoenixDate(new Date(start)) !== phoenixDate(new Date(now));
}
