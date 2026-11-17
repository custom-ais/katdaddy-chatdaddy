import { createHash, randomUUID } from "node:crypto";
import { note, oncePerRequest, forgetPerRequest } from "./timing.mjs";
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
// Time BOB spends waiting on Jobber (rate limits, another instance's token refresh) shows in timing.
const wait = (ms) => { note("jobber_wait", ms); return sleep(ms); };
const USERS_CACHE_MS = 5 * 60_000;

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
    forgetPerRequest("jobber:tokens");
    return tokens;
  }

  // Read once per request (each Jobber call used to read it again); refreshes and saves forget it.
  const loadTokens = () => oncePerRequest("jobber:tokens", () => tokenStore.load());
  const connected = async () => appConfigured && Boolean((await loadTokens())?.refreshToken);
  const disconnect = async () => {
    await store.kvSet("client-hub:connection-epoch", randomUUID());
    await tokenStore.clear();
    forgetPerRequest("jobber:tokens");
    usersCache = null;
  };

  // Calls that find the token expiring at the same moment (a calendar read and a request read run
  // side by side) share one renewal. They used to queue on the lock, each waiting 600 ms. The lock
  // still covers two separate server instances renewing at once.
  let renewing = null;
  async function refresh(current) {
    if (!renewing) renewing = renewOnce(current).finally(() => { renewing = null; });
    const tokens = await renewing;
    forgetPerRequest("jobber:tokens"); // this request reads the new token next time
    return tokens;
  }

  async function renewOnce(current) {
    for (let attempt = 0; attempt < 10; attempt++) {
      if (await store.lock("jobber-refresh", 20)) {
        try {
          forgetPerRequest("jobber:tokens");
          const latest = (await loadTokens()) || current;
          if (latest.accessToken !== current.accessToken && latest.expiresAt - 120_000 > Date.now()) return latest;
          const tokens = await postToken({ grant_type: "refresh_token", refresh_token: latest.refreshToken });
          await tokenStore.save(tokens);
          forgetPerRequest("jobber:tokens");
          return tokens;
        } finally {
          await store.unlock("jobber-refresh");
        }
      }
      await wait(600);
      forgetPerRequest("jobber:tokens");
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
        await wait(t ? Math.min(6000, Math.max(500, ((need - t.currentlyAvailable) / t.restoreRate) * 1000)) : 1500);
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

  // Assessments scheduled on Jobber requests (BidBee's request bookings, the office's own
  // assessments) share the calendar with visits but are not in the visits connection.
  // This is the request/assessment shape BidBee already reads from the same account.
  // Requests have no date filter here, so the whole list is read and shared for 60s.
  const ASSESSMENTS = `
    query BobAssessments($cursor: String) {
      requests(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          assessment {
            id title startAt endAt allDay
            assignedUsers(first: 5) { nodes { id } pageInfo { hasNextPage } }
            property { address { street1 street2 city province postalCode } }
          }
        }
      }
    }`;

  /** Scheduled request assessments starting in [from, to), shaped like readVisits rows. */
  async function readAssessments(from, to, { fresh = false } = {}) {
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error("A valid Jobber assessment lookup interval is required.");
    const binding = await accountIdentityRevision();
    if (!appConfigured || !binding) throw new JobberNotConnected();
    const key = `jobber:assessments:v1:${binding}:${cfg.version}`;
    let all = fresh ? null : await store.kvGet(key);
    if (!all) {
      all = [];
      let cursor = null, complete = false;
      for (let page = 0; page < 40; page++) {
        const data = await gql(ASSESSMENTS, { cursor });
        if (!Array.isArray(data?.requests?.nodes) || typeof data.requests.pageInfo?.hasNextPage !== "boolean") throw new Error("Jobber assessments could not be fully verified.");
        for (const r of data.requests.nodes) {
          const a = r?.assessment;
          if (!a || a.startAt == null) continue; // no assessment, or not scheduled yet
          if (typeof a.id !== "string" || !a.id.trim()) throw new Error("Jobber returned an invalid assessment ID. Office review is required.");
          const start = Date.parse(a.startAt);
          const end = a.endAt ? Date.parse(a.endAt) : a.allDay ? start + 86_400_000 : start + 3_600_000;
          if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("Jobber returned an invalid assessment time range. Office review is required.");
          if (!Array.isArray(a.assignedUsers?.nodes) || typeof a.assignedUsers.pageInfo?.hasNextPage !== "boolean" || a.assignedUsers.pageInfo.hasNextPage) throw new Error("Jobber assessment assignment list is incomplete. Office review is required.");
          if (a.assignedUsers.nodes.some(u => typeof u?.id !== "string" || !u.id)) throw new Error("Jobber assessment assignment could not be verified.");
          all.push({ id: a.id, title: a.title || "", start, end, allDay: Boolean(a.allDay), jobberUserIds: a.assignedUsers.nodes.map((u) => u.id), address: addressLine(a.property?.address) });
        }
        if (!data.requests.pageInfo.hasNextPage) { complete = true; break; }
        const next = data.requests.pageInfo.endCursor;
        if (!next || next === cursor) throw new Error("Jobber assessment pagination could not be completed.");
        cursor = next;
      }
      if (!complete) throw new Error("Jobber assessments exceed the verification limit. Office review is required.");
      if (await accountIdentityRevision() === binding) await store.kvSet(key, all, 60);
    }
    return all.filter((a) => a.start >= from && a.start < to);
  }

  // ---- Tasks and events ---------------------------------------------------------------
  // Tasks and events (time off, meetings, errands) share the Jobber calendar with visits and
  // assessments, but only Jobber's scheduledItems list has them. Its filter names and item types
  // aren't published anywhere BOB can check, so the query is built from Jobber's own description
  // of its API (GraphQL introspection), read once a day per API version: how the list filters by
  // date, which kinds of calendar item it holds, and each kind's fields. Visits and assessments are
  // read above; reminders occupy nobody.
  const TYPE_REF = "kind name ofType { kind name ofType { kind name ofType { kind name } } }";
  const named = (t) => { let x = t; while (x && (x.kind === "NON_NULL" || x.kind === "LIST") && x.ofType) x = x.ofType; return x || null; };
  const listOf = (t) => { for (let x = t; x; x = x.ofType) if (x.kind === "LIST") return true; return false; };
  const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const NOT_TASKS = /^(?:visit|assessment|reminder\w*)$/i;
  const SHAPE_KEY = () => `jobber:calendar-shape:v1:${cfg.version}`;
  const calendarUnsupported = (reason) => Object.assign(new Error(reason), { code: "JOBBER_CALENDAR_UNSUPPORTED" });
  // Jobber answered, but refused what was asked (a schema change, or a permission the app lacks):
  // not a network problem, so asking again won't help.
  const refused = (error) => /^Jobber: /.test(error?.message || "") || /^Jobber HTTP 4(?!29)\d\d/.test(error?.message || "");

  async function describe(query, variables) {
    try { return await gql(query, variables); }
    catch (error) { if (refused(error)) throw calendarUnsupported(`Jobber didn't describe its calendar (${error.message.replace(/^Jobber:?\s*/, "")}).`); throw error; }
  }

  /** How to ask Jobber for tasks and events: { supported, reason } or { supported, dateField, pair, scalar, kinds, types }. */
  async function discoverCalendar() {
    const no = (reason) => ({ supported: false, reason });
    const root = await describe(`query BobCalendarSchemaRoot { schema: __type(name: "Query") { fields { name args { name type { ${TYPE_REF} } } type { ${TYPE_REF} } } } }`);
    const field = (root?.schema?.fields || []).find((f) => f?.name === "scheduledItems");
    if (!field) return no("This Jobber API version has no calendar list (scheduledItems).");
    const args = field.args || [];
    const connection = named(field.type)?.name, filterType = named(args.find((a) => a?.name === "filter")?.type)?.name;
    if (!connection || !filterType || !["first", "after"].every((n) => args.some((a) => a?.name === n))) return no("Jobber's calendar list can't be filtered by date and paged.");
    const parts = await describe(`query BobCalendarSchemaParts($connection: String!, $filter: String!) {
      connection: __type(name: $connection) { fields { name type { ${TYPE_REF} } } }
      filter: __type(name: $filter) { inputFields { name defaultValue type { ${TYPE_REF} } } }
    }`, { connection, filter: filterType });
    const connFields = parts?.connection?.fields || [], inputs = parts?.filter?.inputFields || [];
    const node = named(connFields.find((f) => f?.name === "nodes")?.type)?.name;
    const dateField = ["startAt", "startsBetween", "occursWithin", "occursBetween"].map((n) => inputs.find((i) => i?.name === n)).find(Boolean);
    const kindField = inputs.find((i) => /^(?:schedul\w*Item)?Types?$/i.test(i?.name || "") && named(i.type)?.kind === "ENUM");
    // A filter input Jobber requires that BOB doesn't know how to fill makes the list unreadable.
    const unknownRequired = inputs.filter((i) => i?.type?.kind === "NON_NULL" && i.defaultValue == null && i !== dateField && i !== kindField);
    if (!node || !connFields.some((f) => f?.name === "pageInfo") || !dateField || named(dateField.type)?.kind !== "INPUT_OBJECT") return no("Jobber's calendar list has no date range filter BOB recognizes.");
    if (unknownRequired.length) return no(`Jobber's calendar list requires filters BOB doesn't know (${unknownRequired.map((i) => i.name).join(", ")}).`);
    const details = await describe(`query BobCalendarSchemaTypes($node: String!, $date: String!, $kinds: String!) {
      node: __type(name: $node) { possibleTypes { name fields { name args { name } type { ${TYPE_REF} } } } }
      date: __type(name: $date) { inputFields { name type { ${TYPE_REF} } } }
      kinds: __type(name: $kinds) { enumValues { name } }
    }`, { node, date: named(dateField.type).name, kinds: named(kindField?.type)?.name || named(dateField.type).name });
    const range = details?.date?.inputFields || [];
    const pair = [["after", "before"], ["from", "to"], ["startAt", "endAt"], ["start", "end"]].find(([a, b]) => range.some((i) => i?.name === a) && range.some((i) => i?.name === b));
    const scalar = pair && named(range.find((i) => i.name === pair[0]).type)?.name;
    if (!pair || !NAME.test(scalar || "")) return no("Jobber's calendar date filter has a shape BOB doesn't recognize.");
    const types = [];
    for (const t of details?.node?.possibleTypes || []) {
      if (!NAME.test(t?.name || "") || NOT_TASKS.test(t.name)) continue;
      const has = (n) => (t.fields || []).find((f) => f?.name === n);
      if (!has("id") || !has("startAt")) continue;
      const users = has("assignedUsers");
      const target = users && named(users.type);
      // Who it's for, read the way Jobber shapes it; an unknown shape counts as everyone.
      const assigned = !users ? null
        : target?.kind === "OBJECT" && /Connection$/.test(target.name || "") && (users.args || []).some((a) => a?.name === "first") ? "assignedUsers(first: 5) { nodes { id } pageInfo { hasNextPage } }"
          : listOf(users.type) && (users.args || []).every((a) => a?.name !== "first") ? "assignedUsers { id }" : null;
      types.push({ name: t.name, fields: ["id", has("title") && "title", "startAt", has("endAt") && "endAt", has("allDay") && "allDay", assigned].filter(Boolean) });
    }
    if (!types.length) return no("Jobber's calendar has no task or event items BOB can read.");
    // Ask only for tasks and events when the filter can name every one of them; otherwise read the
    // whole calendar and keep them.
    const squash = (s) => String(s).replace(/[^a-z]/gi, "").toLowerCase();
    const values = (details?.kinds?.enumValues || []).map((v) => v?.name).filter((v) => NAME.test(v || ""));
    const picked = kindField ? types.map((t) => values.find((v) => squash(v) === squash(t.name) || squash(t.name).endsWith(squash(v)))) : [];
    const kinds = kindField && picked.every(Boolean) && (listOf(kindField.type) || new Set(picked).size === 1)
      ? { field: kindField.name, values: [...new Set(picked)], list: listOf(kindField.type) } : null;
    return { supported: true, dateField: dateField.name, pair, scalar, kinds, types };
  }

  async function calendarShape() {
    const cached = await store.kvGet(SHAPE_KEY());
    if (cached) return cached;
    const shape = await discoverCalendar();
    await store.kvSet(SHAPE_KEY(), shape, shape.supported ? 86_400 : 3_600);
    return shape;
  }

  const calendarQuery = (shape) => {
    const [a, b] = shape.pair;
    const kinds = shape.kinds ? `, ${shape.kinds.field}: ${shape.kinds.list ? `[${shape.kinds.values.join(", ")}]` : shape.kinds.values[0]}` : "";
    return `query BobCalendarItems($from: ${shape.scalar}!, $to: ${shape.scalar}!, $cursor: String) {
      scheduledItems(first: 50, after: $cursor, filter: { ${shape.dateField}: { ${a}: $from, ${b}: $to }${kinds} }) {
        pageInfo { hasNextPage endCursor }
        nodes { __typename ${shape.types.map((t) => `... on ${t.name} { ${t.fields.join(" ")} }`).join(" ")} }
      }
    }`;
  };

  // A week off or a multi-day event can start before the window it blocks.
  const CALENDAR_LOOKBACK_MS = 7 * 86_400_000;

  /**
   * Tasks and events overlapping [from, to), shaped like readVisits rows plus kind ("task" or
   * "event"). jobberUserIds is null when Jobber doesn't say who it's for. Throws an error with code
   * JOBBER_CALENDAR_UNSUPPORTED when Jobber won't describe or answer the lookup.
   */
  async function readCalendarItems(from, to, { fresh = false } = {}) {
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error("A valid Jobber calendar lookup interval is required.");
    const binding = await accountIdentityRevision();
    if (!appConfigured || !binding) throw new JobberNotConnected();
    const key = `jobber:calendar:v1:${binding}:${cfg.version}:${from}:${to}`;
    if (!fresh) {
      const cached = await store.kvGet(key);
      if (cached) return cached;
    }
    const shape = await calendarShape();
    if (!shape.supported) throw calendarUnsupported(shape.reason);
    const query = calendarQuery(shape);
    const items = [];
    let cursor = null, complete = false;
    for (let page = 0; page < 15; page++) {
      let data;
      try {
        data = await gql(query, { from: new Date(from - CALENDAR_LOOKBACK_MS).toISOString(), to: new Date(to).toISOString(), cursor });
      } catch (error) {
        if (!refused(error)) throw error;
        await store.kvSet(SHAPE_KEY(), null, 1); // describe the API again next time
        throw calendarUnsupported(`Jobber refused the task and event lookup (${error.message.replace(/^Jobber:?\s*/, "")}).`);
      }
      const list = data?.scheduledItems;
      if (!Array.isArray(list?.nodes) || typeof list.pageInfo?.hasNextPage !== "boolean") throw new Error("Jobber tasks and events could not be fully verified.");
      for (const n of list.nodes) {
        if (!n || !shape.types.some((t) => t.name === n.__typename)) continue; // visits and assessments are read on their own
        if (n.startAt == null) continue; // not on the calendar yet
        if (typeof n.id !== "string" || !n.id.trim()) throw new Error("Jobber returned an invalid task or event ID. Office review is required.");
        const start = Date.parse(n.startAt);
        const end = n.endAt ? Date.parse(n.endAt) : n.allDay ? start + 86_400_000 : start + 3_600_000;
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("Jobber returned an invalid task or event time. Office review is required.");
        let jobberUserIds = null;
        if (n.assignedUsers !== undefined) {
          const connection = !Array.isArray(n.assignedUsers);
          const people = connection ? n.assignedUsers?.nodes : n.assignedUsers;
          if (!Array.isArray(people) || (connection && n.assignedUsers.pageInfo?.hasNextPage !== false)) throw new Error("Jobber task or event assignment list is incomplete. Office review is required.");
          if (people.some((u) => typeof u?.id !== "string" || !u.id)) throw new Error("Jobber task or event assignment could not be verified.");
          jobberUserIds = people.map((u) => u.id);
        }
        if (end <= from || start >= to) continue;
        items.push({ id: n.id, kind: /event/i.test(n.__typename) ? "event" : "task", title: n.title || "", start, end, allDay: Boolean(n.allDay), jobberUserIds, address: "" });
      }
      if (!list.pageInfo.hasNextPage) { complete = true; break; }
      const next = list.pageInfo.endCursor;
      if (!next || next === cursor) throw new Error("Jobber task and event pagination could not be completed.");
      cursor = next;
    }
    if (!complete) throw new Error("Jobber tasks and events exceed the verification limit. Office review is required.");
    if (await accountIdentityRevision() === binding) await store.kvSet(key, items, 60);
    return items;
  }

  // The team list changes rarely: bookings reuse it for 5 minutes (per connected account). A
  // technician missing from a cached list is looked up again before a booking is refused.
  let usersCache = null;
  async function cachedUsers() {
    const binding = await accountIdentityRevision();
    if (usersCache && usersCache.binding === binding && Date.now() - usersCache.at < USERS_CACHE_MS) return { users: usersCache.users, fresh: false };
    const users = await listUsers();
    usersCache = { binding, at: Date.now(), users };
    return { users, fresh: true };
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
    let { users, fresh } = await cachedUsers();
    let user = users.find((candidate) => candidate.id === jobberUserId);
    if (!user && !fresh) {
      usersCache = null;
      ({ users } = await cachedUsers());
      user = users.find((candidate) => candidate.id === jobberUserId);
    }
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

  /**
   * The connected Jobber company ({ id, name }), looked up once per connection and remembered
   * (connecting or disconnecting starts a new connection). null when Jobber isn't connected.
   */
  async function connectedAccount() {
    if (!(await connected())) return null;
    const connection = (await store.kvGet("client-hub:connection-epoch")) || null;
    const saved = await store.kvGet("jobber:account");
    if (saved?.id && (saved.connection || null) === connection) return { id: saved.id, name: saved.name };
    const account = await accountIdentity();
    await store.kvSet("jobber:account", { id: account.id, name: account.name, connection, at: Date.now() });
    return { id: account.id, name: account.name };
  }

  /**
   * Whether a Jobber job (or, if that's gone, its client) is in the connected account: true,
   * false, or null when Jobber couldn't say (a timeout, busy, an answer we don't recognise).
   */
  async function accountHas({ jobId, clientId } = {}) {
    let asked = false;
    for (const [field, id] of [["job", jobId], ["client", clientId]]) {
      if (typeof id !== "string" || !id) continue;
      asked = true;
      try {
        const data = await gql(`query BobAccountHas${field}($id: EncodedId!) { ${field}(id: $id) { id } }`, { id });
        if (data?.[field]?.id) return true;
      } catch (error) {
        // Only a plain "no such record" answer counts as no. Anything else, including a query Jobber
        // doesn't understand ("Field 'job' doesn't exist on type 'Query'"), means it couldn't say.
        const message = error.message || "";
        if (/field|on type|argument|variable|syntax|parse/i.test(message)) return null;
        if (!/not.?found|couldn.?t find|could not find|does(?: not|n.?t) exist|access denied|not authori[sz]ed|unauthori[sz]ed|permission/i.test(message)) return null;
      }
    }
    return asked ? false : null;
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
  /**
   * The people Settings adds to every BOB visit (so it shows on their own Jobber schedule), kept to
   * current users of the connected account. Someone removed from Jobber is skipped, never a reason
   * to refuse the booking.
   */
  async function extraAssignees(alsoAssign, jobberUserId) {
    const wanted = [...new Set((Array.isArray(alsoAssign) ? alsoAssign : []).filter((id) => typeof id === "string" && id.trim() && id.length <= 200 && id !== jobberUserId))];
    if (!wanted.length) return [];
    const known = new Set((await cachedUsers()).users.map((u) => u.id));
    const missing = wanted.filter((id) => !known.has(id));
    if (missing.length) console.warn(`[jobber] skipped ${missing.length} "also assign" user(s) no longer in the connected Jobber account`);
    return wanted.filter((id) => known.has(id));
  }

  async function verifyScheduledVisit({ visitId, jobNumber, start, end, jobberUserId, alsoAssign = [] }) {
    const hasId = typeof visitId === "string" && Boolean(visitId.trim());
    const number = String(jobNumber ?? "").trim();
    const hasNumber = jobNumber != null && number !== "";
    if ((hasNumber && !/^\d{1,10}$/.test(number)) || (hasId && visitId === "confirmed-by-office") || (!hasId && !/^\d{1,10}$/.test(number)) || typeof jobberUserId !== "string" || !jobberUserId.trim() || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw Object.assign(new Error("A Jobber visit ID or job number, assigned technician and expected time are required for verification."), { code: "JOBBER_VISIT_UNVERIFIED" });
    }
    const visits = await readVisits(start - 60_000, end + 60_000, { fresh: true });
    // The technician must be on it; anyone else on it must be one of the people Settings adds.
    const allowed = new Set([jobberUserId, ...(Array.isArray(alsoAssign) ? alsoAssign : [])]);
    const exact = v => v.start === start && v.end === end && !v.allDay && v.jobberUserIds.includes(jobberUserId) && v.jobberUserIds.every(id => allowed.has(id));
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
  async function createScheduledJob({ propertyId, title, instructions, lineItems, start, end, jobberUserId, alsoAssign = [] }) {
    await verifyAssignment(jobberUserId);
    const extra = await extraAssignees(alsoAssign, jobberUserId);
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
    schedule.teamMemberIdsToAssign = [jobberUserId, ...extra];
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
      const verified = await verifyScheduledVisit({ visitId: createdVisit.id, start, end, jobberUserId, alsoAssign: extra });
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
    readAssessments,
    readCalendarItems,
    listUsers,
    verifyAssignment,
    verifyScheduledVisit,
    accountIdentity,
    connectedAccount,
    accountHas,
    accountIdentityRevision,
    ensureClientAndProperty,
    createScheduledJob,
  };
}
