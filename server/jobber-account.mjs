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
