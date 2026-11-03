// Jobber tracking: keep BOB's bookings in step with what actually happens in Jobber.
//
//   - A BOB booking whose Jobber visit is gone (deleted, or its job closed with nothing done) is
//     marked cancelled, so it frees the time, drops out of the revenue counts, and is never billed
//     as a ChatDaddy appointment. If the visit shows up again later, the booking comes back.
//   - A visit moved in Jobber moves the booking (so BOB's own record stops holding the old time).
//   - A completed visit marks the booking completed.
//   - Invoices issued in Jobber are attached to the booking they bill, with their total.
//   - Every visit's job value (when Jobber shares it) is kept for revenue pacing, so jobs the office
//     books in Jobber count at their real value.
// Read-only toward Jobber. Run from the dashboard (at most every 10 minutes), the daily cron and the
// "Sync with Jobber" button.

import { weekStartOf } from "./revenue-pace.mjs";

const DAY = 86_400_000;
export const SYNC_BACK_DAYS = 45;
export const SYNC_KEY = "jobber:sync";
export const VALUES_KEY = "jobber:job-values";
const TRACKED = new Set(["confirmed", "in_progress", "completed", "cancelled"]);
const CLOSED_JOB = new Set(["archived"]);

const monthStart = (ms, back = 0) => {
  const [y, m] = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Phoenix", year: "numeric", month: "2-digit" }).format(ms).split("-").map(Number);
  return Date.parse(`${new Date(Date.UTC(y, m - 1 - back, 1)).toISOString().slice(0, 10)}T00:00:00-07:00`);
};

/**
 * One pass. Returns a summary (also saved under SYNC_KEY) listing what changed.
 * onCancelled(appt) runs once for each booking newly cancelled in Jobber.
 */
