import { createOwnerConsent } from './owner-consent.mjs';
import { notifyOwnerError } from './owner-error-notification.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createAdminAuth } from './admin-auth.mjs';
import { requireAdminRoute, applyConfigPatch, projectSnapshot, projectAdminResponse, projectPrincipal } from './admin-authorization.mjs';
import { hasPermission } from '../shared/admin-permissions.mjs';
import { validateHtmlTemplate, renderHtmlTemplate } from './email-html.mjs';
import { MESSAGE_VARIABLES } from '../shared/message-templates.mjs';
import { deliverConfirmationSmsOnce } from './sms-notification.mjs';
import { createClientHub } from './client-hub.mjs';
import { sanitizeDiagnostic } from "./integration-status.mjs";
// BOB HTTP API — Postgres-backed, serverless-friendly. Jobber is the master schedule,
// Explicitly selected providers carry verification and messages; the selected AI reads
// free-typed chat. Static files are served by the host (Vercel).
//
// Booking sequence (rulebook, Oct 20 architecture):
//   chat → service accepted → contact → selected verification (SMS or email)
//   → live Jobber-aware times → 5-minute hold → final approval
//   → [approval by a named approver only for emergency same-day visits]
//   → Jobber client + job + visit → only then "confirmed" → selected confirmation provider.

import { deliverEmailOnce } from "./email-notification.mjs";
import { notifyBookingOwner } from "./owner-notification.mjs";
import { BOOKING_REPORT_TO, COMMISSION_CENTS, bookingTotals, bookingReportEmail } from "./booking-report.mjs";
import { createVerification } from "./verification.mjs";
import { waitForRequestLock } from "./request-lock.mjs";
import { approvalPolicy } from "./approval-policy.mjs";
import { isIP } from "node:net";
import { distanceMiles, validPoint } from "../shared/coverage.mjs";
import { randomBytes, createHash, scryptSync, timingSafeEqual, createHmac } from "node:crypto";
import {
  DEFAULT_CONFIG, INITIAL_FAQS, bookingQuote, travelFeeFor, validateContact,
  validateConfig, normalizePhone, isBookable, BUNDLE_PRICE_CENTS, phoenixDate, areaFor, drivingAreaFor, money,
} from "../shared/domain.mjs";
import { initialSession, WELCOME, detectSafety, turn } from "../shared/conversation.mjs";
import { territoryFor, WEST_VALLEY_ZIPS } from "../shared/territory.mjs";
import { PACKAGES, upsellSettings } from "../shared/catalog.mjs";
import { validWorkWeek, validTimeOff, cleanWorkWeek, cleanTimeOff } from "../shared/tech-schedule.mjs";
import { withTiming, step, timingSummary, serverTimingHeader } from "./timing.mjs";

// Booking-flow endpoints report where their time went (header, log line, BOB activity).
const TIMED_PATHS = new Set(["/api/availability", "/api/holds", "/api/holds/extras", "/api/bookings", "/api/approvals", "/api/contact", "/api/verify/check"]);
import { chatTurn } from "./chat.mjs";
import { confirmationEmail, confirmationSms, approvalRequestText, afterHoursRequestSms, afterHoursRequestEmail } from "./messages.mjs";

/** Whether an optional add-on that doubles as a checkout upsell is switched on in Settings. */
const upsellOn = (c, key) => key === "dryerflex" ? upsellSettings(c).dryerflexEnabled : key === "fogging" ? upsellSettings(c).foggingEnabled : true;

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
const APPROVAL_WINDOW = 30 * 60_000;
const FAQ_STATUSES = ["approved", "draft"];

