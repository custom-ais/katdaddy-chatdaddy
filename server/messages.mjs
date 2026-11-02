import { renderHtmlTemplate } from './email-html.mjs';
import { renderMessageTemplate, messageTemplateValues, CUSTOMER_SMS_FOOTER, MESSAGE_TEMPLATE_FIELDS } from '../shared/message-templates.mjs';
// Customer confirmation copy (sent through explicitly configured transports).

import { normalizeClientHubUrl } from "../shared/client-hub.mjs";

import { money, windowLabel, serviceQuote } from "../shared/domain.mjs";
import { ADDON_PROMOS, NO_DRYERFLEX, DRYERFLEX_URL } from "../shared/catalog.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
/** A phone link every phone can dial: tel:+1 and ten digits. */
const telHref = (phone) => { const d = String(phone || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""); return d.length === 10 ? `tel:+1${d}` : `tel:${String(phone || "").replace(/[^\d+]/g, "")}`; };

/** Upgrades the customer can still add to this visit (none for assessments, emergency, nest or restoration). */
export function emailUpsells(appt, config) {
  if (!config.pricesAcknowledged || appt.route === "assessment" || appt.urgency === "high" || ["emergency", "nest", "restoration"].includes(appt.packageId)) return [];
  const services = config.services || [];
  const have = new Set((appt.lineItems || []).map((l) => l.id));
  const find = (variant) => services.find((x) => x.family === "addon" && x.variant === variant && x.active !== false);
  const out = [];
  const df = find("dryerflex");
  if (df && !have.has(df.id) && !NO_DRYERFLEX.has(appt.packageId) && appt.property?.hasDryer !== "No") {
    const was = ADDON_PROMOS.dryerflex?.wasCents;
    out.push({ key: "dryerflex", title: "DryerFlex hose upgrade", price: money(df.priceCents), was: was > df.priceCents ? money(was) : "", text: "A crush-resistant, UL 2158A listed aluminum transition hose that keeps the full 4-inch airflow. Professionally installed and backed by our 3-year warranty.", learnMore: DRYERFLEX_URL });
  }
  const fog = find("fogging");
  if (fog && !have.has(fog.id)) out.push({ key: "fogging", title: "Sanitizing fog treatment", price: money(fog.priceCents), was: "", text: "An antimicrobial fogging treatment inside the vent line. A good finishing step after pests, nests or musty smells." });
  if (appt.packageId === "premium") {
    try {
      const route = appt.route === "bundle" ? "bundle" : "cleaning";
      const now = serviceQuote(route, config, { package: "premium", property: appt.property || {} }), up = serviceQuote(route, config, { package: "ultimate", property: appt.property || {} });
      if (up.priceCents > now.priceCents) out.push({ key: "ultimate", title: "Upgrade to Ultimate Protection", price: `+${money(up.priceCents - now.priceCents)}`, was: "", text: "Adds exterior termination cleanout, a DryerFlex hose, before-and-after photos and a 3-year parts and labor warranty." });
    } catch {}
  }
  return out;
}

const prettyPhone = (e164) => {
  const d = String(e164 || "").replace(/\D/g, "").slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : e164 || "";
};

export function confirmationSms(appt, config, resolved = {}) {
  const custom = config.messageTemplates?.confirmationSms;
  if (custom?.trim()) {
    const body = renderMessageTemplate(custom, messageTemplateValues(appt, config, resolved), { ...MESSAGE_TEMPLATE_FIELDS[0], maxRenderedLength: 1577 });
    return body.trim() + ' ' + CUSTOMER_SMS_FOOTER;
  }
  const first = String(appt.customerName || "").split(/\s+/)[0] || "there";
  const call = config.phone ? ` Need to change it? Call or text ${prettyPhone(config.phone)}.` : "";
  return (
    `Hi ${first}, you're booked with Dryer Vent Squad West Valley! ${appt.package} · ${windowLabel(appt.scheduledAt)}. ` +
    `Ref ${appt.id}. Please clear a path to the laundry area and secure pets.${call} Reply STOP to opt out.`
  );
}

