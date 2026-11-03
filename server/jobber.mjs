import { createHash, randomUUID } from "node:crypto";
// Jobber GraphQL integration for BOB the Booking Bot (Jobber app: "BOB the Booking Bot").
//
// - OAuth: tokens live in BOB's database. Refresh tokens ROTATE (each refresh returns a
//   new one that replaces the old), so refreshes are single-flight behind a DB lock.
// - Reading: visits in a date range with the job's property address + assignees.
// - Booking: find/create client -> find/create property -> jobCreate (no visits) ->
//   visitCreate with { date, time, timezone } local times. jobCreate cannot take a
//   visit time, which is why the visit is a second call.

const GRAPHQL_URL = "https://api.getjobber.com/api/graphql";
const AUTHORIZE_URL = "https://api.getjobber.com/api/oauth/authorize";
const TOKEN_URL = "https://api.getjobber.com/api/oauth/token";
const TOKENS = "jobber:tokens";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class JobberNotConnected extends Error {
  constructor() {
    super("Jobber is not connected.");
    this.code = "JOBBER_NOT_CONNECTED";
  }
}

/**
 * Where the OAuth tokens live. ChatDaddy keeps them in its own Supabase table
 * (public.chatdaddy_jobber_tokens, one row); without that table they go in BOB's kv.
 */
export function tokenStoreFor(store, table = "chatdaddy_jobber_tokens") {
  const kv = {
    load: async () => (await store.kvGet(TOKENS)) || null,
    save: (t) => store.kvSet(TOKENS, t),
    clear: () => store.kvDel(TOKENS),
  };
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) return kv;
  let useTable = null;
  const q = (text, params) => store.db.query(text, params);
  const hasTable = async () => {
    if (useTable === null) {
      try {
        useTable = Boolean((await q(`select to_regclass('public.${table}') as t`))[0]?.t);
      } catch {
        useTable = false;
      }
    }
    return useTable;
  };
  return {
    async load() {
      if (!(await hasTable())) return kv.load();
      const [row] = await q(`select access_token, refresh_token, expires_at, updated_at from public.${table} where id=1`);
      return row ? { accessToken: row.access_token, refreshToken: row.refresh_token, expiresAt: row.expires_at ? Date.parse(row.expires_at) : 0, savedAt: Date.parse(row.updated_at) } : null;
    },
    async save(t) {
      if (!(await hasTable())) return kv.save(t);
      await q(
        `insert into public.${table}(id,access_token,refresh_token,expires_at,updated_at) values(1,$1,$2,$3,now())
         on conflict (id) do update set access_token=excluded.access_token, refresh_token=excluded.refresh_token, expires_at=excluded.expires_at, updated_at=now()`,
        [t.accessToken, t.refreshToken, new Date(t.expiresAt).toISOString()],
      );
    },
    async clear() {
      if (!(await hasTable())) return kv.clear();
      await q(`delete from public.${table} where id=1`);
    },
  };
}

/** Discounts are negative lines in BOB's quote; Jobber gets them folded into the main service line. */
export function foldDiscounts(items) {
  const out = items.filter((i) => i.cents >= 0).map((i) => ({ ...i }));
  const discounts = items.filter((i) => i.cents < 0);
  if (!discounts.length || !out.length) return out.length ? out : items;
  const main = out[0];
  main.cents = Math.max(0, main.cents + discounts.reduce((n, d) => n + d.cents, 0));
  main.description = [main.description, ...discounts.map((d) => `Includes ${d.name}: -$${(-d.cents / 100).toFixed(2).replace(/\.00$/, "")}.`)].filter(Boolean).join(" ");
  return out;
}

