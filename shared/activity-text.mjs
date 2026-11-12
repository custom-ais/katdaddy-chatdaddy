// Plain-English wording for BOB activity records on the dashboard's Activity page.
// The server stores short codes ("request.finished", "customer_sms.failed_or_uncertain");
// office staff should not need to know them. describeActivity turns one record into:
//   title   one sentence saying what happened
//   detail  optional follow-up: why, what it means, or what to do about it
//   quote   optional words a customer or BOB wrote, shown as a quote
//   tone    "problem" | "attention" | "good" | "info"
//   routine true for successful behind-the-scenes steps the page can tuck away
// The raw record stays available on the page as technical details for support.
import { PACKAGES } from "./catalog.mjs";

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");
const str = (v) => (typeof v === "string" ? v.trim() : "");
const plainCode = (code) => str(code).replace(/[._]+/g, " ").trim();

/** Where the customer was in the chat when something happened. */
export const STAGE_LABELS = {
  welcome: "just starting",
  evaluating: "describing the problem",
  emergency: "reporting an urgent problem",
  offer: "choosing a service",
  bundle_offer: "looking at package options",
  details: "answering questions about their home",
  contact: "entering contact details",
  travel_offer: "deciding on the travel charge",
  out_of_area: "outside the service area",
  verify: "confirming their phone or email",
  slots: "picking an appointment time",
  approval: "waiting for the team to approve a time",
  review: "reviewing their booking",
  confirmed: "booked",
  call_office: "asked to call the office",
  closed: "chat closed",
};
export const stageLabel = (stage) => STAGE_LABELS[stage] || "";