export function confirmationEmail(appt, config, { clientHubUrl = "" } = {}) {
  // Callers supply an account-resolved link, never a raw tenant setting.
  let hub = "";
  try { hub = normalizeClientHubUrl(clientHubUrl); } catch { /* Invalid links are omitted. */ }
  const first = String(appt.customerName || "").split(/\s+/)[0] || "there";
  const subject = `You're booked: ${appt.package} · ${windowLabel(appt.scheduledAt).split(" · ")[0]}`;
  const total = Math.round(appt.price * 100);
  const lines = appt.lineItems?.length
    ? appt.lineItems.map((l) => [l.name, l.cents])
    : [[appt.package, total - (appt.travelFeeCents || 0)], ...(appt.travelFeeCents ? [["Travel fee", appt.travelFeeCents]] : [])];
  const upsells = emailUpsells(appt, config);
  // "Add this" opens an email to the office with the request filled in, or calls when there's no office email.
  const addHref = (u) => config.email
    ? `mailto:${config.email}?subject=${encodeURIComponent(`Add ${u.title.replace(/^Upgrade to /, "")} to my visit ${appt.id}`)}&body=${encodeURIComponent(`Hi, please add the ${u.title.replace(/^Upgrade to /, "")} (${u.price}) to my appointment ${appt.id} on ${windowLabel(appt.scheduledAt)}. Thank you, ${appt.customerName || ""}`)}`
    : telHref(config.phone);
  const rows = lines
    .map(([n, c]) => `<tr><td style="padding:6px 0;color:#475569">${esc(n)}</td><td style="padding:6px 0;text-align:right;color:#0f172a">${money(c)}</td></tr>`)
    .join("");
  const html = `<!doctype html><html><body style="margin:0;background:#eef2f7;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:18px;overflow:hidden">
<tr><td style="background:#083653;padding:26px 28px;color:#fff">
<div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#9fd0ff">Dryer Vent Squad · West Valley</div>
<div style="font-size:24px;font-weight:700;margin-top:6px">You're on the schedule, ${esc(first)}.</div></td></tr>
<tr><td style="padding:24px 28px;color:#0f172a;font-size:15px;line-height:1.55">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #e2e8f0;margin-bottom:14px">
<tr><td style="padding:8px 0;color:#64748b;width:96px">When</td><td style="padding:8px 0;font-weight:600">${esc(windowLabel(appt.scheduledAt))}</td></tr>
<tr><td style="padding:8px 0;color:#64748b">Where</td><td style="padding:8px 0">${esc(appt.address)}, ${esc(appt.city)}, AZ ${esc(appt.zip)}</td></tr>
<tr><td style="padding:8px 0;color:#64748b">Reference</td><td style="padding:8px 0">${esc(appt.id)}</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}
<tr><td style="padding:10px 0;border-top:1px solid #e2e8f0;font-weight:700">Service total</td><td style="padding:10px 0;border-top:1px solid #e2e8f0;text-align:right;font-weight:700">${money(total)}</td></tr></table>
${appt.route !== "cleaning" ? `<p style="margin:10px 0 0;color:#9a3412;font-size:13px">Repairs and parts are quoted separately.</p>` : ""}
${upsells.length ? `<div style="margin:22px 0 4px;padding:16px;border:1px solid #fed7aa;background:#fff7ed;border-radius:14px">
<div style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#c2410c;font-weight:800">Add to your visit</div>
${upsells.map((u) => `<div style="margin-top:12px;padding-top:12px;border-top:1px solid #fde4cc">
<div style="font-weight:700;color:#0f172a">${esc(u.title)} <span style="float:right">${u.was ? `<span style="color:#94a3b8;text-decoration:line-through;font-weight:400;margin-right:6px">${esc(u.was)}</span>` : ""}${esc(u.price)}</span></div>
<div style="color:#475569;font-size:14px;margin-top:4px">${esc(u.text)}</div>
<div style="margin-top:8px;font-size:14px"><a href="${esc(addHref(u))}" style="color:#c2410c;font-weight:700">Add this to my visit</a>${u.learnMore ? ` &nbsp;·&nbsp; <a href="${esc(u.learnMore)}" style="color:#0b63c7">Learn more about DryerFlex</a>` : ""}</div></div>`).join("")}
</div>` : ""}
${hub ? `<p style="margin:16px 0"><a href="${esc(hub)}" style="display:inline-block;padding:12px 18px;background:#0b63c7;color:#fff;border-radius:8px;text-decoration:none">Open Client Hub</a></p><p style="font-size:13px;color:#64748b">Sign in to your service company’s Jobber Client Hub to view your appointment details.</p>` : ""}
<p style="margin:16px 0 0"><strong>Before we arrive:</strong> ${esc(config.preparation)}</p>
${config.phone ? `<p style="margin:12px 0 0">Need to change your visit? Call or text <a href="${esc(telHref(config.phone))}" style="color:#0b63c7">${esc(prettyPhone(config.phone))}</a>.</p>` : ""}
</td></tr>
<tr><td style="padding:16px 28px;background:#f8fafc;color:#64748b;font-size:12px">Dryer Vent Squad West Valley · Veteran-owned · Booked with BOB, our online assistant</td></tr>
</table></td></tr></table></body></html>`;
  const text =
    `Hi ${first}, you're booked with Dryer Vent Squad West Valley.\n` +
    `${appt.package} — ${money(total)}\n${windowLabel(appt.scheduledAt)}\n` +
    `${appt.address}, ${appt.city}, AZ ${appt.zip}\nReference: ${appt.id}\n\n${config.preparation}` +
    (upsells.length ? `\n\nADD TO YOUR VISIT\n${upsells.map((u) => `- ${u.title}: ${u.was ? `${u.was} → ` : ""}${u.price}. ${u.text}${u.learnMore ? ` Learn more: ${u.learnMore}` : ""}`).join("\n")}\nTo add one, ${config.email ? `reply to ${config.email}` : ""}${config.email && config.phone ? " or " : ""}${config.phone ? `call or text ${prettyPhone(config.phone)}` : ""}.` : "") +
    (config.phone ? `\n\nNeed to change your visit? Call or text ${prettyPhone(config.phone)}.` : "") +
    (hub ? `\n\nOpen Client Hub: ${hub}\nSign in to your service company’s Jobber Client Hub to view your appointment details.` : "");
  const values = messageTemplateValues(appt, config, { clientHubUrl: hub });
  const customSubject = config.messageTemplates?.confirmationEmailSubject;
  const customBody = config.messageTemplates?.confirmationEmailBody;
  const renderedSubject = customSubject?.trim() ? renderMessageTemplate(customSubject, values, MESSAGE_TEMPLATE_FIELDS[1]) : subject;
  if (customBody?.trim() && config.messageEmailFormat === 'html') return { subject: renderedSubject, ...renderHtmlTemplate(customBody, values) };
  const renderedBody = customBody?.trim() ? renderMessageTemplate(customBody, values, MESSAGE_TEMPLATE_FIELDS[2]) : null;
  return { subject: renderedSubject, html: renderedBody === null ? html : '<!doctype html><html><body><p>' + esc(renderedBody).replace(/\r?\n/g, '<br>') + '</p></body></html>', text: renderedBody === null ? text : renderedBody };
}

