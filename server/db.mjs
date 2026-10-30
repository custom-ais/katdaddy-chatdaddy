// Minimal SQL adapter so the store works with Supabase (postgres-js) in production
// and an in-process Postgres (PGlite) in tests and offline development.
//
// Interface: { query(text, params) -> rows[], tx(fn) -> fn({ query }), close() }

import { SCHEMA_SQL } from "./schema.mjs";

export function databaseUrl(env = process.env) {
  return env.DATABASE_URL || env.POSTGRES_URL || env.SUPABASE_DB_URL || "";
}

export const supabaseUrl = (env = process.env) => env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || "";

/**
 * Quote one parameter as a SQL literal. Every value is sent as a quoted literal (or NULL),
 * which Postgres types from context — '123' compares with a bigint, '{"a":1}'::jsonb is
 * JSON. standard_conforming_strings is on in Supabase, so doubling quotes is the escape.
 */
export function literal(value) {
  if (value === null || value === undefined) return "NULL";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (text.includes("\u0000")) throw new Error("Text values can't contain a null character.");
  return `'${text.replace(/'/g, "''")}'`;
}

/** Fill $1, $2… in one pass over the SQL template, so values are never re-scanned. */
export const inline = (text, params = []) =>
  text.replace(/\$(\d+)/g, (_, n) => {
    const i = Number(n) - 1;
    if (i < 0 || i >= params.length) throw new Error(`Missing SQL parameter $${n}.`);
    return literal(params[i]);
  });

/**
 * Postgres through Supabase's REST API (the service-role key + public.bob_exec), for hosts
 * that have the Supabase URL and service key but no database connection string.
 */
export function createSupabaseRpcDb({ url, key, fetchImpl = globalThis.fetch }) {
  const endpoint = `${url.replace(/\/$/, "")}/rest/v1/rpc/bob_exec`;
  async function query(text, params = []) {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ q: inline(text, params) }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message = body?.message || body?.error || `HTTP ${response.status}`;
      const error = new Error(/bob_exec/.test(message) && /find|exist/i.test(message) ? "BOB's database function isn't installed. Run the BOB schema in Supabase." : `Database: ${message}`);
      error.code = body?.code;
      throw error;
    }
    return Array.isArray(body) ? body : [];
  }
  return {
    kind: "supabase-rest",
    query,
    tx: () => {
      throw new Error("Transactions aren't available over the REST adapter.");
    },
    close: async () => {},
  };
}

export async function createPostgresDb(url) {
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, {
    // Supabase's transaction pooler (port 6543) does not support prepared statements.
    prepare: false,
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? false : "require",
    types: {
      bigint: { to: 20, from: [20], serialize: (x) => String(x), parse: (x) => Number(x) },
    },
    onnotice: () => {},
  });
  const wrap = (runner) => ({ query: (text, params = []) => runner.unsafe(text, params) });
  return {
    kind: "postgres",
    ...wrap(sql),
    tx: (fn) => sql.begin((t) => fn(wrap(t))),
    close: () => sql.end({ timeout: 5 }),
  };
}

export async function createPgliteDb(dataDir) {
  const { PGlite } = await import("@electric-sql/pglite");
  if (dataDir && !dataDir.startsWith("memory:")) {
    const { mkdir } = await import("node:fs/promises");
    const { dirname } = await import("node:path");
    await mkdir(dirname(dataDir), { recursive: true });
  }
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  await db.exec(SCHEMA_SQL);
  const wrap = (runner) => ({
    query: async (text, params = []) => (await runner.query(text, params)).rows,
  });
  // PGlite runs one statement at a time; serialize transactions to mimic row locks.
  let chain = Promise.resolve();
  return {
    kind: "pglite",
    ...wrap(db),
    exec: (text) => db.exec(text),
    tx: (fn) => {
      const run = chain.then(() => db.transaction((t) => fn(wrap(t))));
      chain = run.catch(() => {});
      return run;
    },
    close: () => db.close(),
  };
}

/**
 * Production: DATABASE_URL (direct Postgres), or the Supabase URL + service-role key
 * (REST). Otherwise a local PGlite folder (development only).
 */
export async function createDb(env = process.env) {
  const url = databaseUrl(env);
  if (url) return createPostgresDb(url);
  if (supabaseUrl(env) && env.SUPABASE_SERVICE_ROLE_KEY) return createSupabaseRpcDb({ url: supabaseUrl(env), key: env.SUPABASE_SERVICE_ROLE_KEY });
  if (env.VERCEL) throw new Error("No database is set. Add DATABASE_URL, or NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, in Vercel.");
  return createPgliteDb(env.BOB_PGLITE_DIR || ".data/pglite");
}
