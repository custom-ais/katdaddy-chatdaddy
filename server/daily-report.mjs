import { money, TIME_ZONE } from "../shared/domain.mjs";
import { emailLayout, escapeHtml as esc, sectionTitle } from "./email-layout.mjs";

const DAY = 86_400_000;
// 17:10 Arizona is 00:10 UTC the following day; Arizona does not change clocks.
export function dailyReportWindow(now = Date.now()) {
  const date = new Date(now);
  let to = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 10);
  if (to > now) to -= DAY;
  return { from: to - DAY, to };
}

const local = (ms) => new Date(ms).toLocaleString("en-US", { timeZone: TIME_ZONE, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const safeIssue = (text) => String(text || "").replace(/Bearer\s+\S+|pit-[\w-]+|[A-Za-z0-9_.-]{32,}/gi, "[hidden]").slice(0, 220);
const label = (text) => String(text || "unknown").replace(/[_\.]/g, " ");
const eventLabels = {
  "booking.created": "Booking confirmed", "admin.booking.created": "Office booking created",
  "booking.pending_review": "Booking needs review", "booking.jobber_failed": "Jobber booking failed",
  "booking.jobber_unknown": "Jobber result uncertain", "booking.jobber_partial": "Jobber visit needs review",
  "request.created": "Callback requested", "request.updated": "Callback updated",
  "approval.requested": "Approval requested", "approval.approved": "Approval approved",
  "approval.declined": "Approval declined", "approval.expired": "Approval expired",
  "appointment.updated": "Appointment updated", "appointment.confirmation_sent": "Confirmation attempt recorded",
  "appointment.resolved_in_jobber": "Booking reconciled with Jobber", "appointment.resolved_not_created": "Booking not created in Jobber",
  "settings.updated": "Office settings updated", "email.confirmation_failed": "Confirmation email failed",
  'oncall.pending': 'On-call technicians contacted', 'oncall.accepted': 'On-call availability accepted',
  'oncall.follow_up': 'Urgent request sent to office', 'oncall.booked': 'Visit recorded after on-call response', 'integrations.updated': 'Connection settings updated',
};

const table = (headings, rows, empty) => rows.length
  ? `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px;line-height:1.55"><thead><tr>${headings.map((h) => `<th align="left" style="padding:10px 6px;background:#edf3f9;border-bottom:1px solid #dbe5ee;color:#47647e">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((cells) => `<tr>${cells.map((cell) => `<td valign="top" style="padding:12px 6px;border-bottom:1px solid #e6edf3;overflow-wrap:anywhere">${cell}</td>`).join("")}</tr>`).join("")}</tbody></table>`
  : `<p style="margin:0;color:#6b7d90;font-size:14px">${esc(empty)}</p>`;

export function dailyReportEmail(report, { appUrl = "" } = {}) {
  const { from, to, counts, appointments = [], requests = [], approvals = [], activity = [], issues = [] } = report;
  const day = new Date(to).toLocaleDateString("en-US", { timeZone: TIME_ZONE, weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const period = `${local(from)} – ${local(to)} · Arizona time`;
  const newCount = Number(counts.bookingsCreated || 0), confirmed = Number(counts.bookingsConfirmed || 0);
  const cards = [["Conversations started", counts.conversations || 0], ["Bookings confirmed", confirmed], ["Callback requests", counts.requestsCreated || 0]];
  const metrics = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${cards.map(([name, value], i) => `<td width="33%" valign="top" style="padding:${i === 1 ? "0 6px" : "0"}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0f5fa;border:1px solid #dce6ef;border-radius:10px"><tr><td style="padding:16px 10px"><div style="font-size:27px;line-height:1.2;font-weight:700;color:#122c49">${esc(value)}</div><div style="margin-top:6px;font-size:11px;line-height:1.45;color:#58728b">${esc(name)}</div></td></tr></table></td>`).join("")}</tr></table>`;
  const summary = `${counts.messages || 0} customer messages · ${counts.aiReplies || 0} AI replies · ${counts.ruleReplies || 0} guided replies${Number(counts.aiFallbacks) ? ` · ${counts.aiFallbacks} AI fallbacks` : ""}`;
  const appointmentRows = appointments.map((a) => [
    `<strong>${esc(a.customerName || "Customer")}</strong><br>${esc(a.id)}<br><span style="color:#6b7d90">${esc(a.city || "")}${a.zip ? ` ${esc(a.zip)}` : ""}</span>`,
    `${esc(a.package)}<br>${esc(local(Date.parse(a.scheduledAt)))}<br><strong>${esc(money(Math.round(Number(a.price || 0) * 100)))}</strong>`,
    `<strong>${esc(label(a.status))}</strong><br>Email: ${esc(a.notifications?.email === "sent" ? "accepted by sender" : label(a.notifications?.email || "not recorded"))}`,
  ]);
  const requestRows = requests.map((r) => [
    `<strong>${esc(r.name || r.customerName || r.contact?.name || "Customer")}</strong><br>${esc(r.id)}`,
    `${esc(r.phone || r.contact?.phone || "")}<br>${esc(r.email || r.contact?.email || "")}`,
    `${esc(label(r.status || "new"))}<br>${esc(String(r.message || r.notes || r.reason || r.service || "").slice(0, 180))}`,
  ]);
  const approvalRows = approvals.map((a) => [esc(a.id), `${esc(a.service || a.package || "Visit")}<br>${esc(a.customer?.name || "")}`, esc(label(a.status))]);
  const actionRows = activity.filter((a) => eventLabels[a.action]).map((a) => [esc(local(a.created)), esc(eventLabels[a.action]), esc(a.target)]);
  const clipped = (total, shown) => Number(total) > shown ? `<p style="font-size:12px;color:#6b7d90">Showing ${shown} of ${Number(total)} records. Full records are in the BOB dashboard.</p>` : "";
  const needsAttention = Number(counts.pendingApprovals || 0) + Number(counts.bookingProblems || 0) + Number(counts.emailFailures || 0) + Number(counts.openRequests || 0);
  const attention = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:22px;background:${needsAttention || issues.length ? "#fff7e9" : "#edf8f2"};border-left:4px solid ${needsAttention || issues.length ? "#fa9b28" : "#2c936a"}"><tr><td style="padding:16px 18px;font-size:13px"><strong>${needsAttention || issues.length ? "Needs attention" : "No outstanding issues recorded"}</strong><br>${Number(counts.openRequests || 0)} open support/callback requests · ${Number(counts.pendingApprovals || 0)} pending approvals · ${Number(counts.bookingProblems || 0)} booking issues · ${Number(counts.emailFailures || 0)} failed email confirmations${issues.map((i) => `<br>${esc(safeIssue(i.message))}`).join("")}</td></tr></table>`;
  const partial = report.trackingStartedAt > from ? `<p style="font-size:12px;color:#87642d">Conversation tracking began ${esc(local(report.trackingStartedAt))}. Conversation/message totals cover only the period since tracking began; booking and callback records cover the full report window.</p>` : "";
  let dashboard = "";
  try { const url = new URL(appUrl); if (url.protocol === "https:") dashboard = `${url.origin}/admin`; } catch { /* no link when no public URL is configured */ }
  const body = `${metrics}<p style="margin:15px 0 0;font-size:12px;color:#647b92">${esc(summary)}</p>
<p style="margin:18px 0 0;font-size:14px"><strong>${esc(money(Number(counts.bookedValueCents || 0)))}</strong> in quoted value from confirmed bookings created during this period.<br><span style="font-size:12px;color:#6b7d90">${newCount} total booking records created. Confirmation status reflects BOB’s latest saved records.</span></p>
${attention}${partial}${sectionTitle("Bookings & results")}${table(["Customer / reference", "Service / visit", "Result"], appointmentRows, "No bookings were created or updated in this report window.")}${clipped(counts.appointmentsChanged, appointments.length)}
${sectionTitle("Callback requests")}${table(["Customer / reference", "Contact", "Status / request"], requestRows, "No callback requests were created or updated in this report window.")}${clipped(counts.requestsChanged, requests.length)}
${sectionTitle("Approvals")}${table(["Reference", "Visit", "Status"], approvalRows, "No approvals are pending or changed during this report window.")}${clipped(counts.approvalsIncluded, approvals.length)}
${sectionTitle("Activity log")}${table(["Arizona time", "Activity", "Reference"], actionRows, "No additional tracked activity in this report window.")}${clipped(counts.activityCount, activity.length)}
${dashboard ? `<p style="margin:25px 0 0"><a href="${esc(dashboard)}" style="display:inline-block;padding:13px 22px;background:#122c49;border-radius:8px;color:#fff;font-size:14px;font-weight:700;text-decoration:none">Open BOB dashboard &rarr;</a></p>` : ""}`;
  const text = `BOB DAILY ACTIVITY REPORT\n${day}\n${period}\n\nConversations started: ${counts.conversations || 0}\nCustomer messages: ${counts.messages || 0}\nBookings confirmed: ${confirmed}\nCallbacks created: ${counts.requestsCreated || 0}\nQuoted booking value: ${money(Number(counts.bookedValueCents || 0))}\nPending approvals: ${counts.pendingApprovals || 0}\nBooking issues: ${counts.bookingProblems || 0}\nFailed email confirmations: ${counts.emailFailures || 0}\n\nBOOKINGS\n${appointments.map((a) => `${a.id} | ${a.customerName || "Customer"} | ${a.package} | ${local(Date.parse(a.scheduledAt))} | ${a.status} | ${money(Math.round(Number(a.price || 0) * 100))} | Email: ${a.notifications?.email || "not recorded"}`).join("\n") || "None"}\n\nCALLBACKS\n${requests.map((r) => `${r.id} | ${r.name || r.customerName || "Customer"} | ${r.phone || r.contact?.phone || ""} | ${r.status || "new"} | ${String(r.message || r.notes || r.reason || "").slice(0, 180)}`).join("\n") || "None"}\n\nAPPROVALS\n${approvals.map((a) => `${a.id} | ${a.service || "Visit"} | ${a.status}`).join("\n") || "None"}\n\nACTIVITY\n${activity.filter((a) => eventLabels[a.action]).map((a) => `${local(a.created)} | ${eventLabels[a.action]} | ${a.target}`).join("\n") || "None"}\n\n${issues.map((i) => safeIssue(i.message)).join("\n")}\n${report.trackingStartedAt > from ? `Conversation tracking began ${local(report.trackingStartedAt)}; conversation totals are partial.\n` : ""}Covers activity recorded by BOB. Quoted booking value is not a payment record. ${dashboard}`;
  return { subject: `BOB daily activity | ${day}`, text, html: emailLayout({ preheader: `${confirmed} confirmed bookings · ${counts.requestsCreated || 0} callbacks · ${money(Number(counts.bookedValueCents || 0))} quoted booking value`, eyebrow: "Daily activity report", title: "Your day with BOB.", subtitle: period, body, footer: "Dryer Vent Squad West Valley &middot; Internal operations report<br>Activity recorded by BOB. Quoted booking value reflects confirmed appointment totals; email acceptance does not confirm inbox delivery." }) };
}

