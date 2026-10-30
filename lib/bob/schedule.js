import { BOOKING, HOURS } from './catalog';

// Arizona (America/Phoenix) is UTC-7 all year, with no daylight saving time.
const OFFSET_MS = -7 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

// Local Arizona clock reading for an instant.
export function azParts(date) {
  const d = new Date(date.getTime() + OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

// The instant for an Arizona wall-clock time.
export function azDate(year, month, day, hour = 0, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - OFFSET_MS);
}

const pad = (n) => String(n).padStart(2, '0');

export function azDateKey(date) {
  const p = azParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

// Jobber's visit schedule wants local date, time and timezone.
export function toJobberLocal(date) {
  const p = azParts(date);
  return {
    date: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    time: `${pad(p.hour)}:${pad(p.minute)}:00`,
    timezone: 'America/Phoenix',
  };
}

export function formatDay(date) {
  return date.toLocaleDateString('en-US', { timeZone: 'America/Phoenix', weekday: 'short', month: 'short', day: 'numeric' });
}

export function formatTime(date) {
  return date.toLocaleTimeString('en-US', { timeZone: 'America/Phoenix', hour: 'numeric', minute: '2-digit' });
}

export function formatWhen(date) {
  return date.toLocaleString('en-US', {
    timeZone: 'America/Phoenix',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// Turns Jobber visits into busy time ranges. All-day visits block their whole day.
export function busyFromVisits(visits) {
  const busy = [];
  for (const v of visits || []) {
    if (!v?.startAt) continue;
    const start = new Date(v.startAt);
    if (Number.isNaN(start.getTime())) continue;
    if (v.allDay) {
      const p = azParts(start);
      const dayStart = azDate(p.year, p.month, p.day);
      busy.push({ start: dayStart, end: new Date(dayStart.getTime() + DAY), allDay: true });
      continue;
    }
    let end = v.endAt ? new Date(v.endAt) : null;
    if (!end || Number.isNaN(end.getTime()) || end <= start) end = new Date(start.getTime() + 60 * MINUTE);
    busy.push({ start, end, allDay: false });
  }
  return busy;
}

// Every start time inside business hours where the visit fits and doesn't
// collide with something already on the Jobber calendar.
export function openSlots({
  now = new Date(),
  busy = [],
  minutes,
  crews = 1,
  hours = HOURS,
  leadMinutes = BOOKING.leadMinutes,
  horizonDays = BOOKING.horizonDays,
  stepMinutes = BOOKING.stepMinutes,
  bufferMinutes = BOOKING.bufferMinutes,
}) {
  if (!minutes || minutes <= 0) throw new Error('minutes is required');
  const earliest = now.getTime() + leadMinutes * MINUTE;
  const today = azParts(now);
  const slots = [];

  for (let i = 0; i <= horizonDays; i++) {
    const dayStart = azDate(today.year, today.month, today.day + i);
    const p = azParts(dayStart);
    const window = hours[p.weekday];
    if (!window) continue;

    const open = azDate(p.year, p.month, p.day, window.open);
    const close = azDate(p.year, p.month, p.day, window.close);

    for (let t = open.getTime(); t + minutes * MINUTE <= close.getTime(); t += stepMinutes * MINUTE) {
      if (t < earliest) continue;
      const end = t + minutes * MINUTE;
      const clashes = busy.filter((b) => {
        const pad = b.allDay ? 0 : bufferMinutes * MINUTE;
        return t < b.end.getTime() + pad && end > b.start.getTime() - pad;
      }).length;
      if (clashes < crews) {
        slots.push({ start: new Date(t).toISOString(), end: new Date(end).toISOString(), day: azDateKey(new Date(t)) });
      }
    }
  }
  return slots;
}

export function searchWindow(now = new Date(), horizonDays = BOOKING.horizonDays) {
  const p = azParts(now);
  return {
    from: azDate(p.year, p.month, p.day),
    to: azDate(p.year, p.month, p.day + horizonDays + 1),
  };
}
