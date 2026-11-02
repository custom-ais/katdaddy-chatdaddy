// The Custom-AIs booking report: one email to the ChatDaddy operator for every booking BOB makes,
// with the customer, the job, its value, and running counts, revenue and commission for the
// week, month and year (Arizona time).

import { money, windowLabel } from "../shared/domain.mjs";

export const BOOKING_REPORT_TO = "bookings@custom-ais.com";
export const COMMISSION_CENTS = 1200; // per ChatDaddy appointment
const TZ = "America/Phoenix";
// Bookings that count: made by ChatDaddy and on the schedule (not failed, cancelled or still unresolved).
const COUNTED = new Set(["confirmed", "in_progress", "completed"]);

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const cents = (a) => Math.round(Number(a?.price || 0) * 100);

/** Arizona calendar keys for a time: day, Monday-start week, month and year. */
function periods(ms) {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms).split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d));
  const monday = new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * 86_400_000);
  return { week: monday.toISOString().slice(0, 10), month: `${y}-${String(m).padStart(2, "0")}`, year: String(y) };
}

/**
 * Where this booking falls: its number in the week, month and year, and the running revenue and
 * commission up to and including it. Ordered by when each booking was made.
 */
export function bookingTotals(appointments, appt, { commissionCents = COMMISSION_CENTS } = {}) {
  const at = Date.parse(appt.createdAt);
  const mine = periods(at);
  const counted = (appointments || []).filter((a) => a && a.source === "ai_bot" && (a.id === appt.id || COUNTED.has(a.status)) && Number.isFinite(Date.parse(a.createdAt)));
  if (!counted.some((a) => a.id === appt.id)) counted.push(appt);
  // Up to and including this booking; bookings made at the same moment count together.
  const upToThis = counted.filter((a) => Date.parse(a.createdAt) <= at);
  const out = { commissionCents, jobCents: cents(appt), weekStart: mine.week, yearLabel: mine.year };
  for (const key of ["week", "month", "year"]) {
    const same = upToThis.filter((a) => periods(Date.parse(a.createdAt))[key] === mine[key]);
    out[key] = { number: same.length, revenueCents: same.reduce((n, a) => n + cents(a), 0), commissionCents: same.length * commissionCents };
  }
  return out;
}

const SYMPTOM_LABELS = { normal: "Dries in one cycle", two: "Takes about 2 cycles", three: "Takes 3+ cycles", overheat: "Overheating or shutting off", error: "Airflow error code" };
const phone = (v = "") => { const d = String(v).replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(v); };
const PROPERTY_LABELS = { hasDryer: "Dryer installed", recentService: "New/serviced in 90 days", stories: "Stories", laundryFloor: "Laundry floor", power: "Gas or electric", mount: "Setup", exit: "Vent exit", animals: "Signs of animals", dryerWorking: "Dryer working", symptoms: "Symptoms" };

