import { createHash } from "node:crypto";
import { emergencySameDayEligible, localDay, requestedVisit } from "./activity.mjs";
import { normalizePhone } from "../shared/domain.mjs";

/** Ask the office about availability early; this never books or reserves an appointment. */
export async function captureAvailabilityRequest({ store, sendStaffSms = null, config, data, message, session, now, origin, log }) {
  const emergency = data.intent === "emergency" || data.package === "emergency";
  // Older conversations did not have a dedicated preferred-time field.
  const earlier = data.requestedVisit || (data.history || []).filter((entry) => entry.role === "user").reduce((value, entry) => requestedVisit(entry.text, value, now), {});
  const preference = requestedVisit(message, earlier, now);
  if (emergency && !Number.isFinite(data.emergencyRequestedAt)) data.emergencyRequestedAt = now;
  if (emergency && !preference.date) preference.date = localDay(now);
  data.requestedVisit = preference;
  if (data.safety || data.stage === "emergency" || !preference.date) return "";
  const sameDay = preference.date === localDay(now);
  // Ordinary bookings never create company approval/availability texts.
  if (!emergency || !sameDay) return "";
  if (emergency && !emergencySameDayEligible(data.emergencyRequestedAt, preference.date)) {
    if (data.emergencyCutoffShown) return "";
    data.emergencyCutoffShown = true;
    await log("availability.cutoff", { date: preference.date, time: preference.time, cutoff: "14:00 America/Phoenix" });
    // After the cutoff the regular schedule can't do today, but the on-call technician might (offered with the packages).
    return "It's past our 2 p.m. cutoff for same-day visits, but we do have an on-call technician who may be available after hours. I'll show you the options after a few safety questions. Please keep the dryer off.";
  }
  const key = `availability_${createHash("sha256").update(`${session}:${preference.date}:${preference.time}`).digest("hex")}`;
  if (await store.requestByIdem(key)) return "";
  if (!await store.lock(key, 30)) return "";
  try {
    if (await store.requestByIdem(key)) return "";
    if (!await store.rateHit(`staff-availability:${session}`, 4, 3_600_000)) return "";
    const requested = `${preference.date}${preference.time ? ` at ${preference.time}` : " (preferred time not yet given)"} Arizona time`;
    const address = data.serviceAddress?.formatted || [data.serviceAddress?.street, data.serviceAddress?.city, data.zip].filter(Boolean).join(", ") || "Address still being collected";
    const request = {
      id: `AVL-${createHash("sha256").update(key).digest("hex").slice(0, 8).toUpperCase()}`,
      kind: "availability", name: data.contact?.name || "Website visitor", phone: data.contact?.phone || "", email: data.contact?.email || "",
      zip: data.zip || "", status: "new", preference: "phone", createdAt: new Date(now).toISOString(),
      requestedVisit: preference, emergency, requestedAt: now,
      message: `Technician availability requested for ${requested}. ${emergency ? "Same-day emergency; received before the 2 p.m. cutoff. " : ""}${address}. Appointment confirmation is still required.`,
      concerns: data.concerns || [], transcript: data.history || [], notification: { status: "pending" },
    };
    await store.insertRequest(request, session, key);
    await log("availability.requested", { requestId: request.id, requestedVisit: preference, address, emergency });
    const techs = await store.technicians();
    const ryan = techs.find((t) => t.id === "tech-ryan");
    const approver = config.approver?.phone ? config.approver : ryan?.phone ? ryan : config.approver || {};
    const phone = normalizePhone(approver.phone);
    const recipient = approver.name || "the team";
    try {
      if (typeof sendStaffSms !== "function") throw new Error("Twilio staff messaging is not configured.");
      if (!phone) throw new Error("No staff availability phone is configured. Add the approver phone in settings.");
      const text = `BOB availability check: ${recipient}, is a technician available for ${requested}? ${emergency ? "Emergency request received before 2 p.m. " : ""}${address}. This is an availability inquiry; confirm the booking separately. Review: ${origin}/admin?tab=inbox`;
      // Customer confirmation preferences do not disable internal staff notifications.
      const response = await sendStaffSms({ phone, text });
      request.notification = { status: "accepted", provider: "Twilio", recipient, to: `•••${phone.slice(-4)}`, messageId: response?.messageId || response?.id || null, at: now };
      await log("notification.accepted", { requestId: request.id, ...request.notification, delivery: "Delivery is not yet confirmed" });
    } catch (error) {
      request.notification = { status: "failed", recipient, error: String(error.message).slice(0, 500), at: now };
      await log("notification.failed", { requestId: request.id, ...request.notification }, "error");
    }
    await store.updateRequest(request);
    data.availabilityRequestId = request.id;
    // A staff text that couldn't go out is the office's problem, not the customer's: the request is in
    // the Inbox and the failure is logged, and the emergency offer already says same-day depends on
    // availability. So the customer only hears about it when the team was actually asked.
    return request.notification.status === "accepted"
      ? `I’ve asked ${recipient} to check technician availability for ${requested}. Your appointment will be confirmed separately. We can continue collecting the details while the team checks.`
      : "";
  } finally { await store.unlock(key); }
}
