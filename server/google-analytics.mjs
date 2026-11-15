// Website traffic from Google Analytics 4 for the dashboard's Analytics tab (Custom-AIs.com by default).
//
// Read-only. A Google Cloud service account that has Viewer access to one GA4 property reads reports
// through the Google Analytics Data API. Its key stays on the server: the browser only ever receives
// report numbers. No extra packages: the service-account token is signed with node:crypto.
//
// Server settings (Vercel → Settings → Environment Variables):
//   GA4_PROPERTY_ID            numeric Property ID (Google Analytics → Admin → Property details). Not the G-… measurement ID.
//   GA4_SERVICE_ACCOUNT_JSON   the whole JSON key file of the service account (or that file in base64).
//   GA4_SITE_NAME              optional label shown on the dashboard (default "Custom-AIs.com").

import { createSign } from "node:crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DATA_API = "https://analyticsdata.googleapis.com/v1beta";
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
/** Report ranges offered on the dashboard, in days (whole days, through yesterday, like Google Analytics). */
export const ANALYTICS_RANGES = Object.freeze([7, 28, 90]);
export const DEFAULT_RANGE = 28;
export const DEFAULT_SITE_NAME = "Custom-AIs.com";
/** Google Analytics processes data over hours, so a report is reused for 10 minutes (shared by every instance). */
const CACHE_SECONDS = 600;
const TIMEOUT_MS = 10_000;

const problem = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const text = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

function parseServiceAccount(raw) {
  const candidates = [raw];
  if (!raw.startsWith("{")) {
    try { candidates.push(Buffer.from(raw, "base64").toString("utf8")); } catch {}
  }
  for (const candidate of candidates) {
    try {
      const json = JSON.parse(candidate);
      const email = String(json?.client_email || "").trim();
      // A key pasted with its line breaks still escaped ("\n") is repaired.
      const key = String(json?.private_key || "").replace(/\\n/g, "\n");
      if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && /-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(key)) return { email, key };
    } catch {}
  }
  return null;
}

