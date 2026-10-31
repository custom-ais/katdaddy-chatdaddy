-- Additive migration for BOB activity and the 60-day conversation archive.
-- Apply to the existing BOB database before a Supabase REST deployment.
create table if not exists bob.conversations (id text primary key, created bigint not null, updated bigint not null, expires bigint not null, data jsonb not null);
create index if not exists conversations_updated on bob.conversations(updated desc);
create index if not exists conversations_expires on bob.conversations(expires);
create table if not exists bob.conversation_events (id text primary key, conversation_id text not null references bob.conversations(id) on delete cascade, created bigint not null, kind text not null, data jsonb not null);
create index if not exists conversation_events_created on bob.conversation_events(created desc);
create index if not exists conversation_events_conversation on bob.conversation_events(conversation_id,created);
alter table bob.conversations enable row level security;
alter table bob.conversation_events enable row level security;
do $grants$ begin
  if exists(select 1 from pg_roles where rolname='service_role') then
    grant select,insert,update,delete on bob.conversations,bob.conversation_events to service_role;
  end if;
end $grants$;
