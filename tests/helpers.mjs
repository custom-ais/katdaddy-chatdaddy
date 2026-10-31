// Test harness: real BOB handler + in-process Postgres + fake Jobber / LeadConnector / maps.

import http from "node:http";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPgliteDb, createSupabaseRpcDb } from "../server/db.mjs";
import { RPC_SQL } from "../server/schema.mjs";
import { createStore } from "../server/store.mjs";
import { createScheduler } from "../server/schedule.mjs";
import { createBobHandler } from "../server/app.mjs";
import { createTwilio } from "../server/twilio.mjs";
import { estimateDriveMinutes } from "../server/geo.mjs";
import { JobberNotConnected } from "../server/jobber.mjs";
import { DEFAULT_CONFIG } from "../shared/domain.mjs";

export const baseTime = Date.parse("2026-09-21T20:00:00Z"); // Monday 1:00 PM Arizona
export const approved = {
  ...DEFAULT_CONFIG,
  bookingEnabled: true,
  pricesAcknowledged: true,
  scheduleAcknowledged: true,
  serviceZips: ["85326", "85374"],
  leadHours: 12,
};
export const contact = {
  name: "Booking Test", phone: "6235551234", email: "", address: "100 W Test St", city: "Buckeye",
  zip: "85326", notes: "Automated test only", smsConsent: false,
};

// Fixed coordinates so drive times are predictable (straight-line estimate).
export const PLACES = {
  "100 w test st": { lat: 33.4, lng: -112.58 }, // the customer, Buckeye
  "120 w test st": { lat: 33.401, lng: -112.581 }, // another customer next door
  "200 near rd": { lat: 33.41, lng: -112.57 }, // ~1 mile away
  "900 far ave": { lat: 33.64, lng: -112.36 }, // Surprise, ~21 miles
  "1 base way": { lat: 33.45, lng: -112.45 }, // the truck's base
  "50 edge blvd": { lat: 33.22, lng: -112.95 }, // far west Buckeye
  "4515 n 59th ave": { lat: 33.5, lng: -112.19 }, // Phoenix 85033: just outside the service area
  "123 e main st": { lat: 33.41, lng: -111.83 }, // Mesa 85201: not served
};

export function fakeGeo() {
  const lookups = [];
  return {
    provider: "estimate",
    lookups,
    async geocode(address) {
      lookups.push(address);
      const key = Object.keys(PLACES).find((k) => String(address).toLowerCase().includes(k));
      if (!key) return null;
      return { ...PLACES[key], formatted: address, state: "AZ", zip: (String(address).match(/\d{5}/) || [""])[0], precise: true };
    },
    async driveMinutes(pairs) {
      return pairs.map((p) => (p.from && p.to ? estimateDriveMinutes(p.from, p.to) : null));
    },
  };
}