export function createBobHandler({ store, jobber, geo, scheduler, assistant = null, twilio = null, sendgrid = null, integrationAccounts = null, connectionHealth = null, env = process.env, clock = () => Date.now() }) {
  const rawStore = store;
  const adminAuth = createAdminAuth({ store: rawStore, clock });
  const adminScope = new AsyncLocalStorage();
  const currentAdmin = async () => {
    const req = adminScope.getStore();
    if (!req?.adminPrincipal) return;
    if (req.adminPrincipal.role === 'legacy') {
      if (await adminAuth.mode() !== 'legacy') fail(401, 'Please sign in with your individual account.');
    } else {
      req.adminPrincipal = await adminAuth.revalidate(req.adminPrincipal);
    }
    requireAdminRoute(req.adminPrincipal, req.adminPermissionMethod || req.method, req.adminPermissionPath);
  };
  // Recheck authority after awaits, immediately before durable changes or provider work.
  // Cleanup and audit recording remain available even after a session is revoked.
  const guardedWrites = new Set(['set', 'insertAppointment', 'updateAppointment', 'retireAppointment', 'insertRequest', 'updateRequest', 'insertApproval', 'updateApproval', 'enqueue']);
  const consentDb = { ...rawStore.db, query: async (...args) => { await currentAdmin(); return rawStore.db.query(...args); } };
  store = new Proxy(rawStore, { get(target, key) {
    if (key === 'db') return consentDb;
    if (key === 'audit') return async (action, targetId) => {
      await target.audit(action, targetId);
      const req = adminScope.getStore();
      if (req?.adminPrincipal?.role !== 'legacy' && req?.adminPrincipal?.id) {
        await target.log('admin.action', { actorUserId: req.adminPrincipal.id, action, target: String(targetId) }, { requestId: req.bobActivity?.requestId || '' });
      }
    };
    if (key === 'kvSet' || key === 'kvDel') return async (entry, ...args) => {
      if (/^(?:client-hub:|jobber:state:)/.test(String(entry))) await currentAdmin();
      return target[key](entry, ...args);
    };
    if (guardedWrites.has(key)) return async (...args) => { await currentAdmin(); return target[key](...args); };
    return Reflect.get(target, key);
  } });
  const guardProvider = (provider, names) => provider && new Proxy(provider, { get(target, key) {
    if (names.includes(key) && typeof target[key] === 'function') return async (...args) => { await currentAdmin(); return target[key](...args); };
    return Reflect.get(target, key);
  } });
  jobber = guardProvider(jobber, ['ensureClientAndProperty', 'createScheduledJob', 'exchangeCode', 'disconnect', 'verifyScheduledVisit', 'verifyAssignment', 'listUsers']);
  geo = guardProvider(geo, ['geocode', 'geocodeMany', 'serviceAreaSamples', 'driveMinutes']);
  twilio = guardProvider(twilio, ['sendSms', 'sendVerification', 'checkVerification']);
  sendgrid = guardProvider(sendgrid, ['sendEmail']);
  const ownerConsent = createOwnerConsent({store,clock});
  const clientHub = createClientHub({store,jobber,clock});
  const useTwilioVerify = env.BOOKING_VERIFICATION_PROVIDER === 'twilio';
  const verifyService = createVerification({ store, twilio, clock, fail });
  const verificationOn = (c) => useTwilioVerify || c.requirePhoneVerification !== false;
  const useTwilioSms = env.BOOKING_SMS_PROVIDER === 'twilio';
  // Test mode (SMS_VIRTUAL_PHONE): every text goes to Twilio's Virtual Phone, not a carrier, so the
  // campaign-scope limits below don't apply. Consent and every other check still do.
  const virtualPhone = env.SMS_VIRTUAL_PHONE === 'true';
  const ownerAlertsOnly = env.SMS_OWNER_ALERTS_ONLY === 'true' && !virtualPhone;
  // After-hours emergency texts to the account admin stay off until the Twilio campaign and the SMS
  // terms page cover them; the admin's consent must also be on the current (v3) terms.
  const emergencyTextsOn = env.SMS_EMERGENCY_REQUESTS === 'true' || virtualPhone;
  const useSendGrid = env.BOOKING_EMAIL_PROVIDER === 'sendgrid';
  const enabled = (c, name) => c.integrations?.[name] !== false;
  const emailReady = (c) => enabled(c, 'email') && useSendGrid && Boolean(sendgrid?.configured);
  const smsReady = (c) => enabled(c, 'sms') && useTwilioSms && Boolean(twilio?.messagingConfigured);
  const sendSms = async (_contactId, phone, text, beforeSend, purpose = 'other') => {
    if (ownerAlertsOnly && purpose !== 'owner') throw new Error('sms_scope_owner_alerts_only');
    if (!smsReady(await store.config())) throw new Error('Appointment texting is disabled or an approved Twilio sender is not configured.');
    await beforeSend?.();
    return twilio.sendSms(phone, text, { beforeSend });
  };
  const deliverEmail = async (kind, id, to, message) => {
    const c = await store.config();
    return deliverEmailOnce({ store, kind, id, to, message, clock,
      enabled: enabled(c, 'email'), configured: useSendGrid && Boolean(sendgrid?.configured),
      sendEmail: async ({ to: recipient, ...content }) => {
        const latest=await store.config();
        if (!emailReady(latest) || kind === 'appointment_confirmed' && latest.emailConfirmations !== true) throw new Error('Appointment email is disabled or not configured.');
        return sendgrid.sendEmail(recipient, content);
      },
    });
  };
  const applyEmailResult = (result, delivery) => {
    const state = delivery.status === 'already_attempted' ? delivery.prior || { status: 'failed_or_uncertain' } : delivery;
    result.email = state.status;
    result.emailDelivery = 'not_confirmed';
    if (state.messageId) result.emailMessageId = state.messageId;
    if (state.reason) result.emailReason = state.reason;
    if (delivery.status === 'already_attempted') result.emailAlreadyAttempted = true;
  };
  const notifyOwner = async (appointment, config) => {
    try {
      if(!await ownerConsent.allows(config.bookingOwnerSmsPhone))return {status:'skipped',reason:'owner_consent_required'};
      return await notifyBookingOwner({ store, appointment, config, clock, provider: 'Twilio', sendSms: async (phone, text) => {
        const beforeSend = async () => {
          const latest=await store.config();
          if(latest.bookingOwnerSmsEnabled!==true||!smsReady(latest)||normalizePhone(latest.bookingOwnerSmsPhone)!==normalizePhone(phone)||!await ownerConsent.allows(phone))throw new Error('Owner SMS consent is revoked or does not match this recipient.');
        };
        await beforeSend();
        return sendSms(null, phone, text, beforeSend, 'owner');
      } });
    } catch { return { status: 'failed', reason: 'notification_unavailable' }; }
  };
  // Custom-AIs booking report: every confirmed ChatDaddy booking, with running counts, revenue and
  // commission. BOOKING_REPORT_EMAIL changes the recipient ("off" stops it); it doesn't depend on the
  // office's customer-email switches, only on a configured SendGrid sender. Sent at most once per booking.
  const bookingReportTo = () => {
    const value = String(env.BOOKING_REPORT_EMAIL ?? BOOKING_REPORT_TO).trim();
    return /^(?:off|none|false|)$/i.test(value) ? "" : value;
  };
  const commissionCents = Number.isInteger(Number(env.BOOKING_COMMISSION_CENTS)) && Number(env.BOOKING_COMMISSION_CENTS) >= 0 && env.BOOKING_COMMISSION_CENTS !== undefined && env.BOOKING_COMMISSION_CENTS !== "" ? Number(env.BOOKING_COMMISSION_CENTS) : COMMISSION_CENTS;
  const sendBookingReport = async (appointment, config) => {
    try {
      const to = bookingReportTo();
      if (!to || appointment.source !== "ai_bot" || appointment.status !== "confirmed") return { status: "skipped" };
      const totals = bookingTotals(await store.appointments(), appointment, { commissionCents });
      return await deliverEmailOnce({ store, kind: "booking_report", id: appointment.id, to, clock,
        enabled: true, configured: useSendGrid && Boolean(sendgrid?.configured),
        message: bookingReportEmail(appointment, totals, config),
        sendEmail: async ({ to: recipient, ...content }) => sendgrid.sendEmail(recipient, content),
      });
    } catch { return { status: "failed_or_uncertain", reason: "report_unavailable" }; }
  };
  const notifyOwnerProblem = async (kind, appointment) => {
    try {
      return await notifyOwnerError({ store, kind, details: { appointmentId: appointment.id, at: clock() },
        ownerConsent, smsReady, sendSms: (phone, text, options) => sendSms(null, phone, text, options?.beforeSend, 'owner'), provider: 'Twilio', env, clock });
    } catch { return { status: 'skipped', reason: 'notification_unavailable' }; }
  };
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
    req.adminAuthMode = await adminAuth.mode();
    if (req.adminAuthMode === 'named') {
      const raw = cookie(req, 'bob_user');
      req.adminPrincipal = await adminAuth.authenticate(raw);
      return digest(raw);
    }
    const token = digest(cookie(req, "bob_admin"));
    if (!(await store.isAdmin(token))) fail(401, "Please sign in to the management dashboard.");
    req.adminPrincipal = { id: 'legacy', name: 'Shared administrator', role: 'legacy', permissions: [] };
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
  const verificationReady = (c) => !verificationOn(c) || (enabled(c, 'verification') && useTwilioVerify && Boolean(twilio?.verifyConfigured));
  const bookingOpen = async (c) => isBookable(c) && enabled(c, 'maps') && (!jobberMode(c) || enabled(c, 'jobber')) && (c.serviceAreaMode !== "driving_distance" || geo.provider === "google") && verificationReady(c) && (!jobberMode(c) || (await jobber.connected()));
  const selectedAssistant = (c) => assistant?.forProvider ? assistant.forProvider(c.aiProvider || 'gemini') : (c.aiProvider || 'gemini') === 'gemini' ? assistant : null;
  const aiReady = (c) => Boolean(selectedAssistant(c)?.configured) && c.aiAssistant !== false;
  const phoneOk = (data, c) => !verificationOn(c) || (enabled(c, 'verification') && useTwilioVerify && verifyService.verified(data));
  const needsApproval = (q, slot, c) => approvalPolicy(q, slot, c, clock()).required;
  const requireAllowedSlot = (q, slot, c) => { if (approvalPolicy(q, slot, c, clock()).blocked) fail(409, 'This exception needs office scheduling. Please choose a regular opening or contact the office.', { code: 'OFFICE_SCHEDULING_REQUIRED' }); };
  const coverageFingerprint = (c) => digest(JSON.stringify([c.serviceAreaMode, c.baseAddress, c.baseLocation, c.serviceAreaMiles, c.travelAreaMiles, c.customServiceAreas, c.serviceZips, c.travelZips, c.travelZoneFeeCents, c.maxDriveFromBaseMin, c.travelFeeTiers]));
  const ensureCoverageCurrent = (data, c) => {
    if ((data.coverageFingerprint && data.coverageFingerprint !== coverageFingerprint(c)) || (!data.coverageFingerprint && ["driving_distance", "radius"].includes(c.serviceAreaMode))) {
      fail(409, "Our service area changed. Please review your address details so we can check the updated map.", { code: "COVERAGE_CHANGED" });
    }
  };

  const record = async (req, kind, details, level = "info") => {
    try { await store.log(kind, { ...details, ...(req.adminPrincipal?.role !== 'legacy' && req.adminPrincipal?.id ? { actorUserId: req.adminPrincipal.id } : {}) }, { ...req.bobActivity, level }); return true; }
    catch (error) { console.error("[activity] persistent write failed", error.message); return false; }
  };

  const publicConfig = async () => {
    const c = await store.config();
    return {
      businessName: c.businessName,
      phone: c.phone,
      email: c.email,
      bookingEnabled: await bookingOpen(c),
      addressSuggestions: enabled(c, 'maps') && Boolean(geo.suggestions),
      timeZone: "America/Phoenix",
      cleaningPriceCents: c.cleaningPriceCents,
      assessmentPriceCents: c.assessmentPriceCents,
      bundlePriceCents: BUNDLE_PRICE_CENTS,
      preparation: c.preparation,
      faqs: ((await store.get("faqs")) || []).filter((f) => f.status !== "draft").map(({ id, question, answer, category, subcategory }) => ({ id, question, answer, category, subcategory })),
      welcome: WELCOME,
      notificationsConfigured: smsReady(c) || emailReady(c) || Boolean(webhookUrl),
      pricesApproved: Boolean(c.pricesAcknowledged),
      smartChat: aiReady(c),
      phoneVerification: verificationOn(c),
      verificationChannels: useTwilioVerify ? ['sms', 'email'] : [],
      textMessages: !ownerAlertsOnly && smsReady(c) && c.smsConfirmations !== false, // off: no SMS consent question and no texts to customers
      approverName: c.approver?.name || "",
      // Optional extras the customer can tick on the details form.
      // DryerFlex and the fog follow Settings → Upsells at checkout: a hidden offer isn't listed anywhere.
      addOns: [["dryerflex", "dryerflex"], ["fogging", "fogging"], ["toolRetrieval", "tool"]].flatMap(([key, variant]) => {
        if (!upsellOn(c, key)) return [];
        const item = (c.services || []).find((x) => x.family === "addon" && x.variant === variant && x.active !== false);
        return item ? [{ key, name: item.name, description: item.description, cents: item.priceCents }] : [];
      }),
    };
  };

  const historicalIssue = issue => issue ? { at: issue.at, message: sanitizeDiagnostic(issue.message), ...(issue.path ? { path: sanitizeDiagnostic(issue.path) } : {}) } : null;
  const integrations = async () => {
    const c = await store.config(), ai = selectedAssistant(c);
    return {
      accounts: await integrationAccounts?.snapshot() || {},
      observed: await connectionHealth?.snapshot() || {},
      clientHub: await clientHub.snapshot(),
      jobber: { enabled: enabled(c, 'jobber'), appConfigured: jobber.appConfigured, connected: enabled(c, 'jobber') && await jobber.connected() },
      verification: { enabled: enabled(c, 'verification'), provider: useTwilioVerify ? 'twilio' : 'none', configured: useTwilioVerify && Boolean(twilio?.verifyConfigured), channels: useTwilioVerify ? ['sms', 'email'] : [] },
      sms: { enabled: enabled(c, 'sms'), provider: useTwilioSms ? 'twilio' : 'none', configured: useTwilioSms && Boolean(twilio?.messagingConfigured), virtualPhone: useTwilioSms && virtualPhone },
      email: { enabled: enabled(c, 'email'), provider: useSendGrid ? 'sendgrid' : 'none', configured: useSendGrid && Boolean(sendgrid?.configured), deliveryVerified: false },
      maps: { enabled: enabled(c, 'maps'), provider: geo.provider, health: await geo.health?.() || null, issue: historicalIssue(await geo.lastIssue?.()) },
      lastError: historicalIssue(await store.kvGet('diag:last-error').catch(() => null)),
      assistant: { enabled: c.aiAssistant !== false, provider: c.aiProvider || 'gemini', configured: Boolean(ai?.configured), model: ai?.model || '', providers: assistant?.providers || { gemini: { configured: Boolean(assistant?.configured), model: assistant?.model || '' }, openai: { configured: false, model: '' } } },
      database: store.db.kind,
    };
  };

  // ---- outbound webhook (unchanged behaviour) -----------------------------------
  const dispatch = async () => {
    if (!webhookUrl) return;
    const event = await store.nextEvent();
    if (!event) return;
    try {
      const url = new URL(webhookUrl);
      if (url.protocol !== "https:") throw new Error("Webhook requires HTTPS.");
      const payload = JSON.stringify({ id: event.id, type: event.kind, data: event.data });
      await currentAdmin();
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

  const dashboardSnapshot = async ({ maintain = true } = {}) => ({
    config: await store.config(),
    bookingEnabled: await bookingOpen(await store.config()),
    faqs: await store.get("faqs"),
    technicians: await store.technicians(),
    appointments: await store.appointments(),
    requests: await store.requests(),
    approvals: maintain ? await sweepApprovals(await store.approvals()) : await store.approvals(),
    heldLocksCount: await store.countActiveHolds(),
    conversations: await store.countSessions(),
    notifications: await store.recentEvents(),
    notificationsConfigured: smsReady(await store.config()) || emailReady(await store.config()) || Boolean(webhookUrl),
    integrations: await integrations(),
    westValleyZips: WEST_VALLEY_ZIPS,
    now: clock(),
  });

  const notificationText = (appt) => {
    if (appt.status !== "confirmed" && appt.status !== "in_progress" && appt.status !== "completed") {
      return "This visit is not confirmed yet. Our team is finishing it in the schedule and will contact you — please don't book it again.";
    }
    const n = appt.notifications || {};
    const accepted=[];
    if(n.sms==='accepted')accepted.push('text');
    if(n.email==='accepted')accepted.push('email');
    if(accepted.length)return `Your confirmation ${accepted.join(' and ')} ${accepted.length>1?'were':'was'} accepted for delivery; arrival is not yet confirmed. Save your reference number.`;
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
  async function locate(c, { address, city, zip }, { travelZone = false, fresh = false } = {}) {
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
          [route] = await geo.roadRoutes([{ from: base, to: g }], { fresh });
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
      // A configured base constraint must never silently disappear on a routing outage.
      try {
        const base = await geo.geocode(c.baseAddress);
        if (base) [driveFromBaseMin] = await geo.driveMinutes([{ from: base, to: g }], { fresh });
      } catch (error) {
        console.error("[geo] base address", error.message);
      }
    }
    if (c.baseAddress && !Number.isFinite(driveFromBaseMin)) return { ok: false, reason: "routing_unavailable" };
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

  /** Answers the customer didn't know, as one line the technician can't miss. */
  const UNSURE_LABELS = { hasDryer: "whether a dryer is installed", recentService: "recent dryer purchase or service", stories: "number of stories", laundryFloor: "laundry floor", power: "gas or electric", mount: "dryer setup (standard, pedestal or stacked)", exit: "where the vent exits", animals: "signs of animals", dryerWorking: "how the dryer is working" };
  const unsureNote = (property) => {
    const unsure = Object.keys(UNSURE_LABELS).filter((k) => property?.[k] === "Not sure").map((k) => UNSURE_LABELS[k]);
    return unsure.length ? `Tech to double-check on site (customer wasn't sure): ${unsure.join("; ")}.` : "";
  };

  /** Jobber: client + property + job + scheduled visit. Returns appointment.jobber details. */
  async function pushToJobber(appt, slot, notes, c = null) {
    if (!slot.jobberUserId || !jobber.verifyAssignment) throw new Error("The selected technician needs a verified Jobber user mapping before booking.");
    const hubAccountBefore = await clientHub.capture();
    await step("jobber.team", () => jobber.verifyAssignment(slot.jobberUserId));
    const { firstName, lastName } = splitName(appt.customerName);
    const { clientId, propertyId } = await step("jobber.client", () => jobber.ensureClientAndProperty(
      { firstName, lastName, email: appt.email, phone: appt.phone, smsConsent: appt.smsConsent },
      { street1: appt.address, city: appt.city, zip: appt.zip },
    ));
    const lineItems = (appt.lineItems?.length ? appt.lineItems : [{ name: appt.package, cents: appt.servicePriceCents }]).map((l) => ({
      name: l.name, cents: l.cents, description: l.description || "",
    }));
    const instructions = [
      `Booked by BOB (${appt.source === "ai_bot" ? "website chat" : "office"}) · ref ${appt.id}`,
      appt.property && Object.keys(appt.property).length ? `Home: ${Object.entries(appt.property).map(([k, v]) => `${k} ${Array.isArray(v) ? v.join("+") : v}`).join(", ")}` : "",
      unsureNote(appt.property),
      appt.concerns?.length ? `Customer concerns: ${appt.concerns.join(" | ")}` : "",
      notes ? `Access notes: ${notes}` : "",
      slot.nearestJobMin != null ? `Nearest job that day ~${slot.nearestJobMin} min away.` : "",
      appt.approval ? `Approved by ${appt.approval.by} (${appt.approval.id}).` : "",
      appt.overflow ? "5 PM overflow visit." : "",
      appt.afterHours ? "AFTER-HOURS EMERGENCY VISIT (on-call technician). The after-hours premium is on the invoice." : "",
      appt.travelZone ? `Just outside the service area (ZIP ${appt.zip}); the customer accepted a travel charge${appt.travelFeeCents ? ` of $${(appt.travelFeeCents / 100).toFixed(2)}` : " (amount not set in BOB; confirm with the customer)"}.` : "",
      `Phone ${appt.phoneVerified ? "verified by text code" : "not verified"}. Service texts: ${appt.smsConsent ? "consented" : "no consent"}.`,
    ].filter(Boolean).join("\n");
    // Settings → Technicians → "Also put on every BOB visit": extra people, so the visit shows on their schedule too.
    const alsoAssign = (c || (await store.config())).alsoAssignJobberUserIds || [];
    const { job, visit } = await step("jobber.visit", () => jobber.createScheduledJob({
      propertyId,
      title: appt.package,
      instructions,
      lineItems,
      start: Date.parse(appt.scheduledAt),
      end: Date.parse(appt.scheduledAt) + appt.durationMins * 60_000,
      jobberUserId: slot.jobberUserId,
      alsoAssign,
    }));
    if (!visit?.id) throw Object.assign(new Error("The scheduled Jobber visit could not be verified."), { jobberJob: job, uncertain: true });
    const hubAccountAfter = hubAccountBefore ? await clientHub.capture() : null;
    const hubBinding = hubAccountAfter && hubAccountAfter.id === hubAccountBefore.id && hubAccountAfter.epoch === hubAccountBefore.epoch ? { accountId: hubAccountAfter.id, clientHubEpoch: hubAccountAfter.epoch } : {};
    return { clientId, propertyId, jobId: job.id, jobNumber: job.jobNumber, webUri: job.jobberWebUri, visitId: visit.id, ...hubBinding };
  }

  /** Confirmation transports never change booking success and report actual delivery state. */
  async function sendConfirmations(appt, c) {
    const result = { sms: 'skipped', email: 'skipped', at: clock() };
    try { c=await store.config(); } catch { return {...result, ...(appt.notifications || {}), reason:'configuration_unavailable'}; }
    try {
      const current=await store.config();
      if (ownerAlertsOnly) {
        result.smsReason = 'sms_scope_owner_alerts_only';
        await store.log('notification.skipped', { appointmentId: appt.id, channel: 'sms', reason: result.smsReason }).catch(() => {});
      } else {
      const smsEligible=!ownerAlertsOnly && appt.status==='confirmed' && current.smsConfirmations===true && smsReady(current) && appt.smsConsent===true && Boolean(appt.phone) && !['sent','accepted','failed','failed_or_uncertain','rejected','attempting'].includes(appt.notifications?.sms);
      const delivery=await deliverConfirmationSmsOnce({store,appointment:appt,enabled:current.smsConfirmations===true,configured:smsReady(current),message:smsEligible ? confirmationSms(appt,current) : '',clock,sendSms:async(phone,text)=>{
        if((await store.config()).smsConfirmations!==true)throw new Error('Customer confirmation texts are disabled.');
        return sendSms(null,phone,text);
      }});
      const state=delivery.status==='already_attempted'?delivery.prior||{status:'failed_or_uncertain'}:delivery;
      result.sms=state.status;result.smsDelivery='not_confirmed';
      if(state.messageId)result.smsMessageId=state.messageId;
      if(state.reason)result.smsReason=state.reason;
      if(delivery.status==='already_attempted')result.smsAlreadyAttempted=true;
      }
    }catch{result.sms='failed_or_uncertain';result.smsDelivery='not_confirmed';}
    const priorEmail=appt.notifications?.email;
    if(appt.status==='confirmed' && ['sent','accepted','failed','failed_or_uncertain','rejected','attempting'].includes(priorEmail)) {
      result.email=priorEmail==='sent'?'accepted':priorEmail;result.emailDelivery='not_confirmed';result.emailAlreadyAttempted=true;
      if(appt.notifications.emailMessageId)result.emailMessageId=appt.notifications.emailMessageId;
    } else if (appt.email && c.emailConfirmations && appt.status === 'confirmed') {
      try { applyEmailResult(result, await deliverEmail('appointment_confirmed', appt.id, appt.email, confirmationEmail(appt, c, {clientHubUrl: emailReady(await store.config()) ? await clientHub.resolve(appt) : ''}))); }
      catch { result.email = 'failed_or_uncertain'; result.emailDelivery = 'not_confirmed'; }
    } else if (result.email === 'skipped') {
      // Say why, so the office can see it on the appointment.
      result.emailReason = !appt.email ? 'no_email' : !c.emailConfirmations ? 'email_confirmations_off' : appt.status !== 'confirmed' ? 'not_confirmed' : 'skipped';
    }
    return result;
  }

  /** The quote for a conversation: route + package + home details + add-ons + travel fee. */
  const quoteFor = (data, c) =>
    bookingQuote(data.route, c, { package: data.package, property: data.property, addOns: data.addOns, travelFeeCents: data.travelFeeCents });
  /** The same quote with the on-call premium; null when after-hours service is off in the price list. */
  const afterHoursQuote = (data, c) => {
    const fee = (c.services || []).find((x) => x.family === "addon" && x.variant === "afterhours" && x.active !== false);
    if (!fee || !["cleaning", "bundle"].includes(data.route) || !data.package) return null;
    const q = bookingQuote(data.route, c, { package: data.package, property: data.property, addOns: { ...(data.addOns || {}), afterHours: true }, travelFeeCents: data.travelFeeCents });
    return q.lineItems.some((l) => l.id === fee.id) ? q : null;
  };
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
        const [route] = c.serviceAreaMode === "radius" && base ? [{ miles: distanceMiles(base, g) }] : base && geo.roadRoutes ? await geo.roadRoutes([{ from: base, to: g }], { fresh: false }) : [];
        if (!route) return { routingUnavailable: true };
        drivingMiles = route.miles;
      } catch { return { routingUnavailable: true }; }
    }
    return { found: true, street, city: g.city || "", zip: g.zip, state: g.state || "", lat: g.lat, lng: g.lng, drivingMiles, formatted: String(g.formatted || "").replace(/,? USA$/, "") };
  }

  // ---- approvals -------------------------------------------------------------------
  async function notifyApprover(a, c, origin = publicOrigin) {
    const out = { sms: "skipped", email: "skipped" };
    const ap = c.approver || {};
    if (ownerAlertsOnly && ap.phone) {
      out.smsReason = 'sms_scope_owner_alerts_only';
      await store.log('notification.skipped', { approvalId: a.id, channel: 'sms', reason: out.smsReason }).catch(() => {});
    }
    if ((ownerAlertsOnly || !smsReady(c) || !ap.phone) && (!emailReady(c) || !ap.email)) {
      await store.log("notification.skipped", { approvalId: a.id, reason: "not_configured" }, { sessionId: a.session?.slice(0, 16) || "", level: "warning" }).catch((error) => console.error("[activity] notification log", error.message));
      return { ...out, reason: "not_configured" };
    }
    const link = `${origin || ""}/admin?approval=${encodeURIComponent(a.id)}`;
    const text = approvalRequestText(a, link);
    if (!ownerAlertsOnly && ap.phone && smsReady(c)) {
      out.sms = await sendSms(null, normalizePhone(ap.phone), text).then(async (response) => {
        out.smsMessageId = response?.messageId || response?.id || null;
        await store.log("notification.accepted", { approvalId: a.id, channel: "sms", provider: "Twilio", recipient: ap.name, messageId: out.smsMessageId, delivery: "not_confirmed" }, { sessionId: a.session?.slice(0, 16) || "" }).catch((error) => console.error("[activity] notification log", error.message));
        return "sent";
      }, async (error) => {
        out.error = error.message;
        await store.log("notification.failed", { approvalId: a.id, channel: "sms", provider: "Twilio", error: error.message }, { sessionId: a.session?.slice(0, 16) || "", level: "error" }).catch((error) => console.error("[activity] notification log", error.message));
        return "failed";
      });
    }
    if (ap.email && a.status === 'pending') {
      const esc = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
      try { applyEmailResult(out, await deliverEmail('approval_pending', a.id, ap.email, { subject: `ChatDaddy approval needed: ${a.service} (${a.id})`, text, html: `<p>${esc(text)}</p>` })); }
      catch { out.email = 'failed_or_uncertain'; out.emailDelivery = 'not_confirmed'; }
    }
    return out;
  }

  /**
   * An after-hours request goes to the client's account admin: a text to the owner alert number
   * (only with consent on the current terms and SMS_EMERGENCY_REQUESTS on) and an email to the
   * approver, or the office if no approver email is set.
   */
  // One-tap answers from the after-hours email: a link signed for that one request, valid while it's pending.
  const linkSecret = async () => {
    let v = await store.kvGet("approval-link-secret");
    if (typeof v?.key !== "string") {
      await store.kvSet("approval-link-secret", { key: randomBytes(32).toString("hex") });
      v = await store.kvGet("approval-link-secret");
    }
    return v.key;
  };
  const approvalSig = async (a) => createHmac("sha256", await linkSecret()).update(`${a.id}.${a.expiresAt}`).digest("base64url").slice(0, 32);
  const approvalSigOk = async (a, sig) => {
    const want = Buffer.from(await approvalSig(a)), got = Buffer.from(String(sig || ""));
    return got.length === want.length && timingSafeEqual(got, want);
  };
  const respondLink = async (a, origin, choice = "") => `${origin || ""}/respond?a=${encodeURIComponent(a.id)}&s=${await approvalSig(a)}${choice ? `&c=${choice}` : ""}`;

  async function notifyAfterHours(a, c, origin = publicOrigin) {
    const out = { sms: "skipped", email: "skipped" };
    const link = `${origin || ""}/admin?approval=${encodeURIComponent(a.id)}`;
    const answer = await respondLink(a, origin);
    const phone = c.bookingOwnerSmsPhone;
    if (!emergencyTextsOn) out.smsReason = "emergency_texts_off";
    else if (c.bookingOwnerSmsEnabled !== true || !phone) out.smsReason = "owner_alerts_off";
    else if (!smsReady(c)) out.smsReason = "sms_not_configured";
    else if (!(await ownerConsent.allows(phone, "after_hours_emergency_requests"))) out.smsReason = "owner_consent_required";
    else {
      const beforeSend = async () => {
        const latest = await store.config();
        if (latest.bookingOwnerSmsEnabled !== true || !smsReady(latest) || normalizePhone(latest.bookingOwnerSmsPhone) !== normalizePhone(phone) || !(await ownerConsent.allows(phone, "after_hours_emergency_requests"))) throw new Error("Owner SMS consent is revoked or does not match this recipient.");
      };
      out.sms = await sendSms(null, normalizePhone(phone), afterHoursRequestSms(a, answer), beforeSend, "owner").then(async (response) => {
        out.smsMessageId = response?.messageId || response?.id || null;
        await store.log("notification.accepted", { approvalId: a.id, channel: "sms", provider: "Twilio", recipient: "account admin", messageId: out.smsMessageId, delivery: "not_confirmed" }, { sessionId: a.session?.slice(0, 16) || "" }).catch(() => {});
        return "sent";
      }, async (error) => {
        out.error = sanitizeDiagnostic(error.message).slice(0, 200);
        await store.log("notification.failed", { approvalId: a.id, channel: "sms", provider: "Twilio", error: out.error }, { sessionId: a.session?.slice(0, 16) || "", level: "error" }).catch(() => {});
        return "failed";
      });
    }
    if (out.smsReason) await store.log("notification.skipped", { approvalId: a.id, channel: "sms", reason: out.smsReason }, { sessionId: a.session?.slice(0, 16) || "" }).catch(() => {});
    const to = c.approver?.email || c.email || "";
    if (to && emailReady(c)) {
      const message = afterHoursRequestEmail(a, { link, yes: await respondLink(a, origin, "yes"), no: await respondLink(a, origin, "no"), minutes: Math.round((a.expiresAt - a.requestedAt) / 60_000) });
      try { applyEmailResult(out, await deliverEmail("after_hours_request", a.id, to, message)); }
      catch { out.email = "failed_or_uncertain"; out.emailDelivery = "not_confirmed"; }
    } else out.emailReason = to ? "email_not_configured" : "no_recipient";
    if (out.sms !== "sent" && !["accepted", "sent"].includes(out.email)) out.reason = "not_configured";
    return out;
  }

  /**
   * Accept (with an arrival time and technician) or decline an after-hours request whose decision is
   * already recorded on it. Used by the Inbox and by the email's Yes/No page.
   */
  async function decideAfterHours(a, b, c) {
    if (a.decision?.decision === "decline") {
      a.status = "declined"; // the customer's chat sees it and offers regular openings
      await store.updateApproval(a);
      await store.audit("approval.declined", a.id);
      return;
    }
    const arrival = typeof b.arrivalAt === "number" ? b.arrivalAt : Date.parse(String(b.arrivalAt || ""));
    if (!Number.isFinite(arrival) || arrival < clock() - 10 * 60_000 || arrival > clock() + 18 * 3600_000) fail(400, "Choose an arrival time in the next 18 hours.");
    const techs = (await store.technicians()).filter((t) => t.active !== false);
    // Office users without schedule access can't see the list; with one technician on file, that's who goes.
    const tech = b.technicianId ? techs.find((t) => t.id === b.technicianId) : techs.length === 1 ? techs[0] : null;
    if (!tech) fail(400, "Choose the technician who is going.");
    if (jobberMode(c) && !tech.jobberUserId) fail(400, `${tech.name} isn't linked to a Jobber user yet. Link them under Technicians or choose someone else.`);
    const data = await store.loadSession(a.session);
    if (!data || data.approvalId !== a.id) {
      a.status = "failed";
      a.failure = "The customer's conversation expired.";
    } else {
      const slot = { start: arrival, technicianId: tech.id, technicianName: tech.name, jobberUserId: tech.jobberUserId || null, overflow: false, sameDay: true, routeScore: null };
      try {
        const { appt, pending } = await commitBooking({ token: a.session, data, hold: { start: arrival, quote: a.quote, tech: tech.id }, c, idem: `approval-${a.id}`, approval: a, afterHours: { slot } });
        a.status = pending ? "action_needed" : "booked";
        a.appointmentId = appt.id;
        a.scheduledAt = appt.scheduledAt;
        a.technicianName = tech.name;
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        a.status = "failed";
        a.failure = error.message;
      }
    }
    await store.updateApproval(a);
    await store.audit(`approval.${a.status}`, a.id);
  }

  const publicApproval = (a, c) => ({
    id: a.id,
    kind: a.kind || "service",
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
    if (!phoneOk(data, c)) fail(409, "Verify your selected contact method with a code first.", { code: "PHONE_NOT_VERIFIED" });
    ensureCoverageCurrent(data, c);
    const area = areaFor(data.contact.zip, c, "AZ", data.driveFromBaseMiles, data.location);
    if (!(area === "in" || (area === "travel" && data.travelZone))) fail(409, "Service coverage changed. Please ask the team to review.");
  }

  /**
   * Create the appointment: fresh schedule check, Jobber client/job/visit, then confirmed.
   * Returns { appt, pending } — pending means Jobber's result needs the office (never "confirmed").
   */
  async function commitBooking({ token, data, hold, c, idem, approval = null, afterHours = null }) {
    c = await store.config();
    // afterHours: { slot } for an on-call visit the office accepted at a time it chose. It skips the
    // regular schedule check (it's outside regular hours by design) and carries the premium.
    const q = afterHours ? afterHoursQuote(data, c) : quoteFor(data, c);
    if (!q) fail(409, "After-hours service is no longer offered. Please choose a regular time.");
    if (!phoneOk(data, c)) fail(409, 'Verification expired or contact details changed. Verify again before booking.');
    if (!sameQuote(q, hold.quote)) fail(409, "Service details changed. Please review a new quote and time.");
    const errors = validateContact(data.contact);
    if (errors.length) fail(400, errors.join(" "));
    if (!(await bookingOpen(c))) fail(409, "Online confirmation is paused. Please send the team a request.");
    const day = phoenixDate(new Date(hold.start));
    if (!(await store.lock(`slot:${day}`, 60))) fail(409, "Another booking for that day is finishing. Please try again in a moment.");
    let appt, pending = false;
    try {
      if (c.baseAddress || ["driving_distance", "radius"].includes(c.serviceAreaMode)) {
        const currentArea = await step("address", () => locate(c, data.contact, { travelZone: Boolean(data.travelZone), fresh: true }));
        if (!currentArea.ok) fail(409, "We could not reverify the current travel and service-area rules. Please ask the office to review this appointment.");
        if (currentArea.travelFeeCents !== q.travelFeeCents) fail(409, "Travel details changed. Please review a fresh quote.");
      }
      const slot = afterHours ? afterHours.slot : await step("recheck", async () => scheduler.check({ config: c, technicians: await store.technicians(), ...slotOptions(data, c, q), location: data.location, now: clock(), iso: new Date(hold.start).toISOString(), preferTech: hold.tech, excludeSession: token, fresh: true }));
      if (!slot) fail(409, "That opening changed. Please select another time.", { code: "SLOT_GONE" });
      if (!afterHours) {
        requireAllowedSlot(q, slot, c);
        if (approval && !needsApproval(q, slot, c)) fail(409, 'This request needs office scheduling; its approval is no longer applicable.');
        if (needsApproval(q, slot, c) && !approval) fail(409, 'Emergency same-day service needs approval first.');
      }
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
        assessmentAccepted: data.bundleAccepted, urgency: q.package === "emergency" || afterHours ? "high" : "normal", source: "ai_bot", afterHours: Boolean(afterHours),
        createdAt: new Date(clock()).toISOString(), revision: 1, scheduleSource: c.scheduleSource, jobber: null,
        phoneVerified: Boolean(verifyService.verified(data) && data.verifiedContact?.channel === 'sms'), overflow: Boolean(slot.overflow), sameDay: Boolean(slot.sameDay), travelZone: Boolean(data.travelZone),
        routeScore: slot.routeScore ?? null,
        approval: approval ? { id: approval.id, by: approval.decision?.by, at: approval.decision?.at } : null,
      };
      if (!(await store.insertAppointment(appt, { session: token, idem, status: jobberMode(c) ? "confirming" : "confirmed" }))) {
        fail(409, "Your booking is already being processed.");
      }
      if (jobberMode(c)) {
        try {
          appt.jobber = await step("jobber", () => pushToJobber(appt, slot, contact.notes, c));
        } catch (error) {
          console.error("[bookings] jobber", error.message);
          if (error.jobberJob || error.uncertain) {
            // Jobber may hold part or all of this visit. Keep the record (it protects the time)
            // and hand it to the office; never retry blind and never call it confirmed.
            appt.status = "action_needed";
            appt.jobberState = error.jobberJob ? (error.uncertain ? "visit_uncertain" : "visit_failed") : "uncertain";
            appt.jobberError = sanitizeDiagnostic(error.message).slice(0, 300);
            if (error.jobberJob) appt.jobber = { jobId: error.jobberJob.id, jobNumber: error.jobberJob.jobNumber, webUri: error.jobberJob.jobberWebUri, visitId: error.jobberVisit?.id || null };
            await store.updateAppointment(appt);
            await store.audit(`booking.jobber_${appt.jobberState}`, appt.id);
            pending = true;
          } else {
            await store.retireAppointment(appt, "failed");
            await store.audit("booking.jobber_failed", appt.id);
            if (!approval) await notifyOwnerProblem('booking_jobber_failed', appt);
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
    if (pending && !approval) await notifyOwnerProblem('booking_action_needed', appt);
    if (!pending) {
      await step("owner_text", () => notifyOwner(appt, c));
      appt.notifications = await step("confirmations", () => sendConfirmations(appt, c));
      await store.updateAppointment(appt);
      await step("report", () => sendBookingReport(appt, c));
      await step("dispatch", () => dispatch());
    }
    return { appt, pending };
  }

  return (req, res) => withTiming(() => handle(req, res));

  async function handle(req, res) {
    req.bobActivity = { requestId: randomBytes(10).toString("hex"), sessionId: "" };
    let conversationLock = null;
    let response = null;
    const releaseConversation = async () => {
      const lease = conversationLock;
      conversationLock = null;
      if (lease) await lease.release();
    };
    const send = async (status, data) => {
      if (req.adminPrincipal && req.adminPermissionPath && status < 400) {
        if (data?.config || req.method === 'GET') await currentAdmin();
        data = projectAdminResponse(req.adminPrincipal, req.method, req.adminPermissionPath, data);
        if (data?.config && Array.isArray(data.appointments)) data.access = projectPrincipal(req.adminPrincipal);
      }
      if (req.url !== "/api/health" && (status >= 400 || req.method !== "GET")) {
        const path = String(req.url || "").split("?")[0];
        await record(req, "request.finished", { path, method: req.method, status, ...(status >= 400 ? { error: data?.error } : {}), ...(TIMED_PATHS.has(path) ? { timing: timingSummary() } : {}) }, status >= 500 ? "error" : status >= 400 ? "warning" : "info");
      }
      response = { status, data };
    };
    // Prepare the reply, then let every nested finally release its locks before
    // sending it. A browser may make its next request immediately after a reply.
    const routeRequest = async () => {
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
      // Serialize session mutations (including chat/contact/verification/booking),
      // so a slow provider response cannot restore stale ownership or contact data.
      if (method !== 'GET' && !pathname.startsWith('/api/admin/') && !['/api/session', '/api/activity'].includes(pathname) && req.headers['x-bob-session']) {
        const token = digest(req.headers['x-bob-session']);
        if (!await store.loadSession(token)) fail(401, 'This conversation expired. Start again.');
        req.bobActivity.sessionId = token.slice(0, 16);
        conversationLock = await waitForRequestLock(store, `conversation:${token}`);
      }

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
        if (!["widget.minimized", "widget.expanded", "widget.nudge_opened", "client.error"].includes(body.kind)) fail(400, "Unknown activity event.");
        // widget.nudge_opened: the customer tapped the website nudge (topic = the page's offer).
        const topic = ["cleaning", "repair", "emergency", "pest"].includes(body.topic) ? body.topic : "general";
        const saved = await record(req, body.kind, { source: "customer_widget", ...(body.kind === "client.error" ? { message: String(body.message || "").slice(0, 500) } : {}), ...(body.kind === "widget.nudge_opened" ? { topic } : {}) }, body.kind === "client.error" ? "error" : "info");
        if (!saved) fail(503, "Activity could not be saved. Please try again.");
        return send(201, { recorded: true });
      }

      if (method === "POST" && pathname === "/api/chat") {
        await rate(req, "chat", 80);
        const { token, data } = await session(req), body = await readBody(req);
        if (typeof body.message !== "string" || !body.message.trim() || body.message.length > 2000) fail(400, "Enter a message of 1–2,000 characters.");
        if (data.bookingId) fail(409, "This conversation already has a booking. Start a new conversation for another request.");
        if (data.stage === "approval") fail(409, "Your visit is waiting for approval. You'll see the answer here.");
        // Never send an in-band OTP to activity/history or the language model.
        // Keep safety words intact so a safety stop still takes precedence.
        if (data.stage === 'verify' && /\b\d{4,8}\b/.test(body.message)) {
          body.message = body.message.replace(/\b\d{4,8}\b/g, '[verification code omitted]');
          if (!detectSafety(body.message)) {
            await record(req, 'conversation.message', { role: 'user', text: '[verification code omitted]', stage: data.stage });
            return send(200, { session: data, reply: 'Please enter the verification code in the code box below, not in the chat.', options: [], via: 'rules' });
          }
        }
        const c = await store.config();
        const place = data.pending === "serviceAddress" || data.stage === "out_of_area" ? await lookupPlace(body.message, c) : null;
        await record(req, "conversation.message", { role: "user", text: /^\s*\d{4,8}\s*$/.test(body.message) ? "[verification code omitted]" : body.message, stage: data.stage });
        const result = await chatTurn({ message: body.message, session: data, config: c, faqs: await store.get("faqs"), assistant: aiReady(c) ? selectedAssistant(c) : null, place });
        // Same-day emergency availability checks are gone: emergencies go to the office by phone.
        await store.saveSession(token, result.session);
        await record(req, "conversation.message", { role: "assistant", text: result.reply, stage: result.session.stage, via: result.via, availabilityRequestId: result.session.availabilityRequestId || "" });
        // Questions BOB couldn't answer from approved knowledge, and AI answers the safety filter blocked,
        // show under Activity → Warnings so the office can add the missing FAQ.
        const asked = /^\s*\d{4,8}\s*$/.test(body.message) ? "[verification code omitted]" : String(body.message).slice(0, 500);
        if (result.unanswered) await record(req, "conversation.unanswered_question", { text: asked, stage: data.stage, voiced: Boolean(result.voiced) }, "warning");
        if (result.aiRejected?.includes("answer")) await record(req, "conversation.ai_answer_blocked", { text: asked, stage: data.stage }, "warning");
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
        const { token } = await session(req), body = await readBody(req);
        if (!await store.lock(`verification:${token}`, 30)) fail(409, 'A verification request is in progress. Please wait.');
        try {
        const data = await store.loadSession(token);
        if (!data) fail(401, 'This conversation expired. Start again.');
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
        if (data.phoneVerified?.phone !== data.contact.phone) delete data.phoneVerified;
        if (useTwilioVerify) {
          if (!verifyService.verified(data)) delete data.verifiedContact;
          const pending = data.verification;
          const to = pending?.channel === 'email' ? data.contact.email.toLowerCase() : data.contact.phone;
          if (pending?.provider === 'twilio' && pending.to !== to) delete data.verification;
        }
        // End-of-booking upsell: Premium can move up to Ultimate (which already includes DryerFlex).
        if (body.upgrade === "ultimate" && data.package === "premium" && ["cleaning", "bundle"].includes(data.route) && data.property?.hasDryer !== "No") data.package = "ultimate";
        data.addOns = ["cleaning", "bundle"].includes(data.route)
          ? { fogging: body.addOns?.fogging === true && upsellOn(c, "fogging"), toolRetrieval: body.addOns?.toolRetrieval === true, dryerflex: body.addOns?.dryerflex === true && data.package !== "ultimate" && upsellOn(c, "dryerflex") }
          : {};
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
          verification = { required: true, available: verificationReady(c), sent: false, chooseChannel: useTwilioVerify, channels: useTwilioVerify ? ['sms', ...(data.contact.email ? ['email'] : [])] : [] };
        }
        await store.releaseHolds(token);
        await store.saveSession(token, data);
        return send(200, { session: data, quote: quoteFor(data, c), verification, address: where.location.formatted });
        } finally { await store.unlock(`verification:${token}`); }
      }

      if (method === "POST" && pathname === "/api/verify/send") {
        await rate(req, "verify-send", 10, 3_600_000);
        const { token, data } = await session(req);
        const c = await store.config();
        if (!useTwilioVerify || !verificationReady(c)) fail(503, 'Verification is disabled or not configured. Please contact the office.');
        const body = await readBody(req);
        return send(200, { verification: await verifyService.send(token, body.channel) });
      }
      if (method === "POST" && pathname === "/api/verify/check") {
        await rate(req, "verify-check", 30, 3_600_000);
        const { token } = await session(req), body = await readBody(req), c = await store.config();
        if (!useTwilioVerify || !verificationReady(c)) fail(503, 'Verification is disabled or not configured. Please contact the office.');
        return send(200, { verified: true, session: await verifyService.check(token, body.code) });
      }

      if (method === "GET" && pathname === "/api/availability") {
        await rate(req, "availability", 40);
        const { token, data } = await session(req);
        const c = await store.config();
        if (data.stage !== "slots" || !data.serviceAccepted || data.safety || !data.location) fail(409, "Complete the service and contact details first.");
        if (!phoneOk(data, c)) fail(409, "Verify your selected contact method with a code first.", { code: "PHONE_NOT_VERIFIED" });
        ensureCoverageCurrent(data, c);
        if (!(await bookingOpen(c))) return send(200, { slots: [], nextCursor: null, enabled: false });
        const date = url.searchParams.get("date") || "";
        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(400, "Choose a valid date.");
        const q = quoteFor(data, c);
        let all;
        try {
          all = await step("schedule", async () => scheduler.slots({ config: c, technicians: await store.technicians(), ...slotOptions(data, c, q), location: data.location, now: clock(), date, excludeSession: token }));
        } catch (error) {
          if (error.code === "JOBBER_NOT_CONNECTED") return send(200, { slots: [], nextCursor: null, enabled: false });
          console.error("[availability]", error.message);
          fail(502, "We couldn't reach the live schedule. Please try again, or send the team a request.");
        }
        all = all.filter(slot => !approvalPolicy(q, slot, c, clock()).blocked);
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
          const slot = await step("schedule", async () => scheduler.check({ config: c, technicians: await store.technicians(), ...slotOptions(data, c, quote), location: data.location, now: clock(), iso: body.scheduledAt, excludeSession: token, fresh: true }));
          if (!slot) fail(409, "That time is no longer available. Please choose a fresh opening.");
          requireAllowedSlot(quote, slot, c);
          const hold = { id: newId("HOLD"), session: token, tech: slot.technicianId, start: slot.start, end: slot.end, expires: clock() + 300_000, quote, lat: data.location.lat, lng: data.location.lng, address: `${data.contact.address}, ${data.contact.city}, AZ ${data.contact.zip}`, overflow: Boolean(slot.overflow) };
          await store.releaseHolds(token);
          await store.insertHold(hold);
          return send(201, { hold: { id: hold.id, expiresAt: hold.expires, scheduledAt: slot.scheduledAt, quote, approvalRequired: needsApproval(quote, slot, c), overflow: Boolean(slot.overflow) } });
        } finally {
          await store.unlock(`slot:${day}`);
        }
      }
      // Add-ons chosen on the review screen, after the time is picked: re-price the held visit and make
      // sure the longer visit still fits that time (DryerFlex and Ultimate take extra minutes).
      if (method === "POST" && pathname === "/api/holds/extras") {
        await rate(req, "holds", 40);
        const { token, data } = await session(req), body = await readBody(req);
        const c = await store.config();
        requireReadyToBook(data, c);
        if (!["cleaning", "bundle"].includes(data.route) || !data.upsell) fail(409, "Add-ons aren't available for this visit.");
        const hold = await store.getHold(String(body.holdId || ""), token);
        if (!hold) fail(409, "Your hold expired. Choose a time again.");
        const base = data.upgradedFrom || data.package;
        const ultimate = body.ultimate === true && base === "premium" && Boolean(data.upsell.ultimate) && data.property?.hasDryer !== "No";
        const next = {
          ...data, package: ultimate ? "ultimate" : base, upgradedFrom: ultimate ? base : null,
          addOns: { ...(data.addOns || {}), fogging: body.fogging === true && Boolean(data.upsell.fogging), dryerflex: body.dryerflex === true && !ultimate && Boolean(data.upsell.dryerflex) },
        };
        const quote = quoteFor(next, c);
        const day = phoenixDate(new Date(hold.start));
        if (!(await store.lock(`slot:${day}`, 30))) fail(409, "Someone is booking that day right now. Please try again in a moment.");
        try {
          const slot = await scheduler.check({ config: c, technicians: await store.technicians(), ...slotOptions(next, c, quote), location: data.location, now: clock(), iso: new Date(hold.start).toISOString(), preferTech: hold.tech, excludeSession: token, fresh: true });
          if (!slot) fail(409, "That add-on makes the visit too long for this time. Keep the visit as it is, or pick another time to add it.", { code: "EXTRAS_DONT_FIT" });
          requireAllowedSlot(quote, slot, c);
          await store.updateHold(hold.id, { quote, tech: slot.technicianId, end: slot.end });
          Object.assign(data, { package: next.package, upgradedFrom: next.upgradedFrom, addOns: next.addOns });
          await store.saveSession(token, data);
          await record(req, "upsell.changed", { package: next.package, dryerflex: next.addOns.dryerflex, fogging: next.addOns.fogging });
          return send(200, { hold: { id: hold.id, expiresAt: hold.expires, scheduledAt: new Date(hold.start).toISOString(), quote, approvalRequired: needsApproval(quote, slot, c), overflow: Boolean(slot.overflow) }, extras: { dryerflex: next.addOns.dryerflex, fogging: next.addOns.fogging, ultimate } });
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
        requireAllowedSlot(hold.quote, hold, c);
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
        requireAllowedSlot(q, hold, c);
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
      // An after-hours (on-call) request: no regular time to hold. The office picks the arrival time
      // when it accepts; until then the customer waits in the chat.
      // The summary the customer approves before the request goes out: the service, the premium and the address.
      if (method === "GET" && pathname === "/api/approvals/after-hours") {
        const { data } = await session(req);
        if (!data.afterHours || data.stage !== "slots" || !data.contact) fail(409, "Choose after-hours service and enter your details first.");
        const c = await store.config();
        const q = afterHoursQuote(data, c);
        if (!q) fail(409, "After-hours service isn't available online right now. Please choose a regular time or send the team a request.");
        return send(200, { quote: { name: q.name, lineItems: q.lineItems.map((l) => ({ name: l.name, cents: l.cents })), totalCents: q.totalCents, durationMins: q.durationMins }, address: `${data.contact.address}, ${data.contact.city}, AZ ${data.contact.zip}`, minutes: APPROVAL_WINDOW / 60_000 });
      }
      if (method === "POST" && pathname === "/api/approvals/after-hours") {
        await rate(req, "approvals", 10, 600_000);
        const { token, data } = await session(req), body = await readBody(req);
        if (body.approved !== true) fail(400, "Approve the service, the after-hours premium and your address first.");
        if (data.approvalId) {
          const current = await store.approval(data.approvalId);
          if (current?.status === "pending" && clock() <= current.expiresAt) return send(200, { approval: publicApproval(current, await store.config()) });
        }
        if (!data.afterHours) fail(409, "Choose after-hours service first.");
        const c = await store.config();
        requireReadyToBook(data, c);
        if (!(await bookingOpen(c))) fail(409, "Online confirmation is paused. Please send the team a request.");
        const q = afterHoursQuote(data, c);
        if (!q) fail(409, "After-hours service isn't available online right now. Please choose a regular time or send the team a request.");
        const a = {
          id: newId("APR"), session: token, status: "pending", holdId: null, kind: "after_hours",
          reason: "After-hours emergency visit: the on-call technician sets the arrival time",
          service: `${q.name} + after-hours`, packageId: q.package, totalCents: q.totalCents, lineItems: q.lineItems, quote: q,
          scheduledAt: null, durationMins: q.durationMins, technicianName: "",
          customer: { name: data.contact.name, phone: data.contact.phone, email: data.contact.email, address: data.contact.address, city: data.contact.city, zip: data.contact.zip },
          concerns: [...(data.concerns || []), ...(data.notes || [])], property: data.property || {}, notes: data.contact.notes || "",
          requestedAt: clock(), expiresAt: clock() + APPROVAL_WINDOW, decision: null, notified: null,
        };
        await store.insertApproval(a);
        data.approvalId = a.id;
        data.stage = "approval";
        await store.saveSession(token, data);
        a.notified = await notifyAfterHours(a, c, publicOrigin || (req.headers.host ? `${String(req.headers["x-forwarded-proto"] || "https").split(",")[0]}://${req.headers.host}` : ""));
        await store.updateApproval(a);
        await store.audit("approval.requested", a.id);
        await record(req, "approval.after_hours_requested", { approvalId: a.id, service: a.service, sms: a.notified.sms, email: a.notified.email });
        return send(201, { approval: publicApproval(a, c) });
      }

      // The customer changed their mind while a same-day request waits: cancel it, free the held time,
      // and go back to the choices so they can book a regular package instead.
      if (method === "POST" && pathname === "/api/approvals/current/cancel") {
        const { token, data } = await session(req);
        if (!data.approvalId) fail(404, "There's no approval request in this conversation.");
        const [a] = await sweepApprovals([await store.approval(data.approvalId)].filter(Boolean));
        if (!a) fail(404, "There's no approval request in this conversation.");
        if (["booked", "action_needed"].includes(a.status)) fail(409, "This visit was already approved and booked.");
        const c = await store.config();
        let result;
        if (a.kind === "after_hours") {
          // Cancelled, declined or timed out: back to regular openings for the same service.
          if (a.status === "pending") {
            a.status = "cancelled";
            a.cancelledAt = clock();
            await store.updateApproval(a);
            await store.audit("approval.cancelled", a.id);
            await record(req, "approval.cancelled_by_customer", { approvalId: a.id, service: a.service });
          }
          const pkg = PACKAGES[data.package]?.label || "your service";
          const reply = a.status === "cancelled"
            ? `Okay, I cancelled the after-hours request. Here are our soonest regular openings for **${pkg}**.`
            : `${a.status === "declined" ? "I'm sorry, our on-call technician can't make it tonight." : "I'm sorry, our on-call technician didn't answer in time."} Here are our soonest regular openings for **${pkg}**. Please keep the dryer off until your visit.`;
          const next = { ...data, approvalId: null, afterHours: false, stage: "slots" };
          next.history = [...(next.history || []), { role: "assistant", text: reply }].slice(-40);
          await store.saveSession(token, next);
          return send(200, { reply, options: [], session: next, action: "slots", via: "rules" });
        }
        if (a.status === "pending") {
          a.status = "cancelled";
          a.cancelledAt = clock();
          await store.updateApproval(a);
          await store.releaseHold(a.holdId);
          await store.audit("approval.cancelled", a.id);
          await record(req, "approval.cancelled_by_customer", { approvalId: a.id, service: a.service });
          result = turn("Cancel package", { ...data, approvalId: null, stage: "details", serviceAccepted: false }, c, await store.get("faqs"));
        } else {
          // Declined, timed out or couldn't be booked: same-day isn't happening, so offer the regular packages.
          result = turn("Back to packages", { ...data, approvalId: null, stage: "details", serviceAccepted: false, sameDayUnavailable: true }, c, await store.get("faqs"));
        }
        await store.saveSession(token, result.session);
        return send(200, { ...result, via: "rules" });
      }
      // The after-hours email's Yes/No buttons open /respond: the request, then one tap to answer.
      // The signed link is the permission, for that one request while it's pending. GET only reads.
      if (pathname === "/api/approvals/respond" && (method === "GET" || method === "POST")) {
        await rate(req, "respond", 30, 600_000);
        const b = method === "POST" ? await readBody(req) : {};
        const id = String(method === "POST" ? b.a || "" : url.searchParams.get("a") || "").slice(0, 40);
        const sig = method === "POST" ? b.s : url.searchParams.get("s");
        let a = id ? await store.approval(id) : null;
        if (!a || a.kind !== "after_hours" || !(await approvalSigOk(a, sig))) fail(404, "This link isn't valid. Open the request from the dashboard instead.");
        const c = await store.config();
        if (method === "POST") {
          conversationLock = await waitForRequestLock(store, `conversation:${a.session}`);
          a = await store.approval(id);
          await sweepApprovals([a]);
          if (a.status !== "pending") fail(409, a.status === "expired" ? "This request already closed: the customer was offered our regular times." : a.status === "cancelled" ? "The customer cancelled this request." : `Someone already answered this request (${a.status}).`);
          if (!["approve", "decline"].includes(b.decision)) fail(400, "Choose yes or no.");
          const by = String(b.name || c.approver?.name || "On-call technician").trim().slice(0, 100);
          a.decision = { decision: b.decision, by, at: clock(), note: "", via: "email_link", namedApprover: c.approver?.name ? by.toLowerCase() === c.approver.name.trim().toLowerCase() : null };
          await decideAfterHours(a, b, c);
        } else await sweepApprovals([a]);
        const techs = (await store.technicians()).filter((t) => t.active !== false).map((t) => ({ id: t.id, name: t.name }));
        return send(200, {
          request: {
            id: a.id, status: a.status, service: a.service, totalCents: a.totalCents, lineItems: (a.lineItems || []).map((l) => ({ name: l.name, cents: l.cents })),
            customer: a.customer, concerns: a.concerns || [], notes: a.notes || "", expiresAt: a.expiresAt, scheduledAt: a.scheduledAt, technicianName: a.technicianName || "",
            failure: a.failure || null, decision: a.decision ? { decision: a.decision.decision, by: a.decision.by, at: a.decision.at } : null,
          },
          technicians: techs, approverName: c.approver?.name || "", businessName: c.businessName || "Dryer Vent Squad West Valley",
        });
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
        const c = await store.config();
        if (data.afterHours) {
          // An on-call (after-hours) request: what they want, the regular price, and the premium.
          const fee = (c.services || []).find((x) => x.family === "addon" && x.variant === "afterhours" && x.active !== false)?.priceCents ?? null;
          let q = null;
          try { if (data.package || data.suggested) q = bookingQuote(data.route === "bundle" ? "bundle" : "cleaning", c, { package: data.package || data.suggested, property: data.property, addOns: data.addOns }); } catch {}
          request.kind = "after_hours";
          request.afterHours = { package: q?.name || null, serviceCents: q?.priceCents ?? null, premiumCents: fee };
          request.message = `AFTER-HOURS EMERGENCY REQUEST${q ? `: ${q.name} (${money(q.priceCents)})` : ""}${fee ? ` + after-hours premium ${money(fee)}` : ""}. Call the customer to confirm on-call availability.\n\n${request.message}`;
        }
        await store.insertRequest(request, token, body.idempotencyKey);
        if (request.kind === "after_hours") {
          const to = c.approver?.email || c.email || "";
          if (to) {
            const text = `${request.message}\n\nCustomer: ${request.name}\nPhone: ${request.phone}\nEmail: ${request.email || "—"}\nZIP: ${request.zip || "—"}\nPreferred contact: ${request.preference}\n\nReview: ${publicOrigin || ""}/admin?tab=inbox`;
            await deliverEmailOnce({ store, kind: "after_hours_request", id: request.id, to, clock, enabled: true, configured: useSendGrid && Boolean(sendgrid?.configured),
              message: { subject: `After-hours emergency request: ${request.name}${request.afterHours.package ? ` · ${request.afterHours.package}` : ""}`, text },
              sendEmail: async ({ to: recipient, ...content }) => sendgrid.sendEmail(recipient, content) }).catch(() => {});
          }
        }
        await store.enqueue("request.created", request, Boolean(webhookUrl));
        await store.audit("request.created", request.id);
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
        const ok = state && code && (await rawStore.consumeKv(`jobber:state:${state}`));
        let result = "failed";
        if (ok) {
          try {
            if (await adminAuth.mode() === 'named') {
              req.adminPrincipal = await adminAuth.authenticateReference(ok.adminSessionReference);
              req.adminPermissionPath = '/api/admin/jobber/connect';
              req.adminPermissionMethod = 'GET';
              requireAdminRoute(req.adminPrincipal, 'GET', req.adminPermissionPath);
            } else if (ok.adminSessionReference) fail(401, 'The management session is no longer active.');
            await clientHub.invalidate();
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
        const authMode = await adminAuth.mode();
        let authenticated = false;
        try {
          await admin(req);
          authenticated = true;
        } catch (error) { if (error.status !== 401) throw error; }
        return send(200, { authenticated, authMode, ...(authenticated ? { principal: projectPrincipal(req.adminPrincipal) } : {}), setupRequired: authMode === 'legacy' && !envPassword && !(await store.get("auth")), passwordFromEnv: authMode === 'legacy' && Boolean(envPassword) && !(await store.get("auth")) });
      }
      if (method === 'POST' && ['/api/admin/invite/details','/api/admin/invite/accept','/api/admin/owner-bootstrap/accept'].includes(pathname)) {
        await rate(req, 'account-acceptance', 12, 900_000);
        const body = await readBody(req);
        if (Object.keys(body).some(key => !['token','password'].includes(key))) fail(400, 'Only the invitation and your password may be supplied.');
        if (pathname === '/api/admin/invite/details') return send(200, await adminAuth.invitationDetails({ token: body.token }));
        const result = pathname === '/api/admin/owner-bootstrap/accept' ? await adminAuth.acceptOwnerBootstrap(body) : await adminAuth.acceptInvite(body);
        return send(200, result);
      }
      if (method === "POST" && pathname === "/api/admin/setup") {
        if (await adminAuth.mode() !== 'legacy') fail(403, 'Shared-password setup is unavailable.');
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
        const body = await readBody(req);
        if (await adminAuth.mode() === 'named' || Object.prototype.hasOwnProperty.call(body, 'email')) {
          if (!await rawStore.rateHit(`named-account-login:${digest(String(body.email || '').trim().toLowerCase())}`, 8, 900_000)) fail(429, 'Too many requests. Please try again shortly.');
          const result = await adminAuth.login(body);
          const secure = publicOrigin.startsWith('https:') || env.VERCEL ? '; Secure' : '';
          res.setHeader('Set-Cookie', `bob_user=${result.token}; HttpOnly; SameSite=Lax; Path=/api/admin; Max-Age=28800${secure}`);
          return send(200, { authenticated: !result.pendingCutover, pendingCutover: result.pendingCutover, principal: projectPrincipal(result.principal) });
        }
        const auth = await store.get("auth");
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
        req.adminPermissionPath = pathname;
        requireAdminRoute(req.adminPrincipal, method, pathname);
        const snapshot = () => dashboardSnapshot({ maintain: req.adminPrincipal.role === 'legacy' });
        if (pathname === '/api/admin/users' && method === 'GET') return send(200, await adminAuth.listUsers(req.adminPrincipal));
        if (pathname === '/api/admin/users/invite' && method === 'POST') {
          await rate(req, 'user-management', 20, 900_000);
          return send(201, await adminAuth.invite(req.adminPrincipal, await readBody(req)));
        }
        if (method === 'PATCH' && /^\/api\/admin\/users\/[^/]+$/.test(pathname)) {
          return send(200, await adminAuth.updateUser(req.adminPrincipal, decodeURIComponent(pathname.split('/').pop()), await readBody(req)));
        }
        if (method === 'POST' && /^\/api\/admin\/users\/[^/]+\/reset-invite$/.test(pathname)) {
          await rate(req, 'user-management', 20, 900_000);
          return send(201, await adminAuth.resetInvite(req.adminPrincipal, decodeURIComponent(pathname.split('/')[4])));
        }
        if (method === 'POST' && /^\/api\/admin\/invitations\/[^/]+\/revoke$/.test(pathname)) {
          return send(200, await adminAuth.revokeInvite(req.adminPrincipal, decodeURIComponent(pathname.split('/')[4])));
        }
        if (method === "POST" && pathname === "/api/admin/booking-report/test") {
          await rate(req, "booking-report-test", 5, 600_000);
          const to = bookingReportTo();
          if (!to) return send(200, { status: "off", to: "" });
          if (!(useSendGrid && sendgrid?.configured)) return send(200, { status: "not_configured", to });
          const c = await store.config();
          const now = new Date(clock()).toISOString();
          const sample = {
            id: "TEST-REPORT", createdAt: now, price: 179, source: "ai_bot", status: "confirmed",
            customerName: "Test Customer", phone: "6235550100", email: "test@example.com", address: "123 W Test St", city: "Buckeye", zip: "85326",
            package: "Premium 1-2-3 See-It-Clean", lineItems: [{ name: "Premium 1-2-3 See-It-Clean", cents: 17900 }],
            scheduledAt: new Date(clock() + 2 * 86_400_000).toISOString(), durationMins: 60, technicianName: "Test Technician",
            concerns: ["This is a test email from the ChatDaddy dashboard. No appointment was booked."],
          };
          const email = bookingReportEmail(sample, bookingTotals(await store.appointments(), sample, { commissionCents }), c);
          try {
            const r = await sendgrid.sendEmail(to, { ...email, subject: `[TEST] ${email.subject}` });
            await record(req, "booking_report.test", { status: r?.status === "accepted" ? "accepted" : "uncertain" });
            return send(200, { status: r?.status === "accepted" ? "accepted" : "uncertain", to });
          } catch (error) {
            await record(req, "booking_report.test", { status: error?.code === "SENDGRID_REJECTED" ? "rejected" : "failed" }, "warning");
            return send(200, { status: error?.code === "SENDGRID_REJECTED" ? "rejected" : "failed", to });
          }
        }
        if(pathname==='/api/admin/owner-sms-consent'&&['GET','POST'].includes(method)) {
          if(method==='GET')return send(200,await ownerConsent.snapshot());
          const body=await readBody(req);
          try{
            const result = await ownerConsent.record(body, adminToken, req.adminPrincipal.role === 'master' ? req.adminPrincipal.id : null);
            await store.audit('owner_sms.consent_recorded', result.receipt.id);
            return send(200,result);
          }
          catch(error){fail(error.status||503,error.status?error.message:'Consent could not be saved. Please retry.');}
        }

        if (["GET", "POST"].includes(method) && pathname === "/api/admin/integration-accounts") {
          if (method === "POST") {
            await rate(req, "integration-accounts", 5, 60_000);
            if (!integrationAccounts) fail(503, "Account identity lookup is unavailable.");
            return send(200, await integrationAccounts.refresh());
          }
          return send(200, await integrationAccounts?.snapshot() || {});
        }
        if (method === "POST" && pathname === "/api/admin/logout") {
          if (req.adminPrincipal.role === 'legacy') await store.removeAdmin(adminToken);
          else await adminAuth.logout(cookie(req, 'bob_user'));
          res.setHeader("Set-Cookie", ["bob_admin=; HttpOnly; SameSite=Lax; Path=/api/admin; Max-Age=0", "bob_user=; HttpOnly; SameSite=Lax; Path=/api/admin; Max-Age=0"]);
          return send(200, { signedOut: true });
        }
        if (method === "GET" && pathname === "/api/admin/data") return send(200, await snapshot());
        if (method === "GET" && pathname === "/api/admin/activity") return send(200, await store.activity({ sessionId: (url.searchParams.get("session") || "").slice(0, 32), level: url.searchParams.get("level") || "", cursor: url.searchParams.get("cursor") || "", limit: 100 }));
        // The browser Maps key is separate from the server key: it's restricted to the dashboard's web
        // address in Google Cloud, so it's safe to send to the browser. Without it the map uses OpenStreetMap.
        // Revenue pacing: this week and the next two against the minimum. The Settings page passes the
        // values being edited so the preview updates before they're saved.
        if (method === "GET" && pathname === "/api/admin/revenue-pace") {
          const c = await store.config();
          const q = url.searchParams, num = (k, fallback) => { const v = Number(q.get(k)); return q.has(k) && Number.isInteger(v) && v >= 0 && v <= 100000000 ? v : fallback; };
          const rp = c.revenuePacing || {};
          const pacing = { enabled: true, period: ["month", "week"].includes(q.get("period")) ? q.get("period") : rp.period || "month", targetCents: num("target", rp.targetCents || 0), outsideJobCents: num("outside", rp.outsideJobCents || 0) };
          const pace = await scheduler.pace({ config: { ...c, revenuePacing: pacing }, now: clock() });
          return send(200, { pace: pace && { ...pace, now: clock(), weeks: pace.weeks.map(({ days, ...w }) => w) } });
        }
        if (method === "GET" && pathname === "/api/admin/maps-key") {
          const key = String(env.GOOGLE_MAPS_BROWSER_KEY || "").trim();
          return send(200, { key: /^[A-Za-z0-9_-]{20,100}$/.test(key) ? key : "" });
        }
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
          if (!enabled(await store.config(), 'jobber')) fail(409, 'Enable Jobber in Connections first.');
          if (!jobber.appConfigured) fail(400, "Add JOBBER_CLIENT_ID, JOBBER_CLIENT_SECRET and JOBBER_REDIRECT_URI in Vercel first.");
          const state = secret();
          await store.kvSet(`jobber:state:${state}`, { at: clock(), ...(req.adminPrincipal.role === 'legacy' ? {} : { adminSessionReference: adminAuth.sessionReference(req.adminPrincipal) }) }, 600);
          res.writeHead(302, { Location: jobber.authorizeUrl(state), "Cache-Control": "no-store" });
          return res.end();
        }
        if (method === "POST" && pathname === "/api/admin/jobber/disconnect") {
          await clientHub.invalidate();
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

        if (method === 'POST' && pathname === '/api/admin/jobber/client-hub/identity') {
          try { return send(200, await clientHub.challenge()); }
          catch { fail(409, 'The connected Jobber account could not be verified.'); }
        }
        if (method === 'POST' && pathname === '/api/admin/jobber/client-hub') {
          const body=await readBody(req);
          try { await clientHub.save(body); }
          catch(error) { fail(error.status === 409 ? 409 : 400, error.status === 409 ? 'Verify the connected Jobber account again before saving its Client Hub link.' : 'The Client Hub link could not be saved. Check the public share-login URL and verify the account again.'); }
          await store.audit('client_hub.updated', 'jobber');
          return send(200, await snapshot());
        }

        if (method === 'POST' && pathname === '/api/admin/templates/preview') {
          await rate(req, 'template-preview', 20, 60_000);
          const body = await readBody(req);
          const errors = validateHtmlTemplate(body?.template);
          if (errors.length) fail(400, errors.join(' '));
          const values = Object.fromEntries(MESSAGE_VARIABLES.map(v => [v.key, v.sample]));
          // Fictional public company-login example, never a real client access token.
          values.client_hub_url = 'https://clienthub.getjobber.com/client_hubs/00000000-0000-0000-0000-000000000000/login/new?source=share_login';
          try { return send(200, renderHtmlTemplate(body.template, values)); }
          catch { fail(400, 'Email HTML must produce readable content within the allowed size.'); }
        }
        if (method === 'POST' && pathname === '/api/admin/connections/refresh') {
          await rate(req, 'connections-refresh', 5, 60_000);
          if (!connectionHealth) fail(503, 'Connection checks are unavailable.');
          await connectionHealth.refresh();
          return send(200, await snapshot());
        }

        if (method === "PATCH" && pathname === "/api/admin/config") {
          const body = await readBody(req), old = await store.config();
          if (body.version !== old.version) fail(409, "Settings were changed elsewhere. Refresh before saving.");
          if (req.adminPrincipal.role === 'legacy' && 'ownerErrorSmsEnabled' in body && body.ownerErrorSmsEnabled !== old.ownerErrorSmsEnabled) fail(403, 'Master Admin access is required to change owner service-error alerts.');
          const next = req.adminPrincipal.role === 'legacy' ? { ...old } : applyConfigPatch(req.adminPrincipal, body, old);
          if (req.adminPrincipal.role === 'legacy') for (const key of Object.keys(DEFAULT_CONFIG)) if (key in body && key !== "version") {
            const value = body[key], previous = old[key];
            // The dashboard sends sparse nested changes; retain unsupplied settings and custom templates.
            next[key] = value && typeof value === 'object' && !Array.isArray(value) && previous && typeof previous === 'object' && !Array.isArray(previous)
              ? { ...previous, ...value } : value;
          }
          next.version = old.version + 1;
          next.bundlePriceCents = BUNDLE_PRICE_CENTS;
          const errors = validateConfig(next), known = (await store.technicians()).map((t) => t.id);
          if (next.messageEmailFormat === 'html' && next.messageTemplates?.confirmationEmailBody?.trim()) {
            const htmlErrors = validateHtmlTemplate(next.messageTemplates.confirmationEmailBody);
            errors.push(...htmlErrors);
            if (!htmlErrors.length) {
              try { renderHtmlTemplate(next.messageTemplates.confirmationEmailBody, Object.fromEntries(MESSAGE_VARIABLES.map(v => [v.key, v.sample]))); }
              catch { errors.push('Email HTML must produce readable content within the allowed size.'); }
            }
          }
          if (next.activeTechnicianIds.some((id) => !known.includes(id))) errors.push("Select a known technician.");
          if (errors.length) fail(400, errors.join(" "));
          await store.set("config", next);
          await store.audit("settings.updated", next.version);
          return send(200, await snapshot());
        }
        if (method === "POST" && pathname === "/api/admin/password") {
          const b = await readBody(req);
          if (req.adminPrincipal.role !== 'legacy') return send(200, await adminAuth.changePassword(req.adminPrincipal, b));
          const auth = await store.get("auth");
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
          if (req.adminPrincipal.role !== 'legacy') {
            const previous = await store.technicians();
            if (!hasPermission(req.adminPrincipal, 'integrations.manage')) {
              // This technician is the legacy availability-text fallback recipient.
              // Protect it even while an explicit approver currently overrides it.
              const before = previous.find(t => t.id === 'tech-ryan');
              const after = b.technicians.find(t => t.id === 'tech-ryan');
              const afterPhone = String(after && Object.hasOwn(after, 'phone') ? after.phone || '' : before?.phone || '').slice(0, 30);
              if (Boolean(before) !== Boolean(after) || normalizePhone(before?.phone) !== normalizePhone(afterPhone)) fail(403, 'Changing the staff SMS fallback recipient requires Master Admin.');
            }
            if (!hasPermission(req.adminPrincipal, 'integrations.manage') && b.technicians.some(t => {
              const old = previous.find(row => row.id === t.id)?.jobberUserId || '';
              return String(Object.hasOwn(t, 'jobberUserId') ? t.jobberUserId || '' : old) !== String(old);
            })) fail(403, 'Changing provider technician mappings requires Master Admin.');
            if (!hasPermission(req.adminPrincipal, 'integrations.manage') && previous.some(old => old.jobberUserId && !b.technicians.some(t => t.id === old.id))) fail(403, 'Removing a mapped technician requires Master Admin.');
            b.technicians = b.technicians.map(t => ({ ...previous.find(old => old.id === t.id), ...t }));
          }
          const linked = b.technicians.map((t) => t.jobberUserId).filter(Boolean);
          if (new Set(linked).size !== linked.length) fail(400, "Each Jobber user can be linked to only one technician.");
          // Work schedule and time off: a request that leaves them out keeps what was saved.
          const saved = await store.technicians();
          for (const t of b.technicians) {
            const who = t.name.trim();
            if (Object.hasOwn(t, "workWeek") && !validWorkWeek(t.workWeek)) fail(400, `Check ${who}'s work schedule: each working day needs a start time before its end time.`);
            if (Object.hasOwn(t, "timeOff") && !validTimeOff(t.timeOff)) fail(400, `Check ${who}'s time off: each entry needs a start date on or before its end date (up to a year), and a start time before its end time if it isn't all day.`);
          }
          const today = phoenixDate(new Date(clock()));
          await store.set("technicians", b.technicians.map((t) => {
            const before = saved.find((x) => x.id === t.id) || {};
            return {
              id: t.id, name: t.name.trim(), phone: String(t.phone || "").slice(0, 30), status: t.status, color: /^#[0-9a-f]{6}$/i.test(t.color || "") ? t.color : "#f97316",
              zone: String(t.zone || "").slice(0, 200), jobberUserId: String(t.jobberUserId || ""), vehicle: String(t.vehicle || "").slice(0, 60), bio: String(t.bio || "").slice(0, 400),
              workWeek: cleanWorkWeek(Object.hasOwn(t, "workWeek") ? t.workWeek : before.workWeek),
              timeOff: cleanTimeOff(Object.hasOwn(t, "timeOff") ? t.timeOff : before.timeOff, today),
            };
          }));
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
          const id = decodeURIComponent(pathname.split("/").pop()), b = await readBody(req);
          let a = await store.approval(id);
          if (!a) fail(404, "Approval request not found.");
          const key = `conversation:${a.session}`;
          conversationLock = await waitForRequestLock(store, key);
          a = await store.approval(id);
          if (!a) fail(404, 'Approval request not found.');
          const c = await store.config();
          await sweepApprovals([a]);
          if (a.status !== "pending") fail(409, `This request is already ${a.status}.`);
          if (!["approve", "decline"].includes(b.decision)) fail(400, "Choose approve or decline.");
          const by = String(req.adminPrincipal.role === 'legacy' ? b.approverName || '' : req.adminPrincipal.name || '').trim();
          if (by.length < 2 || by.length > 100) fail(400, "Enter the name of the person approving.");
          a.decision = {
            decision: b.decision, by, at: clock(), note: String(b.note || "").slice(0, 500),
            ...(req.adminPrincipal.role === 'legacy' ? {} : { actorUserId: req.adminPrincipal.id }),
            namedApprover: c.approver?.name ? by.toLowerCase() === c.approver.name.trim().toLowerCase() : null,
          };
          if (a.kind === "after_hours") {
            await decideAfterHours(a, b, c);
            return send(200, { ...(await snapshot()), result: { status: a.status, failure: a.failure || null, appointmentId: a.appointmentId || null } });
          }
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
          if (b.sendConfirmation === true && !hasPermission(req.adminPrincipal, 'appointments.send')) fail(403, 'Sending confirmations requires a separate permission.');
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
            a.status = jobberMode(c) ? "confirming" : "confirmed";
            await store.insertAppointment(a);
            if (jobberMode(c)) {
              try { a.jobber = await pushToJobber(a, slot, b.notes, c); a.status = "confirmed"; }
              catch (error) {
                if (!error.jobberJob && !error.uncertain) {
                  await store.retireAppointment(a, "failed");
                  fail(502, "The office booking could not be created. No visit is confirmed.");
                }
                a.status = "action_needed";
                a.jobberState = error.jobberJob ? "visit_uncertain" : "uncertain";
                a.jobberError = sanitizeDiagnostic(error.message).slice(0, 300);
                if (error.jobberJob) a.jobber = { jobId: error.jobberJob.id, jobNumber: error.jobberJob.jobNumber, webUri: error.jobberJob.jobberWebUri, visitId: error.jobberVisit?.id || null };
              }
              await store.updateAppointment(a);
            }
            await store.audit(a.status === "confirmed" ? "admin.booking.created" : "admin.booking.pending_review", a.id);
            if (a.status === "confirmed") await store.enqueue("booking.created", a, Boolean(webhookUrl));
            if (a.status === "confirmed" && b.sendConfirmation === true) {
              a.notifications = await sendConfirmations(a, c);
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
            if (!smsReady(c) && !emailReady(c)) fail(409, 'Configure and enable an approved appointment messaging provider first.');
            a.notifications = await sendConfirmations(a, c);
            await store.updateAppointment(a);
            await store.audit("appointment.confirmation_requested", id);
            return send(200, await snapshot());
          }
          if (a.status !== "action_needed" || !a.jobberState) fail(409, "Only bookings waiting on a Jobber check can be resolved here.");
          if (b.outcome === "in_jobber") {
            const number = String(b.jobNumber || a.jobber?.jobNumber || "").trim();
            if (!/^\d{1,10}$/.test(number)) fail(400, "Enter the Jobber job number you found.");
            const visitId = a.jobber?.visitId || (typeof b.visitId === "string" ? b.visitId.trim() : "");
            const tech = (await store.technicians()).find(t => t.id === a.technicianId);
            if (!tech?.jobberUserId || !jobber.verifyScheduledVisit) fail(409, "A mapped technician and verified Jobber visit are required before this appointment can be confirmed.");
            let verifiedVisit;
            try { verifiedVisit = await jobber.verifyScheduledVisit({ visitId, jobNumber: Number(number), start: Date.parse(a.scheduledAt), end: Date.parse(a.scheduledAt) + a.durationMins * 60_000, jobberUserId: tech.jobberUserId, alsoAssign: c.alsoAssignJobberUserIds || [] }); if (!verifiedVisit?.id) throw new Error("Missing verified visit ID"); }
            catch { fail(409, "Jobber has not verified this visit's time and technician. Keep it pending and correct the visit in Jobber."); }
            a.jobber = { ...(a.jobber || {}), jobNumber: Number(number), visitId: verifiedVisit.id };
            a.jobberState = "resolved";
            a.status = "confirmed";
            a.revision++;
            await store.updateAppointment(a);
            await notifyOwner(a, c);
            a.notifications = await sendConfirmations(a, c);
            await store.updateAppointment(a);
            await sendBookingReport(a, c);
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
          const exported = await snapshot();
          await currentAdmin();
          res.writeHead(200, { "Content-Type": "application/json", "Content-Disposition": 'attachment; filename="BOB-data-export.json"', "Cache-Control": "no-store" });
          return res.end(JSON.stringify({ ...projectSnapshot(exported, req.adminPrincipal), access: projectPrincipal(req.adminPrincipal), exportedAt: new Date(clock()).toISOString() }, null, 2));
        }
        fail(404, "Management action not found.");
      }
      fail(404, "Endpoint not found.");
    } catch (e) {
      if (res.headersSent) return res.end();
      if (!(e instanceof HttpError) && !(Number.isInteger(e.status) && e.status >= 400 && e.status < 500) && e.extra?.code !== 'CONVERSATION_PENDING') {
        console.error("BOB request failed:", e);
        // Kept for a week so the office can see what went wrong (Settings → Connections).
        await store.kvSet("diag:last-error", { at: clock(), path: `${method} ${pathname}`, message: String(e?.message || e).slice(0, 300) }, 60 * 60 * 24 * 7).catch(() => {});
      }
      return send(e.status || 500, {
        error: e.status ? e.message : "The operation could not be completed. Your appointment is not confirmed unless a booking reference was returned.",
        ...(e.extra || {}),
      });
    } finally {
      await releaseConversation();
    }
    };
    await adminScope.run(req, routeRequest);
    if (response && !res.headersSent) {
      res.setHeader("X-BOB-Request-ID", req.bobActivity.requestId);
      const path = String(req.url || "").split("?")[0];
      if (TIMED_PATHS.has(path)) {
        const timing = timingSummary();
        res.setHeader("Server-Timing", serverTimingHeader(timing));
        console.log(`[timing] ${req.method} ${path} ${response.status} ${timing.ms}ms ${JSON.stringify(timing)}`);
      }
      res.writeHead(response.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(response.data));
    }
  }
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
