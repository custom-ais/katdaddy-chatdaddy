import { createHash } from "node:crypto";
import { emergencySameDayEligible, localDay } from "./activity.mjs";
import { normalizePhone } from "../shared/domain.mjs";
import { formatUsPhone } from "../shared/phone-display.mjs";
import { PACKAGES } from "../shared/catalog.mjs";

// Across all conversations: someone sending fake emergencies can't flood the technician's phone.
const ALERTS_PER_HOUR = 12;

/** An emergency conversation: the emergency route, its package, or an on-call (after-hours) request. */
export const isEmergency = (data) => data?.intent === "emergency" || data?.package === "emergency" || data?.afterHours === true;

/** Staff texts go to the approver's phone in Settings, else Ryan's (the same person as the availability check). */
export async function staffRecipient(store, config) {
  const techs = await store.technicians();
  const ryan = techs.find((t) => t.id === "tech-ryan");
  const who = config.approver?.phone ? config.approver : ryan?.phone ? ryan : config.approver || {};
  return { phone: normalizePhone(who.phone), name: who.name || "the team" };
}

/**
 * As soon as an emergency customer's contact details are in, the approver / on-call technician gets a
 * text with who, where and what, whatever happens with the booking afterwards. It's also kept in the
 * Inbox as a request. Once per conversation; the customer isn't told (it happens behind the scenes).
 * Returns the request, or null when nothing was sent.
 */
export async function notifyEmergencyContact({ store, sendStaffSms = null, config, data, session, now, origin = "", log = async () => {} }) {
  if (!isEmergency(data) || !data.contact?.phone || data.emergencyAlertId) return null;
  const key = `emergency_${createHash("sha256").update(String(session)).digest("hex")}`;
  if (await store.requestByIdem(key)) return null;
  if (!await store.lock(key, 30)) return null;
  try {
    if (await store.requestByIdem(key)) return null;
    if (!await store.rateHit("staff-emergency-alerts", ALERTS_PER_HOUR, 3_600_000)) {
      await log("notification.skipped", { channel: "sms", kind: "emergency", reason: "hourly_limit" }, "warning");
      return null;
    }
    const c = data.contact;
    const address = [c.address, c.city, c.zip ? `AZ ${c.zip}` : ""].filter(Boolean).join(", ");
    const service = data.afterHours ? `${PACKAGES[data.package]?.short || "Service"} + after-hours (on-call)` : PACKAGES[data.package]?.short || "";
    const timing = data.afterHours ? "Asked for the on-call technician."
      : Number.isFinite(data.emergencyRequestedAt) && emergencySameDayEligible(data.emergencyRequestedAt, localDay(now)) ? "Wants same-day; came in before the 2 p.m. cutoff."
      : data.emergencyAfterCutoff ? "Came in after the 2 p.m. same-day cutoff." : "";
    const request = {
      id: `EMR-${createHash("sha256").update(key).digest("hex").slice(0, 8).toUpperCase()}`,
      kind: "emergency", name: c.name || "Website visitor", phone: c.phone, email: c.email || "", zip: c.zip || "",
      smsConsent: c.smsConsent === true, route: data.route || "", status: "new", preference: "phone", createdAt: new Date(now).toISOString(), emergency: true,
      message: `EMERGENCY REQUEST: the customer gave their contact details and hasn't booked yet. Call them.\n${address}${service ? `\nService: ${service}` : ""}${timing ? `\n${timing}` : ""}`,
      concerns: data.concerns || [], transcript: data.history || [], notification: { status: "pending" },
    };
    await store.insertRequest(request, session, key);
    const { phone, name: recipient } = await staffRecipient(store, config);
    try {
      if (typeof sendStaffSms !== "function") throw new Error("Twilio staff messaging is not configured.");
      if (!phone) throw new Error("No staff phone is configured. Add the approver phone in settings.");
      const text = `BOB emergency request: ${request.name}, ${formatUsPhone(c.phone)}, ${address}.${service ? ` ${service}.` : ""}${timing ? ` ${timing}` : ""}${data.availabilityRequestId ? " Follow-up to the availability check." : ""} Not booked yet; please call them. Inbox: ${origin}/admin?tab=inbox`;
      const response = await sendStaffSms({ phone, text });
      request.notification = { status: "accepted", provider: "Twilio", recipient, to: `•••${phone.slice(-4)}`, messageId: response?.messageId || response?.id || null, at: now };
      await log("notification.accepted", { requestId: request.id, kind: "emergency", ...request.notification, delivery: "Delivery is not yet confirmed" });
    } catch (error) {
      request.notification = { status: "failed", recipient, error: String(error.message).slice(0, 500), at: now };
      await log("notification.failed", { requestId: request.id, kind: "emergency", ...request.notification }, "error");
    }
    await store.updateRequest(request);
    data.emergencyAlertId = request.id;
    return request;
  } finally { await store.unlock(key); }
}
