// Named management identities stay private to the existing server database role.
// One function call is one transaction on direct Postgres and Supabase's REST RPC.
export const ADMIN_AUTH_PASSWORD_SCHEME = 'scrypt-v1-N16384-r8-p5-l64';
export const ADMIN_AUTH_SCHEMA_SQL = `
create table if not exists bob.auth_users (
  id text primary key,
  email text not null unique,
  name text not null,
  role text not null check (role in ('master','member')),
  status text not null check (status in ('pending','active','disabled','removed')),
  permissions jsonb not null default '[]'::jsonb check (jsonb_typeof(permissions)='array'),
  password_salt text,
  password_hash text,
  password_scheme text,
  version integer not null default 1,
  session_version integer not null default 1,
  login_proven boolean not null default false,
  created bigint not null,
  updated bigint not null,
  check(status<>'active' or (password_salt is not null and password_hash is not null))
);
alter table bob.auth_users add column if not exists password_scheme text;
create table if not exists bob.auth_sessions (
  token text primary key,
  user_id text not null references bob.auth_users(id),
  session_version integer not null,
  created bigint not null,
  expires bigint not null
);
create index if not exists auth_sessions_user on bob.auth_sessions(user_id);
create table if not exists bob.auth_invitations (
  id text primary key,
  token_hash text not null unique,
  user_id text not null references bob.auth_users(id),
  user_version integer not null,
  kind text not null check(kind in ('owner_bootstrap','invite','reset')),
  status text not null check(status in ('pending','consumed','revoked')),
  created bigint not null,
  expires bigint not null,
  created_by text not null,
  consumed bigint
);
create index if not exists auth_invitations_user on bob.auth_invitations(user_id);
create table if not exists bob.auth_audit (
  id text primary key,
  created bigint not null,
  actor_id text not null,
  action text not null,
  target_id text not null
);

create or replace function bob.admin_user_public(u bob.auth_users)
returns jsonb language sql immutable set search_path = '' as $pub$
 select jsonb_build_object('id',u.id,'email',u.email,'name',u.name,'role',u.role,
   'status',u.status,'permissions',u.permissions,'version',u.version,
   'sessionVersion',u.session_version,'created',u.created,'updated',u.updated)
$pub$;

create or replace function bob.admin_invitation_public(i bob.auth_invitations)
returns jsonb language sql stable set search_path = '' as $pub$
 select jsonb_build_object('id',i.id,'userId',i.user_id,'email',u.email,'name',u.name,
   'kind',i.kind,'status',i.status,'created',i.created,'expires',i.expires)
 from bob.auth_users u where u.id=i.user_id
$pub$;

create or replace function bob.admin_auth_command(op text, p jsonb, at_ms bigint)
returns jsonb language plpgsql set search_path = '' as $auth$
declare
 authority jsonb;
 actor bob.auth_users;
 u bob.auth_users;
 inv bob.auth_invitations;
 sess bob.auth_sessions;
 target_status text;
 target_role text;
 actor_id text := 'operator';
 target_id text := '';
 result jsonb;
begin
 if not exists(select 1 from bob.kv where key='admin-auth:authority') and exists(select 1 from bob.auth_users) then
   return jsonb_build_object('error','Account authority is missing. Operator review is required.','status',503);
 end if;
 -- Serialize account security changes, including concurrent last-master edits.
 insert into bob.kv(key,value,expires) values('admin-auth:authority','{"mode":"legacy"}'::jsonb,null)
 on conflict(key) do nothing;
 select value into authority from bob.kv where key='admin-auth:authority' for update;
 if authority->>'mode' is null or authority->>'mode' not in ('legacy','named') then
   return jsonb_build_object('error','Account access is temporarily unavailable.','status',503);
 end if;

 if op in ('authenticate','list_users','invite','update_user','revoke_invite','reset_invite','change_password','logout') then
   if op<>'logout' and authority->>'mode'<>'named' then return jsonb_build_object('error','Individual account access has not been activated.','status',403); end if;
   select * into sess from bob.auth_sessions where token=p->>'sessionHash' and expires>at_ms;
   select * into actor from bob.auth_users where id=sess.user_id and status='active' and session_version=sess.session_version;
   if actor.id is null then return jsonb_build_object('error','Please sign in to your account.','status',401); end if;
   actor_id:=actor.id;
   if op in ('list_users','invite','update_user','revoke_invite','reset_invite') and actor.role<>'master' then
     return jsonb_build_object('error','Master Admin access is required.','status',403);
   end if;
 end if;

 if op='authenticate' then return bob.admin_user_public(actor); end if;
 if op='list_users' then
   return jsonb_build_object('users',coalesce((select jsonb_agg(bob.admin_user_public(x) order by x.created,x.id) from bob.auth_users x),'[]'::jsonb),
     'invitations',coalesce((select jsonb_agg(bob.admin_invitation_public(x) order by x.created desc,x.id) from bob.auth_invitations x),'[]'::jsonb));
 end if;
 if op='logout' then
   delete from bob.auth_sessions where token=p->>'sessionHash';
   return jsonb_build_object('signedOut',true);
 end if;

 if op='prepare_owner' then
   if authority->>'mode'<>'legacy' then return jsonb_build_object('error','Owner bootstrap is closed.','status',409); end if;
   select * into u from bob.auth_users where id=authority->>'ownerId';
   if u.id is not null and (u.email<>p->>'email' or u.status<>'pending' or u.role<>'master') then
     return jsonb_build_object('error','An owner account is already prepared.','status',409);
   end if;
   if u.id is null then
     if exists(select 1 from bob.auth_users) then return jsonb_build_object('error','Existing account state requires operator review.','status',409); end if;
     insert into bob.auth_users(id,email,name,role,status,created,updated)
       values(p->>'userId',p->>'email',p->>'name','master','pending',at_ms,at_ms) returning * into u;
     authority:=authority||jsonb_build_object('ownerId',u.id);
     update bob.kv set value=authority where key='admin-auth:authority';
   end if;
   update bob.auth_invitations set status='revoked' where user_id=u.id and status='pending';
   insert into bob.auth_invitations(id,token_hash,user_id,user_version,kind,status,created,expires,created_by)
     values(p->>'invitationId',p->>'tokenHash',u.id,u.version,'owner_bootstrap','pending',at_ms,(p->>'expires')::bigint,'operator') returning * into inv;
   result:=jsonb_build_object('user',bob.admin_user_public(u),'invitation',bob.admin_invitation_public(inv));
   target_id:=u.id;

 elsif op in ('invitation_details','accept_invite','accept_owner') then
   select * into inv from bob.auth_invitations where token_hash=p->>'tokenHash' and status='pending' and expires>at_ms;
   select * into u from bob.auth_users where id=inv.user_id and version=inv.user_version and status in ('pending','active');
   if inv.id is null or u.id is null then return jsonb_build_object('error','This invitation is invalid, expired, or no longer available.','status',400); end if;
   if inv.kind='owner_bootstrap' then
     if authority->>'mode'<>'legacy' or u.id is distinct from authority->>'ownerId' or u.status<>'pending' then
       return jsonb_build_object('error','Owner bootstrap is no longer available.','status',409);
     end if;
   elsif authority->>'mode'<>'named' then
     return jsonb_build_object('error','Individual account access has not been activated.','status',403);
   end if;
   if op='invitation_details' then return bob.admin_invitation_public(inv); end if;
   if (op='accept_owner')<>(inv.kind='owner_bootstrap') then return jsonb_build_object('error','Use the matching invitation acceptance page.','status',400); end if;
   if (inv.kind in ('owner_bootstrap','invite') and u.status<>'pending') or (inv.kind='reset' and u.status<>'active') then
     return jsonb_build_object('error','This invitation is no longer available.','status',409);
   end if;
   update bob.auth_users set password_salt=p->>'salt',password_hash=p->>'hash',password_scheme=p->>'scheme',status='active',
     version=version+1,session_version=session_version+1,login_proven=false,updated=at_ms where id=u.id returning * into u;
   update bob.auth_invitations set status='revoked' where user_id=u.id and status='pending';
   update bob.auth_invitations set status='consumed',consumed=at_ms where id=inv.id;
   delete from bob.auth_sessions where user_id=u.id;
   actor_id:=u.id;target_id:=u.id;
   result:=jsonb_build_object('user',bob.admin_user_public(u),'requiresLogin',true);

 elsif op='login' then
   select * into u from bob.auth_users where id=p->>'userId' and status='active' and version=(p->>'expectedVersion')::int;
   if u.id is null or (authority->>'mode'='legacy' and (u.id is distinct from authority->>'ownerId' or u.role<>'master')) then
     return jsonb_build_object('error','Invalid email or password.','status',401);
   end if;
   insert into bob.auth_sessions(token,user_id,session_version,created,expires)
     values(p->>'sessionHash',u.id,u.session_version,at_ms,(p->>'expires')::bigint);
   update bob.auth_users set login_proven=true where id=u.id;
   actor_id:=u.id;target_id:=u.id;
   result:=jsonb_build_object('principal',bob.admin_user_public(u),'pendingCutover',authority->>'mode'='legacy');

 elsif op='activate_named' then
   if authority->>'mode'<>'legacy' then return jsonb_build_object('error','Individual account access is already active.','status',409); end if;
   select * into u from bob.auth_users where id=p->>'ownerId' and id=authority->>'ownerId' and role='master' and status='active' and login_proven=true;
   if u.id is null or not exists(select 1 from bob.auth_sessions where user_id=u.id and session_version=u.session_version and expires>at_ms) then
     return jsonb_build_object('error','The prepared owner must successfully sign in before cutover.','status',409);
   end if;
   update bob.kv set value=authority||jsonb_build_object('mode','named','activatedAt',at_ms) where key='admin-auth:authority';
   delete from bob.admins;
   target_id:=u.id;result:=jsonb_build_object('mode','named','ownerId',u.id);

 elsif op='invite' then
   if exists(select 1 from bob.auth_users where email=p->>'email') then return jsonb_build_object('error','An account already uses this email.','status',409); end if;
   insert into bob.auth_users(id,email,name,role,status,permissions,created,updated)
     values(p->>'userId',p->>'email',p->>'name',p->>'role','pending',p->'permissions',at_ms,at_ms) returning * into u;
   insert into bob.auth_invitations(id,token_hash,user_id,user_version,kind,status,created,expires,created_by)
     values(p->>'invitationId',p->>'tokenHash',u.id,u.version,'invite','pending',at_ms,(p->>'expires')::bigint,actor.id) returning * into inv;
   target_id:=u.id;result:=jsonb_build_object('user',bob.admin_user_public(u),'invitation',bob.admin_invitation_public(inv));

 elsif op='update_user' then
   select * into u from bob.auth_users where id=p->>'userId';
   if u.id is null or u.status='removed' then return jsonb_build_object('error','This account is not available.','status',404); end if;
   if u.version<>(p->>'version')::int then return jsonb_build_object('error','This account changed. Refresh before saving.','status',409); end if;
   target_status:=coalesce(p->>'status',u.status);target_role:=coalesce(p->>'role',u.role);
   if target_status='active' and (u.password_salt is null or u.password_hash is null) then
     -- Enabling an unclaimed account returns it to pending; it cannot count as an active master.
     target_status:='pending';
   end if;
   if u.role='master' and u.status='active' and (target_role<>'master' or target_status<>'active')
      and not exists(select 1 from bob.auth_users where id<>u.id and role='master' and status='active') then
     return jsonb_build_object('error','Keep at least one active Master Admin.','status',409);
   end if;
   update bob.auth_users set name=coalesce(p->>'name',name),role=target_role,status=target_status,
     permissions=coalesce(p->'permissions',permissions),version=version+1,session_version=session_version+1,
     password_hash=case when target_status='removed' then null else password_hash end,
     password_scheme=case when target_status='removed' then null else password_scheme end,
     password_salt=case when target_status='removed' then null else password_salt end,updated=at_ms where id=u.id returning * into u;
   delete from bob.auth_sessions where user_id=u.id;
   update bob.auth_invitations set status='revoked' where user_id=u.id and status='pending';
   target_id:=u.id;result:=jsonb_build_object('user',bob.admin_user_public(u));

 elsif op='revoke_invite' then
   select * into inv from bob.auth_invitations where id=p->>'invitationId';
   if inv.id is null then return jsonb_build_object('error','Invitation not found.','status',404); end if;
   if inv.status='consumed' then return jsonb_build_object('error','The invitation was already used. Disable the account to remove access.','status',409); end if;
   update bob.auth_invitations set status='revoked' where id=inv.id;
   target_id:=inv.user_id;result:=jsonb_build_object('revoked',true);

 elsif op='reset_invite' then
   select * into u from bob.auth_users where id=p->>'userId' and status in ('pending','active');
   if u.id is null then return jsonb_build_object('error','Enable an existing account before issuing an invitation.','status',409); end if;
   update bob.auth_users set version=version+1,session_version=session_version+1,updated=at_ms where id=u.id returning * into u;
   delete from bob.auth_sessions where user_id=u.id;
   update bob.auth_invitations set status='revoked' where user_id=u.id and status='pending';
   insert into bob.auth_invitations(id,token_hash,user_id,user_version,kind,status,created,expires,created_by)
     values(p->>'invitationId',p->>'tokenHash',u.id,u.version,case when u.status='pending' then 'invite' else 'reset' end,'pending',at_ms,(p->>'expires')::bigint,actor.id) returning * into inv;
   target_id:=u.id;result:=jsonb_build_object('user',bob.admin_user_public(u),'invitation',bob.admin_invitation_public(inv));

 elsif op='change_password' then
   if actor.version<>(p->>'expectedVersion')::int then return jsonb_build_object('error','This account changed. Sign in again.','status',409); end if;
   update bob.auth_users set password_salt=p->>'salt',password_hash=p->>'hash',password_scheme=p->>'scheme',version=version+1,
     session_version=session_version+1,updated=at_ms where id=actor.id;
   delete from bob.auth_sessions where user_id=actor.id;
   update bob.auth_invitations set status='revoked' where user_id=actor.id and status='pending';
   target_id:=actor.id;result:=jsonb_build_object('changed',true);
 else
   return jsonb_build_object('error','Unknown account operation.','status',400);
 end if;
 insert into bob.auth_audit(id,created,actor_id,action,target_id) values(p->>'auditId',at_ms,actor_id,op,target_id);
 return result;
end
$auth$;
revoke all on function bob.admin_user_public(bob.auth_users) from public;
revoke all on function bob.admin_invitation_public(bob.auth_invitations) from public;
revoke all on function bob.admin_auth_command(text,jsonb,bigint) from public;
do $auth_grants$
begin
 if exists(select 1 from pg_roles where rolname='service_role') then
   grant execute on function bob.admin_user_public(bob.auth_users) to service_role;
   grant execute on function bob.admin_invitation_public(bob.auth_invitations) to service_role;
   grant execute on function bob.admin_auth_command(text,jsonb,bigint) to service_role;
 end if;
end
$auth_grants$;
`;