export const verificationSms = (code) =>
  `Dryer Vent Squad: your verification code is ${code}. It expires in 10 minutes. If you didn't ask for this code, you can ignore this text.`;

export function approvalRequestText(a, link) {
  const when = windowLabel(a.scheduledAt);
  return (
    `BOB approval needed (${a.id}): ${a.service} for ${String(a.customer.name || "").split(/\s+/)[0]} in ${a.customer.city} ${a.customer.zip}, ${when}. ` +
    `${a.reason}. Approve or decline in the BOB dashboard: ${link}`
  );
}

/** Editable owner copy remains separate from emergency approval and customer consent. */
export function ownerBookingSms(appt, config) {
  const custom = config.messageTemplates?.ownerBookingSms;
  if (custom?.trim()) return renderMessageTemplate(custom, messageTemplateValues(appt, config), { ...MESSAGE_TEMPLATE_FIELDS[3], maxRenderedLength: 1600 });
  const when = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Phoenix', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(appt.scheduledAt));
  const clean = value => String(value || '').replace(/[\r\n\t]+/g, ' ').slice(0, 180);
  return `Custom-AIs ChatDaddy alert: booking confirmed for ${clean(appt.customerName)} — ${clean(appt.package)}. ${when} Arizona time. Ref ${clean(appt.id)}. No approval needed. Reply STOP to opt out.`;
}

/** Fixed owner-only error copy accepts identifiers and times, never provider errors or customer details. */
export function ownerErrorSms(kind, details = {}) {
  if (kind === 'booking_action_needed') {
    const ref = details.appointmentId;
    if (typeof ref !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(ref)) throw new Error('Invalid booking reference.');
    return `Custom-AIs ChatDaddy alert: booking ${ref} needs your review. Jobber did not confirm the visit. Resolve it in your ChatDaddy dashboard. Reply STOP to opt out.`;
  }
  const at = details.at;
  if (!Number.isFinite(at) || !Number.isFinite(new Date(at).getTime())) throw new Error('Invalid alert time.');
  const time = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Phoenix', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(at));
  switch (kind) {
    case 'booking_jobber_failed': return `Custom-AIs ChatDaddy alert: a customer could not finish booking because Jobber returned an error at ${time} Arizona time. Check your ChatDaddy dashboard. Reply STOP to opt out.`;
    case 'jobber': return `Custom-AIs ChatDaddy alert: online booking may be paused because the Jobber calendar connection failed at ${time} Arizona time. Check Settings > Connections in your ChatDaddy dashboard. Reply STOP to opt out.`;
    case 'verification': return `Custom-AIs ChatDaddy alert: customers may not be able to verify their phone and book because the phone-code service failed at ${time} Arizona time. Check Settings > Connections in your ChatDaddy dashboard. Reply STOP to opt out.`;
    case 'assistant': return `Custom-AIs ChatDaddy alert: the AI assistant connection failed at ${time} Arizona time, so the chat may not understand typed answers. Check Settings > Connections in your ChatDaddy dashboard. Reply STOP to opt out.`;
    case 'email': return `Custom-AIs ChatDaddy alert: booking emails may not be sending because the email connection failed at ${time} Arizona time. Check Settings > Connections in your ChatDaddy dashboard. Reply STOP to opt out.`;
    default: throw new Error('Unsupported owner alert.');
  }
}
