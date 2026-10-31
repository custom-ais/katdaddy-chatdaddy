import { OBSERVABILITY_DDL } from "./observability.mjs";

// BOB's Postgres schema (Supabase). Everything lives in the `bob` schema, which is
// not exposed through Supabase's public Data API; only the server connects to it.
// Timestamps are epoch milliseconds (bigint), matching the original SQLite store.

export const SCHEMA_SQL = `
create schema if not exists bob;

create table if not exists bob.settings (
  key text primary key,
  value jsonb not null
);

create table if not exists bob.sessions (
  token text primary key,
  data jsonb not null,
  created bigint not null,
  expires bigint not null
);
create index if not exists sessions_expires on bob.sessions (expires);

create table if not exists bob.admins (
  token text primary key,
  expires bigint not null
);

create table if not exists bob.holds (
  id text primary key,
  session text not null,
  tech text not null,
  start_ms bigint not null,
  end_ms bigint not null,
  expires bigint not null,
  quote jsonb not null,
  lat double precision,
  lng double precision,
  address text,
  overflow boolean not null default false
);
alter table bob.holds add column if not exists overflow boolean not null default false;
create index if not exists holds_schedule on bob.holds (start_ms, end_ms, expires);
create index if not exists holds_session on bob.holds (session);

create table if not exists bob.appointments (
  id text primary key,
  session text,
  idem text unique,
  tech text not null,
  start_ms bigint not null,
  end_ms bigint not null,
  status text not null,
  data jsonb not null,
  jobber_job_id text,
  jobber_visit_id text,
  created bigint not null
);
create index if not exists appointments_schedule on bob.appointments (start_ms, end_ms, status);

create table if not exists bob.requests (
  id text primary key,
  session text,
  idem text unique,
  data jsonb not null,
  created bigint not null
);

-- Emergency / exception / 5 PM approvals (rulebook U3): pending until a named approver decides.
create table if not exists bob.approvals (
  id text primary key,
  session text not null,
  status text not null,
  data jsonb not null,
  created bigint not null,
  expires bigint not null
);
create index if not exists approvals_status on bob.approvals (status, expires);

create table if not exists bob.events (
  id text primary key,
  kind text not null,
  created bigint not null,
  data jsonb not null,
  status text not null,
  attempts integer not null default 0,
  next bigint not null default 0
);

create table if not exists bob.audit (
  id text primary key,
  created bigint not null,
  action text not null,
  target text not null
);

-- Cache, locks, rate limits and integration tokens.
create table if not exists bob.kv (
  key text primary key,
  value jsonb,
  expires bigint
);
create index if not exists kv_expires on bob.kv (expires);
` + OBSERVABILITY_DDL.map((sql) => `${sql};`).join("\n");

// Row-level security on, no policies: nothing but the server's own role can read these.
export const RLS_SQL = [
  "settings", "sessions", "admins", "holds", "appointments", "requests", "approvals", "events", "audit", "kv", "conversations", "conversation_events",
]
  .map((t) => `alter table bob.${t} enable row level security;`)
  .join("\n");

// Hosting without a database password: the server reaches Postgres through Supabase's REST
// API with the service-role key and this one function. It runs as the caller, and only the
// service role may call it — anonymous and signed-in Supabase users can't.
export const RPC_SQL = `
create or replace function public.bob_exec(q text)
returns jsonb
language plpgsql
set search_path = ''
as $fn$
declare
  result jsonb;
begin
  if q ~* '^\\s*(select|with)\\M' or q ~* '\\mreturning\\M' then
    execute format('with bob_rows as (%s) select coalesce(jsonb_agg(to_jsonb(bob_rows)), ''[]''::jsonb) from bob_rows', q) into result;
  else
    execute q;
    result := '[]'::jsonb;
  end if;
  return result;
end
$fn$;
revoke all on function public.bob_exec(text) from public;
do $grants$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on function public.bob_exec(text) from anon'; end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on function public.bob_exec(text) from authenticated'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.bob_exec(text) to service_role';
    execute 'grant usage on schema bob to service_role';
    execute 'grant select, insert, update, delete on all tables in schema bob to service_role';
    execute 'alter default privileges in schema bob grant select, insert, update, delete on tables to service_role';
  end if;
end
$grants$;
`;