export function fakeJobber({ connected = true } = {}) {
  const j = {
    appConfigured: true,
    isConnected: connected,
    visits: [],
    jobs: [],
    clients: [],
    failNext: null, // 'job' | 'visit'
    async connected() {
      return j.isConnected;
    },
    async readVisits(from, to) {
      if (!j.isConnected) throw new JobberNotConnected();
      return j.visits.filter((v) => v.start >= from && v.start < to).map((v) => ({ ...v }));
    },
    async listUsers() {
      return [{ id: "J-RYAN", name: "Ryan Boucher" }, { id: "J-ANDREW", name: "Andrew Sulanke" }];
    },
    async ensureClientAndProperty(c, a) {
      j.clients.push({ contact: c, address: a });
      return { clientId: `C${j.clients.length}`, propertyId: `P${j.clients.length}` };
    },
    async createScheduledJob(args) {
      if (j.failNext === "job") {
        j.failNext = null;
        throw new Error("Jobber jobCreate: boom");
      }
      if (j.failNext === "timeout") {
        j.failNext = null;
        const error = new Error("Jobber request failed: timeout");
        error.uncertain = true;
        throw error;
      }
      const n = j.jobs.length + 1;
      const job = { id: `JOB${n}`, jobNumber: 100 + n, jobberWebUri: `https://secure.getjobber.com/jobs/${n}` };
      if (j.failNext === "visit") {
        j.failNext = null;
        const error = new Error("Jobber visitCreate: boom");
        error.jobberJob = job;
        j.jobs.push({ ...args, job, visit: null });
        throw error;
      }
      const visit = { id: `VIS${n}`, startAt: new Date(args.start).toISOString(), endAt: new Date(args.end).toISOString() };
      j.jobs.push({ ...args, job, visit });
      const prop = j.clients.at(-1)?.address;
      j.visits.push({
        id: visit.id, title: args.title, start: args.start, end: args.end, allDay: false,
        jobberUserIds: args.jobberUserId ? [args.jobberUserId] : [],
        address: prop ? `${prop.street1}, ${prop.city}, AZ ${prop.zip}` : "",
      });
      return { job, visit };
    },
    authorizeUrl: (state) => `https://api.getjobber.com/api/oauth/authorize?state=${state}`,
    async exchangeCode() {
      j.isConnected = true;
    },
    async disconnect() {
      j.isConnected = false;
    },
  };
  return j;
}

export function fakeLc({ configured = true, failSms = false } = {}) {
  const lc = {
    configured,
    failSms,
    cfg: { bookedTags: ["bob-booked"], requestTags: ["bob-request"] },
    calls: [],
    async upsertContact(c) {
      lc.calls.push(["upsert", c]);
      return "LC1";
    },
    async sendSms(id, message) {
      if (lc.failSms) throw new Error("sms down");
      lc.calls.push(["sms", id, message]);
    },
    async sendEmail(id, email) {
      lc.calls.push(["email", id, email]);
    },
    async addNote(id, text) {
      lc.calls.push(["note", id, text]);
    },
  };
  return lc;
}

/** A made-up Twilio SID (prefix + 32 hex), built at run time so it never reads as a real credential. */
export const fakeSid = (prefix) => prefix + "0123456789abcdef".repeat(2);
export const TWILIO_ENV = {
  TWILIO_ACCOUNT_SID: fakeSid("AC"),
  TWILIO_AUTH_TOKEN: "test-auth-token",
  TWILIO_MESSAGING_SERVICE_SID: fakeSid("MG"),
  SENDGRID_API_KEY: "SG.test-key",
  SENDGRID_FROM_EMAIL: "bookings@example.com",
};

/**
 * The real Twilio module over a fake network: texts, Verify (the right code is 123456) and
 * SendGrid. Every request is kept in `calls` as { url, fields | json }.
 */
export function fakeTwilioNet() {
  const net = { calls: [], fail: null, n: 0 };
  net.fetchImpl = async (url, init) => {
    url = String(url);
    const fields = init.body instanceof URLSearchParams ? Object.fromEntries(init.body) : null;
    const json = fields ? null : JSON.parse(init.body || "{}");
    net.calls.push({ url, fields, json, headers: init.headers });
    const kind = url.includes("sendgrid") ? "email" : url.includes("VerificationCheck") ? "check" : url.includes("Verifications") ? "verify" : "sms";
    if (net.fail && (net.fail.kind === kind || net.fail.kind === "all")) {
      const { status = 400, code = 30034, message = "blocked" } = net.fail;
      return new Response(JSON.stringify(kind === "email" ? { errors: [{ message }] } : { code, message, status }), { status });
    }
    net.n++;
    if (kind === "email") return new Response(null, { status: 202, headers: { "X-Message-Id": `msg${net.n}` } });
    if (kind === "check") return new Response(JSON.stringify({ status: fields.Code === "123456" ? "approved" : "pending" }), { status: 200 });
    if (kind === "verify") return new Response(JSON.stringify({ sid: `VE${net.n}`, status: "pending" }), { status: 201 });
    return new Response(JSON.stringify({ sid: `SM${String(net.n).padStart(32, "0")}`, status: "queued" }), { status: 201 });
  };
  net.texts = () => net.calls.filter((c) => c.fields?.Body).map((c) => ({ to: c.fields.To, body: c.fields.Body, callback: c.fields.StatusCallback }));
  net.emails = () => net.calls.filter((c) => c.json?.personalizations).map((c) => ({ to: c.json.personalizations[0].to[0].email, subject: c.json.subject, text: c.json.content[0].value, replyTo: c.json.reply_to?.email }));
  return net;
}