export async function syncJobber({ store, jobber, now, horizonDays = 45, onCancelled = async () => {} }) {
  const from = now - SYNC_BACK_DAYS * DAY, to = now + (horizonDays + 2) * DAY;
  const { visits, complete } = await jobber.readVisitStatuses(from, to);
  const byId = new Map(visits.map((v) => [v.id, v]));
  const summary = { at: now, ok: true, visits: visits.length, complete, cancelled: [], restored: [], rescheduled: [], completed: [], invoices: null, error: null };

  const tracked = (await store.appointments()).filter((appt) => {
    const start = Date.parse(appt.scheduledAt);
    // Only Jobber's own cancellations come back; an office cancellation in BOB stays put.
    return appt.jobber?.visitId && TRACKED.has(appt.status) && start >= from && start < to && !(appt.status === "cancelled" && appt.cancelledBy !== "jobber");
  });
  // Safety: if most of BOB's live bookings vanished at once, Jobber was probably reconnected to a
  // different account or returned a partial list. Cancel nothing and say so.
  const live = tracked.filter((a) => a.status !== "cancelled");
  const missing = live.filter((a) => !byId.has(a.jobber.visitId));
  const holdCancellations = !complete || (missing.length >= 3 && missing.length > live.length / 2);
  if (holdCancellations && missing.length) summary.held = { missing: missing.length, of: live.length, reason: complete ? "Most of BOB's bookings are missing from Jobber at once. Check that Jobber is connected to the right account." : "Jobber's visit list was too long to read in full." };

  for (const appt of tracked) {
    const start = Date.parse(appt.scheduledAt);
    const v = byId.get(appt.jobber.visitId);
    let changed = false;
    const gone = !v || (CLOSED_JOB.has(v.jobStatus) && !v.complete && v.status !== "COMPLETED");
    if (gone) {
      // Only call it cancelled when the whole window was read; otherwise it may just be on a later page.
      if (!holdCancellations && appt.status !== "cancelled") {
        Object.assign(appt, { status: "cancelled", cancelledBy: "jobber", cancelledAt: new Date(now).toISOString(), cancelledReason: v ? "Job closed in Jobber without the visit being completed" : "Visit removed from Jobber" });
        summary.cancelled.push(appt.id);
        changed = true;
      }
    } else {
      if (appt.status === "cancelled") {
        Object.assign(appt, { status: "confirmed", cancelledBy: null, cancelledAt: null, cancelledReason: null });
        summary.restored.push(appt.id);
        changed = true;
      }
      if (!v.allDay && v.start !== start && Number.isFinite(v.start)) {
        appt.rescheduledFrom = appt.rescheduledFrom || appt.scheduledAt;
        appt.scheduledAt = new Date(v.start).toISOString();
        if (v.end > v.start) appt.durationMins = Math.round((v.end - v.start) / 60_000);
        summary.rescheduled.push(appt.id);
        changed = true;
      }
      if ((v.complete || v.status === "COMPLETED") && appt.status !== "completed") {
        appt.status = "completed";
        summary.completed.push(appt.id);
        changed = true;
      }
      const seen = { visitStatus: v.status, jobStatus: v.jobStatus, ...(v.jobTotalCents != null ? { jobTotalCents: v.jobTotalCents } : {}) };
      if (JSON.stringify(appt.jobberTracking || {}) !== JSON.stringify(seen)) { appt.jobberTracking = seen; changed = true; }
    }
    if (changed) {
      appt.jobberSyncedAt = new Date(now).toISOString();
      await store.updateAppointment(appt);
      await store.audit(`booking.jobber_sync.${gone ? "cancelled" : "updated"}`, appt.id);
      if (summary.cancelled.at(-1) === appt.id) await onCancelled(appt).catch(() => {});
    }
  }

  // Job values for revenue pacing (only when Jobber shares job totals).
  const values = {};
  for (const v of visits) if (v.jobTotalCents != null && v.start >= weekStartOf(now)) values[v.id] = v.jobTotalCents;
  await store.kvSet(VALUES_KEY, values, 2 * DAY / 1000);

  // Invoices issued this month and last month, attached to the booking they bill.
  try {
    const since = monthStart(now, 1);
    const { invoices, complete: allInvoices } = await jobber.readInvoices(since, now + DAY);
    const counted = invoices.filter((i) => i.status !== "voided" && i.status !== "draft");
    const byJob = new Map();
    for (const i of counted) if (i.jobId) byJob.set(i.jobId, [...(byJob.get(i.jobId) || []), i]);
    for (const appt of await store.appointments()) {
      const mine = appt.jobber?.jobId ? byJob.get(appt.jobber.jobId) : null;
      if (!mine?.length) continue;
      const invoice = { number: mine.map((i) => i.number).join(", "), status: mine.at(-1).status, issuedAt: new Date(Math.max(...mine.map((i) => i.issuedAt))).toISOString(), totalCents: mine.reduce((n, i) => n + i.totalCents, 0) };
      if (JSON.stringify(appt.invoice || null) === JSON.stringify(invoice)) continue;
      appt.invoice = invoice;
      await store.updateAppointment(appt);
    }
    const thisMonth = monthStart(now);
    const sum = (list) => ({ count: list.length, totalCents: list.reduce((n, i) => n + i.totalCents, 0) });
    summary.invoices = { complete: allInvoices, thisMonth: sum(counted.filter((i) => i.issuedAt >= thisMonth)), lastMonth: sum(counted.filter((i) => i.issuedAt < thisMonth)) };
  } catch (error) {
    summary.invoices = { error: String(error.message || error).slice(0, 200) };
  }
  await store.kvSet(SYNC_KEY, summary);
  return summary;
}

/**
 * ChatDaddy billing for a month: bookings BOB made for visits that month, how many were cancelled
 * (in Jobber or by the office), and the billable count at the commission rate.
 */
export function billingSummary(appointments, { now, commissionCents, back = 0 }) {
  const from = monthStart(now, back), to = monthStart(now, back - 1);
  const mine = (appointments || []).filter((a) => a?.source === "ai_bot" && Date.parse(a.scheduledAt) >= from && Date.parse(a.scheduledAt) < to && ["confirmed", "in_progress", "completed", "cancelled", "action_needed"].includes(a.status));
  const cancelled = mine.filter((a) => a.status === "cancelled");
  const pending = mine.filter((a) => a.status === "action_needed");
  const billable = mine.filter((a) => ["confirmed", "in_progress", "completed"].includes(a.status));
  return {
    month: new Intl.DateTimeFormat("en-US", { timeZone: "America/Phoenix", month: "long", year: "numeric" }).format(from + 2 * DAY),
    booked: mine.length, cancelled: cancelled.length, pending: pending.length, billable: billable.length, completed: billable.filter((a) => a.status === "completed").length,
    commissionCents, billableCents: billable.length * commissionCents,
    invoicedCents: billable.reduce((n, a) => n + (a.invoice?.totalCents || 0), 0),
    cancelledList: cancelled.map((a) => ({ id: a.id, customer: a.customerName, scheduledAt: a.scheduledAt, by: a.cancelledBy || "office", reason: a.cancelledReason || "" })),
  };
}