// Every request BOB answers: who makes it, what they were trying to do, and what it is once done.
// Checked in order; the first match wins.
const REQUESTS = [
  ["POST", /^\/api\/session$/, "customer", "start a chat with BOB", "started a chat with BOB"],
  ["GET", /^\/api\/session$/, "customer", "reopen their chat", "reopened their chat"],
  ["POST", /^\/api\/chat$/, "customer", "send a message to BOB", "sent a message to BOB"],
  ["POST", /^\/api\/chat\/back$/, "customer", "go back a step in the chat", "went back a step in the chat"],
  ["POST", /^\/api\/activity$/, "customer", "use the chat window", "used the chat window"],
  ["GET", /^\/api\/availability$/, "customer", "see open appointment times", "looked at open appointment times"],
  ["POST", /^\/api\/holds$/, "customer", "hold an appointment time", "held an appointment time"],
  ["DELETE", /^\/api\/holds$/, "customer", "let go of a held time", "let go of a held time"],
  ["POST", /^\/api\/holds\/extras$/, "customer", "choose add-ons for their visit", "chose add-ons for their visit"],
  ["POST", /^\/api\/bookings$/, "customer", "confirm their booking", "confirmed their booking"],
  ["GET", /^\/api\/approvals\/current$/, "customer", "check on their request to the team", "checked on their request to the team"],
  ["POST", /^\/api\/approvals\/current\/cancel$/, "customer", "cancel their request to the team", "cancelled their request to the team"],
  ["*", /^\/api\/approvals\/after-hours$/, "customer", "ask for the after-hours technician", "asked for the after-hours technician"],
  ["*", /^\/api\/approvals\/respond$/, "team", "answer a request from a text or email link", "answered a request from a text or email link"],
  ["POST", /^\/api\/approvals$/, "customer", "ask the team to approve a time", "asked the team to approve a time"],
  ["POST", /^\/api\/contact$/, "customer", "enter their contact details", "entered their contact details"],
  ["POST", /^\/api\/verify\/send$/, "customer", "get a verification code", "asked for a verification code"],
  ["POST", /^\/api\/verify\/check$/, "customer", "enter their verification code", "entered their verification code"],
  ["POST", /^\/api\/requests$/, "customer", "send a message to the office", "sent a message to the office"],
  ["GET", /^\/api\/address\//, "customer", "look up their address", "looked up their address"],
  ["GET", /^\/api\/public\/config$/, "customer", "open BOB", "opened BOB"],
  ["*", /^\/api\/jobber\//, "team", "connect Jobber", "connected Jobber"],
  ["POST", /^\/api\/admin\/login$/, "team", "sign in to the dashboard", "signed in to the dashboard"],
  ["POST", /^\/api\/admin\/logout$/, "team", "sign out of the dashboard", "signed out of the dashboard"],
  ["POST", /^\/api\/admin\/password$/, "team", "change their password", "changed their password"],
  ["POST", /^\/api\/admin\/setup$/, "team", "set up the first dashboard account", "set up the first dashboard account"],
  ["*", /^\/api\/admin\/(?:invite|owner-bootstrap)\//, "team", "accept a dashboard invitation", "accepted a dashboard invitation"],
  ["PATCH", /^\/api\/admin\/config$/, "team", "save settings", "saved settings"],
  ["POST", /^\/api\/admin\/appointments$/, "team", "add an appointment from the office", "added an appointment from the office"],
  ["PATCH", /^\/api\/admin\/appointments\/[^/]+$/, "team", "change an appointment", "changed an appointment"],
  ["POST", /^\/api\/admin\/appointments\/[^/]+\/resolve$/, "team", "settle an appointment that needed a Jobber check", "settled an appointment that needed a Jobber check"],
  ["POST", /^\/api\/admin\/appointments\/[^/]+\/confirmation$/, "team", "send an appointment confirmation", "sent an appointment confirmation"],
  ["POST", /^\/api\/admin\/approvals\/[^/]+$/, "team", "answer a request waiting for approval", "answered a request waiting for approval"],
  ["PATCH", /^\/api\/admin\/requests\/[^/]+$/, "team", "update an Inbox request", "updated an Inbox request"],
  ["POST", /^\/api\/admin\/technicians$/, "team", "save technicians", "saved technicians"],
  ["POST", /^\/api\/admin\/faqs\/reset$/, "team", "reset BOB's answers to common questions", "reset BOB's answers to common questions"],
  ["POST", /^\/api\/admin\/faqs$/, "team", "save BOB's answers to common questions", "saved BOB's answers to common questions"],
  ["POST", /^\/api\/admin\/geo\/check$/, "team", "test an address against the service area", "tested an address against the service area"],
  ["POST", /^\/api\/admin\/service-area\/map$/, "team", "check the service area map", "checked the service area map"],
  ["POST", /^\/api\/admin\/jobber\/disconnect$/, "team", "disconnect Jobber", "disconnected Jobber"],
  ["GET", /^\/api\/admin\/jobber\/connect$/, "team", "connect Jobber", "started connecting Jobber"],
  ["POST", /^\/api\/admin\/jobber\/client-hub/, "team", "save the Jobber Client Hub link", "saved the Jobber Client Hub link"],
  ["POST", /^\/api\/admin\/booking-report\/test$/, "team", "send a test booking report", "sent a test booking report"],
  ["POST", /^\/api\/admin\/(?:connections\/refresh|integration-accounts)$/, "team", "refresh connection status", "refreshed connection status"],
  ["POST", /^\/api\/admin\/templates\/preview$/, "team", "preview a message template", "previewed a message template"],
  ["POST", /^\/api\/admin\/owner-sms-consent$/, "team", "update the owner's text alert permission", "updated the owner's text alert permission"],
  ["POST", /^\/api\/admin\/users\/invite$/, "team", "invite a new dashboard user", "invited a new dashboard user"],
  ["PATCH", /^\/api\/admin\/users\/[^/]+$/, "team", "change a dashboard user's access", "changed a dashboard user's access"],
  ["POST", /^\/api\/admin\/users\/[^/]+\/reset-invite$/, "team", "send a fresh invitation", "sent a fresh invitation"],
  ["POST", /^\/api\/admin\/invitations\/[^/]+\/revoke$/, "team", "cancel an invitation", "cancelled an invitation"],
  ["*", /^\/api\/admin\//, "team", "use the dashboard", "used the dashboard"],
];
const WHO = { customer: "a customer", team: "a team member" };

function requestAction(method, path) {
  const m = str(method).toUpperCase(), p = str(path);
  const hit = REQUESTS.find(([verb, pattern]) => (verb === "*" || verb === m) && pattern.test(p));
  return hit ? { who: WHO[hit[2]], attempt: hit[3], done: hit[4] } : { who: "someone", attempt: "use BOB", done: "used BOB" };
}

const STATUS_HELP = {
  400: "Something they entered wasn't accepted.",
  401: "They weren't signed in, or their sign-in had expired.",
  403: "Their account doesn't have permission to do that.",
  404: "What they were working on couldn't be found. It may have expired or been removed.",
  409: "Things changed while they were working (for example, the time was taken or a setting changed).",
  413: "What they sent was too large.",
  429: "Too many tries in a short time, so BOB asked them to wait a moment.",
};
const seconds = (ms) => (ms >= 10_000 ? `${Math.round(ms / 1000)} seconds` : `${(ms / 1000).toFixed(1)} seconds`);

function describeRequest(d) {
  const { who, attempt, done } = requestAction(d.method, d.path);
  const status = Number(d.status) || 0;
  const said = str(d.error);
  if (status >= 500) return {
    title: `Something went wrong on BOB's side when ${who} tried to ${attempt}`,
    detail: `This wasn't their fault.${said ? ` They saw: "${said}"` : ""} If it keeps happening, send the technical details below to support.`,
    tone: "problem",
  };
  if (status >= 400) return {
    title: `${cap(who)} couldn't ${attempt}`,
    // BOB's own message to them is the most specific explanation; the general one is the fallback.
    detail: said ? `BOB told them: "${said}"` : STATUS_HELP[status] || "BOB didn't accept the request.",
    tone: "attention",
  };
  const ms = Number(d.timing?.ms);
  return { title: `${cap(who)} ${done}`, ...(ms >= 0 && Number.isFinite(ms) ? { detail: `Took ${seconds(ms)}.` } : {}), tone: "info", routine: true };
}

// ---- messages BOB sends (texts and emails) ----------------------------------------------

const EMAIL_KINDS = {
  appointment_confirmed: "the booking confirmation email to the customer",
  approval_pending: "the email asking the team to approve a time",
  booking_report: "the booking report email",
  after_hours_request: "the after-hours request email to the team",
};
const NOT_PROOF = "The text service accepted it. That usually means it arrives, but doesn't prove it reached the phone.";
const NOT_PROOF_EMAIL = "The email service accepted it. That usually means it arrives, but doesn't prove it reached the inbox.";

const SKIP_REASONS = {
  not_configured: "No one is set up to receive it, or the text/email service isn't set up.",
  disabled_or_not_configured: "Emails are turned off, or the email service isn't set up.",
  not_configured_or_disabled: "Confirmation texts are turned off, or the text service isn't set up.",
  no_consent: "The customer didn't agree to receive texts.",
  missing_phone: "There's no phone number on the booking.",
  not_confirmed: "The booking isn't confirmed yet.",
  sms_scope_owner_alerts_only: "Texting is limited to owner alerts, so other texts aren't sent.",
  emergency_texts_off: "Emergency texts are turned off.",
  owner_alerts_off: "Owner text alerts are off, or there's no owner phone number.",
  sms_not_configured: "The text service (Twilio) isn't set up.",
  owner_consent_required: "The owner hasn't agreed to receive these texts yet (Settings).",
  disabled: "Problem alerts by text are turned off.",
  recipient_changed: "The owner's phone number changed while BOB was sending, so it stopped to be safe.",
  sms_unavailable: "The text service wasn't available.",
  daily_cap: "Today's limit of 10 problem-alert texts was reached.",
  already_attempted: "BOB already tried to send this once and never sends it twice.",
  booking_already_attempted: "BOB already sent an alert about this booking.",
  read_only_preview: "This is a preview copy of BOB, which never sends anything.",
  claim_failed: "BOB couldn't save a record of the attempt, so it didn't send (to avoid duplicates).",
  clock_changed: "The day changed while BOB was sending, so it stopped.",
  unavailable: "Something BOB needed wasn't available.",
  invalid_notification: "The message was missing something it needs, like a valid address.",
  unsupported_kind: "BOB doesn't send alerts for this kind of problem.",
  invalid_reference: "The alert didn't point to a valid booking.",
  invalid_time: "The alert had an invalid time.",
  configuration_unavailable: "BOB couldn't read its settings.",
};
const skipReason = (code) => SKIP_REASONS[code] || (code ? `Reason: ${plainCode(code)}.` : "");

/** One send attempt: the thing being sent, how it went, and why. */
function describeSend(thing, status, { reason, email = false } = {}) {
  const proof = email ? NOT_PROOF_EMAIL : NOT_PROOF;
  switch (status) {
    case "accepted":
    case "sent":
      return { title: `Sent ${thing}`, detail: proof, tone: "good" };
    case "skipped":
      return { title: `Didn't send ${thing}`, detail: skipReason(reason), tone: "info" };
    case "already_attempted":
      return { title: `Didn't send ${thing} again`, detail: skipReason("already_attempted"), tone: "info" };
    case "rejected":
      return { title: `${cap(thing)} was refused`, detail: `The ${email ? "email" : "text"} service refused it, so it wasn't sent. ${skipReason(reason)}`.trim(), tone: "attention" };
    case "failed":
      return { title: `Couldn't send ${thing}`, detail: [skipReason(reason), "Please follow up another way."].filter(Boolean).join(" "), tone: "problem" };
    case "failed_or_uncertain":
      return { title: `${cap(thing)} may not have been sent`, detail: `BOB couldn't confirm it went out and won't retry on its own, so it doesn't send twice. Please check, and follow up by phone if needed.`, tone: "attention" };
    default:
      return { title: `${cap(thing)}: ${plainCode(status) || "status unknown"}`, tone: "info" };
  }
}

const OWNER_ALERT_TOPICS = {
  booking_action_needed: "a booking that needs attention",
  booking_jobber_failed: "a booking that didn't reach Jobber",
  jobber: "a problem with the Jobber connection",
  verification: "a problem sending verification codes",
  assistant: "a problem with BOB's AI assistant",
  email: "a problem sending emails",
};

// ---- things the office does in the dashboard -----------------------------------------

const ADMIN_ACTIONS = {
  "admin.setup": "set up the first dashboard account",
  "settings.updated": "changed settings",
  "technicians.updated": "updated technicians",
  "faqs.updated": "updated BOB's answers to common questions",
  "client_hub.updated": "changed the Jobber Client Hub link",
  "jobber.connected": "connected Jobber",
  "jobber.disconnected": "disconnected Jobber",
  "owner_sms.consent_recorded": "updated the owner's permission for text alerts",
  "request.created": "added an Inbox request",
  "request.updated": "updated an Inbox request",
  "appointment.updated": "changed an appointment",
  "appointment.confirmation_requested": "sent an appointment confirmation",
  "appointment.resolved_in_jobber": "confirmed an appointment is in Jobber",
  "appointment.resolved_not_created": "marked an appointment as not created in Jobber",
  "approval.requested": "sent a request for approval",
  "approval.confirmed": "approved a requested time",
  "approval.booked": "approved a requested time",
  "approval.declined": "declined a requested time",
  "approval.cancelled": "cancelled a request waiting for approval",
  "approval.expired": "let a request for approval expire",
  "approval.action_needed": "approved a time that still needs a Jobber check",
  "approval.failed": "approved a time, but it couldn't be booked",
  "booking.created": "booked an appointment",
  "booking.pending_review": "booked an appointment that needs review",
  "admin.booking.created": "booked an appointment from the office",
  "admin.booking.pending_review": "added an office appointment that needs review",
  "booking.jobber_uncertain": "booked an appointment, but BOB couldn't confirm it reached Jobber",
  "booking.jobber_visit_failed": "booked an appointment, but the visit couldn't be added in Jobber",
  "booking.jobber_visit_uncertain": "booked an appointment, but BOB couldn't confirm the visit was added in Jobber",
};
// Office actions that leave something for someone to check.
const ADMIN_ACTIONS_TO_CHECK = new Set(["approval.action_needed", "approval.failed", "booking.pending_review", "admin.booking.pending_review", "booking.jobber_uncertain", "booking.jobber_visit_failed", "booking.jobber_visit_uncertain"]);

const NUDGE_TOPICS = { cleaning: "vent cleaning", repair: "repairs", emergency: "an urgent problem", pest: "pests or nests", question: "asking a question", general: "a general offer" };
const AREAS = {
  in: "is inside the service area",
  travel: "is just outside the service area (travel charge applies if they continue)",
  out: "is outside the service area",
};
const onOff = (v) => (v ? "added" : "not added");

/**
 * @typedef {{ title: string, detail?: string, quote?: { who: "customer" | "bob" | "error", text: string },
 *   tone: "problem" | "attention" | "good" | "info", routine?: boolean, chat?: boolean }} ActivityText
 */

/**
 * A plain-English description of one activity record ({ kind, level, details, ... }).
 * Never throws: an unknown or malformed record gets a readable fallback.
 * @param {any} item
 * @returns {ActivityText}
 */
export function describeActivity(item) {
  const kind = str(item?.kind);
  const d = item?.details && typeof item.details === "object" ? item.details : {};
  const level = item?.level;
  const base = (() => {
    try { return describeKind(kind, d); } catch { return null; }
  })() || { title: cap(plainCode(kind)) || "Activity", tone: "info" };
  // A record's saved level is the final word on how serious it is.
  if (level === "error") base.tone = "problem";
  else if (level === "warning" && base.tone === "info") base.tone = "attention";
  if (base.tone !== "info") base.routine = false;
  return base;
}

function describeKind(kind, d) {
  const [family, ...rest] = kind.split(".");
  const status = rest.join(".");
  switch (kind) {
    case "conversation.started":
      return { title: "A customer opened a new chat with BOB", tone: "info" };
    case "conversation.message": {
      const step = stageLabel(d.stage);
      const text = str(d.text) === "[verification code omitted]" ? "(A verification code. Hidden for security.)" : str(d.text);
      if (d.role === "user") return { title: "Customer wrote", quote: { who: "customer", text }, ...(step ? { detail: `While ${step}.` } : {}), tone: "info", chat: true };
      return { title: "BOB replied", quote: { who: "bob", text }, ...(d.via === "ai" ? { detail: "Written with help from BOB's AI assistant." } : {}), tone: "info", chat: true };
    }
    case "conversation.unanswered_question":
      return { title: "BOB couldn't answer a customer's question", quote: { who: "customer", text: str(d.text) }, detail: "If customers ask this often, add an answer in Settings → Answers.", tone: "attention" };
    case "conversation.ai_answer_blocked":
      return { title: "BOB held back an AI answer", quote: { who: "customer", text: str(d.text) }, detail: "The AI's answer mentioned a price, phone number or promise BOB isn't allowed to give, so BOB used its standard reply instead. If this question comes up often, add an approved answer in Settings → Answers.", tone: "attention" };
    case "coverage.checked": {
      const where = AREAS[d.area] || "was checked against the service area";
      const miles = Number(d.miles), minutes = Number(d.minutes);
      const distance = [Number.isFinite(miles) && d.miles !== null ? `about ${Math.round(miles)} miles` : "", Number.isFinite(minutes) && d.minutes !== null ? `about ${Math.round(minutes)} minutes' drive` : ""].filter(Boolean).join(", ");
      return { title: `The customer's address ${where}`, ...(distance ? { detail: `${cap(distance)} from base.` } : {}), tone: d.area === "out" ? "attention" : "info" };
    }
    case "upsell.changed":
      return { title: "Customer changed their package or add-ons", detail: [d.package && `Package: ${PACKAGES[d.package]?.label || cap(plainCode(d.package))}`, `DryerFlex hose: ${onOff(d.dryerflex)}`, `Sanitizing fog: ${onOff(d.fogging)}`].filter(Boolean).join(" · "), tone: "info" };
    case "approval.after_hours_requested": {
      const told = [d.sms === "sent" && "text", d.email === "sent" && "email"].filter(Boolean);
      return { title: "Customer asked for the after-hours technician", detail: told.length ? `The team was notified by ${told.join(" and ")}. Someone needs to call them back to confirm.` : "BOB couldn't notify anyone by text or email. Please check the Inbox and call them back.", tone: told.length ? "attention" : "problem" };
    }
    case "approval.cancelled_by_customer":
      return { title: "Customer cancelled their request to the team", detail: "They no longer need an answer on that time.", tone: "info" };
    case "booking_report.test":
      return describeSend("a test booking report", d.status === "uncertain" ? "failed_or_uncertain" : d.status, { email: true });
    case "widget.minimized":
      return { title: "Customer minimized the chat window", tone: "info" };
    case "widget.expanded":
      return { title: "Customer reopened the chat window", tone: "info" };
    case "widget.nudge_opened":
      return { title: "Customer tapped the pop-up offer on the website", detail: `Offer about ${NUDGE_TOPICS[d.topic] || NUDGE_TOPICS.general}.`, tone: "info" };
    case "client.error":
      return { title: "Customer saw an error in the chat", ...(str(d.message) ? { quote: { who: "error", text: str(d.message) } } : {}), detail: "If several customers see this, send the technical details below to support.", tone: "problem" };
    case "request.finished":
      return describeRequest(d);
    case "admin.action": {
      const did = ADMIN_ACTIONS[d.action] || (str(d.action) ? `made a change (${plainCode(d.action)})` : "made a change");
      return { title: `A team member ${did}`, tone: ADMIN_ACTIONS_TO_CHECK.has(d.action) ? "attention" : "info" };
    }
  }
  if (family === "notification") {
    const to = d.recipient === "account admin" ? "the owner" : str(d.recipient) || "the team";
    const thing = d.approvalId ? `the text to ${to} about a customer's request` : "the booking confirmation text to the customer";
    const out = describeSend(thing, status, { reason: d.reason });
    if (status === "failed" && str(d.error)) out.detail = `The text service said: "${str(d.error)}". Please contact the team another way.`;
    if (status === "skipped" && d.reason === "not_configured") return { title: "No one was notified about a request waiting for approval", detail: "No approver phone number or email is set up, or texts and emails aren't set up. Check the Inbox for this request.", tone: "attention" };
    return out;
  }
  if (family === "email_notification") return describeSend(EMAIL_KINDS[d.kind] || "an email", status, { reason: d.reason, email: true });
  if (family === "customer_sms") return describeSend("the booking confirmation text to the customer", status, { reason: d.reason });
  if (family === "owner_notification") return describeSend("the new-booking text to the owner", status, { reason: d.reason });
  if (family === "owner_error_alert") return describeSend(`the owner's alert text about ${OWNER_ALERT_TOPICS[d.kind] || "an issue"}`, status, { reason: d.reason });
  return null;
}