/** Chat steps that reach the contact step for each kind of visit. */
export const FLOWS = {
  cleaning: (zip) => ["Dryer Vent Cleaning", zip, "Have Dryer", "No", "1-Story", "Electric", "Standard", "Dries in one normal cycle", "No signs", "Premium 1-2-3 · $179", "Accept & Continue"],
  assessment: (zip) => ["Repair / Reroute / Assessment", zip, "Disconnected Duct in Wall/Attic", "1-Story Home", "Electric Dryer", "Standard Floor Setup", "Working Normal", "The vent is disconnected behind the dryer", "Book Assessment"],
  bundle: (zip) => ["Dryer Vent Cleaning", "The vent also has damage.", "Include assessment", zip, "Have Dryer", "No", "1-Story", "Electric", "Standard", "Dries in one normal cycle", "No signs", "Select Premium 1-2-3 ⭐ ($238.50)", "Accept"],
  emergency: (zip) => ["Emergency Clog / Overheating", "No, it's turned off now", "Possible nest/blockage", zip, "1-Story Home", "Electric Dryer", "Emergency Same-Day · $349", "Accept"],
};

/** The Supabase REST adapter, talking to an in-process Postgres through public.bob_exec. */
export async function restDb(pglite) {
  await pglite.exec(RPC_SQL); // the bob schema is already in place
  const fetchImpl = async (url, init) => {
    assert.match(String(url), /\/rest\/v1\/rpc\/bob_exec$/);
    assert.equal(init.headers.apikey, "test-service-key");
    const { q } = JSON.parse(init.body);
    try {
      const [row] = await pglite.query("select public.bob_exec($1) as r", [q]);
      return new Response(JSON.stringify(row.r), { status: 200 });
    } catch (error) {
      return new Response(JSON.stringify({ message: error.message, code: error.code }), { status: 400 });
    }
  };
  const db = createSupabaseRpcDb({ url: "https://example.supabase.co", key: "test-service-key", fetchImpl });
  return { ...db, close: () => pglite.close() };
}

