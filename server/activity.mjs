// Persistent, admin-only activity records. Never store credentials or verification codes.
export function safeDetails(value, depth = 0) {
  if (depth > 5) return "[truncated]";
  if (typeof value === "string") return value.slice(0, 4000).replace(/\b(?:Bearer\s+)[\w.\-]+/gi, "Bearer [hidden]");
  if (Array.isArray(value)) return value.slice(0, 40).map((v) => safeDetails(v, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !/password|secret|token|cookie|authorization|verification|api.?key/i.test(key)).slice(0, 40).map(([k, v]) => [k, safeDetails(v, depth + 1)]));
  return value ?? null;
}

export const phoenixHour = (at) => Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Phoenix", hour: "numeric", hourCycle: "h23" }).format(new Date(at)));
export const localDay = (at) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Phoenix", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
export const emergencySameDayEligible = (requestedAt, day) => Number.isFinite(requestedAt) && localDay(requestedAt) === day && phoenixHour(requestedAt) < 14;

/** Capture an explicit preference without asking the language model to invent a date/time. */
export function requestedVisit(text, previous = {}, now = Date.now()) {
  const input = String(text).toLowerCase();
  const time = input.match(/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\b/);
  const iso = input.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  const monthDay = input.match(/\b(1[0-2]|0?[1-9])\/(3[01]|[12]\d|0?[1-9])(?:\/(20\d{2}))?\b/);
  let date = previous.date || "";
  if (/\btoday\b/.test(input)) date = localDay(now);
  else if (/\btomorrow\b/.test(input)) date = localDay(now + 86_400_000);
  else if (iso) date = iso[1];
  else if (monthDay) date = `${monthDay[3] || localDay(now).slice(0, 4)}-${monthDay[1].padStart(2, "0")}-${monthDay[2].padStart(2, "0")}`;
  let at = previous.time || "";
  if (time) at = `${String(Number(time[1]) % 12 + (/p/.test(time[3]) ? 12 : 0)).padStart(2, "0")}:${time[2] || "00"}`;
  return { date, time: at };
}
