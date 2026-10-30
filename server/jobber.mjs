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
    await tokenStore.save(tokens);
    return tokens;
  }

  const loadTokens = () => tokenStore.load();
  const connected = async () => appConfigured && Boolean((await loadTokens())?.refreshToken);
  const disconnect = () => tokenStore.clear();

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
      if (json.errors?.length) throw new Error(`Jobber: ${json.errors[0].message}`);
      return json.data;
    }
    throw new Error("Jobber is busy right now (rate limited).");
  }

  const userErrors = (payload, op) => {
    const errors = (payload?.userErrors || []).map((e) => e.message).filter(Boolean);
    if (errors.length) throw new Error(`Jobber ${op}: ${errors.join("; ")}`);
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
          assignedUsers(first: 5) { nodes { id } }
          job { id property { address { street1 street2 city province postalCode } } }
        }
      }
    }`;

  /** Visits starting in [from, to). Cached 60s unless fresh. */
  async function readVisits(from, to, { fresh = false } = {}) {
    const key = `jobber:visits:${Math.floor(from / 3_600_000)}:${Math.floor(to / 86_400_000)}`;
    if (!fresh) {
      const cached = await store.kvGet(key);
      if (cached) return cached;
    }
    const visits = [];
    let cursor = null;
    for (let page = 0; page < 15; page++) {
      const data = await gql(VISITS, { after: new Date(from).toISOString(), before: new Date(to).toISOString(), cursor });
      for (const n of data.visits.nodes) {
        const start = Date.parse(n.startAt);
        if (!Number.isFinite(start)) continue;
        visits.push({
          id: n.id,
          title: n.title || "",
          start,
          end: n.endAt ? Date.parse(n.endAt) : start + 90 * 60_000,
          allDay: Boolean(n.allDay),
          jobberUserIds: (n.assignedUsers?.nodes || []).map((u) => u.id),
          address: addressLine(n.job?.property?.address),
        });
      }
      if (!data.visits.pageInfo.hasNextPage) break;
      cursor = data.visits.pageInfo.endCursor;
    }
    await store.kvSet(key, visits, 60);
    return visits;
  }

  async function listUsers() {
    const data = await gql(`query BobUsers { users(first: 50) { nodes { id name { full } email { raw } } } }`);
    return data.users.nodes.map((u) => ({ id: u.id, name: u.name?.full || u.email?.raw || u.id }));
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
      userErrors(data.propertyCreate, "propertyCreate");
      return { clientId: existing.id, propertyId: data.propertyCreate.properties[0].id, newClient: false };
    }
    const input = {
      firstName: contact.firstName,
      lastName: contact.lastName || "-",
      // LeadConnector sends the confirmations, so Jobber's client reminders stay off by default.
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
    userErrors(data.clientCreate, "clientCreate");
    return { clientId: data.clientCreate.client.id, propertyId: data.clientCreate.client.properties[0].id, newClient: true };
  }

  const local = (ms) => {
    const f = new Intl.DateTimeFormat("en-CA", { timeZone: cfg.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === "24" ? "00" : p.hour}:${p.minute}:${p.second}`, timezone: cfg.timezone };
  };

  /** Creates the job (no visits) and then its one scheduled visit. */
  async function createScheduledJob({ propertyId, title, instructions, lineItems, start, end, jobberUserId }) {
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
          lineItems: lineItems.map((i) => ({
            name: i.name,
            description: i.description || undefined,
            quantity: 1,
            unitPrice: i.cents / 100,
            saveToProductsAndServices: false,
          })),
        },
      },
    );
    userErrors(created.jobCreate, "jobCreate");
    const job = created.jobCreate.job;
    const schedule = { startAt: local(start), endAt: local(end), notifyTeam: env.JOBBER_NOTIFY_TEAM !== "false" };
    if (jobberUserId) schedule.teamMemberIdsToAssign = [jobberUserId];
    try {
      const visitData = await gql(
        `mutation BobVisitCreate($jobId: EncodedId!, $input: VisitCreateInput!) {
          visitCreate(jobId: $jobId, input: $input) { createdVisits { id startAt endAt } userErrors { message path } }
        }`,
        { jobId: job.id, input: { visits: [{ title, instructions: instructions || undefined, schedule }] } },
      );
      userErrors(visitData.visitCreate, "visitCreate");
      return { job, visit: visitData.visitCreate.createdVisits?.[0] || null };
    } catch (error) {
      error.jobberJob = job; // job exists without a visit — surfaced to the office
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
    listUsers,
    ensureClientAndProperty,
    createScheduledJob,
  };
}
