// One place that decides how a text or an email goes out — Twilio or LeadConnector — sends it,
// and writes it to the message log. Never throws: every send returns what actually happened.
//
// settings.messagingProvider:
//   "auto"          Twilio for whatever Twilio is set up for, LeadConnector for the rest (default)
//   "twilio"        Twilio only
//   "leadconnector" LeadConnector only
// LeadConnector keeps saving contacts, tags and notes either way; this module is only delivery.

import { randomUUID } from "node:crypto";
import { hintFor } from "./twilio.mjs";
import { normalizePhone } from "../shared/domain.mjs";

/** A Twilio stand-in for when the module isn't wired in (tests, local runs). */
export const NO_TWILIO = Object.freeze({
  configured: false, smsConfigured: false, verifyConfigured: false, emailConfigured: false, webhooksConfigured: false, ownNumber: "",
  describe: () => ({ sms: false, verify: false, email: false, webhooks: false, sender: "", from: "", emailFrom: "", accountOk: true }),
  validate: () => false,
});

// Errors about one recipient (bad number, opted out, landline) say nothing about the connection.
const RECIPIENT_ERRORS = new Set([21211, 21610, 21612, 21614, 60200]);
const LABELS = {
  code: "Text code not sent",
  confirmation: "Confirmation not sent",
  reminder: "Reminder not sent",
  approval: "Approval request not sent",
  office: "Office alert not sent",
  test: "Test message not sent",
};
const MESSAGE_TTL = 60 * 60 * 24 * 90; // the log keeps 90 days

