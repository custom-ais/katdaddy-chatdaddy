// Twilio — texts (Programmable Messaging), phone codes (Verify) and email (Twilio SendGrid).
// Plain fetch, like the LeadConnector and Jobber modules; no SDK in the function bundle.
//
// Environment (Vercel):
//   TWILIO_ACCOUNT_SID            AC…  (required)
//   TWILIO_AUTH_TOKEN             signs webhooks; also the API password unless an API key is set
//   TWILIO_API_KEY_SID / _SECRET  SK… + secret (optional, preferred for API calls)
//   TWILIO_MESSAGING_SERVICE_SID  MG…  (preferred sender: handles STOP/HELP and A2P registration)
//   TWILIO_FROM_NUMBER            +1…  (used only when there is no Messaging Service)
//   TWILIO_VERIFY_SERVICE_SID     VA…  (optional: phone codes through Verify, no A2P registration needed)
//   SENDGRID_API_KEY              SG…  (email)
//   SENDGRID_FROM_EMAIL           a sender verified in SendGrid, e.g. bookings@dryerventsquadaz.com
//   SENDGRID_FROM_NAME            optional display name

import { createHmac, timingSafeEqual } from "node:crypto";
import { cleanSecret } from "./leadconnector.mjs";

const API = "https://api.twilio.com/2010-04-01";
const VERIFY = "https://verify.twilio.com/v2";
const SENDGRID = "https://api.sendgrid.com/v3/mail/send";

/** Plain-English notes for the Twilio errors an office is most likely to hit. */
const HINTS = {
  20003: "Twilio rejected the credentials. Check TWILIO_ACCOUNT_SID and the auth token or API key.",
  21211: "That phone number isn't valid.",
  21408: "Texting this country isn't enabled in Twilio's geo permissions.",
  21606: "TWILIO_FROM_NUMBER isn't a Twilio number that can send texts.",
  21608: "This Twilio account is still a trial: it can only text numbers verified in the Twilio console.",
  21610: "This person replied STOP, so Twilio won't text them until they reply START.",
  21614: "That number can't receive texts (likely a landline).",
  30007: "The carrier filtered the text as spam.",
  30032: "The toll-free number isn't verified yet, so carriers block its texts.",
  30034: "The sending number isn't registered for A2P 10DLC, so US carriers block its texts. Finish the A2P registration in Twilio, or use a verified toll-free number.",
  60200: "Twilio Verify rejected the phone number.",
  60203: "Too many codes were sent to this number. Twilio Verify will allow more shortly.",
  60410: "Twilio Verify blocked this number as suspected fraud.",
};
export const hintFor = (code) => HINTS[Number(code)] || "";

