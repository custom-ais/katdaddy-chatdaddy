// BOB HTTP API — Postgres-backed, serverless-friendly. Jobber is the master schedule,
// LeadConnector carries the phone check, approvals and confirmations, and Gemini reads
// free-typed chat. Static files are served by the host (Vercel).
//
// Booking sequence (rulebook, Oct 20 architecture):
//   chat → service accepted → contact → LeadConnector text code (phone verified)
//   → live Jobber-aware times → 5-minute hold → final approval
//   → [approval by a named approver for emergency / 5 PM visits]
//   → Jobber client + job + visit → only then "confirmed" → LeadConnector confirmation.

import { isIP } from "node:net";
import { distanceMiles, validPoint } from "../shared/coverage.mjs";
import { captureAvailabilityRequest } from "./availability-request.mjs";
import { randomBytes, randomInt, createHash, scryptSync, timingSafeEqual, createHmac } from "node:crypto";
import {
  DEFAULT_CONFIG, INITIAL_FAQS, bookingQuote, travelFeeFor, validateContact,
  validateConfig, normalizePhone, isBookable, BUNDLE_PRICE_CENTS, phoenixDate, areaFor, drivingAreaFor, textCodeOn,
} from "../shared/domain.mjs";
import { initialSession, WELCOME } from "../shared/conversation.mjs";
import { territoryFor, WEST_VALLEY_ZIPS } from "../shared/territory.mjs";
import { chatTurn } from "./chat.mjs";
import { confirmationEmail, confirmationSms, verificationSms, approvalRequestText } from "./messages.mjs";

const digest = (v) => createHash("sha256").update(String(v || "")).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const fail = (status, message, extra) => {
  throw new HttpError(status, message, extra);
};
const cookie = (req, name) => {
  try {
    return decodeURIComponent(
      (req.headers.cookie || "").split(";").map((x) => x.trim()).find((x) => x.startsWith(name + "="))?.slice(name.length + 1) || "",
    );
  } catch {
    return "";
  }
};
async function readBody(req) {
  if (!(req.headers["content-type"] || "").startsWith("application/json")) fail(415, "Send JSON data.");
  let value = req.body;
  if (value === undefined || typeof value === "string" || Buffer.isBuffer(value)) {
    let raw = typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : "";
    if (value === undefined) for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 65_536) fail(413, "Request is too large.");
    }
    try {
      value = JSON.parse(raw || "{}");
    } catch {
      fail(400, "Invalid JSON request.");
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "Invalid JSON request.");
  return value;
}
const maskPhone = (e164) => {
  const d = String(e164 || "").replace(/\D/g, "").slice(-4);
  return d ? `(•••) •••-${d}` : "";
};
const VERIFY_TTL = 10 * 60_000;
const VERIFIED_FOR = 6 * 3_600_000;
const APPROVAL_WINDOW = 30 * 60_000;
const FAQ_STATUSES = ["approved", "draft"];