/** One report per completed window. SMTP failures never change bookings or customer sessions. */
export async function sendDailyReport({ store, email, env, clock = Date.now }) {
  await store.observer?.cleanup();
  if (!email?.configured) return { status: 503, body: { error: "Daily report email is not configured." } };
  const window = dailyReportWindow(clock());
  const key = `report:daily:${window.to}`;
  if (!(await store.lock("daily-report", 90))) return { status: 409, body: { error: "A report is already being prepared." } };
  try {
    const previous = await store.kvGet("report:daily:last");
    const receipt = await store.kvGet(key);
    if (receipt?.status === "sent" || Number(previous?.to) >= window.to) return { status: 200, body: { ok: true, alreadySent: true } };
    if (receipt?.status === "sending" || receipt?.status === "uncertain") return { status: 409, body: { error: "A previous delivery attempt needs review before retrying." } };
    if (previous?.to && Number(previous.to) < window.from) window.from = Number(previous.to);
    const report = await store.activityReport(window.from, window.to);
    const message = dailyReportEmail(report, { appUrl: env.PUBLIC_ORIGIN || env.NEXT_PUBLIC_APP_URL || env.APP_URL });
    await store.kvSet(key, { status: "sending", ...window, at: clock() });
    try {
      const sent = await email.send({
        to: env.DAILY_REPORT_TO || "westvalley@dryerventsquad.com",
        cc: env.DAILY_REPORT_CC || "seth@custom-ais.com",
        ...message, messageId: `<bob-daily-${window.to}@dryerventsquad.com>`,
      });
      const saved = { status: "sent", ...window, at: clock(), messageId: sent?.messageId || null };
      await store.kvSet(key, saved);
      await store.kvSet("report:daily:last", saved);
      await store.kvDel("diag:daily-report");
      return { status: 200, body: { ok: true, from: window.from, to: window.to } };
    } catch (error) {
      // A timeout can happen after SMTP accepts a message. Preserve uncertainty instead of duplicating it.
      await store.kvSet(key, { status: "uncertain", ...window, at: clock() }).catch(() => {});
      await store.kvSet("diag:daily-report", { at: clock(), message: "Daily report delivery needs review. Check the sender's Sent folder before retrying." }, 7 * 86400).catch(() => {});
      return { status: 502, body: { error: "Daily report delivery could not be confirmed. Review the sender before retrying." } };
    }
  } finally {
    await store.unlock("daily-report");
  }
}