/** The report email: subject, HTML and plain text. */
export function bookingReportEmail(appt, totals, config = {}) {
  const t = totals;
  const items = appt.lineItems?.length ? appt.lineItems.map((l) => [l.name, l.cents]) : [[appt.package, t.jobCents]];
  const monthName = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "long" }).format(Date.parse(appt.createdAt));
  const weekLabel = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(Date.parse(`${t.weekStart}T12:00:00Z`));
  const job = [
    ["Service", appt.package],
    ["When", windowLabel(appt.scheduledAt)],
    ["Duration", appt.durationMins ? `${appt.durationMins} minutes` : ""],
    ["Technician", appt.technicianName],
    ["Reference", appt.id],
    ["Jobber job", appt.jobber?.jobNumber ? `#${appt.jobber.jobNumber}` : ""],
    ["Urgency", appt.urgency === "high" ? "Emergency same-day" : ""],
    ["Approved by", appt.approval?.by || ""],
    ["Travel zone", appt.travelZone ? `Yes${appt.travelFeeCents ? ` (${money(appt.travelFeeCents)} travel fee)` : ""}` : ""],
    ["Booked", new Intl.DateTimeFormat("en-US", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" }).format(Date.parse(appt.createdAt)) + " Arizona time"],
  ].filter(([, v]) => v);
  const home = Object.entries(appt.property || {})
    .filter(([, v]) => v != null && v !== "" && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => [PROPERTY_LABELS[k] || k, Array.isArray(v) ? v.map((x) => (k === "symptoms" && SYMPTOM_LABELS[x]) || x).join(", ") : String(v)]);
  const customer = [
    ["Name", appt.customerName],
    ["Phone", `${phone(appt.phone)}${appt.phoneVerified ? " (verified)" : ""}`],
    ["Email", appt.email],
    ["Address", `${appt.address}, ${appt.city}, AZ ${appt.zip}`],
    ["Service texts", appt.smsConsent ? "Consented" : "No consent"],
    ["Notes", appt.notes],
    ["Concerns", (appt.concerns || []).join(" | ")],
  ].filter(([, v]) => v && String(v).trim());

  const subject = `ChatDaddy booking #${t.month.number} in ${monthName}: ${appt.customerName} · ${appt.package} (${money(t.jobCents)})`;

  const stat = (label, number, revenue, commission) => `<td width="33%" style="padding:6px" valign="top"><div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:12px">
<div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#64748b;font-weight:700">${esc(label)}</div>
<div style="font-size:26px;font-weight:800;color:#0f172a;margin-top:2px">#${number}</div>
<div style="font-size:13px;color:#334155;margin-top:6px">Revenue <b>${money(revenue)}</b></div>
<div style="font-size:13px;color:#334155">Commission <b>${money(commission)}</b></div></div></td>`;
  const table = (rows) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows.map(([k, v]) => `<tr><td style="padding:5px 0;color:#64748b;width:150px;vertical-align:top">${esc(k)}</td><td style="padding:5px 0;color:#0f172a">${esc(v)}</td></tr>`).join("")}</table>`;
  const head = (s) => `<div style="font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:#f97316;font-weight:800;margin:22px 0 8px">${esc(s)}</div>`;
  const html = `<!doctype html><html><body style="margin:0;background:#eef2f7;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#fff;border-radius:18px;overflow:hidden">
<tr><td style="background:#0f172a;padding:22px 26px;color:#fff">
<div style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:#fdba74;font-weight:700">ChatDaddy · ${esc(config.businessName || "Dryer Vent Squad West Valley")}</div>
<div style="font-size:22px;font-weight:800;margin-top:6px">New booking: ${esc(appt.customerName)}</div>
<div style="font-size:15px;color:#cbd5e1;margin-top:4px">${esc(appt.package)} · <b style="color:#fff">${money(t.jobCents)}</b></div></td></tr>
<tr><td style="padding:16px 20px 4px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
${stat(`Week of ${weekLabel}`, t.week.number, t.week.revenueCents, t.week.commissionCents)}
${stat(monthName, t.month.number, t.month.revenueCents, t.month.commissionCents)}
${stat(t.yearLabel, t.year.number, t.year.revenueCents, t.year.commissionCents)}
</tr></table>
<div style="font-size:13px;color:#475569;padding:6px 6px 0">Commission: ${money(t.commissionCents)} per appointment. ${monthName} so far: <b>${t.month.number} × ${money(t.commissionCents)} = ${money(t.month.commissionCents)}</b>.</div></td></tr>
<tr><td style="padding:0 26px 26px;font-size:14px;line-height:1.5">
${head("Job")}${table(job)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px">${items.map(([n, c]) => `<tr><td style="padding:5px 0;color:#475569">${esc(n)}</td><td style="padding:5px 0;text-align:right;color:#0f172a">${money(c)}</td></tr>`).join("")}
<tr><td style="padding:8px 0;border-top:1px solid #e2e8f0;font-weight:800">Job value</td><td style="padding:8px 0;border-top:1px solid #e2e8f0;text-align:right;font-weight:800">${money(t.jobCents)}</td></tr></table>
${head("Customer")}${table(customer)}
${home.length ? `${head("Home details")}${table(home)}` : ""}
</td></tr></table></td></tr></table></body></html>`;

  const lines = (rows) => rows.map(([k, v]) => `${k}: ${v}`).join("\n");
  const text = [
    `New ChatDaddy booking: ${appt.customerName} · ${appt.package} · ${money(t.jobCents)}`,
    "",
    `This week (from ${weekLabel}): booking #${t.week.number} · revenue ${money(t.week.revenueCents)} · commission ${money(t.week.commissionCents)}`,
    `${monthName}: booking #${t.month.number} · revenue ${money(t.month.revenueCents)} · commission ${money(t.month.commissionCents)} (${t.month.number} × ${money(t.commissionCents)})`,
    `${t.yearLabel}: booking #${t.year.number} · revenue ${money(t.year.revenueCents)} · commission ${money(t.year.commissionCents)}`,
    "",
    "JOB",
    lines(job),
    ...items.map(([n, c]) => `  ${n}: ${money(c)}`),
    `Job value: ${money(t.jobCents)}`,
    "",
    "CUSTOMER",
    lines(customer),
    ...(home.length ? ["", "HOME DETAILS", lines(home)] : []),
  ].join("\n");
  return { subject, html, text };
}