export async function harness(t, { ready = true, config = {}, jobber: jobberOpts = {}, lc: lcOpts = {}, twilio: twilioEnv = null, dataDir, assistant = null, rest = false, env: envOpts = {} } = {}) {
  let now = baseTime;
  const clock = () => now;
  const pg = await createPgliteDb(dataDir);
  const db = rest ? await restDb(pg) : pg;
  const store = createStore(db, { clock });
  await store.init();
  if (ready) await store.set("config", structuredClone({ ...approved, ...config }));
  const jobber = fakeJobber(jobberOpts);
  const lc = fakeLc(lcOpts);
  const geo = fakeGeo();
  const scheduler = createScheduler({ store, jobber, geo });
  const env = { BOB_SETUP_TOKEN: "test-only-setup-token", ...envOpts };
  const net = fakeTwilioNet();
  const twilio = twilioEnv ? createTwilio({ env: { ...TWILIO_ENV, ...twilioEnv }, fetchImpl: net.fetchImpl }) : undefined;
  const handle = createBobHandler({ store, jobber, lc, twilio, geo, scheduler, assistant, env, clock });
  const server = http.createServer((req, res) => handle(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await db.close().catch(() => {});
  });

  const call = async (path, { method = "GET", body, token, cookie, headers = {} } = {}) => {
    const r = await fetch(origin + path, {
      method,
      redirect: "manual",
      headers: {
        "Content-Type": "application/json", "X-BOB-Request": "1", Origin: origin,
        ...(token ? { "X-BOB-Session": token } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: r.status, data, cookie: r.headers.get("set-cookie")?.split(";")[0], headers: r.headers };
  };
  const fresh = async () => {
    const r = await call("/api/session", { method: "POST", body: {} });
    assert.equal(r.status, 201);
    return r.data.token;
  };
  const chat = async (token, message) => {
    const r = await call("/api/chat", { method: "POST", token, body: { message } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };
  /** Chat until the service is accepted (the contact step). */
  const accept = async (route = "cleaning", zip = contact.zip) => {
    const token = await fresh();
    let r;
    for (const m of FLOWS[route](zip)) r = await chat(token, m);
    assert.equal(r.action, "contact", `expected the contact step, got: ${r.reply}`);
    return token;
  };
  const lastCode = () => {
    if (net.calls.some((c) => c.url.includes("/Verifications"))) return "123456"; // Twilio Verify's code in the fake
    const texts = [...lc.calls.filter((c) => c[0] === "sms").map((c) => c[2]), ...net.texts().map((x) => x.body)];
    const sms = texts.filter((b) => /verification code is (\d{6})/.test(b)).at(-1);
    return sms ? sms.match(/verification code is (\d{6})/)[1] : null;
  };
  /** Contact details, then the text code, as the page does. */
  const contactAndVerify = async (token, who = contact) => {
    const r = await call("/api/contact", { method: "POST", token, body: who });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    if (r.data.verification?.sent) {
      const v = await call("/api/verify/check", { method: "POST", token, body: { code: lastCode() } });
      assert.equal(v.status, 200, JSON.stringify(v.data));
    }
    lc.calls.length = 0; // tests below look only at what happens after verification
    net.calls.length = 0;
    return r;
  };
  const prepare = async (route = "cleaning", who = contact) => {
    const token = await accept(route, who.zip);
    await contactAndVerify(token, who);
    return token;
  };
  const slots = async (token, query = "") => (await call(`/api/availability${query}`, { token })).data.slots;
  const hold = (token, scheduledAt) => call("/api/holds", { method: "POST", token, body: { scheduledAt } });
  const confirm = (token, h, extra = {}) =>
    call("/api/bookings", { method: "POST", token, body: { holdId: h.id, idempotencyKey: randomUUID(), approved: true, ...extra } });
  const book = async (route = "cleaning", who = contact) => {
    const token = await prepare(route, who);
    const held = await hold(token, (await slots(token))[0].scheduledAt);
    assert.equal(held.status, 201, JSON.stringify(held.data));
    return confirm(token, held.data.hold);
  };
  const login = async () => {
    let r = await call("/api/admin/setup", { method: "POST", body: { setupToken: "test-only-setup-token", password: "Test-only-strong-password-2026" } });
    assert.equal(r.status, 201);
    r = await call("/api/admin/login", { method: "POST", body: { password: "Test-only-strong-password-2026" } });
    assert.equal(r.status, 200);
    return r.cookie;
  };
  const count = async (table) => Number((await db.query(`select count(*)::int as n from bob.${table}`))[0].n);
  /** A Twilio webhook, signed the way Twilio signs it (or with `signature` to test a forgery). */
  const webhook = async (path, params, { signature } = {}) => {
    const { twilioSignature } = await import("../server/twilio.mjs");
    const body = new URLSearchParams(params);
    const r = await fetch(origin + path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Twilio-Signature": signature ?? twilioSignature(TWILIO_ENV.TWILIO_AUTH_TOKEN, origin + path, params) },
      body,
    });
    return { status: r.status, text: await r.text(), type: r.headers.get("content-type") };
  };
  return { db, store, jobber, lc, net, twilio, geo, origin, call, webhook, fresh, chat, accept, contactAndVerify, lastCode, prepare, slots, hold, confirm, book, login, count, now: () => now, advance: (ms) => (now += ms) };
}
