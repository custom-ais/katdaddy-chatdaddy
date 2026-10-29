-- Stores the app's Jobber OAuth tokens (one row).
-- Row level security is on with no policies, so only the service role key
-- (used on the server) can read or write it; the public anon key cannot.
create table if not exists public.jobber_tokens (
  id smallint primary key default 1 check (id = 1),
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.jobber_tokens enable row level security;
