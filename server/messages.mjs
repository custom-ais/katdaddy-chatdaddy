// Customer notification copy. SMS uses LeadConnector; email also supports SMTP.

import { windowLabel } from "../shared/domain.mjs";

const prettyPhone = (e164) => {
  const d = String(e164 || "").replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : e164 || "";
};

export function confirmationSms(appt, config) {
  const first = String(appt.customerName || "").split(/\s+/)[0] || "there";
  const call = config.phone ? ` Need to change it? Call or text ${prettyPhone(config.phone)}.` : "";
  return (
    `Hi ${first}, you're booked with Dryer Vent Squad West Valley! ${appt.package} · ${windowLabel(appt.scheduledAt)}. ` +
    `Ref ${appt.id}. Please clear a path to the laundry area and secure pets.${call} Reply STOP to opt out.`
  );
}

export { confirmationEmail } from "./confirmation-email.mjs";

export const verificationSms = (code) =>
  `Dryer Vent Squad: your verification code is ${code}. It expires in 10 minutes. If you didn't ask for this code, you can ignore this text.`;

export function approvalRequestText(a, link) {
  const when = windowLabel(a.scheduledAt);
  return (
    `BOB approval needed (${a.id}): ${a.service} for ${String(a.customer.name || "").split(/\s+/)[0]} in ${a.customer.city} ${a.customer.zip}, ${when}. ` +
    `${a.reason}. Approve or decline in the BOB dashboard: ${link}`
  );
}