/** What the server settings say, without calling Google. Never includes the private key. */
export function analyticsSettings(env = process.env) {
  const site = text(env.GA4_SITE_NAME, 80) || DEFAULT_SITE_NAME;
  const missing = [], problems = [];
  const rawId = String(env.GA4_PROPERTY_ID || "").trim().replace(/^properties\//i, "");
  let propertyId = "";
  if (!rawId) missing.push("GA4_PROPERTY_ID");
  else if (/^G-/i.test(rawId)) problems.push("GA4_PROPERTY_ID holds a measurement ID (G-…). Use the numeric Property ID from Google Analytics → Admin → Property details.");
  else if (!/^\d{4,20}$/.test(rawId)) problems.push("GA4_PROPERTY_ID should be the numeric Property ID from Google Analytics → Admin → Property details.");
  else propertyId = rawId;
  const rawKey = String(env.GA4_SERVICE_ACCOUNT_JSON || "").trim();
  const account = rawKey ? parseServiceAccount(rawKey) : null;
  if (!rawKey) missing.push("GA4_SERVICE_ACCOUNT_JSON");
  else if (!account) problems.push("GA4_SERVICE_ACCOUNT_JSON isn't a Google service-account key. Paste the whole JSON key file downloaded from Google Cloud.");
  return { site, propertyId, account, missing, problems, configured: Boolean(propertyId && account) };
}

/** YYYY-MM-DD for a moment in a time zone. */
const dayIn = (ms, timeZone) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
const validZone = (zone) => {
  try { return Boolean(zone) && Boolean(new Intl.DateTimeFormat("en-US", { timeZone: zone })); } catch { return false; }
};

/** Turns Google's error reply into what to do about it, in plain words. */
function explain(status, body, settings) {
  const g = body?.error || {};
  const message = String(g.message || "");
  const reason = [g.status, ...(Array.isArray(g.details) ? g.details.map((d) => d?.reason) : [])].join(" ");
  if (status === 401) return problem("auth_rejected", "Google didn't accept the service-account sign-in. Create a new JSON key for the service account and replace GA4_SERVICE_ACCOUNT_JSON.");
  if (status === 403 && /SERVICE_DISABLED|has not been used|is disabled|API_DISABLED/i.test(`${reason} ${message}`)) {
    return problem("api_disabled", "The Google Analytics Data API is turned off for the service account's Google Cloud project. Turn it on (Google Cloud → APIs & Services → Library → Google Analytics Data API → Enable), then try again in a few minutes.");
  }
  if (status === 403) {
    return problem("no_access", `The service account can't read this Google Analytics property. In Google Analytics → Admin → Property access management, add ${settings.account.email} as a Viewer.`, { serviceAccount: settings.account.email });
  }
  if (status === 404 || (status === 400 && /propert/i.test(message))) {
    return problem("bad_property", `Google Analytics has no property ${settings.propertyId} that this account can see. Check GA4_PROPERTY_ID (Admin → Property details → Property ID).`);
  }
  if (status === 429) return problem("quota", "Google Analytics is limiting how often reports can be read for this property. Try again in an hour.");
  return problem("failed", `Google Analytics didn't return the report (HTTP ${status}). Try again in a few minutes.`);
}

export function createGoogleAnalytics({ env = process.env, cache = null, fetchImpl = globalThis.fetch, clock = Date.now } = {}) {
  const settings = analyticsSettings(env);
  let token = null; // { value, expires } — per instance; a new one is signed when it nears expiry.

  async function request(url, init) {
    let response;
    try {
      response = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw problem("unreachable", "Couldn't reach Google Analytics. Try again in a minute.");
    }
    let body = null;
    try { body = await response.json(); } catch {}
    return { ok: response.ok, status: response.status, body };
  }

  async function accessToken() {
    if (token && token.expires - 60_000 > clock()) return token.value;
    const now = Math.floor(clock() / 1000);
    const unsigned = `${Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ iss: settings.account.email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })).toString("base64url")}`;
    let signature;
    try { signature = createSign("RSA-SHA256").update(unsigned).sign(settings.account.key).toString("base64url"); }
    catch { throw problem("bad_key", "The private key in GA4_SERVICE_ACCOUNT_JSON can't be read. Download a new JSON key for the service account and paste the whole file."); }
    const r = await request(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }).toString(),
    });
    if (!r.ok || typeof r.body?.access_token !== "string") {
      console.error("[google-analytics] token request rejected:", r.status, text(r.body?.error_description || r.body?.error, 200));
      throw problem("auth_rejected", "Google rejected the service-account key (it may have been deleted or disabled). Create a new JSON key for the service account and replace GA4_SERVICE_ACCOUNT_JSON.");
    }
    token = { value: r.body.access_token, expires: clock() + Math.min(3600, Math.max(60, num(r.body.expires_in) || 3600)) * 1000 };
    return token.value;
  }

  async function fetchReport(days) {
    const current = { name: "current", startDate: `${days}daysAgo`, endDate: "yesterday" };
    const previous = { name: "previous", startDate: `${days * 2}daysAgo`, endDate: `${days + 1}daysAgo` };
    const metrics = (...names) => names.map((name) => ({ name }));
    const top = (metricName, limit) => ({ orderBys: [{ metric: { metricName }, desc: true }], limit });
    const body = {
      requests: [
        { dateRanges: [current, previous], metrics: metrics("activeUsers", "newUsers", "sessions", "screenPageViews", "engagementRate", "averageSessionDuration") },
        { dateRanges: [current], dimensions: [{ name: "date" }], metrics: metrics("activeUsers", "sessions", "screenPageViews"), orderBys: [{ dimension: { dimensionName: "date" } }], limit: 400 },
        { dateRanges: [current], dimensions: [{ name: "pagePath" }], metrics: metrics("screenPageViews", "activeUsers"), ...top("screenPageViews", 10) },
        { dateRanges: [current], dimensions: [{ name: "sessionDefaultChannelGroup" }], metrics: metrics("sessions"), ...top("sessions", 8) },
        { dateRanges: [current], dimensions: [{ name: "deviceCategory" }], metrics: metrics("activeUsers"), ...top("activeUsers", 5) },
      ],
    };
    const call = async () => request(`${DATA_API}/properties/${settings.propertyId}:batchRunReports`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    let r = await call();
    if (r.status === 401) { token = null; r = await call(); } // A token revoked early gets one fresh try.
    if (!r.ok) {
      console.error("[google-analytics] report request failed:", r.status, text(r.body?.error?.status, 60), text(r.body?.error?.message, 300));
      throw explain(r.status, r.body, settings);
    }
    return normalize(r.body, days);
  }

  function normalize(body, days) {
    const [totalsReport, dailyReport, pagesReport, channelsReport, devicesReport] = Array.isArray(body?.reports) ? body.reports : [];
    const rows = (report) => (Array.isArray(report?.rows) ? report.rows : []);
    const metric = (row, i) => num(row?.metricValues?.[i]?.value);
    const dim = (row, i = 0) => String(row?.dimensionValues?.[i]?.value ?? "");
    const totalsFor = (range) => {
      const row = rows(totalsReport).find((r) => dim(r) === range);
      return { activeUsers: metric(row, 0), newUsers: metric(row, 1), sessions: metric(row, 2), pageViews: metric(row, 3), engagementRate: metric(row, 4), avgSessionSeconds: metric(row, 5) };
    };
    const timeZone = validZone(totalsReport?.metadata?.timeZone) ? totalsReport.metadata.timeZone : validZone(dailyReport?.metadata?.timeZone) ? dailyReport.metadata.timeZone : "America/Phoenix";
    // Every day of the range appears, including days without visits.
    const byDate = new Map(rows(dailyReport).map((r) => {
      const d = dim(r);
      return [/^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d, { users: metric(r, 0), sessions: metric(r, 1), pageViews: metric(r, 2) }];
    }));
    // Calendar days counted back from today in the property's time zone (safe across daylight-saving changes).
    const today = Date.parse(`${dayIn(clock(), timeZone)}T00:00:00Z`);
    const daily = [];
    for (let back = days; back >= 1; back--) {
      const date = new Date(today - back * 86_400_000).toISOString().slice(0, 10);
      daily.push({ date, ...(byDate.get(date) || { users: 0, sessions: 0, pageViews: 0 }) });
    }
    return {
      status: "ok", site: settings.site, propertyId: settings.propertyId, days, timeZone, fetchedAt: clock(),
      totals: totalsFor("current"), previous: totalsFor("previous"), daily,
      pages: rows(pagesReport).map((r) => ({ path: text(dim(r), 300) || "(not set)", views: metric(r, 0), users: metric(r, 1) })),
      channels: rows(channelsReport).map((r) => ({ name: text(dim(r), 60) || "Unassigned", sessions: metric(r, 0) })),
      devices: rows(devicesReport).map((r) => ({ name: text(dim(r), 40) || "Other", users: metric(r, 0) })),
    };
  }

  /** The report for the last `days` days, or why there isn't one. Never throws. */
  async function report({ days = DEFAULT_RANGE } = {}) {
    days = ANALYTICS_RANGES.includes(days) ? days : DEFAULT_RANGE;
    const base = { site: settings.site, days };
    if (!settings.configured) {
      return { ...base, status: "not_configured", missing: settings.missing, problems: settings.problems, ...(settings.account ? { serviceAccount: settings.account.email } : {}) };
    }
    const key = `ga4:report:v1:${settings.propertyId}:${days}`;
    try {
      const saved = await cache?.kvGet(key);
      if (saved?.status === "ok" && clock() - saved.fetchedAt < CACHE_SECONDS * 1000) return saved;
    } catch {}
    try {
      const fresh = await fetchReport(days);
      try { await cache?.kvSet(key, fresh, CACHE_SECONDS); } catch {}
      return fresh;
    } catch (error) {
      return { ...base, status: "error", propertyId: settings.propertyId, error: { code: error.code || "failed", message: error.code ? error.message : "Google Analytics didn't return the report. Try again in a few minutes." }, ...(error.serviceAccount ? { serviceAccount: error.serviceAccount } : {}) };
    }
  }

  return { configured: settings.configured, site: settings.site, report };
}
