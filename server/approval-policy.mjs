import { localDay } from "./activity.mjs";

/** Company approvals are limited to emergency appointments occurring today in Arizona.
 * Keep legacy approval-only exceptions closed rather than silently granting them approval.
 * Never trust the client's sameDay flag: use the actual scheduled instant.
 */
export function approvalPolicy(quote, slot, config, now) {
  const rawStart = slot?.start ?? slot?.scheduledAt;
  const start = typeof rawStart === "number" ? rawStart : Date.parse(rawStart || "");
  const emergency = quote?.package === "emergency";
  const sameDay = Number.isFinite(start) && Number.isFinite(now) && localDay(start) === localDay(now);
  if (emergency && sameDay) return { required: true, blocked: false, reason: "" };
  const legacyApproval = (config?.approvalServices || []).includes(quote?.package) || Boolean(slot?.overflow);
  if (legacyApproval || emergency) {
    return { required: false, blocked: true, reason: "This exception cannot be confirmed online. Please contact the office for scheduling." };
  }
  return { required: false, blocked: false, reason: "" };
}
