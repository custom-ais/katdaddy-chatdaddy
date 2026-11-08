// Which Jobber account a BOB appointment was booked into, compared with the account connected now.
// New bookings record it (appointment.jobber.accountId). Older ones are checked once against the
// connected account (is their Jobber job, else client, there?): a yes records the account; a no
// is noted in jobber.notInAccounts. The dashboard shows only "this" and "unknown" appointments,
// and only "other" ones stop blocking technicians' times, so nothing is hidden on a guess.

/** "this", "other" or "unknown" (no connected account, no Jobber link, or not checked yet). */
export function accountMatch(appointment, account) {
  if (!account?.id) return "unknown";
  const j = appointment?.jobber;
  if (!j || typeof j !== "object") return "unknown";
  if (j.accountId) return j.accountId === account.id ? "this" : "other";
  if (Array.isArray(j.notInAccounts) && j.notInAccounts.includes(account.id)) return "other";
  return "unknown";
}

/** Booked into a different Jobber account than the one connected now. */
export const inOtherAccount = (appointment, account) => accountMatch(appointment, account) === "other";

// ---- Inbox (customer requests and approval requests) ----------------------------------------
// They aren't in Jobber, so they record the account that was connected when they came in
// (jobberAccountId). Older ones are placed by time: BOB's activity history has every Jobber
// connection, and the account switch happened at the first connection after the newest booking
// known to be in another account. With no sign of a switch nothing is hidden.

const ms = (value) => (typeof value === "number" ? value : Date.parse(value));

/** When the connected account took over from a different one, or null when BOB has no sign of it. */
export function accountSwitchedAt({ appointments = [], account, connections = [] }) {
  if (!account?.id) return null;
  const others = appointments.filter((a) => inOtherAccount(a, account)).map((a) => ms(a.createdAt)).filter(Number.isFinite);
  if (!others.length) return null;
  const lastOther = Math.max(...others);
  const next = connections.filter((t) => Number.isFinite(t) && t > lastOther).sort((a, b) => a - b)[0];
  return next ?? null;
}

/** An Inbox item recorded under another account, or from before the switch. at: when it came in. */
export function inboxInOtherAccount(item, at, { account, switchedAt }) {
  if (!account?.id) return false;
  if (item?.jobberAccountId) return item.jobberAccountId !== account.id;
  const time = ms(at);
  return Number.isFinite(switchedAt) && Number.isFinite(time) && time < switchedAt;
}