export function createBobHandler({ store, jobber, lc, geo, scheduler, assistant = null, env = process.env, clock = () => Date.now() }) {
  const publicOrigin = (env.PUBLIC_ORIGIN || env.NEXT_PUBLIC_APP_URL || env.APP_URL || "").replace(/\/$/, "");
  // ChatDaddy's existing admin password works as the dashboard password.
  const envPassword = env.ADMIN_PASSWORD || "";
  const webhookUrl = env.BOOKING_WEBHOOK_URL || "";
  const webhookSecret = env.BOOKING_WEBHOOK_SECRET || "";
  const setupToken = env.BOB_SETUP_TOKEN || "";
  const normalizeIP = (v) => String(v || "").replace(/^::ffff:/, "");
  const trustedProxies = new Set(String(env.TRUSTED_PROXY_IPS || "").split(",").map((v) => normalizeIP(v.trim())).filter((v) => isIP(v)));

  const clientIP = (req) => {
    // Vercel's edge sets these headers itself; elsewhere only trusted proxies may.
    if (env.VERCEL) return normalizeIP(req.headers["x-real-ip"] || String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket?.remoteAddress);
    let peer = normalizeIP(req.socket?.remoteAddress);
    if (trustedProxies.has(peer)) {
      for (const item of String(req.headers["x-forwarded-for"] || "").split(",").slice(-20).reverse()) {
        const ip = normalizeIP(item.trim());
        if (!isIP(ip)) break;
        if (!trustedProxies.has(ip)) {
          peer = ip;
          break;
        }
      }
    }
    return peer;
  };
  const csrf = (req) => {
    if (req.headers["x-bob-request"] !== "1") fail(403, "Request verification failed.");
    const origin = req.headers.origin;
    const proto = String(req.headers["x-forwarded-proto"] || (env.VERCEL ? "https" : "http")).split(",")[0].trim();
    const own = `${proto}://${req.headers.host}`;
    if (origin && origin !== own && origin !== publicOrigin) fail(403, "This request origin is not allowed.");
  };
  const rate = async (req, scope, limit = 60, period = 60_000) => {
    if (!(await store.rateHit(`${scope}:${clientIP(req)}`, limit, period))) fail(429, "Too many requests. Please try again shortly.");
  };
  const admin = async (req) => {
    const token = digest(cookie(req, "bob_admin"));
    if (!(await store.isAdmin(token))) fail(401, "Please sign in to the management dashboard.");
    return token;
  };
  const session = async (req) => {
    const token = digest(req.headers["x-bob-session"]);
    const data = await store.loadSession(token);
    if (!data) fail(401, "This conversation expired. Start a new conversation.");
    if (req.bobActivity) req.bobActivity.sessionId = token.slice(0, 16);
    return { token, data };
  };

  const jobberMode = (c) => c.scheduleSource === "Jobber";
  const verificationReady = (c) => !textCodeOn(c) || lc.configured;
  const bookingOpen = async (c) => isBookable(c) && (c.serviceAreaMode !== "driving_distance" || geo.provider === "google") && verificationReady(c) && (!jobberMode(c) || (await jobber.connected()));
  const aiReady = (c) => Boolean(assistant?.configured) && c.aiAssistant !== false;
  const phoneOk = (data, c) =>
    !textCodeOn(c) ||
    Boolean(data.phoneVerified?.phone && data.phoneVerified.phone === data.contact?.phone && clock() - data.phoneVerified.at < VERIFIED_FOR);
  const needsApproval = (q, slot, c) => (c.approvalServices || []).includes(q.package) || Boolean(slot?.overflow);
  const coverageFingerprint = (c) => digest(JSON.stringify([c.serviceAreaMode, c.baseAddress, c.baseLocation, c.serviceAreaMiles, c.travelAreaMiles, c.customServiceAreas, c.serviceZips, c.travelZips, c.travelZoneFeeCents, c.maxDriveFromBaseMin, c.travelFeeTiers]));
  const ensureCoverageCurrent = (data, c) => {
    if ((data.coverageFingerprint && data.coverageFingerprint !== coverageFingerprint(c)) || (!data.coverageFingerprint && ["driving_distance", "radius"].includes(c.serviceAreaMode))) {
      fail(409, "Our service area changed. Please review your address details so we can check the updated map.", { code: "COVERAGE_CHANGED" });
    }
  };

  const record = async (req, kind, details, level = "info") => {
    try { await store.log(kind, details, { ...req.bobActivity, level }); return true; }
    catch (error) { console.error("[activity] persistent write failed", error.message); return false; }
  };

  const publicConfig = async () => {
    const c = await store.config();
    return {
      businessName: c.businessName,
      phone: c.phone,
      email: c.email,
      bookingEnabled: await bookingOpen(c),
      addressSuggestions: Boolean(geo.suggestions),
      timeZone: "America/Phoenix",
      cleaningPriceCents: c.cleaningPriceCents,
      assessmentPriceCents: c.assessmentPriceCents,
      bundlePriceCents: BUNDLE_PRICE_CENTS,
      preparation: c.preparation,
      faqs: ((await store.get("faqs")) || []).filter((f) => f.status !== "draft").map(({ id, question, answer, category, subcategory }) => ({ id, question, answer, category, subcategory })),
      welcome: WELCOME,
      notificationsConfigured: lc.configured || Boolean(webhookUrl),
      pricesApproved: Boolean(c.pricesAcknowledged),
      smartChat: aiReady(c),
      phoneVerification: textCodeOn(c),
      textMessages: c.smsConfirmations !== false, // off: no SMS consent question and no texts to customers
      approverName: c.approver?.name || "",
      // Optional extras the customer can tick on the details form.
      addOns: [["fogging", "fogging"], ["toolRetrieval", "tool"]].flatMap(([key, variant]) => {
        const item = (c.services || []).find((x) => x.family === "addon" && x.variant === variant && x.active !== false);
        return item ? [{ key, name: item.name, description: item.description, cents: item.priceCents }] : [];
      }),
    };
  };

  const integrations = async () => ({
    jobber: { appConfigured: jobber.appConfigured, connected: await jobber.connected() },
    leadConnector: { configured: lc.configured, tokenKind: lc.tokenKind || "", issue: (await store.kvGet("diag:lc").catch(() => null)) || null },
    maps: { provider: geo.provider, issue: (await geo.lastIssue?.()) || null },
    lastError: (await store.kvGet("diag:last-error").catch(() => null)) || null,
    assistant: { configured: Boolean(assistant?.configured), model: assistant?.model || "" },
    database: store.db.kind,
  });

  // ---- outbound webhook (unchanged behaviour) -----------------------------------
  const dispatch = async () => {
    if (!webhookUrl) return;
    const event = await store.nextEvent();
    if (!event) return;
    try {
      const url = new URL(webhookUrl);
      if (url.protocol !== "https:") throw new Error("Webhook requires HTTPS.");
      const payload = JSON.stringify({ id: event.id, type: event.kind, data: event.data });
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-BOB-Event": event.id,
          ...(webhookSecret ? { "X-BOB-Signature": createHmac("sha256", webhookSecret).update(payload).digest("hex") } : {}),
        },
        body: payload,
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });
      if (!response.ok) throw new Error("Delivery rejected.");
      await store.markEvent(event.id, true, event.attempts);
    } catch {
      await store.markEvent(event.id, false, event.attempts);
    }
  };

  /** Pending approvals past their deadline become expired and free their hold. */
  const sweepApprovals = async (list) => {
    for (const a of list) {
      if (a.status === "pending" && clock() > a.expiresAt) {
        a.status = "expired";
        await store.updateApproval(a);
        await store.releaseHold(a.holdId);
        await store.audit("approval.expired", a.id);
      }
    }
    return list;
  };

  const snapshot = async () => ({
    config: await store.config(),
    faqs: await store.get("faqs"),
    technicians: await store.technicians(),
    appointments: await store.appointments(),
    requests: await store.requests(),
    approvals: await sweepApprovals(await store.approvals()),
    heldLocksCount: await store.countActiveHolds(),
    conversations: await store.countSessions(),
    notifications: await store.recentEvents(),
    notificationsConfigured: lc.configured || Boolean(webhookUrl),
    integrations: await integrations(),
    westValleyZips: WEST_VALLEY_ZIPS,
    now: clock(),
  });

  const notificationText = (appt) => {
    if (appt.status !== "confirmed" && appt.status !== "in_progress" && appt.status !== "completed") {
      return "This visit is not confirmed yet. Our team is finishing it in the schedule and will contact you — please don't book it again.";
    }
    const n = appt.notifications || {};
    const parts = [];
    if (n.sms === "sent") parts.push("a confirmation text");
    if (n.email === "sent") parts.push("a confirmation email");
    if (parts.length) return `We sent ${parts.join(" and ")}. Keep your reference number handy.`;
    return "Your confirmation is shown here. Save it — a text or email has not been confirmed sent.";
  };
  const receipt = async (appt) => ({
    id: appt.id,
    status: appt.status,
    service: appt.package,
    priceCents: Math.round(appt.price * 100),
    servicePriceCents: appt.servicePriceCents ?? Math.round(appt.price * 100),
    travelFeeCents: appt.travelFeeCents || 0,
    lineItems: appt.lineItems || [],
    scheduledAt: appt.scheduledAt,
    durationMins: appt.durationMins,
    name: appt.customerName,
    address: appt.address,
    city: appt.city,
    zip: appt.zip,
    route: appt.route,
    jobberJobNumber: appt.jobber?.jobNumber || null,
    notification: notificationText(appt),
    preparation: (await store.config()).preparation,
  });

  /** Geocode a service address and apply the area + travel-fee rules. */
  async function locate(c, { address, city, zip }, { travelZone = false } = {}) {
    let g;
    try {
      g = await geo.geocode(`${address}, ${city}, AZ ${zip}`);
    } catch (error) {
      if (error.code !== "GEO_UNAVAILABLE") throw error;
      console.error("[geo]", error.message);
      return { ok: false, reason: "lookup_unavailable" };
    }
    if (!g) return { ok: false, reason: "not_found" };
    if (g.state && g.state.toUpperCase() !== "AZ") return { ok: false, reason: "out_of_area" };
    if (["driving_distance", "radius"].includes(c.serviceAreaMode)) {
      let route;
      try {
        const base = validPoint(c.baseLocation) ? c.baseLocation : c.baseAddress ? await geo.geocode(c.baseAddress) : null;
        if (!base) return { ok: false, reason: "routing_unavailable" };
        if (c.serviceAreaMode === "radius") route = { miles: distanceMiles(base, g), minutes: null };
        else {
          if (!geo.roadRoutes) return { ok: false, reason: "routing_unavailable" };
          [route] = await geo.roadRoutes([{ from: base, to: g }]);
        }
      } catch { return { ok: false, reason: "routing_unavailable" }; }
      if (!route) return { ok: false, reason: "routing_unavailable" };
      const area = drivingAreaFor(route.miles, c, g.state, g);
      return {
        ok: area !== "out", area, reason: area === "out" ? "out_of_area" : null,
        location: { lat: g.lat, lng: g.lng, formatted: g.formatted, precise: g.precise, neighborhood: g.neighborhood || "" },
        driveFromBaseMiles: route.miles, driveFromBaseMin: route.minutes, distanceMethod: c.serviceAreaMode,
        travelFeeCents: area === "travel" ? c.travelZoneFeeCents : 0,
        territory: territoryFor(zip, g.neighborhood || ""),
      };
    }
    let driveFromBaseMin = null;
    if (c.baseAddress) {
      // The customer's address is known, so a failed drive-time check doesn't stop the booking;
      // it is treated like no base address (no travel fee, no farthest-drive limit).
      try {
        const base = await geo.geocode(c.baseAddress);
        if (base) [driveFromBaseMin] = await geo.driveMinutes([{ from: base, to: g }]);
      } catch (error) {
        console.error("[geo] base address", error.message);
      }
    }
    // A just-outside ZIP the customer accepted is beyond the usual drive limits by design.
    if (!travelZone && driveFromBaseMin != null && driveFromBaseMin > c.maxDriveFromBaseMin) return { ok: false, reason: "out_of_area", driveFromBaseMin };
    const fee = travelFeeFor(driveFromBaseMin, c);
    if (fee == null && !travelZone) return { ok: false, reason: "out_of_area", driveFromBaseMin };
    return {
      ok: true,
      location: { lat: g.lat, lng: g.lng, formatted: g.formatted, precise: g.precise, neighborhood: g.neighborhood || "" },
      driveFromBaseMin,
      travelFeeCents: fee ?? 0,
      territory: territoryFor(zip, g.neighborhood || ""),
    };
  }

  /** Jobber: client + property + job + scheduled visit. Returns appointment.jobber details. */
  async function pushToJobber(appt, slot, notes) {
    const { firstName, lastName } = splitName(appt.customerName);
    const { clientId, propertyId } = await jobber.ensureClientAndProperty(
      { firstName, lastName, email: appt.email, phone: appt.phone, smsConsent: appt.smsConsent },
      { street1: appt.address, city: appt.city, zip: appt.zip },
    );
    const lineItems = (appt.lineItems?.length ? appt.lineItems : [{ name: appt.package, cents: appt.servicePriceCents }]).map((l) => ({
      name: l.name, cents: l.cents, description: l.description || "",
    }));
    const instructions = [
      `Booked by BOB (${appt.source === "ai_bot" ? "website chat" : "office"}) · ref ${appt.id}`,
      appt.property && Object.keys(appt.property).length ? `Home: ${Object.entries(appt.property).map(([k, v]) => `${k} ${Array.isArray(v) ? v.join("+") : v}`).join(", ")}` : "",
      appt.concerns?.length ? `Customer concerns: ${appt.concerns.join(" | ")}` : "",
      notes ? `Access notes: ${notes}` : "",
      slot.nearestJobMin != null ? `Nearest job that day ~${slot.nearestJobMin} min away.` : "",
      appt.approval ? `Approved by ${appt.approval.by} (${appt.approval.id}).` : "",
      appt.overflow ? "5 PM overflow visit." : "",
      appt.travelZone ? `Just outside the service area (ZIP ${appt.zip}); the customer accepted a travel charge${appt.travelFeeCents ? ` of $${(appt.travelFeeCents / 100).toFixed(2)}` : " (amount not set in BOB; confirm with the customer)"}.` : "",
      `Phone ${appt.phoneVerified ? "verified by text code" : "not verified"}. Service texts: ${appt.smsConsent ? "consented" : "no consent"}.`,
    ].filter(Boolean).join("\n");
    const { job, visit } = await jobber.createScheduledJob({
      propertyId,
      title: appt.package,
      instructions,
      lineItems,
      start: Date.parse(appt.scheduledAt),
      end: Date.parse(appt.scheduledAt) + appt.durationMins * 60_000,
      jobberUserId: slot.jobberUserId,
    });
    return { clientId, propertyId, jobId: job.id, jobNumber: job.jobNumber, webUri: job.jobberWebUri, visitId: visit?.id || null };
  }

  /** LeadConnector confirmations. Never throws; records what actually happened. */
  async function confirmWithLeadConnector(appt, c) {
    const result = { sms: "skipped", email: "skipped" };
    if (!lc.configured) return result;
    try {
      const contactId = await lc.upsertContact({
        name: appt.customerName, phone: appt.phone, email: appt.email, address: appt.address, city: appt.city, zip: appt.zip,
        smsConsent: appt.smsConsent, tags: lc.cfg.bookedTags,
      });
      result.contactId = contactId;
      if (appt.phone && appt.smsConsent && c.smsConfirmations) {
        result.sms = await lc.sendSms(contactId, confirmationSms(appt, c)).then(async (response) => {
          result.smsMessageId = response?.messageId || response?.id || null;
          await store.log("notification.accepted", { appointmentId: appt.id, channel: "sms", provider: "LeadConnector", messageId: result.smsMessageId, delivery: "not_confirmed" }).catch((error) => console.error("[activity] notification log", error.message));
          return "sent";
        }, async (error) => {
          await store.log("notification.failed", { appointmentId: appt.id, channel: "sms", error: error.message }, { level: "error" }).catch((error) => console.error("[activity] notification log", error.message));
          return "failed";
        });
      }
      if (appt.email && c.emailConfirmations) {
        result.email = await lc.sendEmail(contactId, confirmationEmail(appt, c)).then(() => "sent", (e) => (console.error("[lc] email", e.message), "failed"));
      }
      await lc.addNote(contactId, `BOB booking ${appt.id}: ${appt.package}, ${new Date(appt.scheduledAt).toLocaleString("en-US", { timeZone: "America/Phoenix" })}${appt.jobber?.jobNumber ? ` · Jobber job #${appt.jobber.jobNumber}` : ""}.`);
    } catch (error) {
      console.error("[lc] contact", error.message);
      if (result.sms === "skipped" && appt.smsConsent && c.smsConfirmations) result.sms = "failed";
      if (result.email === "skipped" && appt.email) result.email = "failed";
    }
    result.at = clock();
    return result;
  }

  /** The quote for a conversation: route + package + home details + add-ons + travel fee. */
  const quoteFor = (data, c) =>
    bookingQuote(data.route, c, { package: data.package, property: data.property, addOns: data.addOns, travelFeeCents: data.travelFeeCents });
  const slotOptions = (data, c, q) => ({
    durationMins: q.durationMins,
    leadHours: q.package === "emergency" ? c.emergencyLeadHours : c.leadHours,
    zip: data.contact?.zip || data.zip || "",
    neighborhood: data.location?.neighborhood || "",
    ticketCents: q.totalCents,
    emergencyRequestedAt: q.package === "emergency" ? (data.emergencyRequestedAt ?? clock()) : null,
  });

  const newId = (prefix) => `${prefix}-${randomBytes(4).toString("hex").toUpperCase()}`;
  const UNDO_DEPTH = 30, UNDO_TTL = 60 * 60 * 24;

  // ---- the first question: is this address in the service area? --------------------------
  /** The customer's typed address, looked up. null = not an address (a bare ZIP or a question). */
  async function lookupPlace(text, c) {
    const raw = String(text || "").trim();
    if (!/\d/.test(raw) || !/[a-z]/i.test(raw) || raw.endsWith("?") || raw.length > 200) return null;
    let g;
    try {
      g = await geo.geocode(/\b(?:az|arizona)\b/i.test(raw) ? raw : `${raw}, AZ`);
    } catch (error) {
      if (error.code === "GEO_UNAVAILABLE") return { unavailable: true };
      throw error;
    }
    if (!g) return { notFound: true };
    if (!g.zip || !g.precise) return { incomplete: true };
    const first = (x) => String(x || "").split(",")[0].trim();
    const street = /^\d/.test(first(g.formatted)) && g.provider === "google" ? first(g.formatted) : first(raw);
    let drivingMiles = null;
    if (["driving_distance", "radius"].includes(c.serviceAreaMode)) {
      try {
        const base = validPoint(c.baseLocation) ? c.baseLocation : c.baseAddress ? await geo.geocode(c.baseAddress) : null;
        const [route] = c.serviceAreaMode === "radius" && base ? [{ miles: distanceMiles(base, g) }] : base && geo.roadRoutes ? await geo.roadRoutes([{ from: base, to: g }]) : [];
        if (!route) return { routingUnavailable: true };
        drivingMiles = route.miles;
      } catch { return { routingUnavailable: true }; }
    }
    return { found: true, street, city: g.city || "", zip: g.zip, state: g.state || "", lat: g.lat, lng: g.lng, drivingMiles, formatted: String(g.formatted || "").replace(/,? USA$/, "") };
  }

  // ---- phone verification (LeadConnector text code) ---------------------------------
  async function sendCode(token, data) {
    const phone = data.contact.phone;
    if (!lc.configured) return { required: true, sent: false, available: false };
    const now = clock(), v = data.verification || {};
    const sends = (v.phone === phone ? v.sends || [] : []).filter((t) => now - t < 3_600_000);
    if (sends.length && now - sends.at(-1) < 30_000) return { required: true, sent: false, available: true, to: maskPhone(phone), retryInSeconds: Math.ceil((30_000 - (now - sends.at(-1))) / 1000) };
    if (sends.length >= 4) fail(429, "Too many codes were requested for this number. Please wait an hour, or send the team a request.");
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    try {
      const contactId = await lc.upsertContact({ phone });
      await lc.sendSms(contactId, verificationSms(code));
    } catch (error) {
      console.error("[lc] verification", error.message);
      await store.kvSet("diag:lc", { at: now, message: `Text code not sent: ${String(error.message).slice(0, 300)}` }, 60 * 60 * 24 * 7).catch(() => {});
      return { required: true, sent: false, available: true, error: true, to: maskPhone(phone) };
    }
    data.verification = { phone, hash: digest(`${code}:${token}:${phone}`), expires: now + VERIFY_TTL, attempts: 0, sends: [...sends, now] };
    await store.audit("phone.code_sent", maskPhone(phone));
    return { required: true, sent: true, available: true, to: maskPhone(phone), expiresAt: now + VERIFY_TTL };
  }

  // ---- approvals -------------------------------------------------------------------
  async function notifyApprover(a, c, origin = publicOrigin) {
    const out = { sms: "skipped", email: "skipped" };
    const ap = c.approver || {};
    if (!lc.configured || (!ap.phone && !ap.email)) {
      await store.log("notification.skipped", { approvalId: a.id, reason: "not_configured" }, { sessionId: a.session?.slice(0, 16) || "", level: "warning" }).catch((error) => console.error("[activity] notification log", error.message));
      return { ...out, reason: "not_configured" };
    }
    const link = `${origin || ""}/admin?approval=${encodeURIComponent(a.id)}`;
    const text = approvalRequestText(a, link);
    try {
      const contactId = await lc.upsertContact({ name: ap.name, phone: normalizePhone(ap.phone) || undefined, email: ap.email || undefined, tags: ["bob-approver"] });
      if (ap.phone) out.sms = await lc.sendSms(contactId, text).then(async (response) => {
        out.smsMessageId = response?.messageId || response?.id || null;
        await store.log("notification.accepted", { approvalId: a.id, channel: "sms", recipient: ap.name, messageId: out.smsMessageId, delivery: "not_confirmed" }, { sessionId: a.session?.slice(0, 16) || "" }).catch((error) => console.error("[activity] notification log", error.message));
        return "sent";
      }, async (error) => {
        out.error = error.message;
        await store.log("notification.failed", { approvalId: a.id, channel: "sms", error: error.message }, { sessionId: a.session?.slice(0, 16) || "", level: "error" }).catch((error) => console.error("[activity] notification log", error.message));
        return "failed";
      });
      if (ap.email) {
        out.email = await lc
          .sendEmail(contactId, { subject: `BOB approval needed: ${a.service} (${a.id})`, html: `<p>${text.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch])}</p>`, text })
          .then(() => "sent", (e) => (console.error("[lc] approval email", e.message), "failed"));
      }
    } catch (error) {
      console.error("[lc] approver contact", error.message);
      if (ap.phone) out.sms = "failed";
      if (ap.email) out.email = "failed";
    }
    return out;
  }
  const publicApproval = (a, c) => ({
    id: a.id,
    status: a.status,
    expiresAt: a.expiresAt,
    service: a.service,
    scheduledAt: a.scheduledAt,
    approverName: c.approver?.name || "",
    reason: a.reason,
  });

  /** Checks shared by holds, bookings and approvals. */
  function requireReadyToBook(data, c) {
    if (data.stage !== "slots" || data.safety || !data.serviceAccepted || !data.location) fail(409, "Complete the service and contact details first.");
    if (data.route === "bundle" && !data.bundleAccepted) fail(409, "Accept the combined assessment offer first.");
    if (!phoneOk(data, c)) fail(409, "Confirm your phone number with the text code first.", { code: "PHONE_NOT_VERIFIED" });
    ensureCoverageCurrent(data, c);
    const area = areaFor(data.contact.zip, c, "AZ", data.driveFromBaseMiles, data.location);
    if (!(area === "in" || (area === "travel" && data.travelZone))) fail(409, "Service coverage changed. Please ask the team to review.");
  }

  /**
   * Create the appointment: fresh schedule check, Jobber client/job/visit, then confirmed.
   * Returns { appt, pending } — pending means Jobber's result needs the office (never "confirmed").
   */
  async function commitBooking({ token, data, hold, c, idem, approval = null }) {
    const q = quoteFor(data, c);
    if (!sameQuote(q, hold.quote)) fail(409, "Service details changed. Please review a new quote and time.");
    const errors = validateContact(data.contact);
    if (errors.length) fail(400, errors.join(" "));
    if (!(await bookingOpen(c))) fail(409, "Online confirmation is paused. Please send the team a request.");
    const day = phoenixDate(new Date(hold.start));
    if (!(await store.lock(`slot:${day}`, 60))) fail(409, "Another booking for that day is finishing. Please try again in a moment.");
    let appt, pending = false;
    try {
      const slot = await scheduler.check({ config: c, technicians: await store.technicians(), ...slotOptions(data, c, q), location: data.location, now: clock(), iso: new Date(hold.start).toISOString(), preferTech: hold.tech, excludeSession: token, fresh: true });
      if (!slot) fail(409, "That opening changed. Please select another time.", { code: "SLOT_GONE" });
      const contact = data.contact;
      appt = {
        id: newId("DVS"), customerName: contact.name, email: contact.email, phone: contact.phone,
        address: contact.address, city: contact.city, zip: contact.zip, location: data.location,
        territory: territoryFor(contact.zip, data.location?.neighborhood || ""),
        package: q.name, packageId: q.package, serviceId: q.serviceId, lineItems: q.lineItems, addOns: data.addOns || {},
        price: q.totalCents / 100, servicePriceCents: q.priceCents, travelFeeCents: q.travelFeeCents,
        route: data.route, status: "confirmed", scheduledAt: new Date(slot.start).toISOString(), durationMins: q.durationMins,
        technicianId: slot.technicianId, technicianName: slot.technicianName, notes: contact.notes,
        concerns: [...(data.concerns || []), ...(data.notes || [])], property: data.property, smsConsent: contact.smsConsent,
        assessmentAccepted: data.bundleAccepted, urgency: q.package === "emergency" ? "high" : "normal", source: "ai_bot",
        createdAt: new Date(clock()).toISOString(), revision: 1, scheduleSource: c.scheduleSource, jobber: null,
        phoneVerified: Boolean(data.phoneVerified), overflow: Boolean(slot.overflow), sameDay: Boolean(slot.sameDay), travelZone: Boolean(data.travelZone),
        routeScore: slot.routeScore ?? null,
        approval: approval ? { id: approval.id, by: approval.decision?.by, at: approval.decision?.at } : null,
      };
      if (!(await store.insertAppointment(appt, { session: token, idem, status: jobberMode(c) ? "confirming" : "confirmed" }))) {
        fail(409, "Your booking is already being processed.");
      }
      if (jobberMode(c)) {
        try {
          appt.jobber = await pushToJobber(appt, slot, contact.notes);
        } catch (error) {
          console.error("[bookings] jobber", error.message);
          if (error.jobberJob || error.uncertain) {
            // Jobber may hold part or all of this visit. Keep the record (it protects the time)
            // and hand it to the office; never retry blind and never call it confirmed.
            appt.status = "action_needed";
            appt.jobberState = error.jobberJob ? (error.uncertain ? "visit_uncertain" : "visit_failed") : "uncertain";
            appt.jobberError = String(error.message).slice(0, 300);
            if (error.jobberJob) appt.jobber = { jobId: error.jobberJob.id, jobNumber: error.jobberJob.jobNumber, webUri: error.jobberJob.jobberWebUri, visitId: null };
            await store.updateAppointment(appt);
            await store.audit(`booking.jobber_${appt.jobberState}`, appt.id);
            pending = true;
          } else {
            await store.retireAppointment(appt, "failed");
            await store.audit("booking.jobber_failed", appt.id);
            fail(502, "We couldn't finish scheduling this visit. It is not confirmed — please try again or send the team a request.");
          }
        }
      }
      if (!pending) {
        appt.status = "confirmed";
        await store.updateAppointment(appt);
      }
      await store.releaseHolds(token);
      data.bookingId = appt.id;
      data.stage = pending ? "pending_review" : "confirmed";
      await store.saveSession(token, data);
      await store.audit(pending ? "booking.pending_review" : "booking.created", appt.id);
      if (!pending) await store.enqueue("booking.created", appt, Boolean(webhookUrl));
    } finally {
      await store.unlock(`slot:${day}`);
    }
    if (!pending) {
      appt.notifications = await confirmWithLeadConnector(appt, c);
      await store.updateAppointment(appt);
      await dispatch();
    }
    return { appt, pending };
  }

  return async function handle(req, res) {
    req.bobActivity = { requestId: randomBytes(10).toString("hex"), sessionId: "" };
    const send = async (status, data) => {
      if (req.url !== "/api/health" && (status >= 400 || req.method !== "GET")) {
        await record(req, "request.finished", { path: String(req.url || "").split("?")[0], method: req.method, status, ...(status >= 400 ? { error: data?.error } : {}) }, status >= 500 ? "error" : status >= 400 ? "warning" : "info");
      }
      res.setHeader("X-BOB-Request-ID", req.bobActivity.requestId);
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(data));
    };
    let url;
    try {
      url = new URL(req.url || "/", "http://bob.local");
    } catch {
      return send(400, { error: "Invalid request URL." });
    }
    const pathname = url.pathname, method = req.method || "GET";
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    // Health answers even when the database is broken, and says why (never keys or addresses).
    if (method === "GET" && pathname === "/api/health") {
      try {
        await store.init();
        return send(200, { ok: true, version: "3.0.0", bookingEnabled: await bookingOpen(await store.config()) });
      } catch (e) {
        console.error("BOB health check failed:", e);
        const reason = String(e?.message || e).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[address]").replace(/[A-Za-z0-9_.-]{32,}/g, "[hidden]").slice(0, 240);
        return send(503, { ok: false, error: "BOB can't reach its database.", reason });
      }
    }
    try {
      await store.init();
      if (Math.random() < 0.05) store.cleanup().catch(() => {});
      if (!pathname.startsWith("/api/")) fail(404, "Not found.");
      await rate(req, "api", 240);
      if (!["GET", "POST", "PATCH", "DELETE"].includes(method)) fail(405, "Method not supported.");
      if (method !== "GET") csrf(req);

      if (method === "GET" && pathname === "/api/health") {
        return send(200, { ok: true, version: "3.0.0", bookingEnabled: await bookingOpen(await store.config()) });
      }
      if (method === "GET" && pathname === "/api/public/config") return send(200, await publicConfig());

      if (method === "POST" && pathname === "/api/session") {
        await rate(req, "new-session", 30, 3_600_000);
        const token = secret(), s = initialSession();
        await store.createSession(digest(token), s);
        req.bobActivity.sessionId = digest(token).slice(0, 16);
        await record(req, "conversation.started", { stage: s.stage });
        return send(201, { token, session: s, config: await publicConfig() });
      }
      if (method === "GET" && pathname === "/api/session") {
        const s = await session(req);
        const booked = s.data.bookingId ? await store.appointment(s.data.bookingId) : null;
        const extra = booked ? { receipt: await receipt(booked) } : {};
        return send(200, { session: s.data, config: await publicConfig(), ...extra });
      }

      if (method === "POST" && pathname === "/api/activity") {
        await rate(req, "client-activity", 40);
        await session(req);
        const body = await readBody(req);
        if (!["widget.minimized", "widget.expanded", "client.error"].includes(body.kind)) fail(400, "Unknown activity event.");
        const saved = await record(req, body.kind, { source: "customer_widget", ...(body.kind === "client.error" ? { message: String(body.message || "").slice(0, 500) } : {}) }, body.kind === "client.error" ? "error" : "info");
        if (!saved) fail(503, "Activity could not be saved. Please try again.");
        return send(201, { recorded: true });
      }

      if (method === "POST" && pathname === "/api/chat") {
        await rate(req, "chat", 80);
        const { token, data } = await session(req), body = await readBody(req);
        if (typeof body.message !== "string" || !body.message.trim() || body.message.length > 2000) fail(400, "Enter a message of 1–2,000 characters.");
        if (data.bookingId) fail(409, "This conversation already has a booking. Start a new conversation for another request.");
        if (data.stage === "approval") fail(409, "Your visit is waiting for approval. You'll see the answer here.");
        const c = await store.config();
        const place = data.pending === "serviceAddress" || data.stage === "out_of_area" ? await lookupPlace(body.message, c) : null;
        await record(req, "conversation.message", { role: "user", text: /^\s*\d{4,8}\s*$/.test(body.message) ? "[verification code omitted]" : body.message, stage: data.stage });
        const result = await chatTurn({ message: body.message, session: data, config: c, faqs: await store.get("faqs"), assistant: aiReady(c) ? assistant : null, place });
        const note = await captureAvailabilityRequest({ store, lc, config: c, data: result.session, message: body.message, session: token, now: clock(), origin: publicOrigin, log: (kind, details, level) => record(req, kind, details, level) });
        if (note) {
          result.reply = `${note}\n\n${result.reply}`;
          const last = result.session.history.at(-1);
          if (last?.role === "assistant") last.text = result.reply;
        }
        await store.saveSession(token, result.session);
        await record(req, "conversation.message", { role: "assistant", text: result.reply, stage: result.session.stage, via: result.via, availabilityRequestId: result.session.availabilityRequestId || "" });
        // Keep the state before this answer so the customer can go back and change it.
        const { history: before = [], ...snapshot } = data;
        const undo = [...((await store.kvGet(`undo:${token}`)) || []).slice(-(UNDO_DEPTH - 1)), { ...snapshot, historyLen: before.length }];
        await store.kvSet(`undo:${token}`, undo, UNDO_TTL);
        const s = result.session;
        if (s.route !== data.route || s.package !== data.package || s.stage === "review" || s.safety) await store.releaseHolds(token);
        return send(200, { ...result, canGoBack: true });
      }
      // Back: restore the state before the last chat answer. The server keeps those states, so a
      // customer can change an answer but can't hand BOB a made-up conversation.
      if (method === "POST" && pathname === "/api/chat/back") {
        await rate(req, "chat-back", 60);
        const { token, data } = await session(req);
        if (data.bookingId || ["verify", "slots", "approval", "confirmed"].includes(data.stage) || data.contact?.phone) fail(409, "Your details are already in. Use “Edit details” to change them.");
        if (data.stage === "emergency") fail(409, "For your safety, this conversation can't go back. Please follow the safety steps above.");
        const undo = (await store.kvGet(`undo:${token}`)) || [];
        const prev = undo.pop();
        if (!prev) fail(409, "There's nothing to go back to.");
        const { historyLen = 0, ...restored } = prev;
        restored.history = (data.history || []).slice(0, historyLen);
        await store.saveSession(token, restored);
        await store.kvSet(`undo:${token}`, undo, UNDO_TTL);
        await store.releaseHolds(token);
        return send(200, { session: restored, canGoBack: undo.length > 0 });
      }

      // Address suggestions for the contact step. The Google key stays on the server.
      if (method === "GET" && pathname === "/api/address/suggest") {
        await rate(req, "address-suggest", 150, 600_000);
        await session(req);
        const q = String(url.searchParams.get("q") || "").trim().slice(0, 120);
        const sessionToken = String(url.searchParams.get("s") || "");
        if (!/^[A-Za-z0-9_-]{8,36}$/.test(sessionToken)) fail(400, "Missing address session.");
        if (q.length < 3 || !geo.suggestions) return send(200, { suggestions: [] });
        try {
          return send(200, { suggestions: await geo.suggestAddresses(q, sessionToken) });
        } catch (error) {
          console.warn("[geo] suggestions", error.message);
          return send(200, { suggestions: [], unavailable: true }); // the customer just keeps typing
        }
      }
      if (method === "GET" && pathname === "/api/address/details") {
        await rate(req, "address-details", 40, 600_000);
        await session(req);
        const id = String(url.searchParams.get("id") || "");
        const sessionToken = String(url.searchParams.get("s") || "");
        if (!/^[A-Za-z0-9_-]{8,300}$/.test(id) || !/^[A-Za-z0-9_-]{8,36}$/.test(sessionToken)) fail(400, "Choose an address from the list.");
        let address = null;
        try { address = await geo.addressFor(id, sessionToken); } catch (error) { console.warn("[geo] address details", error.message); }
        if (!address) fail(503, "We couldn't load that address. Please type it instead.");
        return send(200, { address });
      }

      if (method === "POST" && pathname === "/api/contact") {
        await rate(req, "contact", 20, 600_000);
        const { token, data } = await session(req), body = await readBody(req);
        if (!["cleaning", "assessment", "bundle"].includes(data.route) || !data.serviceAccepted || data.safety || ["review", "approval", "confirmed"].includes(data.stage)) fail(409, "Choose and accept the appropriate service first.");
        if (data.route === "bundle" && !data.bundleAccepted) fail(409, "Accept the combined assessment offer first.");
        const errors = validateContact(body);
        if (errors.length) fail(400, errors.join(" "));
        const c = await store.config();
        const initialArea = areaFor(body.zip, c);
        const where = await locate(c, { address: body.address.trim(), city: body.city.trim(), zip: body.zip }, { travelZone: initialArea === "travel" && data.travelAccepted });
        const area = ["driving_distance", "radius"].includes(c.serviceAreaMode) ? where.area : initialArea;
        const travelZone = area === "travel" && data.travelAccepted;
        if (where.reason === "routing_unavailable") fail(503, "We couldn't verify the driving distance. Please try again or ask the office to review your address.", { code: "ROUTING_UNAVAILABLE" });
        if (area !== "in" && !travelZone) fail(409, area === "travel" ? "That address is just outside our service area. Go back and choose to continue with the travel charge, or send the team a request." : "We don't currently service that area. Check the address, or send the team a request.", { code: "OUT_OF_AREA" });
        if (!where.ok && where.reason === "lookup_unavailable") fail(503, "We couldn't check that address just now. Please try again in a minute, or send the team a request.", { code: "ADDRESS_LOOKUP_UNAVAILABLE" });
        if (!where.ok && where.reason === "not_found") fail(400, "We couldn't find that street address. Check the street number, street name, and ZIP code.");
        if (!where.ok) fail(409, "That address is outside our online booking area. The team can review it — send a callback request.", { code: "OUT_OF_AREA" });
        data.contact = {
          name: body.name.trim(), phone: normalizePhone(body.phone), email: (body.email || "").trim(),
          address: body.address.trim(), city: body.city.trim(), zip: body.zip,
          notes: String(body.notes || "").trim(), smsConsent: body.smsConsent === true,
        };
        data.addOns = data.route === "cleaning" ? { fogging: body.addOns?.fogging === true, toolRetrieval: body.addOns?.toolRetrieval === true } : {};
        data.zip = body.zip;
        data.location = where.location;
        data.driveFromBaseMin = where.driveFromBaseMin;
        data.driveFromBaseMiles = where.driveFromBaseMiles ?? null;
        data.coverageFingerprint = coverageFingerprint(c);
        await record(req, "coverage.checked", { area, miles: data.driveFromBaseMiles, minutes: data.driveFromBaseMin, mode: c.serviceAreaMode });
        data.travelFeeCents = travelZone ? Math.max(c.travelZoneFeeCents || 0, where.travelFeeCents || 0) : where.travelFeeCents;
        data.travelZone = travelZone;
        let verification = { required: false };
        if (phoneOk(data, c)) data.stage = "slots";
        else {
          data.stage = "verify";
          const live = data.verification?.phone === data.contact.phone && data.verification.expires > clock() + 60_000;
          verification = live ? { required: true, sent: true, available: true, to: maskPhone(data.contact.phone), expiresAt: data.verification.expires, reused: true } : await sendCode(token, data);
        }
        await store.releaseHolds(token);
        await store.saveSession(token, data);
        return send(200, { session: data, quote: quoteFor(data, c), verification, address: where.location.formatted });
      }

      if (method === "POST" && pathname === "/api/verify/send") {
        await rate(req, "verify-send", 10, 3_600_000);
        const { token, data } = await session(req);
        const c = await store.config();
        if (!textCodeOn(c)) fail(409, "Phone verification isn't required.");
        if (!data.contact?.phone || !["verify", "slots"].includes(data.stage)) fail(409, "Enter your contact details first.");
        const verification = await sendCode(token, data);
        await store.saveSession(token, data);
        return send(200, { verification });
      }
      if (method === "POST" && pathname === "/api/verify/check") {
        await rate(req, "verify-check", 30, 3_600_000);
        const { token, data } = await session(req), body = await readBody(req);
        const v = data.verification;
        if (!v?.hash || v.phone !== data.contact?.phone) fail(409, "Send a new code first.");
        if (clock() > v.expires) fail(410, "That code expired. Send a new one.");
        if (v.attempts >= 5) fail(429, "Too many tries. Send a new code.");
        const code = String(body.code || "").replace(/\D/g, "");
        v.attempts++;
        if (!(code.length === 6 && safeEqual(digest(`${code}:${token}:${v.phone}`), v.hash))) {
          await store.saveSession(token, data);
          const left = 5 - v.attempts;
          fail(400, left > 0 ? `That code doesn't match. ${left} ${left === 1 ? "try" : "tries"} left.` : "That code doesn't match. Send a new code.");
        }
        data.phoneVerified = { phone: v.phone, at: clock() };
        delete data.verification;
        data.stage = "slots";
        await store.saveSession(token, data);
        await store.audit("phone.verified", maskPhone(v.phone));
        return send(200, { verified: true, session: data });
      }

      if (method === "GET" && pathname === "/api/availability") {
        await rate(req, "availability", 40);
        const { token, data } = await session(req);
        const c = await store.config();
        if (data.stage !== "slots" || !data.serviceAccepted || data.safety || !data.location) fail(409, "Complete the service and contact details first.");
        if (!phoneOk(data, c)) fail(409, "Confirm your phone number with the text code first.", { code: "PHONE_NOT_VERIFIED" });
        ensureCoverageCurrent(data, c);
        if (!(await bookingOpen(c))) return send(200, { slots: [], nextCursor: null, enabled: false });
        const date = url.searchParams.get("date") || "";
        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(400, "Choose a valid date.");
        const q = quoteFor(data, c);
        let all;
        try {
          all = await scheduler.slots({ config: c, technicians: await store.technicians(), ...slotOptions(data, c, q), location: data.location, now: clock(), date, excludeSession: token });
        } catch (error) {
          if (error.code === "JOBBER_NOT_CONNECTED") return send(200, { slots: [], nextCursor: null, enabled: false });
          console.error("[availability]", error.message);
          fail(502, "We couldn't reach the live schedule. Please try again, or send the team a request.");
        }
        const start = Math.max(0, Number(url.searchParams.get("cursor")) || 0);
        return send(200, {
          slots: all.slice(start, start + 3).map((s, i) => ({
            scheduledAt: s.scheduledAt,
            nearby: s.nearby,
            bestFit: !date && start === 0 && i === 0 && (s.routeScore ?? 0) >= 10,
            overflow: Boolean(s.overflow),
            sameDay: Boolean(s.sameDay),
            approval: needsApproval(q, s, c),
          })),
          nextCursor: start + 3 < all.length ? start + 3 : null,
          enabled: true,
          quote: q,
        });
      }

      if (method === "POST" && pathname === "/api/holds") {
        await rate(req, "holds", 20);
        const { token, data } = await session(req), body = await readBody(req);
        const c = await store.config();
        requireReadyToBook(data, c);
        const start = Date.parse(String(body.scheduledAt || ""));
        if (!Number.isFinite(start)) fail(400, "Choose an available time.");
        const day = phoenixDate(new Date(start));
        if (!(await store.lock(`slot:${day}`, 30))) fail(409, "Someone is booking that day right now. Please try again in a moment.");
        try {
          const quote = quoteFor(data, c);
          const slot = await scheduler.check({ config: c, technicians: await store.technicians(), ...slotOptions(data, c, quote), location: data.location, now: clock(), iso: body.scheduledAt, excludeSession: token, fresh: true });
          if (!slot) fail(409, "That time is no longer available. Please choose a fresh opening.");
          const hold = { id: newId("HOLD"), session: token, tech: slot.technicianId, start: slot.start, end: slot.end, expires: clock() + 300_000, quote, lat: data.location.lat, lng: data.location.lng, address: `${data.contact.address}, ${data.contact.city}, AZ ${data.contact.zip}`, overflow: Boolean(slot.overflow) };
          await store.releaseHolds(token);
          await store.insertHold(hold);
          return send(201, { hold: { id: hold.id, expiresAt: hold.expires, scheduledAt: slot.scheduledAt, quote, approvalRequired: needsApproval(quote, slot, c), overflow: Boolean(slot.overflow) } });
        } finally {
          await store.unlock(`slot:${day}`);
        }
      }
      if (method === "DELETE" && pathname === "/api/holds") {
        const { token, data } = await session(req);
        if (data.stage === "approval") fail(409, "This time is held while the team reviews your request.");
        await store.releaseHolds(token);
        return send(200, { released: true });
      }

      if (method === "POST" && pathname === "/api/bookings") {
        await rate(req, "bookings", 10, 600_000);
        const { token, data } = await session(req), body = await readBody(req);
        if (body.approved !== true) fail(400, "Approve the final service, price, address, and arrival window first.");
        if (typeof body.idempotencyKey !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(body.idempotencyKey)) fail(400, "A valid booking request identifier is required.");
        const existing = await store.appointmentByIdem(body.idempotencyKey);
        if (existing) {
          if (existing.session !== token) fail(409, "Request identifier is already in use.");
          if (existing.status === "confirming") fail(409, "Your booking is still being confirmed. Please wait a moment.");
          return send(existing.status === "action_needed" ? 202 : 201, { receipt: await receipt(existing.data), pending: existing.status === "action_needed" });
        }
        if (data.bookingId) {
          const previous = await store.appointment(data.bookingId);
          if (previous) return send(previous.status === "action_needed" ? 202 : 201, { receipt: await receipt(previous), pending: previous.status === "action_needed" });
        }
        const c = await store.config();
        requireReadyToBook(data, c);
        const hold = await store.getHold(String(body.holdId || ""), token);
        if (!hold) fail(409, "Your hold expired. Choose a time again before confirming.");
        if (needsApproval(hold.quote, hold, c)) fail(409, "This visit needs approval from our team first.", { code: "APPROVAL_REQUIRED" });
        const { appt, pending } = await commitBooking({ token, data, hold, c, idem: body.idempotencyKey });
        return send(pending ? 202 : 201, { receipt: await receipt(appt), pending });
      }

      if (method === "POST" && pathname === "/api/approvals") {
        await rate(req, "approvals", 10, 600_000);
        const { token, data } = await session(req), body = await readBody(req);
        if (body.approved !== true) fail(400, "Approve the final service, price, address, and arrival window first.");
        if (data.approvalId) {
          const current = await store.approval(data.approvalId);
          if (current?.status === "pending" && clock() <= current.expiresAt) return send(200, { approval: publicApproval(current, await store.config()) });
        }
        const c = await store.config();
        requireReadyToBook(data, c);
        if (!(await bookingOpen(c))) fail(409, "Online confirmation is paused. Please send the team a request.");
        const hold = await store.getHold(String(body.holdId || ""), token);
        if (!hold) fail(409, "Your hold expired. Choose a time again.");
        const q = quoteFor(data, c);
        if (!sameQuote(q, hold.quote)) fail(409, "Service details changed. Please review a new quote and time.");
        if (!needsApproval(q, hold, c)) fail(409, "This visit doesn't need approval. Confirm it directly.");
        const slot = await scheduler.check({ config: c, technicians: await store.technicians(), ...slotOptions(data, c, q), location: data.location, now: clock(), iso: new Date(hold.start).toISOString(), preferTech: hold.tech, excludeSession: token, fresh: true });
        if (!slot) fail(409, "That time is no longer available. Please choose a fresh opening.");
        const expiresAt = Math.min(clock() + APPROVAL_WINDOW, hold.start - 30 * 60_000);
        if (expiresAt < clock() + 5 * 60_000) fail(409, "That time is too soon for an approval. Please choose a later opening.");
        const a = {
          id: newId("APR"), session: token, status: "pending", holdId: hold.id,
          reason: hold.overflow ? "5 PM overflow visit (needs technician approval)" : `${q.name} needs approval before booking`,
          kind: hold.overflow ? "overflow" : "service",
          service: q.name, packageId: q.package, totalCents: q.totalCents, lineItems: q.lineItems,
          scheduledAt: new Date(hold.start).toISOString(), durationMins: q.durationMins, technicianName: slot.technicianName,
          customer: { name: data.contact.name, phone: data.contact.phone, email: data.contact.email, address: data.contact.address, city: data.contact.city, zip: data.contact.zip },
          concerns: [...(data.concerns || []), ...(data.notes || [])], property: data.property || {}, notes: data.contact.notes || "",
          requestedAt: clock(), expiresAt, decision: null, notified: null,
        };
        await store.extendHold(hold.id, expiresAt);
        await store.insertApproval(a);
        data.approvalId = a.id;
        data.stage = "approval";
        await store.saveSession(token, data);
        a.notified = await notifyApprover(a, c, publicOrigin || (req.headers.host ? `${String(req.headers["x-forwarded-proto"] || "https").split(",")[0]}://${req.headers.host}` : ""));
        await store.updateApproval(a);
        await store.audit("approval.requested", a.id);
        return send(201, { approval: publicApproval(a, c) });
      }
      if (method === "GET" && pathname === "/api/approvals/current") {
        const { data } = await session(req);
        if (!data.approvalId) fail(404, "There's no approval request in this conversation.");
        const [a] = await sweepApprovals([await store.approval(data.approvalId)].filter(Boolean));
        if (!a) fail(404, "There's no approval request in this conversation.");
        const booked = data.bookingId ? await store.appointment(data.bookingId) : null;
        return send(200, { approval: publicApproval(a, await store.config()), ...(booked ? { receipt: await receipt(booked), pending: booked.status === "action_needed" } : {}) });
      }

      if (method === "POST" && pathname === "/api/requests") {
        await rate(req, "requests", 10, 600_000);
        const { token, data } = await session(req), body = await readBody(req);
        const errors = validateContact(body, { address: false });
        if (errors.length) fail(400, errors.join(" "));
        if (typeof body.message !== "string" || body.message.trim().length < 3 || body.message.length > 4000) fail(400, "Include a short description of the request.");
        if (typeof body.idempotencyKey !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(body.idempotencyKey)) fail(400, "A valid request identifier is required.");
        const existing = await store.requestByIdem(body.idempotencyKey);
        if (existing) {
          if (existing.session !== token) fail(409, "Request identifier is in use.");
          return send(200, { request: existing.data });
        }
        const request = {
          id: newId("REQ"), name: body.name.trim(), phone: normalizePhone(body.phone), email: body.email || "",
          zip: body.zip || data.zip || "", message: body.message.trim(), preference: body.preference === "email" ? "email" : "phone",
          smsConsent: body.smsConsent === true, status: "new", createdAt: new Date(clock()).toISOString(),
          route: data.route, safety: data.safety, concerns: [...(data.concerns || []), ...(data.notes || [])], transcript: data.history,
        };
        await store.insertRequest(request, token, body.idempotencyKey);
        await store.enqueue("request.created", request, Boolean(webhookUrl));
        await store.audit("request.created", request.id);
        if (lc.configured) {
          try {
            const contactId = await lc.upsertContact({ name: request.name, phone: request.phone, email: request.email, zip: request.zip, smsConsent: request.smsConsent, tags: lc.cfg.requestTags });
            await lc.addNote(contactId, `BOB request ${request.id} (prefers ${request.preference}):\n${request.message}${request.safety ? `\nSafety flag: ${request.safety}` : ""}`);
          } catch (error) {
            console.error("[lc] request", error.message);
          }
        }
        await dispatch();
        return send(201, { request: { id: request.id, status: "submitted" } });
      }

      // ---- Jobber OAuth callback (public, state-checked) -----------------------------
      if (method === "GET" && pathname === "/api/jobber/oauth/start") {
        res.writeHead(302, { Location: "/admin?tab=settings", "Cache-Control": "no-store" });
        return res.end();
      }
      if (method === "GET" && (pathname === "/api/jobber/callback" || pathname === "/api/jobber/oauth/callback")) {
        const state = url.searchParams.get("state") || "", code = url.searchParams.get("code") || "";
        const ok = state && code && (await store.kvGet(`jobber:state:${state}`));
        if (state) await store.kvDel(`jobber:state:${state}`);
        let result = "failed";
        if (ok) {
          try {
            await jobber.exchangeCode(code);
            await store.audit("jobber.connected", "jobber");
            result = "connected";
          } catch (error) {
            console.error("[jobber callback]", error.message);
          }
        }
        res.writeHead(302, { Location: `/admin?jobber=${result}`, "Cache-Control": "no-store" });
        return res.end();
      }

      // ---- management --------------------------------------------------------------
      if (method === "GET" && pathname === "/api/admin/status") {
        let authenticated = false;
        try {
          await admin(req);
          authenticated = true;
        } catch {}
        return send(200, { authenticated, setupRequired: !envPassword && !(await store.get("auth")), passwordFromEnv: Boolean(envPassword) && !(await store.get("auth")) });
      }
      if (method === "POST" && pathname === "/api/admin/setup") {
        await rate(req, "setup", 5, 900_000);
        const body = await readBody(req);
        if ((await store.get("auth")) || envPassword) fail(409, "Management access has already been set up.");
        if (!setupToken) fail(403, "Add a BOB_SETUP_TOKEN environment variable in Vercel, redeploy, then enter it here.");
        if (digest(body.setupToken) !== digest(setupToken)) fail(403, "That setup code doesn't match BOB_SETUP_TOKEN.");
        if (typeof body.password !== "string" || body.password.length < 14 || body.password.length > 200) fail(400, "Use a password of at least 14 characters.");
        const salt = secret(), hash = scryptSync(body.password, salt, 64).toString("hex");
        await store.set("auth", { salt, hash });
        await store.audit("admin.setup", "admin");
        return send(201, { configured: true });
      }
      if (method === "POST" && pathname === "/api/admin/login") {
        await rate(req, "login", 8, 900_000);
        const body = await readBody(req), auth = await store.get("auth");
        if (!auth && !envPassword) fail(409, "Complete management setup first.");
        if (typeof body.password !== "string" || body.password.length > 200) fail(401, "Invalid password.");
        if (auth) {
          const test = scryptSync(body.password, auth.salt, 64), saved = Buffer.from(auth.hash, "hex");
          if (saved.length !== test.length || !timingSafeEqual(saved, test)) fail(401, "Invalid password.");
        } else if (!safeEqual(digest(body.password), digest(envPassword))) fail(401, "Invalid password.");
        const token = secret();
        await store.addAdmin(digest(token), clock() + 8 * 3_600_000);
        const secure = publicOrigin.startsWith("https:") || env.VERCEL ? "; Secure" : "";
        res.setHeader("Set-Cookie", `bob_admin=${token}; HttpOnly; SameSite=Lax; Path=/api/admin; Max-Age=28800${secure}`);
        return send(200, { authenticated: true });
      }

      if (pathname.startsWith("/api/admin/")) {
        const adminToken = await admin(req);
        if (method === "POST" && pathname === "/api/admin/logout") {
          await store.removeAdmin(adminToken);
          res.setHeader("Set-Cookie", "bob_admin=; HttpOnly; SameSite=Lax; Path=/api/admin; Max-Age=0");
          return send(200, { signedOut: true });
        }
        if (method === "GET" && pathname === "/api/admin/data") return send(200, await snapshot());
        if (method === "GET" && pathname === "/api/admin/activity") return send(200, await store.activity({ sessionId: (url.searchParams.get("session") || "").slice(0, 32), level: url.searchParams.get("level") || "", cursor: url.searchParams.get("cursor") || "", limit: 100 }));
        if (method === "POST" && pathname === "/api/admin/service-area/map") {
          await rate(req, "area-map", 5);
          const b = await readBody(req), c = { ...await store.config(), ...Object.fromEntries(["baseAddress", "baseLocation", "serviceAreaMode", "serviceAreaMiles", "travelAreaMiles", "customServiceAreas"].filter((key) => key in b).map((key) => [key, b[key]])) };
          if (typeof c.baseAddress !== "string" || (!c.baseAddress.trim() && !validPoint(c.baseLocation)) || c.baseAddress.length > 300 || !Number.isFinite(c.serviceAreaMiles) || c.serviceAreaMiles <= 0 || !Number.isFinite(c.travelAreaMiles) || c.travelAreaMiles < c.serviceAreaMiles || c.travelAreaMiles > 150) fail(400, "Enter a base address and valid driving-mile limits (up to 150 miles).");
          const base = validPoint(c.baseLocation) ? { ...c.baseLocation, formatted: "Selected base location" } : await geo.geocode(c.baseAddress);
          if (!base) fail(400, "The base address could not be found.");
          if (!geo.serviceAreaSamples && c.serviceAreaMode !== "radius") fail(503, "Driving-distance mapping is unavailable.");
          let points;
          try { points = c.serviceAreaMode === "radius" ? [] : await geo.serviceAreaSamples(base, c.travelAreaMiles); }
          catch (error) {
            // Say what Google actually said (and how to fix it), not just that it failed.
            const reason = error.cause?.message || error.message;
            console.error("[service-area] road-distance lookup failed:", reason);
            fail(503, `Google road-distance lookup failed. ${reason}`);
          }
          return send(200, { base, points: points.map((point) => ({ ...point, area: drivingAreaFor(point.miles, c, "", point) })), generatedAt: clock(), limits: { standard: c.serviceAreaMiles, travel: c.travelAreaMiles } });
        }

        if (method === "GET" && pathname === "/api/admin/jobber/connect") {
          if (!jobber.appConfigured) fail(400, "Add JOBBER_CLIENT_ID, JOBBER_CLIENT_SECRET and JOBBER_REDIRECT_URI in Vercel first.");
          const state = secret();
          await store.kvSet(`jobber:state:${state}`, { at: clock() }, 600);
          res.writeHead(302, { Location: jobber.authorizeUrl(state), "Cache-Control": "no-store" });
          return res.end();
        }
        if (method === "POST" && pathname === "/api/admin/jobber/disconnect") {
          await jobber.disconnect();
          await store.audit("jobber.disconnected", "jobber");
          return send(200, await snapshot());
        }
        if (method === "GET" && pathname === "/api/admin/jobber/users") {
          try {
            return send(200, { users: await jobber.listUsers() });
          } catch (error) {
            fail(error.code === "JOBBER_NOT_CONNECTED" ? 409 : 502, error.code === "JOBBER_NOT_CONNECTED" ? "Connect Jobber first." : "Couldn't load Jobber users.");
          }
        }
        if (method === "POST" && pathname === "/api/admin/geo/check") {
          const b = await readBody(req), c = { ...await store.config(), ...Object.fromEntries(["serviceAreaMode", "baseAddress", "baseLocation", "customServiceAreas", "serviceAreaMiles", "travelAreaMiles", "travelZoneFeeCents"].filter((key) => b.config && key in b.config).map((key) => [key, b.config[key]])) };
          const parts = String(b.address || "").split(",").map((s) => s.trim());
          const zip = (String(b.address || "").match(/\b(\d{5})\b/) || [])[1] || "";
          const where = await locate(c, { address: parts[0] || "", city: parts[1] || "", zip });
          return send(200, { ...where, zipApproved: c.serviceZips.includes(zip), area: where.area || areaFor(zip, c), territory: where.territory || territoryFor(zip) });
        }

        if (method === "PATCH" && pathname === "/api/admin/config") {
          const body = await readBody(req), old = await store.config();
          if (body.version !== old.version) fail(409, "Settings were changed elsewhere. Refresh before saving.");
          const next = { ...old };
          for (const key of Object.keys(DEFAULT_CONFIG)) if (key in body && key !== "version") next[key] = body[key];
          next.version = old.version + 1;
          next.bundlePriceCents = BUNDLE_PRICE_CENTS;
          const errors = validateConfig(next), known = (await store.technicians()).map((t) => t.id);
          if (next.activeTechnicianIds.some((id) => !known.includes(id))) errors.push("Select a known technician.");
          if (errors.length) fail(400, errors.join(" "));
          await store.set("config", next);
          await store.audit("settings.updated", next.version);
          return send(200, await snapshot());
        }
        if (method === "POST" && pathname === "/api/admin/password") {
          const b = await readBody(req), auth = await store.get("auth");
          if (!auth && envPassword) {
            if (typeof b.currentPassword !== "string" || !safeEqual(digest(b.currentPassword), digest(envPassword))) fail(403, "Current password is incorrect.");
          } else if (typeof b.currentPassword !== "string" || b.currentPassword.length > 200 || digest(scryptSync(b.currentPassword, auth.salt, 64).toString("hex")) !== digest(auth.hash)) fail(403, "Current password is incorrect.");
          if (typeof b.newPassword !== "string" || b.newPassword.length < 14 || b.newPassword.length > 200) fail(400, "Use a new password of at least 14 characters.");
          const salt = secret();
          await store.set("auth", { salt, hash: scryptSync(b.newPassword, salt, 64).toString("hex") });
          await store.clearAdmins();
          return send(200, { changed: true });
        }
        if (method === "POST" && pathname === "/api/admin/faqs") {
          const b = await readBody(req);
          const bad = (f) =>
            !f || typeof f.id !== "string" || !f.id || f.id.length > 100 ||
            typeof f.question !== "string" || !f.question.trim() || f.question.length > 300 ||
            typeof f.answer !== "string" || !f.answer.trim() || f.answer.length > 3000 ||
            !Array.isArray(f.keywords) || f.keywords.length > 40 || f.keywords.some((k) => typeof k !== "string" || k.length > 80) ||
            (f.status != null && !FAQ_STATUSES.includes(f.status));
          if (!Array.isArray(b.faqs) || b.faqs.length > 200 || b.faqs.some(bad)) fail(400, "Each FAQ needs a question, an answer, keywords, and a status.");
          if (new Set(b.faqs.map((f) => f.id)).size !== b.faqs.length) fail(400, "FAQ identifiers must be unique.");
          const clean = b.faqs.map((f) => ({
            id: f.id, question: f.question.trim(), answer: f.answer.trim(), keywords: f.keywords.map((k) => k.trim()).filter(Boolean),
            category: String(f.category || "General").slice(0, 60), subcategory: String(f.subcategory || "General").slice(0, 60),
            status: f.status || "approved", ...(f.reviewNote ? { reviewNote: String(f.reviewNote).slice(0, 300) } : {}),
            ...(f.isCustom ? { isCustom: true } : {}), updatedAt: new Date(clock()).toISOString(),
          }));
          await store.set("faqs", clean);
          await store.audit("faqs.updated", "faqs");
          return send(200, await snapshot());
        }
        if (method === "POST" && pathname === "/api/admin/faqs/reset") {
          await store.set("faqs", INITIAL_FAQS);
          return send(200, await snapshot());
        }
        if (method === "POST" && pathname === "/api/admin/technicians") {
          const b = await readBody(req);
          if (!Array.isArray(b.technicians) || !b.technicians.length || b.technicians.length > 30 || b.technicians.some((t) => !/^[-a-zA-Z0-9]{1,80}$/.test(t.id) || typeof t.name !== "string" || !t.name.trim() || t.name.length > 100 || !["available", "on_route", "on_job", "off_duty"].includes(t.status) || (t.jobberUserId != null && (typeof t.jobberUserId !== "string" || t.jobberUserId.length > 200)))) fail(400, "Check technician names and status.");
          if (new Set(b.technicians.map((t) => t.id)).size !== b.technicians.length) fail(400, "Technician identifiers must be unique.");
          const linked = b.technicians.map((t) => t.jobberUserId).filter(Boolean);
          if (new Set(linked).size !== linked.length) fail(400, "Each Jobber user can be linked to only one technician.");
          await store.set("technicians", b.technicians.map((t) => ({
            id: t.id, name: t.name.trim(), phone: String(t.phone || "").slice(0, 30), status: t.status, color: /^#[0-9a-f]{6}$/i.test(t.color || "") ? t.color : "#f97316",
            zone: String(t.zone || "").slice(0, 200), jobberUserId: String(t.jobberUserId || ""), vehicle: String(t.vehicle || "").slice(0, 60), bio: String(t.bio || "").slice(0, 400),
          })));
          await store.audit("technicians.updated", "technicians");
          return send(200, await snapshot());
        }
        if (method === "PATCH" && /^\/api\/admin\/requests\//.test(pathname)) {
          const id = decodeURIComponent(pathname.split("/").pop()), b = await readBody(req);
          const r = (await store.requests()).find((x) => x.id === id);
          if (!r) fail(404, "Request not found.");
          if (!["new", "in_progress", "resolved"].includes(b.status)) fail(400, "Choose a valid request status.");
          r.status = b.status;
          await store.updateRequest(r);
          await store.audit("request.updated", id);
          return send(200, await snapshot());
        }

        if (method === "POST" && /^\/api\/admin\/approvals\/[^/]+$/.test(pathname)) {
          const id = decodeURIComponent(pathname.split("/").pop()), b = await readBody(req), c = await store.config();
          const a = await store.approval(id);
          if (!a) fail(404, "Approval request not found.");
          await sweepApprovals([a]);
          if (a.status !== "pending") fail(409, `This request is already ${a.status}.`);
          if (!["approve", "decline"].includes(b.decision)) fail(400, "Choose approve or decline.");
          const by = String(b.approverName || "").trim();
          if (by.length < 2 || by.length > 100) fail(400, "Enter the name of the person approving.");
          a.decision = {
            decision: b.decision, by, at: clock(), note: String(b.note || "").slice(0, 500),
            namedApprover: c.approver?.name ? by.toLowerCase() === c.approver.name.trim().toLowerCase() : null,
          };
          if (b.decision === "decline") {
            a.status = "declined";
            await store.updateApproval(a);
            await store.releaseHold(a.holdId);
            const s = await store.loadSession(a.session);
            if (s) await store.saveSession(a.session, { ...s, stage: "review" });
            await store.audit("approval.declined", a.id);
            return send(200, await snapshot());
          }
          const data = await store.loadSession(a.session);
          const hold = await store.holdById(a.holdId);
          if (!data || !hold || hold.expires < clock()) {
            a.status = "failed";
            a.failure = !data ? "The customer's conversation expired." : "The held time expired.";
          } else {
            try {
              const { appt, pending } = await commitBooking({ token: a.session, data, hold, c, idem: `approval-${a.id}`, approval: a });
              a.status = pending ? "action_needed" : "booked";
              a.appointmentId = appt.id;
            } catch (error) {
              if (!(error instanceof HttpError)) throw error;
              a.status = "failed";
              a.failure = error.message;
              await store.releaseHold(a.holdId);
              const s = await store.loadSession(a.session);
              if (s && !s.bookingId) await store.saveSession(a.session, { ...s, stage: "review" });
            }
          }
          await store.updateApproval(a);
          await store.audit(`approval.${a.status}`, a.id);
          return send(200, { ...(await snapshot()), result: { status: a.status, failure: a.failure || null, appointmentId: a.appointmentId || null } });
        }

        if (method === "POST" && pathname === "/api/admin/appointments") {
          const b = await readBody(req), c = await store.config();
          const errors = validateContact(b);
          if (errors.length) fail(400, errors.join(" "));
          if (!["driving_distance", "radius"].includes(c.serviceAreaMode) && areaFor(b.zip, c) === "out") fail(400, "Add the ZIP code to the service area (or the just-outside list) in settings first.");
          if (!["cleaning", "assessment", "bundle"].includes(b.route)) fail(400, "Choose a supported service.");
          const where = await locate(c, { address: b.address, city: b.city, zip: b.zip });
          if (!where.ok) fail(400, where.reason === "not_found" ? "Couldn't find that address." : "That address is outside the booking area rules.");
          const forced = { ...c, bookingEnabled: true, scheduleAcknowledged: true, pricesAcknowledged: true };
          const day = phoenixDate(new Date(b.scheduledAt));
          if (!(await store.lock(`slot:${day}`, 60))) fail(409, "Another booking for that day is finishing. Try again in a moment.");
          try {
            const office = {
              route: b.route, package: typeof b.package === "string" ? b.package : "premium",
              property: { stories: b.stories === "2-story" ? "2-story" : "1-story", laundryFloor: b.upstairs ? "2nd floor" : "1st floor", hasDryer: b.noDryer ? "No" : "Yes", power: b.gas ? "Gas" : "Electric" },
              addOns: b.route === "cleaning" ? { fogging: b.fogging === true, toolRetrieval: b.toolRetrieval === true } : {}, travelFeeCents: where.travelFeeCents,
            };
            const q = quoteFor(office, c);
            const techs = await store.technicians();
            const prefer = typeof b.technicianId === "string" && techs.some((t) => t.id === b.technicianId) ? b.technicianId : undefined;
            const slot = await scheduler.check({ config: forced, technicians: techs, durationMins: q.durationMins, leadHours: 0, location: where.location, zip: b.zip, neighborhood: where.location.neighborhood, ticketCents: q.totalCents, now: clock(), iso: b.scheduledAt, preferTech: prefer, fresh: true });
            if (!slot) fail(409, "That appointment does not fit the schedule, drive-time, capacity, or hours rules.");
            const a = {
              id: newId("DVS"), customerName: b.name, email: b.email || "", phone: normalizePhone(b.phone), address: b.address, city: b.city, zip: b.zip,
              location: where.location, territory: where.territory, package: q.name, packageId: q.package, serviceId: q.serviceId, lineItems: q.lineItems, addOns: office.addOns,
              property: office.property, price: q.totalCents / 100, servicePriceCents: q.priceCents, travelFeeCents: q.travelFeeCents,
              route: b.route, status: "confirmed", scheduledAt: slot.scheduledAt, durationMins: q.durationMins, technicianId: slot.technicianId,
              technicianName: slot.technicianName, notes: String(b.notes || "").slice(0, 4000), urgency: ["normal", "elevated", "high"].includes(b.urgency) ? b.urgency : "normal", source: "phone_dispatch",
              createdAt: new Date(clock()).toISOString(), revision: 1, scheduleSource: c.scheduleSource, jobber: null, smsConsent: b.smsConsent === true,
            };
            if (jobberMode(c)) a.jobber = await pushToJobber(a, slot, b.notes);
            await store.insertAppointment(a);
            await store.audit("admin.booking.created", a.id);
            await store.enqueue("booking.created", a, Boolean(webhookUrl));
            if (b.sendConfirmation === true) {
              a.notifications = await confirmWithLeadConnector(a, c);
              await store.updateAppointment(a);
            }
            await dispatch();
            return send(201, { appointment: a, ...(await snapshot()) });
          } finally {
            await store.unlock(`slot:${day}`);
          }
        }
        if (method === "POST" && /^\/api\/admin\/appointments\/[^/]+\/(resolve|confirmation)$/.test(pathname)) {
          const [, , , , rawId, action] = pathname.split("/");
          const id = decodeURIComponent(rawId), b = await readBody(req), c = await store.config();
          const a = await store.appointment(id);
          if (!a) fail(404, "Appointment not found.");
          if (action === "confirmation") {
            if (a.status !== "confirmed") fail(409, "Only confirmed appointments get a confirmation.");
            if (!lc.configured) fail(409, "Connect LeadConnector first.");
            a.notifications = await confirmWithLeadConnector(a, c);
            await store.updateAppointment(a);
            await store.audit("appointment.confirmation_sent", id);
            return send(200, await snapshot());
          }
          if (a.status !== "action_needed" || !a.jobberState) fail(409, "Only bookings waiting on a Jobber check can be resolved here.");
          if (b.outcome === "in_jobber") {
            const number = String(b.jobNumber || a.jobber?.jobNumber || "").trim();
            if (!/^\d{1,10}$/.test(number)) fail(400, "Enter the Jobber job number you found.");
            a.jobber = { ...(a.jobber || {}), jobNumber: Number(number), visitId: a.jobber?.visitId || "confirmed-by-office" };
            a.jobberState = "resolved";
            a.status = "confirmed";
            a.revision++;
            await store.updateAppointment(a);
            a.notifications = await confirmWithLeadConnector(a, c);
            await store.updateAppointment(a);
            await store.audit("appointment.resolved_in_jobber", id);
          } else if (b.outcome === "not_in_jobber") {
            a.jobberState = "not_created";
            await store.retireAppointment(a, "failed");
            await store.audit("appointment.resolved_not_created", id);
          } else fail(400, "Choose whether the visit is in Jobber.");
          return send(200, await snapshot());
        }
        if (method === "PATCH" && /^\/api\/admin\/appointments\/[^/]+$/.test(pathname)) {
          const id = decodeURIComponent(pathname.split("/").pop()), b = await readBody(req);
          const a = await store.appointment(id);
          if (!a) fail(404, "Appointment not found.");
          if (b.revision !== a.revision) fail(409, "This appointment changed elsewhere. Refresh before editing.");
          if (b.status && !["confirmed", "in_progress", "completed", "cancelled", "action_needed"].includes(b.status)) fail(400, "Invalid appointment status.");
          const c = await store.config();
          const linked = Boolean(a.jobber?.jobId || a.jobber?.jobNumber);
          const rescheduling = b.scheduledAt && Date.parse(b.scheduledAt) !== Date.parse(a.scheduledAt);
          const reactivating = a.status === "cancelled" && b.status && b.status !== "cancelled";
          const cancelling = b.status === "cancelled" && a.status !== "cancelled";
          const reassigning = b.technicianId && b.technicianId !== a.technicianId;
          if (linked && (rescheduling || reactivating || cancelling || reassigning)) {
            fail(409, "This visit lives in Jobber. Reschedule, reassign, or cancel it in Jobber; BOB's calendar follows Jobber.");
          }
          if (rescheduling || reactivating || reassigning) {
            const preserved = { ...c, bookingEnabled: true, scheduleAcknowledged: true, pricesAcknowledged: true, ...(reassigning ? { activeTechnicianIds: [b.technicianId] } : {}) };
            const location = a.location || (await locate(c, a)).location;
            const slot = location && (await scheduler.check({ config: preserved, technicians: await store.technicians(), durationMins: a.durationMins, leadHours: 0, location, zip: a.zip, now: clock(), iso: b.scheduledAt || a.scheduledAt, ignoreAppointmentId: id, fresh: true }));
            if (!slot) fail(409, "That change does not fit the current schedule. The original booking was not changed.");
            a.scheduledAt = slot.scheduledAt;
            a.technicianId = slot.technicianId;
            a.technicianName = slot.technicianName;
          }
          if (typeof b.notes === "string") {
            if (b.notes.length > 4000) fail(400, "Notes are too long.");
            a.notes = b.notes;
          }
          if (b.urgency && ["normal", "elevated", "high"].includes(b.urgency)) a.urgency = b.urgency;
          if (b.status) a.status = b.status;
          if (b.airflowReadings) {
            const r = b.airflowReadings;
            for (const k of ["beforeCfm", "afterCfm"]) if (r[k] != null && (!Number.isFinite(r[k]) || r[k] < 0 || r[k] > 2000)) fail(400, "Enter measured airflow values between 0 and 2,000.");
            a.airflowReadings = { beforeCfm: r.beforeCfm ?? null, afterCfm: r.afterCfm ?? null };
          }
          a.revision++;
          await store.updateAppointment(a);
          await store.audit("appointment.updated", id);
          return send(200, await snapshot());
        }
        if (method === "GET" && pathname === "/api/admin/export") {
          res.writeHead(200, { "Content-Type": "application/json", "Content-Disposition": 'attachment; filename="BOB-data-export.json"', "Cache-Control": "no-store" });
          return res.end(JSON.stringify({ ...(await snapshot()), exportedAt: new Date(clock()).toISOString() }, null, 2));
        }
        fail(404, "Management action not found.");
      }
      fail(404, "Endpoint not found.");
    } catch (e) {
      if (res.headersSent) return res.end();
      if (!(e instanceof HttpError)) {
        console.error("BOB request failed:", e);
        // Kept for a week so the office can see what went wrong (Settings → Connections).
        await store.kvSet("diag:last-error", { at: clock(), path: `${method} ${pathname}`, message: String(e?.message || e).slice(0, 300) }, 60 * 60 * 24 * 7).catch(() => {});
      }
      send(e.status || 500, {
        error: e.status ? e.message : "The operation could not be completed. Your appointment is not confirmed unless a booking reference was returned.",
        ...(e.extra || {}),
      });
    }
  };
}

/** Postgres jsonb reorders object keys, so compare quotes structurally. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
}
const sameQuote = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/);
  return { firstName: parts[0] || "", lastName: parts.slice(1).join(" ") };
}
