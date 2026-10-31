// Every text and email BOB sends — to customers, the approver and the office.
// Delivery (Twilio or LeadConnector) is server/notify.mjs; this file is only the words.

import { money, windowLabel } from "../shared/domain.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const prettyPhone = (e164) => {
  const d = String(e164 || "").replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : e164 || "";
};
const firstName = (name) => String(name || "").split(/\s+/)[0] || "there";
const shortName = (name) => {
  const [f = "", l = ""] = String(name || "").trim().split(/\s+/);
  return l ? `${f} ${l[0]}.` : f || "a customer";
};

/** The branded email frame shared by confirmations and reminders. */
function customerEmail({ heading, inner }) {
  return `<!doctype html><html><body style="margin:0;background:#eef2f7;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:18px;overflow:hidden">
<tr><td style="background:#083653;padding:26px 28px;color:#fff">
<div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#9fd0ff">Dryer Vent Squad · West Valley</div>
<div style="font-size:24px;font-weight:700;margin-top:6px">${heading}</div></td></tr>
<tr><td style="padding:24px 28px;color:#0f172a;font-size:15px;line-height:1.55">
${inner}
</td></tr>
<tr><td style="padding:16px 28px;background:#f8fafc;color:#64748b;font-size:12px">Dryer Vent Squad West Valley · Veteran-owned · Booked with BOB, our online assistant</td></tr>
</table></td></tr></table></body></html>`;
}

const visitTable = (appt) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #e2e8f0;margin-bottom:14px">
<tr><td style="padding:8px 0;color:#64748b;width:96px">When</td><td style="padding:8px 0;font-weight:600">${esc(windowLabel(appt.scheduledAt))}</td></tr>
<tr><td style="padding:8px 0;color:#64748b">Where</td><td style="padding:8px 0">${esc(appt.address)}, ${esc(appt.city)}, AZ ${esc(appt.zip)}</td></tr>
<tr><td style="padding:8px 0;color:#64748b">Reference</td><td style="padding:8px 0">${esc(appt.id)}</td></tr></table>`;

const changeLine = (config) =>
  config.phone ? `<p style="margin:12px 0 0">Need to change your visit? Call or text <a href="tel:${esc(config.phone)}" style="color:#0b63c7">${esc(prettyPhone(config.phone))}</a>.</p>` : "";

// ---- customer: booking confirmation ----------------------------------------------------

export function confirmationSms(appt, config) {
  const call = config.phone ? ` Need to change it? Call or text ${prettyPhone(config.phone)}.` : "";
  return (
    `Hi ${firstName(appt.customerName)}, you're booked with Dryer Vent Squad West Valley! ${appt.package} · ${windowLabel(appt.scheduledAt)}. ` +
    `Ref ${appt.id}. Please clear a path to the laundry area and secure pets.${call} Reply STOP to opt out.`
  );
}

export function confirmationEmail(appt, config) {
  const first = firstName(appt.customerName);
  const subject = `You're booked: ${appt.package} · ${windowLabel(appt.scheduledAt).split(" · ")[0]}`;
  const total = Math.round(appt.price * 100);
  const lines = appt.lineItems?.length
    ? appt.lineItems.map((l) => [l.name, l.cents])
    : [[appt.package, total - (appt.travelFeeCents || 0)], ...(appt.travelFeeCents ? [["Travel fee", appt.travelFeeCents]] : [])];
  const rows = lines
    .map(([n, c]) => `<tr><td style="padding:6px 0;color:#475569">${esc(n)}</td><td style="padding:6px 0;text-align:right;color:#0f172a">${money(c)}</td></tr>`)
    .join("");
  const html = customerEmail({
    heading: `You're on the schedule, ${esc(first)}.`,
    inner: `${visitTable(appt)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}
<tr><td style="padding:10px 0;border-top:1px solid #e2e8f0;font-weight:700">Service total</td><td style="padding:10px 0;border-top:1px solid #e2e8f0;text-align:right;font-weight:700">${money(total)}</td></tr></table>
${appt.route !== "cleaning" ? `<p style="margin:10px 0 0;color:#9a3412;font-size:13px">Repairs and parts are quoted separately.</p>` : ""}
<p style="margin:16px 0 0"><strong>Before we arrive:</strong> ${esc(config.preparation)}</p>
${changeLine(config)}`,
  });
  const text =
    `Hi ${first}, you're booked with Dryer Vent Squad West Valley.\n` +
    `${appt.package} — ${money(total)}\n${windowLabel(appt.scheduledAt)}\n` +
    `${appt.address}, ${appt.city}, AZ ${appt.zip}\nReference: ${appt.id}\n\n${config.preparation}` +
    (config.phone ? `\n\nNeed to change your visit? Call or text ${prettyPhone(config.phone)}.` : "");
  return { subject, html, text };
}

// ---- customer: day-before reminder -----------------------------------------------------

export function reminderSms(appt, config) {
  const call = config.phone ? ` Need to change it? Call or text ${prettyPhone(config.phone)}.` : "";
  return (
    `Reminder from Dryer Vent Squad West Valley: your ${appt.package} visit is tomorrow, ${windowLabel(appt.scheduledAt)}. ` +
    `Ref ${appt.id}. Please clear a path to the laundry area and secure pets.${call} Reply STOP to opt out.`
  );
}