export function createJobber({ store, env = process.env, fetchImpl = fetch, tokens: tokenStore = tokenStoreFor(store, env.JOBBER_TOKEN_TABLE || "chatdaddy_jobber_tokens") } = {}) {
  const cfg = {
    clientId: env.JOBBER_CLIENT_ID || "",
    clientSecret: env.JOBBER_CLIENT_SECRET || "",
    redirectUri: env.JOBBER_REDIRECT_URI || "",
    version: env.JOBBER_GRAPHQL_VERSION || "2025-04-16",
    timezone: "America/Phoenix",
  };
  const appConfigured = Boolean(cfg.clientId && cfg.clientSecret && cfg.redirectUri);

  // ---- OAuth ------------------------------------------------------------------
  const authorizeUrl = (state) =>
    `${AUTHORIZE_URL}?${new URLSearchParams({ response_type: "code", client_id: cfg.clientId, redirect_uri: cfg.redirectUri, state })}`;

  function jwtExpiry(token) {
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
      return typeof payload.exp === "number" ? payload.exp * 1000 : null;
    } catch {
      return null;
    }
  }

  async function postToken(body) {
    const response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...body }),
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || !json.access_token) {
      throw new Error(`Jobber token request failed (${response.status}) ${json.error_description || json.error || ""}`.trim());
    }
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token || body.refresh_token,
      expiresAt: jwtExpiry(json.access_token) || Date.now() + Number(json.expires_in || 3300) * 1000,
      savedAt: Date.now(),
    };
  }

  async function exchangeCode(code) {
    const tokens = await postToken({ grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri });
    await store.kvSet("client-hub:connection-epoch", randomUUID());
    await tokenStore.save(tokens);
    return tokens;
  }

  const loadTokens = () => tokenStore.load();
  const connected = async () => appConfigured && Boolean((await loadTokens())?.refreshToken);
  const disconnect = async () => {
    await store.kvSet("client-hub:connection-epoch", randomUUID());
    await tokenStore.clear();
  };

  async function refresh(current) {
    for (let attempt = 0; attempt < 10; attempt++) {
      if (await store.lock("jobber-refresh", 20)) {
        try {
          const latest = (await loadTokens()) || current;
          if (latest.accessToken !== current.accessToken && latest.expiresAt - 120_000 > Date.now()) return latest;
          const tokens = await postToken({ grant_type: "refresh_token", refresh_token: latest.refreshToken });
          await tokenStore.save(tokens);
          return tokens;
        } finally {
          await store.unlock("jobber-refresh");
        }
      }
      await sleep(600);
      const latest = await loadTokens();
      if (latest?.accessToken && latest.expiresAt - 120_000 > Date.now()) return latest;
    }
    throw new Error("Timed out waiting for a Jobber token refresh.");
  }

  async function accessToken(force = false) {
    const tokens = await loadTokens();
    if (!appConfigured || !tokens?.refreshToken) throw new JobberNotConnected();
    if (!force && tokens.accessToken && tokens.expiresAt - 120_000 > Date.now()) return tokens.accessToken;
    return (await refresh(tokens)).accessToken;
  }

  // ---- GraphQL --------------------------------------------------------------------
  // A mutation whose result we never saw may still have happened in Jobber. Those errors
  // are marked `uncertain` so the booking is held for the office instead of retried blind.
  async function gql(query, variables = {}) {
    const mutation = /^\s*mutation\b/.test(query);
    const unsure = (error) => {
      if (mutation) error.uncertain = true;
      return error;
    };
    let token = await accessToken();
    for (let attempt = 1; attempt <= 4; attempt++) {
      let response;
      try {
        response = await fetchImpl(GRAPHQL_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-JOBBER-GRAPHQL-VERSION": cfg.version,
          },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        throw unsure(new Error(`Jobber request failed: ${error.message}`));
      }
      if (response.status === 401 && attempt === 1) {
        token = await accessToken(true);
        continue;
      }
      const json = await response.json().catch(() => null);
      if (json === null) {
        const error = new Error(`Jobber HTTP ${response.status} (unreadable response)`);
        throw response.ok || response.status >= 500 ? unsure(error) : error;
      }
      // A partial mutation response may already have written data. Never replay it.
      if (mutation && json.data && json.errors?.length) {
        const partial = unsure(new Error("Jobber mutation returned a partial result; office review is required."));
        if (json.data.jobCreate?.job?.id) partial.jobberJob = json.data.jobCreate.job;
        if (json.data.visitCreate?.createdVisits?.[0]?.id) partial.jobberVisit = json.data.visitCreate.createdVisits[0];
        throw partial;
      }
      const throttled = response.status === 429 || (json.errors || []).some((e) => /throttl/i.test(e.message || ""));
      if (throttled && attempt < 4) {
        const t = json.extensions?.cost?.throttleStatus;
        const need = json.extensions?.cost?.requestedQueryCost || 1000;
        await sleep(t ? Math.min(6000, Math.max(500, ((need - t.currentlyAvailable) / t.restoreRate) * 1000)) : 1500);
        continue;
      }
      if (!response.ok) {
        const error = new Error(`Jobber HTTP ${response.status}`);
        throw response.status >= 500 ? unsure(error) : error;
      }
      if (json.errors?.length) throw unsure(new Error(`Jobber: ${json.errors[0].message}`));
      if (mutation && (!json.data || typeof json.data !== "object")) throw unsure(new Error("Jobber mutation returned no readable data; office review is required."));
      return json.data;
    }
    throw new Error("Jobber is busy right now (rate limited).");
  }

  const userErrors = (payload, op) => {
    const errors = (payload?.userErrors || []).map((e) => e.message).filter(Boolean);
    if (errors.length) {
      const error = new Error(`Jobber ${op}: ${errors.join("; ")}`);
      if (payload?.job?.id || payload?.client?.id || payload?.properties?.some(p => p?.id) || payload?.createdVisits?.some(v => v?.id)) {
        error.uncertain = true;
        if (payload.job?.id) error.jobberJob = payload.job;
        if (payload.client?.id) error.jobberClientId = payload.client.id;
        if (payload.createdVisits?.[0]?.id) error.jobberVisit = payload.createdVisits[0];
      }
      throw error;
    }
  };

  // ---- Reading ---------------------------------------------------------------------
  const addressLine = (a) =>
    a ? [a.street1, a.street2, a.city, [a.province, a.postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ") : "";

  const VISITS = `
    query BobVisits($after: ISO8601DateTime!, $before: ISO8601DateTime!, $cursor: String) {
      visits(first: 50, after: $cursor, filter: { startAt: { after: $after, before: $before } }) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id title startAt endAt allDay
          assignedUsers(first: 5) { nodes { id } pageInfo { hasNextPage } }
          job { id jobNumber property { address { street1 street2 city province postalCode } } }
        }
      }
    }`;

  /** Visits starting in [from, to). Cached 60s unless fresh. */
  async function readVisits(from, to, { fresh = false } = {}) {
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error("A valid Jobber visit lookup interval is required.");
    const binding = await accountIdentityRevision();
    if (!appConfigured || !binding) throw new JobberNotConnected();
    // Exact ranges and the OAuth binding prevent reusing another window/account.
    const key = `jobber:visits:v2:${binding}:${cfg.version}:${from}:${to}`;
    if (!fresh) {
      const cached = await store.kvGet(key);
      if (cached) return cached;
    }
    const visits = [];
    let cursor = null, complete = false;
    for (let page = 0; page < 15; page++) {
      const data = await gql(VISITS, { after: new Date(from).toISOString(), before: new Date(to).toISOString(), cursor });
      if (!Array.isArray(data?.visits?.nodes) || typeof data.visits.pageInfo?.hasNextPage !== "boolean") throw new Error("Jobber occupancy could not be fully verified.");
      for (const n of data.visits.nodes) {
        if (typeof n?.id !== "string" || !n.id.trim()) throw new Error("Jobber returned an invalid visit ID. Office review is required.");
        const start = Date.parse(n.startAt);
        const end = n.endAt ? Date.parse(n.endAt) : n.allDay ? start + 86_400_000 : NaN;
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("Jobber returned an invalid visit time range. Office review is required.");
        if (!Array.isArray(n.assignedUsers?.nodes) || typeof n.assignedUsers.pageInfo?.hasNextPage !== "boolean" || n.assignedUsers.pageInfo.hasNextPage) throw new Error("Jobber visit assignment list is incomplete. Office review is required.");
        if (n.assignedUsers.nodes.some(u => typeof u?.id !== "string" || !u.id)) throw new Error("Jobber visit assignment could not be verified.");
        visits.push({
          id: n.id,
          title: n.title || "",
          start,
          end,
          allDay: Boolean(n.allDay),
          jobberUserIds: (n.assignedUsers?.nodes || []).map((u) => u.id),
          jobNumber: n.job?.jobNumber ?? null,
          address: addressLine(n.job?.property?.address),
        });
      }
      if (!data.visits.pageInfo.hasNextPage) { complete = true; break; }
      const next = data.visits.pageInfo.endCursor;
      if (!next || next === cursor) throw new Error("Jobber occupancy pagination could not be completed.");
      cursor = next;
    }
    if (!complete) throw new Error("Jobber occupancy exceeds the verification limit. Office review is required.");
    // A refresh during pagination changes the binding conservatively. Do not
    // populate a cache under stale credentials, even though these fresh rows are usable.
    if (await accountIdentityRevision() === binding) await store.kvSet(key, visits, 60);
    return visits;
  }

  // ---- Tracking: visit status, job values and invoices (read-only) -------------------------------
  // Field names are checked against the connected account's schema first (introspection, cached a
  // day), so a field Jobber doesn't have is left out instead of failing the whole read. Without
  // introspection, only fields known to exist are used: visitStatus, isComplete, jobStatus, and the
  // invoice's invoiceNumber, invoiceStatus, issuedDate, amounts.total and jobs.
  async function schemaFields() {
    const key = `jobber:schema:v1:${cfg.version}`;
    const cached = await store.kvGet(key);
    if (cached) return cached.ok ? cached : null;
    try {
      const data = await gql(`query BobSchema {
        visit: __type(name: "Visit") { fields { name } }
        job: __type(name: "Job") { fields { name } }
        invoice: __type(name: "Invoice") { fields { name } }
        invoiceFilter: __type(name: "InvoiceFilterAttributes") { inputFields { name } }
      }`);
      const names = (t, list = "fields") => (data?.[t]?.[list] || []).map((f) => f?.name).filter(Boolean);
      const out = { ok: Boolean(data?.visit), visit: names("visit"), job: names("job"), invoice: names("invoice"), invoiceFilter: names("invoiceFilter", "inputFields") };
      await store.kvSet(key, out, 86_400);
      return out.ok ? out : null;
    } catch {
      await store.kvSet(key, { ok: false }, 3_600);
      return null;
    }
  }
  const has = (schema, type, field, known = false) => (schema ? schema[type]?.includes(field) : known);

  /** Every visit starting in [from, to) with its status and its job's status (and total when available). */
  async function readVisitStatuses(from, to) {
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error("A valid Jobber visit lookup interval is required.");
    if (!appConfigured || !(await accountIdentityRevision())) throw new JobberNotConnected();
    const schema = await schemaFields();
    const visitFields = ["id", "startAt", "endAt", "allDay", has(schema, "visit", "visitStatus", true) && "visitStatus", has(schema, "visit", "isComplete", true) && "isComplete"].filter(Boolean).join(" ");
    const jobFields = ["id", "jobNumber", has(schema, "job", "jobStatus", true) && "jobStatus", has(schema, "job", "total") && "total"].filter(Boolean).join(" ");
    const query = `query BobVisitStatus($after: ISO8601DateTime!, $before: ISO8601DateTime!, $cursor: String) {
      visits(first: 50, after: $cursor, filter: { startAt: { after: $after, before: $before } }) {
        pageInfo { hasNextPage endCursor }
        nodes { ${visitFields} job { ${jobFields} } }
      }
    }`;
    const out = [];
    let cursor = null;
    for (let page = 0; page < 30; page++) {
      const data = await gql(query, { after: new Date(from).toISOString(), before: new Date(to).toISOString(), cursor });
      if (!Array.isArray(data?.visits?.nodes) || typeof data.visits.pageInfo?.hasNextPage !== "boolean") throw new Error("Jobber visits could not be read.");
      for (const n of data.visits.nodes) {
        const start = Date.parse(n?.startAt);
        if (typeof n?.id !== "string" || !Number.isFinite(start)) continue;
        const end = n.endAt ? Date.parse(n.endAt) : start;
        const total = Number(n.job?.total);
        out.push({
          id: n.id, start, end: Number.isFinite(end) ? end : start, allDay: Boolean(n.allDay),
          status: typeof n.visitStatus === "string" ? n.visitStatus.toUpperCase() : null, complete: n.isComplete === true,
          jobId: n.job?.id || null, jobNumber: n.job?.jobNumber ?? null, jobStatus: typeof n.job?.jobStatus === "string" ? n.job.jobStatus.toLowerCase() : null,
          jobTotalCents: Number.isFinite(total) ? Math.round(total * 100) : null,
        });
      }
      if (!data.visits.pageInfo.hasNextPage) return { visits: out, complete: true };
      const next = data.visits.pageInfo.endCursor;
      if (!next || next === cursor) break;
      cursor = next;
    }
    return { visits: out, complete: false };
  }

  /** Invoices issued in [from, to): number, status, issued date, total and the job they bill. */
  async function readInvoices(from, to) {
    if (!appConfigured || !(await accountIdentityRevision())) throw new JobberNotConnected();
    const schema = await schemaFields();
    const fields = "id invoiceNumber invoiceStatus issuedDate amounts { total } jobs(first: 1) { nodes { id jobNumber } }";
    const filtered = has(schema, "invoiceFilter", "issuedDate");
    const query = filtered
      ? `query BobInvoices($cursor: String, $after: ISO8601DateTime!, $before: ISO8601DateTime!) { invoices(first: 50, after: $cursor, filter: { issuedDate: { after: $after, before: $before } }) { pageInfo { hasNextPage endCursor } nodes { ${fields} } } }`
      : `query BobInvoices($cursor: String) { invoices(first: 50, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { ${fields} } } }`;
    const out = [];
    let cursor = null;
    for (let page = 0; page < (filtered ? 20 : 40); page++) {
      const data = await gql(query, { cursor, ...(filtered ? { after: new Date(from).toISOString(), before: new Date(to).toISOString() } : {}) });
      if (!Array.isArray(data?.invoices?.nodes) || typeof data.invoices.pageInfo?.hasNextPage !== "boolean") throw new Error("Jobber invoices could not be read.");
      for (const n of data.invoices.nodes) {
        const issued = n?.issuedDate ? Date.parse(String(n.issuedDate).length === 10 ? `${n.issuedDate}T12:00:00-07:00` : n.issuedDate) : NaN;
        if (typeof n?.id !== "string" || !Number.isFinite(issued) || issued < from || issued >= to) continue;
        const total = Number(n.amounts?.total);
        const job = n.jobs?.nodes?.[0] || null;
        out.push({ id: n.id, number: String(n.invoiceNumber ?? ""), status: String(n.invoiceStatus || "").toLowerCase(), issuedAt: issued, totalCents: Number.isFinite(total) ? Math.round(total * 100) : 0, jobId: job?.id || null, jobNumber: job?.jobNumber ?? null });
      }
      if (!data.invoices.pageInfo.hasNextPage) return { invoices: out, complete: true };
      const next = data.invoices.pageInfo.endCursor;
      if (!next || next === cursor) break;
      cursor = next;
    }
    return { invoices: out, complete: false };
  }

  async function listUsers() {
    const users = [];
    let cursor = null;
    for (let page = 0; page < 20; page++) {
      const data = await gql(`query BobUsers($cursor: String) { users(first: 50, after: $cursor) { nodes { id name { full } email { raw } } pageInfo { hasNextPage endCursor } } }`, { cursor });
      if (!Array.isArray(data?.users?.nodes)) throw new Error("Jobber users could not be verified.");
      users.push(...data.users.nodes.map((u) => ({ id: u.id, name: u.name?.full || u.email?.raw || u.id })));
      if (!data.users.pageInfo?.hasNextPage) return users;
      const next = data.users.pageInfo.endCursor;
      if (!next || next === cursor) throw new Error("Jobber users could not be fully verified.");
      cursor = next;
    }
    throw new Error("Jobber users exceed the verification limit. Ask the office to review the connection.");
  }

  /** Validate account membership before ANY booking mutation. Do not infer a user
   * from the local technician name or default to the account owner. */
  async function verifyAssignment(jobberUserId) {
    if (typeof jobberUserId !== "string" || !jobberUserId.trim() || jobberUserId.length > 200) {
      throw Object.assign(new Error("Link the active technician to a Jobber user before booking."), { code: "JOBBER_ASSIGNMENT_REQUIRED" });
    }
    const user = (await listUsers()).find((candidate) => candidate.id === jobberUserId);
    if (!user) throw Object.assign(new Error("The selected technician is not a verified user of the connected Jobber account."), { code: "JOBBER_ASSIGNMENT_INVALID" });
    return user;
  }

  /** Explicit read-only identity lookup. A configured OAuth client is not evidence
   * of the connected business. Documented account fields require no special scope:
   * https://developer.getjobber.com/docs/getting_started/ */
  // Server-only cache binding. Never include this fingerprint in public identity.
  async function accountIdentityRevision() {
    const tokens = await loadTokens();
    if (!tokens?.refreshToken) return null;
    return createHash("sha256").update(JSON.stringify([cfg.clientId, tokens.refreshToken, tokens.savedAt || null])).digest("hex");
  }

  async function accountIdentity() {
    const data = await gql(`query BobAccountIdentity { account { id name } }`);
    if (typeof data?.account?.id !== "string" || !data.account.id || typeof data.account.name !== "string" || !data.account.name.trim()) {
      throw new Error("The connected Jobber account identity could not be verified.");
    }
    return { id: data.account.id, name: data.account.name, verified: true, checkedAt: Date.now() };
  }

  // ---- Booking ---------------------------------------------------------------------
  const digits = (s) => String(s || "").replace(/\D/g, "");
  const sameStreet = (a, b) => String(a || "").toLowerCase().replace(/[^a-z0-9]/g, "") === String(b || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  const CLIENT_SEARCH = `
    query BobClientSearch($term: String!) {
      clients(searchTerm: $term, first: 10) {
        nodes { id emails { address } phones { number } properties { id address { street1 postalCode } } }
      }
    }`;

  async function findClient({ email, phone }) {
    for (const term of [email, digits(phone).slice(-10)].filter(Boolean)) {
      const data = await gql(CLIENT_SEARCH, { term });
      const match = data.clients.nodes.find(
        (c) =>
          (email && c.emails.some((e) => e.address.toLowerCase() === email.toLowerCase())) ||
          (phone && c.phones.some((p) => digits(p.number).slice(-10) === digits(phone).slice(-10))),
      );
      if (match) return match;
    }
    return null;
  }

  /** contact: { firstName, lastName, email, phone, smsConsent }, address: { street1, city, zip } */
  async function ensureClientAndProperty(contact, address) {
    const addr = { street1: address.street1, city: address.city, province: "AZ", postalCode: address.zip, country: "US" };
    const existing = await findClient(contact);
    if (existing) {
      const property = existing.properties.find(
        (p) => sameStreet(p.address?.street1, addr.street1) && digits(p.address?.postalCode).slice(0, 5) === addr.postalCode,
      );
      if (property) return { clientId: existing.id, propertyId: property.id, newClient: false };
      const data = await gql(
        `mutation BobPropertyCreate($clientId: EncodedId!, $input: PropertyCreateInput!) {
          propertyCreate(clientId: $clientId, input: $input) { properties { id } userErrors { message path } }
        }`,
        { clientId: existing.id, input: { properties: [{ address: addr }] } },
      );
      userErrors(data?.propertyCreate, "propertyCreate");
      const propertyId = data?.propertyCreate?.properties?.[0]?.id;
      if (!propertyId) throw Object.assign(new Error("Jobber property creation could not be verified. Office review is required."), { uncertain: true, jobberClientId: existing.id });
      return { clientId: existing.id, propertyId, newClient: false };
    }
    const input = {
      firstName: contact.firstName,
      lastName: contact.lastName || "-",
      // ChatDaddy's selected transports send confirmations; Jobber client reminders stay off by default.
      receivesReminders: env.JOBBER_CLIENT_REMINDERS === "true",
      properties: [{ address: addr }],
    };
    if (contact.email) input.emails = [{ description: "MAIN", primary: true, address: contact.email }];
    if (contact.phone) input.phones = [{ description: "MOBILE", primary: true, number: contact.phone, smsAllowed: Boolean(contact.smsConsent) }];
    const data = await gql(
      `mutation BobClientCreate($input: ClientCreateInput!) {
        clientCreate(input: $input) { client { id properties { id } } userErrors { message path } }
      }`,
      { input },
    );
    userErrors(data?.clientCreate, "clientCreate");
    const clientId = data?.clientCreate?.client?.id, propertyId = data?.clientCreate?.client?.properties?.[0]?.id;
    if (!clientId || !propertyId) throw Object.assign(new Error("Jobber client/property creation could not be verified. Office review is required."), { uncertain: true, ...(clientId ? { jobberClientId: clientId } : {}) });
    return { clientId, propertyId, newClient: true };
  }

  const local = (ms) => {
    const f = new Intl.DateTimeFormat("en-CA", { timeZone: cfg.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === "24" ? "00" : p.hour}:${p.minute}:${p.second}`, timezone: cfg.timezone };
  };

  /** Read-only verification for creation and office reconciliation. Never accepts
   * a job number as proof of a correctly scheduled and assigned visit. */
  async function verifyScheduledVisit({ visitId, jobNumber, start, end, jobberUserId }) {
    const hasId = typeof visitId === "string" && Boolean(visitId.trim());
    const number = String(jobNumber ?? "").trim();
    const hasNumber = jobNumber != null && number !== "";
    if ((hasNumber && !/^\d{1,10}$/.test(number)) || (hasId && visitId === "confirmed-by-office") || (!hasId && !/^\d{1,10}$/.test(number)) || typeof jobberUserId !== "string" || !jobberUserId.trim() || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw Object.assign(new Error("A Jobber visit ID or job number, assigned technician and expected time are required for verification."), { code: "JOBBER_VISIT_UNVERIFIED" });
    }
    const visits = await readVisits(start - 60_000, end + 60_000, { fresh: true });
    const exact = v => v.start === start && v.end === end && !v.allDay && v.jobberUserIds.length === 1 && v.jobberUserIds[0] === jobberUserId;
    // A job number is only a search hint, never proof: require one exact matching
    // visit in the connected account and return its actual ID for reconciliation.
    const matches = visits.filter(v => (hasId ? v.id === visitId && (!hasNumber || String(v.jobNumber) === number) : String(v.jobNumber) === number) && exact(v));
    if (matches.length !== 1) {
      throw Object.assign(new Error("One uniquely matching Jobber visit with the expected time and technician could not be confirmed."), { code: "JOBBER_VISIT_UNVERIFIED" });
    }
    const readback = matches[0];
    return { id: readback.id, ...(readback.jobNumber != null ? { jobNumber: readback.jobNumber } : {}), startAt: new Date(readback.start).toISOString(), endAt: new Date(readback.end).toISOString(), assignedUserIds: readback.jobberUserIds, assignmentVerified: true };
  }

  /** Creates the job (no visits) and then its one scheduled visit. */
  async function createScheduledJob({ propertyId, title, instructions, lineItems, start, end, jobberUserId }) {
    await verifyAssignment(jobberUserId);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("A valid scheduled visit interval is required.");
    const created = await gql(
      `mutation BobJobCreate($input: JobCreateAttributes!) {
        jobCreate(input: $input) { job { id jobNumber jobberWebUri } userErrors { message path } }
      }`,
      {
        input: {
          propertyId,
          title,
          instructions: instructions || undefined,
          scheduling: { createVisits: false, notifyTeam: false },
          invoicing: { invoicingType: "FIXED_PRICE", invoicingSchedule: "ON_COMPLETION" },
          lineItems: foldDiscounts(lineItems).map((i) => ({
            name: i.name,
            description: i.description || undefined,
            quantity: 1,
            unitPrice: i.cents / 100,
            saveToProductsAndServices: false,
          })),
        },
      },
    );
    userErrors(created?.jobCreate, "jobCreate");
    const job = created?.jobCreate?.job;
    if (!job?.id) throw Object.assign(new Error("Jobber did not return the created job. Office review is required."), { uncertain: true, code: "JOBBER_JOB_UNVERIFIED" });
    const schedule = { startAt: local(start), endAt: local(end), notifyTeam: env.JOBBER_NOTIFY_TEAM !== "false" };
    schedule.teamMemberIdsToAssign = [jobberUserId];
    let createdVisit = null;
    try {
      const visitData = await gql(
        `mutation BobVisitCreate($jobId: EncodedId!, $input: VisitCreateInput!) {
          visitCreate(jobId: $jobId, input: $input) { createdVisits { id startAt endAt } userErrors { message path } }
        }`,
        { jobId: job.id, input: { visits: [{ title, instructions: instructions || undefined, schedule }] } },
      );
      userErrors(visitData?.visitCreate, "visitCreate");
      createdVisit = visitData?.visitCreate?.createdVisits?.[0] || null;
      if (!createdVisit?.id || visitData.visitCreate.createdVisits.length !== 1) throw new Error("Jobber did not return exactly one created visit.");
      // Read from the existing documented Visits connection, not a guessed root
      // lookup. fresh:true bypasses any availability cache from before creation.
      const verified = await verifyScheduledVisit({ visitId: createdVisit.id, start, end, jobberUserId });
      return { job, visit: { ...createdVisit, ...verified } };
    } catch (error) {
      createdVisit ||= error.jobberVisit || null;
      error.jobberJob = job; // Preserve known IDs; never re-create a job after a failed readback.
      if (createdVisit) {
        error.jobberVisit = createdVisit;
        error.uncertain = true;
        error.code = "JOBBER_VISIT_UNVERIFIED";
      } else if (!error.code && !error.message.startsWith("Jobber visitCreate:")) {
        error.uncertain = true;
        error.code = "JOBBER_VISIT_UNVERIFIED";
      }
      throw error;
    }
  }

  return {
    appConfigured,
    authorizeUrl,
    exchangeCode,
    connected,
    disconnect,
    gql,
    readVisits,
    readVisitStatuses,
    readInvoices,
    listUsers,
    verifyAssignment,
    verifyScheduledVisit,
    accountIdentity,
    accountIdentityRevision,
    ensureClientAndProperty,
    createScheduledJob,
  };
}
