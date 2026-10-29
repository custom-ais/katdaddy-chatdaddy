-- Stores ChatDaddy's Jobber OAuth tokens (one row).
-- Its own table name, so it never clashes with another app's jobber_tokens table.
-- Row level security is on with no policies, so only the service role key
-- (used on the server) can read or write it; the public anon key cannot.
create table if not exists public.chatdaddy_jobber_tokens (
  id smallint primary key default 1 check (id = 1),
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.chatdaddy_jobber_tokens enable row level security;