export function reminderEmail(appt, config) {
  const first = firstName(appt.customerName);
  const subject = `Reminder: ${appt.package} tomorrow · ${windowLabel(appt.scheduledAt).split(" · ")[1] || ""}`.replace(/ · $/, "");
  const html = customerEmail({
    heading: `See you tomorrow, ${esc(first)}.`,
    inner: `<p style="margin:0 0 14px">This is a reminder of your <strong>${esc(appt.package)}</strong> visit.</p>
${visitTable(appt)}
<p style="margin:16px 0 0"><strong>Before we arrive:</strong> ${esc(config.preparation)}</p>
${changeLine(config)}`,
  });
  const text =
    `Hi ${first}, a reminder of your Dryer Vent Squad West Valley visit tomorrow.\n` +
    `${appt.package}\n${windowLabel(appt.scheduledAt)}\n${appt.address}, ${appt.city}, AZ ${appt.zip}\nReference: ${appt.id}\n\n${config.preparation}` +
    (config.phone ? `\n\nNeed to change your visit? Call or text ${prettyPhone(config.phone)}.` : "");
  return { subject, html, text };
}

// ---- phone code ------------------------------------------------------------------------

export const verificationSms = (code) =>
  `Dryer Vent Squad: your verification code is ${code}. It expires in 10 minutes. If you didn't ask for this code, you can ignore this text.`;

// ---- approver --------------------------------------------------------------------------

export function approvalRequestText(a, link) {
  const when = windowLabel(a.scheduledAt);
  return (
    `BOB approval needed (${a.id}): ${a.service} for ${String(a.customer.name || "").split(/\s+/)[0]} in ${a.customer.city} ${a.customer.zip}, ${when}. ` +
    `${a.reason}. Approve or decline in the BOB dashboard: ${link}`
  );
}

// ---- office alerts ---------------------------------------------------------------------

/** A plain email for staff: the text, plus a button to the dashboard when there's a link. */
export function staffEmail(subject, text, link = "") {
  const paragraphs = String(text).split(/\n+/).map((p) => `<p style="margin:0 0 10px">${esc(p)}</p>`).join("");
  const button = link ? `<p style="margin:16px 0 0"><a href="${esc(link)}" style="display:inline-block;background:#083653;color:#fff;padding:10px 16px;border-radius:10px;text-decoration:none;font-weight:600">Open the BOB dashboard</a></p>` : "";
  return {
    subject,
    html: `<!doctype html><html><body style="margin:0;padding:20px;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;line-height:1.5;color:#0f172a">${paragraphs}${button}</body></html>`,
    text: link ? `${text}\n\n${link}` : text,
  };
}

export function officeBookingText(appt) {
  const total = money(Math.round(appt.price * 100));
  return (
    `BOB booked ${appt.id}: ${appt.package} for ${shortName(appt.customerName)} in ${appt.city} ${appt.zip}, ${windowLabel(appt.scheduledAt)}. ${total}.` +
    (appt.jobber?.jobNumber ? ` Jobber job #${appt.jobber.jobNumber}.` : "") +
    (appt.approval?.by ? ` Approved by ${appt.approval.by}.` : "")
  );
}

export function officeProblemText(appt, link = "") {
  const why = appt.jobberState === "uncertain"
    ? "Jobber didn't answer, so it may or may not have the visit"
    : "the job is in Jobber but its visit didn't get scheduled";
  return (
    `BOB needs a check on ${appt.id} (${shortName(appt.customerName)}, ${windowLabel(appt.scheduledAt)}): ${why}. ` +
    `The customer was told it isn't confirmed yet. Check Jobber, then resolve it in the dashboard${link ? `: ${link}` : "."}`
  );
}

export function officeRequestText(r) {
  const how = r.preference === "email" && r.email ? `email ${r.email}` : `call ${prettyPhone(r.phone)}`;
  const msg = String(r.message || "").replace(/\s+/g, " ").slice(0, 220);
  return `New BOB request ${r.id} from ${shortName(r.name)}${r.zip ? ` (${r.zip})` : ""} — prefers ${how}. "${msg}"${r.safety ? ` Safety flag: ${r.safety}.` : ""}`;
}

/** Opt-out words carriers and Twilio act on. "Cancel" is one of them, which customers use for appointments too. */
export const OPT_OUT = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|revoke|optout|opt out)\s*[.!]*\s*$/i;

export function inboundForwardText({ from, body, appt }) {
  const who = appt ? `${shortName(appt.customerName)} (${appt.id}, ${windowLabel(appt.scheduledAt).split(" · ")[0]})` : prettyPhone(from);
  const text = String(body || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (OPT_OUT.test(text)) {
    return `${who} texted "${text}" to BOB's number. Twilio treats that as opting out of texts, so BOB can't text them until they reply START.` +
      (/cancel/i.test(text) ? " If they meant the appointment, call them." : "") + ` ${prettyPhone(from)}`;
  }
  return `Text from ${who}${appt ? ` ${prettyPhone(from)}` : ""}: "${text}" — reply to them directly; this number doesn't forward your answer.`;
}

export const testSms = (config) => `Test from BOB (${config.businessName || "Dryer Vent Squad"}): texts are working.`;
export const testEmail = (config, provider) =>
  staffEmail(`BOB test email`, `This is a test from BOB (${config.businessName || "Dryer Vent Squad"}). Email through ${provider === "twilio" ? "Twilio SendGrid" : "LeadConnector"} is working.`);