export function createNotifier({ lc, twilio = NO_TWILIO, store, clock = Date.now, publicOrigin = "" }) {
  const pref = (c) => (["twilio", "leadconnector"].includes(c?.messagingProvider) ? c.messagingProvider : "auto");

  /** Which provider handles a channel right now: "twilio" | "twilio-verify" | "leadconnector" | null. */
  function route(c, channel) {
    const p = pref(c);
    const tw = channel === "email" ? twilio.emailConfigured : twilio.smsConfigured;
    if (channel === "code") {
      const viaTwilio = twilio.verifyConfigured ? "twilio-verify" : twilio.smsConfigured ? "twilio" : null;
      if (p === "twilio") return viaTwilio;
      if (p === "leadconnector") return lc.configured ? "leadconnector" : null;
      return viaTwilio || (lc.configured ? "leadconnector" : null);
    }
    if (p === "twilio") return tw ? "twilio" : null;
    if (p === "leadconnector") return lc.configured ? "leadconnector" : null;
    return tw ? "twilio" : lc.configured ? "leadconnector" : null;
  }
  const routes = (c) => ({ provider: pref(c), sms: route(c, "sms"), email: route(c, "email"), code: route(c, "code") });
  const anyConfigured = (c) => Boolean(route(c, "sms") || route(c, "email"));

  async function diag(provider, channel, kind, error) {
    const key = provider === "leadconnector" ? "diag:lc" : "diag:twilio";
    if (error) {
      if (provider !== "leadconnector" && RECIPIENT_ERRORS.has(Number(error.code))) return;
      await store.kvSet(key, { at: clock(), channel, message: `${LABELS[kind] || "Message not sent"}: ${String(error.message).slice(0, 300)}` }, 60 * 60 * 24 * 7).catch(() => {});
    } else if (provider !== "leadconnector") {
      // A Twilio send on this channel worked, so an older problem on the same channel is over.
      const last = await store.kvGet(key).catch(() => null);
      if (last?.channel === channel) await store.kvDel(key).catch(() => {});
    }
  }

  async function log(entry) {
    const id = entry.id || `local-${randomUUID()}`;
    await store.logMessage({ ...entry, id, at: clock() }, MESSAGE_TTL).catch((e) => console.warn("[messages] log:", e.message));
    return id;
  }

  /** LeadConnector needs a contact to message; reuse one the caller already has. */
  const lcContact = (to, { contactId, name, lcTags }) =>
    contactId || lc.upsertContact({ name, ...(to.includes("@") ? { email: to } : { phone: to }), ...(lcTags?.length ? { tags: lcTags } : {}) });

  /**
   * Text one person. opts: { to, body, kind, ref, name, contactId, lcTags, origin }.
   * Returns { status: "sent" | "failed" | "skipped", provider, id?, error? }.
   */
  async function sms(c, { to, body, kind = "message", ref = "", name, contactId, lcTags, origin } = {}) {
    const provider = route(c, "sms");
    if (!provider || !to) return { status: "skipped", provider: provider || null, reason: provider ? "no_recipient" : "not_configured" };
    return smsVia(provider, { to, body, kind, ref, name, contactId, lcTags, origin });
  }

  async function smsVia(provider, { to, body, kind, ref, name, contactId, lcTags, origin }) {
    const base = (origin || publicOrigin || "").replace(/\/$/, "");
    try {
      let id = "", accepted = "sent";
      if (provider === "leadconnector") {
        const json = await lc.sendSms(await lcContact(to, { contactId, name, lcTags }), body);
        id = json?.messageId || "";
      } else {
        const callback = base.startsWith("https://") && twilio.webhooksConfigured ? `${base}/api/twilio/status` : undefined;
        const r = await twilio.sendSms(to, body, { statusCallback: callback });
        id = r.sid;
        accepted = r.status || "queued";
      }
      await log({ id: id || undefined, channel: "sms", direction: "out", provider, kind, ref, to, status: accepted });
      await diag(provider, "sms", kind, null);
      return { status: "sent", provider, id };
    } catch (error) {
      console.error(`[messages] ${provider} sms (${kind})`, error.message);
      await log({ channel: "sms", direction: "out", provider, kind, ref, to, status: "failed", error: String(error.message).slice(0, 300), errorCode: error.code ?? null });
      await diag(provider, "sms", kind, error);
      return { status: "failed", provider, error: String(error.message), errorCode: error.code ?? null };
    }
  }

  /** Email one person. opts: { to, name, subject, html, text, kind, ref, contactId, lcTags, replyTo }. */
  async function email(c, { to, name, subject, html, text, kind = "message", ref = "", contactId, lcTags, replyTo } = {}) {
    const provider = route(c, "email");
    if (!provider || !to) return { status: "skipped", provider: provider || null, reason: provider ? "no_recipient" : "not_configured" };
    try {
      let id = "";
      if (provider === "leadconnector") {
        const json = await lc.sendEmail(await lcContact(to, { contactId, name, lcTags }), { subject, html, text });
        id = json?.emailMessageId || json?.messageId || "";
      } else {
        const r = await twilio.sendEmail({ to, toName: name, subject, html, text, replyTo: replyTo ?? (c.email || undefined), fromName: c.businessName, tags: { kind, ref } });
        id = r.id ? `sg-${r.id}` : "";
      }
      await log({ id: id || undefined, channel: "email", direction: "out", provider, kind, ref, to, status: "sent", subject });
      await diag(provider, "email", kind, null);
      return { status: "sent", provider, id };
    } catch (error) {
      console.error(`[messages] ${provider} email (${kind})`, error.message);
      await log({ channel: "email", direction: "out", provider, kind, ref, to, status: "failed", subject, error: String(error.message).slice(0, 300) });
      await diag(provider, "email", kind, error);
      return { status: "failed", provider, error: String(error.message) };
    }
  }

  /**
   * Phone code. With Twilio Verify, Twilio makes the code (pass none); otherwise BOB's code is texted.
   * Returns { status, provider, error? }.
   */
  async function code(c, phone, value) {
    const provider = route(c, "code");
    if (!provider) return { status: "skipped", provider: null };
    if (provider !== "twilio-verify") return smsVia(provider, { to: phone, body: value.body, kind: "code" });
    try {
      const r = await twilio.startVerification(phone);
      await log({ id: r.sid || undefined, channel: "sms", direction: "out", provider, kind: "code", to: phone, status: r.status || "pending" });
      await diag(provider, "verify", "code", null);
      return { status: "sent", provider };
    } catch (error) {
      console.error("[messages] twilio verify", error.message);
      await log({ channel: "sms", direction: "out", provider, kind: "code", to: phone, status: "failed", error: String(error.message).slice(0, 300), errorCode: error.code ?? null });
      await diag(provider, "verify", "code", error);
      return { status: "failed", provider, error: String(error.message) };
    }
  }

  /**
   * Alert the office. kind: "bookings" | "requests" | "problems" | "replies" (the settings switches).
   * Uses settings.officeAlerts phone/email; nothing is sent when neither is filled in.
   */
  async function office(c, kind, { sms: body, email: mail, ref = "", origin } = {}) {
    const o = c.officeAlerts || {};
    const out = { sms: "skipped", email: "skipped" };
    if (o[kind] === false) return out;
    const phone = normalizePhone(o.phone);
    if (phone && body) out.sms = (await sms(c, { to: phone, body, kind: "office", ref, name: "Office", origin })).status;
    if (o.email && mail) out.email = (await email(c, { to: o.email, name: "Office", ...mail, kind: "office", ref, replyTo: mail.replyTo })).status;
    return out;
  }

  return { route, routes, anyConfigured, sms, email, code, office, hintFor };
}