export class TwilioError extends Error {
  constructor(message, { status = 0, code = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---- webhook signatures -----------------------------------------------------------------
// Twilio signs each webhook: HMAC-SHA1 (key = auth token) over the full URL followed by every
// POST parameter, sorted by name, as name+value with no separators. Base64 in X-Twilio-Signature.
// Matches twilio-node's validateRequest (tests compare the two), including the with/without
// default-port variants of the URL.

function splitUrl(url) {
  const m = /^(https?:\/\/)([^/?#@]*@)?([^/?#:]+)(:\d+)?(.*)$/i.exec(url);
  return m ? { scheme: m[1], userInfo: m[2] || "", host: m[3], port: m[4] || "", rest: m[5] } : null;
}
const withPort = (url) => {
  const p = splitUrl(url);
  if (!p || p.port) return url;
  return p.scheme + p.userInfo + p.host + (p.scheme.toLowerCase() === "https://" ? ":443" : ":80") + p.rest;
};
const withoutPort = (url) => {
  const p = splitUrl(url);
  return p ? p.scheme + p.userInfo + p.host + p.rest : url;
};

export function twilioSignature(authToken, url, params = {}) {
  const pair = (name, value) =>
    Array.isArray(value) ? [...new Set(value)].sort().map((v) => pair(name, v)).join("") : `${name}${value ?? ""}`;
  const data = Object.keys(params).sort().reduce((acc, key) => acc + pair(key, params[key]), url);
  return createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");
}

/** True when the signature matches any of the URLs Twilio could have signed. */
export function validTwilioSignature(authToken, signature, urls, params) {
  if (!authToken || !signature) return false;
  const given = Buffer.from(String(signature));
  const candidates = new Set((Array.isArray(urls) ? urls : [urls]).filter(Boolean).flatMap((u) => [withoutPort(u), withPort(u)]));
  for (const url of candidates) {
    const expected = Buffer.from(twilioSignature(authToken, url, params));
    if (expected.length === given.length && timingSafeEqual(expected, given)) return true;
  }
  return false;
}

// ---- client -----------------------------------------------------------------------------

export function createTwilio({ env = process.env, fetchImpl = fetch } = {}) {
  const cfg = {
    accountSid: cleanSecret(env.TWILIO_ACCOUNT_SID),
    authToken: cleanSecret(env.TWILIO_AUTH_TOKEN),
    apiKeySid: cleanSecret(env.TWILIO_API_KEY_SID),
    apiKeySecret: cleanSecret(env.TWILIO_API_KEY_SECRET),
    messagingServiceSid: cleanSecret(env.TWILIO_MESSAGING_SERVICE_SID),
    fromNumber: cleanSecret(env.TWILIO_FROM_NUMBER),
    verifyServiceSid: cleanSecret(env.TWILIO_VERIFY_SERVICE_SID),
    sendgridKey: cleanSecret(env.SENDGRID_API_KEY),
    emailFrom: cleanSecret(env.SENDGRID_FROM_EMAIL),
    emailFromName: String(env.SENDGRID_FROM_NAME || "").trim(),
  };
  const user = cfg.apiKeySid && cfg.apiKeySecret ? cfg.apiKeySid : cfg.accountSid;
  const pass = cfg.apiKeySid && cfg.apiKeySecret ? cfg.apiKeySecret : cfg.authToken;
  const credentials = Boolean(/^AC[0-9a-f]{32}$/i.test(cfg.accountSid) && pass);

  const smsConfigured = credentials && Boolean(cfg.messagingServiceSid || cfg.fromNumber);
  const verifyConfigured = credentials && Boolean(cfg.verifyServiceSid);
  const emailConfigured = Boolean(cfg.sendgridKey && cfg.emailFrom);
  const webhooksConfigured = Boolean(cfg.authToken);

  async function form(url, fields) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== "") body.append(k, String(v));
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new TwilioError(`Twilio request failed: ${error.message}`);
    }
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const hint = hintFor(json.code);
      throw new TwilioError(`Twilio ${response.status}${json.code ? ` (error ${json.code})` : ""}: ${hint || json.message || "request failed"}`, { status: response.status, code: json.code ?? null });
    }
    return json;
  }

  /** Send a text. Returns { sid, status } as Twilio accepted it (usually "queued"/"accepted"). */
  async function sendSms(to, body, { statusCallback } = {}) {
    if (!smsConfigured) throw new TwilioError("Twilio texting isn't set up.");
    const json = await form(`${API}/Accounts/${cfg.accountSid}/Messages.json`, {
      To: to,
      Body: body,
      ...(cfg.messagingServiceSid ? { MessagingServiceSid: cfg.messagingServiceSid } : { From: cfg.fromNumber }),
      StatusCallback: statusCallback,
    });
    return { sid: json.sid, status: json.status || "queued" };
  }

  /** Verify: Twilio makes and texts the code. */
  async function startVerification(to) {
    if (!verifyConfigured) throw new TwilioError("Twilio Verify isn't set up.");
    const json = await form(`${VERIFY}/Services/${cfg.verifyServiceSid}/Verifications`, { To: to, Channel: "sms" });
    return { sid: json.sid, status: json.status };
  }

  /** Verify: true only when Twilio says "approved". An expired or used-up code is false, not an error. */
  async function checkVerification(to, code) {
    if (!verifyConfigured) throw new TwilioError("Twilio Verify isn't set up.");
    try {
      const json = await form(`${VERIFY}/Services/${cfg.verifyServiceSid}/VerificationCheck`, { To: to, Code: code });
      return json.status === "approved";
    } catch (error) {
      if (error.status === 404) return false; // no pending code: expired, already used, or too many tries
      throw error;
    }
  }

  /** Email through Twilio SendGrid. Returns { id } (SendGrid's X-Message-Id). */
  async function sendEmail({ to, toName, subject, html, text, replyTo, fromName, tags = {} }) {
    if (!emailConfigured) throw new TwilioError("SendGrid email isn't set up.");
    const body = {
      personalizations: [{ to: [{ email: to, ...(toName ? { name: toName } : {}) }] }],
      from: { email: cfg.emailFrom, ...((cfg.emailFromName || fromName) ? { name: cfg.emailFromName || fromName } : {}) },
      ...(replyTo ? { reply_to: { email: replyTo } } : {}),
      subject,
      content: [{ type: "text/plain", value: text || " " }, ...(html ? [{ type: "text/html", value: html }] : [])],
      custom_args: Object.fromEntries(Object.entries(tags).filter(([, v]) => v != null && v !== "").map(([k, v]) => [k, String(v)])),
      categories: ["bob"],
    };
    let response;
    try {
      response = await fetchImpl(SENDGRID, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.sendgridKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new TwilioError(`SendGrid request failed: ${error.message}`);
    }
    if (!response.ok) {
      const json = await response.json().catch(() => ({}));
      const detail = (json.errors || []).map((e) => e.message).filter(Boolean).join("; ");
      const hint = response.status === 401 || response.status === 403
        ? "SendGrid rejected the key, or SENDGRID_FROM_EMAIL isn't a verified sender."
        : "";
      throw new TwilioError(`SendGrid ${response.status}: ${hint || detail || "request failed"}`, { status: response.status });
    }
    return { id: response.headers.get("x-message-id") || "" };
  }

  const validate = (signature, urls, params) => validTwilioSignature(cfg.authToken, signature, urls, params);

  /** What the dashboard may show: which pieces are set up, and masked identifiers only. */
  const describe = () => ({
    sms: smsConfigured,
    verify: verifyConfigured,
    email: emailConfigured,
    webhooks: webhooksConfigured,
    sender: cfg.messagingServiceSid ? "messaging-service" : cfg.fromNumber ? "number" : "",
    from: cfg.fromNumber ? `•••${cfg.fromNumber.replace(/\D/g, "").slice(-4)}` : "",
    emailFrom: cfg.emailFrom,
    accountOk: !cfg.accountSid || /^AC[0-9a-f]{32}$/i.test(cfg.accountSid),
  });

  return {
    cfg,
    configured: smsConfigured || verifyConfigured || emailConfigured,
    smsConfigured, verifyConfigured, emailConfigured, webhooksConfigured,
    ownNumber: cfg.fromNumber,
    sendSms, startVerification, checkVerification, sendEmail, validate, describe,
  };
}
