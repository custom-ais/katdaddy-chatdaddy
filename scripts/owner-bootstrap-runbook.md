# Named administration: operator migration plan

This is a local implementation plan, not approval to run a production migration,
create a live account, issue an invitation, change credentials, or deploy.
No real owner identity is hard-coded in the application or this document.

## Prepare a reviewed release

1. Confirm the intended owner account and a private delivery channel with the owner.
   The existing shared password, any legacy admin session, and an entered email
   address do not independently verify ownership.
2. For a code-only dormant release, first confirm the production authority state
   and whether named identities or owner consent receipts already exist using
   sanitized read-only metadata. The production database adapters do not apply
   schema automatically. Do not bootstrap accounts or change authority in this stage.
   For a later, separately authorized migration, review the isolated
   `named-auth-additive-migration.sql` from the release preflight package.
   Do not apply the full `npm run db:schema` output to production: it also contains
   existing broad grants and default privileges outside this migration's scope.
   New tables are
   `bob.auth_users`, `bob.auth_sessions`, `bob.auth_invitations`, and
   `bob.auth_audit`; the existing private server-role boundary remains in use.
   Named account security changes execute in one database function call so that
   direct Postgres and the existing Supabase REST adapter have the same atomicity.
3. Obtain action-time authorization for production SQL, release deployment, and
   the exact owner bootstrap. Take a verified database backup, preserve the
   deployed build, and prepare a rollback build that understands named auth.
4. Only in the separately authorized migration stage, apply the additive schema
   with its explicitly reviewed narrow server-role grants. An absent
   `bob.kv['admin-auth:authority']` means legacy mode only while no named identities
   exist. A missing authority row with existing identities, read error, or malformed
   mode fails closed. Legacy mode does not authorize named-user management or
   viewing, granting, or revoking the separate owner SMS consent receipt. Existing
   legacy operational owner-alert switches remain available until cutover; they
   neither establish owner identity nor override a persisted consent hold.

## Privileged owner bootstrap and cutover

Only a trusted operator with the already-authorized server database access may
call the following backend methods. There are deliberately no HTTP routes to
prepare a bootstrap or activate named mode. Never add a first-visitor or
shared-admin shortcut.

- `prepareOwnerBootstrap({email, name})` reserves one named Master Admin and
  returns a one-use claim token. Deliver it only through the verified private
  channel. It expires in one hour; only its hash is stored. Reissuing to the same
  still-pending owner revokes the earlier token. A different owner or an already
  claimed owner requires a separately reviewed operator recovery plan.
- The owner accepts through the app's owner-bootstrap acceptance page and sets
  their own password. No password is supplied by the operator. The acceptance
  token cannot choose an email, role, or permissions.
- The owner must successfully log in with their named account. The response is
  `pendingCutover:true`; named management APIs remain unavailable. Confirm that
  the owner can access the account before the operator proceeds.
- After explicit cutover authorization, call
  `activateNamedMode({ownerId})` with that verified prepared account ID. The
  database requires a current successful owner login, atomically enables named
  mode, and clears legacy admin sessions. `bob_user` sessions are stored in a
  separate table, so old shared-admin code cannot recognize them as legacy sessions.
- Verify the owner's authenticated access, direct API denial for legacy cookies,
  a synthetic/reviewed restricted-user permission matrix, and master-only owner
  consent. Cutover does not enable texting or change sender readiness.

## Account lifecycle

Master Admins issue member invitations or intentionally grant the Master Admin
role. Member permissions must be explicit recognized capability keys; reserved
master-only capabilities cannot be assigned to members. Invitations bind the
account and its current version. Acceptance only sets the password; it never
accepts invitee-supplied roles or permissions. Invitation, bootstrap, and reset
tokens are single-use, expire, and are absent from list/audit responses.

Changing an account invalidates its sessions and outstanding invitations. Reissue
an invitation after editing a pending account. Enabling a never-claimed disabled
account returns it to pending, requiring invitation acceptance before activation.
Password reset issuance invalidates sessions and older reset links; successful
acceptance invalidates sessions again. Removing an account is a tombstone and
clears its password; audit attribution remains. Use Disable for reversible access
removal. Removed email identifiers remain reserved in this first implementation.

Named passwords store a versioned scheme identifier with a unique salt and verifier:
`scrypt-v1-N16384-r8-p5-l64` (N=16384, r=8, p=5, 64-byte output, 32 MiB runtime
memory cap). This is the 16 MiB profile listed in the
[OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt).
Missing or unknown schemes fail authentication; there is no weak named-hash
fallback. Existing synthetic accounts from earlier local candidates must be
recreated or reset before validation. No production named accounts have been provisioned.

The database serializes security changes and refuses disabling, deleting, or
demoting the final active Master Admin. Pending accounts do not count. Every
operation checks the acting account and session again inside the same transaction.
Provider callbacks must revalidate the server-held named session reference, and
ordinary writes/provider calls must recheck authorization immediately before the
side effect. Already-completed external operations cannot be undone by revoking a
session afterward.

## Rollback and recovery boundary

Before cutover, a rollback must retain the owner SMS receipt checks and sending
hold, including revocation, as well as the restriction on legacy sessions accessing
the separate consent form/API. A build that predates those checks is not a safe
rollback when receipts exist: it could ignore them and resume legacy owner alerts.
Never delete or reset consent receipts to restore legacy sending. Retain the
separate named-session boundary so prepared users do not gain legacy privileges.
After cutover, do not deploy the old shared-password-only build: it ignores the
named authority mode and can accept legacy credentials.
Keep a compatible rollback build that retains named authentication enforcement,
or temporarily deny management access while an authorized operator recovers the
verified owner. Never switch to legacy mode automatically after a database error.
Do not drop new identity or audit tables as a rollback step.

Recovery when every master has lost access needs a separately reviewed, explicitly
authorized operator action tied to the verified owner. There is intentionally no
unauthenticated public recovery or shared-password fallback. The existing
`scripts/reset-access.mjs` targets an obsolete SQLite/openStore implementation and
must not be used against this Postgres application.

Automated proof is local only: the auth suite exercises both PGlite and the real
Supabase REST SQL/RPC path over synthetic storage, including token reuse,
permission escalation attempts, concurrent final-master changes, expired and
revoked sessions, OAuth-reference invalidation, and unavailable database state.

## Page access and notification actions

Viewing a page grants no editing action. `appointments.send` governs **manual**
customer confirmations. Existing booking/approval/resolution workflows can still
send configured automatic confirmations when a user has the corresponding
management permission; those actions disclose this consequence in the UI.
Opening the live booking bot uses the existing public booking workflow. Provider
configuration and sender controls are Master Admin only in named mode. The
separate owner SMS consent form/API always requires a named Master Admin; a
legacy shared-password session cannot view, grant, or revoke its receipt.
The legacy `tech-ryan` availability-text fallback recipient is also protected:
named non-masters cannot add/remove that identity or change its effective phone, even
while an explicit approver phone currently overrides it.
