// One customer conversation from its BOB activity records: when it started, the service address,
// how it ended, and (if nothing was booked) where the customer stopped. Used for the conversation
// list on the dashboard's Activity page. Works with older records too, which lack some details.

import { stageLabel } from "./activity-text.mjs";

const str = (v) => (typeof v === "string" ? v.trim() : "");
const short = (text, n = 140) => { const t = str(text).replace(/\s+/g, " "); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
// A message that is a street address: a house number, then a street.
const ADDRESS = /^\s*\d{1,6}\s+[a-z0-9.' #-]+?\s+(?:st|street|rd|road|ave|avenue|dr|drive|ln|lane|ct|court|way|blvd|boulevard|pl|place|cir|circle|pkwy|parkway|trl|trail|ter|terrace|loop|hwy|highway)\b/i;
const azTime = (ms) => new Date(ms).toLocaleString("en-US", { timeZone: "America/Phoenix", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Where the chat was opened, in words. */
function openedFrom(started) {
  const site = str(started?.details?.site), host = str(started?.details?.host);
  const name = (u) => u.replace(/^https?:\/\//, "").replace(/^www\./, "");
  if (site) return name(site);
  // A deployment's own address (project-hash-team.vercel.app): usually Vercel's automatic check.
  if (/^[a-z0-9-]+-[a-z0-9]{6,}-[a-z0-9-]+\.vercel\.app$/i.test(host)) return `${host} (a Vercel deployment link, often an automatic check)`;
  return host;
}

/**
 * items: one conversation's activity records ({ kind, created, details, level }), any order.
 * Returns { start, end, address, name, openedFrom, messages, result: { kind, title, tone },
 * stopped: { where, lastBot, lastCustomer } | null, confirmation }.
 */
export function summarizeConversation(items = []) {
  const list = [...items].filter(Boolean).sort((a, b) => a.created - b.created);
  const d = (e) => (e && e.details && typeof e.details === "object" ? e.details : {});
  const all = (kind) => list.filter((e) => e.kind === kind);
  const last = (kind) => all(kind).at(-1);
  const messages = all("conversation.message");
  const customer = messages.filter((e) => d(e).role === "user" && str(d(e).text) && str(d(e).text) !== "[verification code omitted]");
  const bob = messages.filter((e) => d(e).role === "assistant" && str(d(e).text));
  const started = all("conversation.started")[0];

  // The service address: the one checked at the contact step, else one found or typed in the chat.
  const typedZip = customer.map((e) => str(d(e).text)).find((t) => /^\d{5}$/.test(t));
  const address = str(d(last("coverage.checked")).address)
    || [...customer].reverse().map((e) => str(d(e).address)).find(Boolean)
    || customer.map((e) => str(d(e).text)).find((t) => ADDRESS.test(t) && t.length <= 120)
    || (typedZip ? `ZIP ${typedZip}` : "");
  const name = str(d(last("request.sent")).name);

  // How it ended.
  const bookedCall = list.filter((e) => e.kind === "request.finished" && d(e).path === "/api/bookings" && [201, 202].includes(Number(d(e).status))).at(-1);
  const booking = last("booking.confirmed") || bookedCall;
  const request = last("request.sent");
  const decided = last("approval.decided");
  const asked = last("approval.requested") || last("approval.after_hours_requested");
  const lastStage = [...list].reverse().map((e) => str(d(e).stage)).find(Boolean) || "";
  const commercial = d(started).audience === "commercial" || all("conversation.commercial").length > 0;
  const steps = list.filter((e) => /^(?:booking\.|approval\.|request\.sent|coverage\.)/.test(e.kind) || (e.kind === "request.finished" && d(e).path !== "/api/session"));
  let result;
  if (booking) {
    const b = d(booking), when = Date.parse(b.scheduledAt);
    const pending = b.pending === true || Number(b.status) === 202;
    result = { kind: "booked", tone: pending ? "attention" : "good", title: `Booked${str(b.service) ? `: ${str(b.service)}` : ""}${Number.isFinite(when) ? ` for ${azTime(when)}` : ""}${pending ? " (needs a Jobber check)" : ""}` };
  } else if (request) {
    const r = d(request);
    result = { kind: "request", tone: "attention", title: r.commercial ? "Commercial request sent to the office" : r.afterHours ? "After-hours request sent to the office" : "Sent a request to the office" };
  } else if (decided) {
    const s = d(decided).status;
    result = { kind: "approval", tone: s === "booked" ? "good" : "attention", title: { booked: "The team approved the requested time and it was booked", action_needed: "Approved, but the booking needs a Jobber check", declined: "The team declined the requested time", expired: "The requested time expired before anyone answered", failed: "Approved, but the booking couldn't be made" }[s] || "Request to the team ended" };
  } else if (asked) {
    result = { kind: "approval", tone: "attention", title: "Waiting for the team to answer a requested time" };
  } else if (lastStage === "emergency") {
    result = { kind: "safety", tone: "problem", title: "Safety stop: BOB told them to get to safety and call 911" };
  } else if (commercial) {
    result = { kind: "commercial", tone: "attention", title: "Commercial job: didn't send the request form" };
  } else if (!customer.length && !steps.length) {
    result = { kind: "empty", tone: "info", title: "Opened the chat but didn't use it" };
  } else if (lastStage === "out_of_area" || d(last("coverage.checked")).area === "out") {
    result = { kind: "out_of_area", tone: "info", title: "Not booked: outside the service area" };
  } else {
    result = { kind: "not_booked", tone: "attention", title: "Not booked" };
  }

  // Where a customer who didn't book stopped.
  let stopped = null;
  if (["not_booked", "commercial", "out_of_area"].includes(result.kind)) {
    const tail = list.at(-1);
    const held = last("booking.time_held");
    const error = [...list].reverse().find((e) => e.kind === "request.finished" && Number(d(e).status) >= 400);
    let where;
    // An error among the last few records, after any time they picked, is what stopped them.
    const errorAt = error ? list.indexOf(error) : -1;
    if (errorAt >= list.length - 3 && errorAt > list.indexOf(held)) where = `after an error${str(d(error).error) ? `: "${short(d(error).error, 90)}"` : ""}`;
    else if (held) where = "after picking a time, before confirming the booking";
    else if (lastStage === "verify") where = "at the verification code step";
    else if (lastStage === "slots") where = "while looking at open times";
    else if (stageLabel(lastStage)) where = `while ${stageLabel(lastStage)}`;
    else where = tail ? "after opening the chat" : "";
    stopped = { where, lastBot: short(d(bob.at(-1)).text), lastCustomer: short(d(customer.at(-1)).text) };
  }

  // Whether a booked customer was told.
  const told = d(last("confirmation.result"));
  const confirmation = Object.keys(told).length ? { sms: str(told.sms), smsReason: str(told.smsReason), email: str(told.email), emailReason: str(told.emailReason) } : null;
  // Booked, but the customer heard nothing: someone should call them.
  const heard = (v) => ["accepted", "sent"].includes(v);
  if (result.kind === "booked" && confirmation && !heard(confirmation.sms) && !heard(confirmation.email)) result = { ...result, tone: "attention" };

  return {
    start: list[0]?.created ?? null,
    end: list.at(-1)?.created ?? null,
    address,
    name,
    openedFrom: openedFrom(started),
    messages: customer.length + bob.length,
    result,
    stopped,
    confirmation,
  };
}

/** The conversation's title line: date and time it started, then the address. */
export function conversationTitle(summary) {
  const when = Number.isFinite(summary?.start) ? azTime(summary.start) : "Unknown time";
  return `${when} · ${summary?.address || "No address given"}`;
}
