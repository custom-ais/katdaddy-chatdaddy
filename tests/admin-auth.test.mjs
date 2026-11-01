import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, scryptSync } from 'node:crypto';
import { createPgliteDb, createSupabaseRpcDb } from '../server/db.mjs';
import { RPC_SQL } from '../server/schema.mjs';
import { createStore } from '../server/store.mjs';
import { createAdminAuth } from '../server/admin-auth.mjs';
import { ADMIN_AUTH_PASSWORD_SCHEME } from '../server/admin-auth-schema.mjs';

const PASSWORD = 'Synthetic-owner-password-2026';
const MEMBER_PASSWORD = 'Synthetic-member-password-2026';
const digest = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, rest) {
  const pg = await createPgliteDb();
  t.after(() => pg.close());
  let db = pg, now = Date.parse('2026-11-01T00:00:00Z');
  if (rest) {
    await pg.exec(RPC_SQL);
    db = createSupabaseRpcDb({ url: 'https://synthetic.invalid', key: 'synthetic-test-key', fetchImpl: async (url, init) => {
      assert.equal(url, 'https://synthetic.invalid/rest/v1/rpc/bob_exec');
      try {
        const [{ result }] = await pg.query('select public.bob_exec($1) as result', [JSON.parse(init.body).q]);
        return new Response(JSON.stringify(result), { status: 200 });
      } catch (error) { return new Response(JSON.stringify({ message: error.message, code: error.code }), { status: 400 }); }
    } });
  }
  const store = createStore(db, { clock: () => now });
  const auth = createAdminAuth({ store, clock: () => now });
  const prepared = async () => auth.prepareOwnerBootstrap({ email: 'owner@example.test', name: 'Synthetic Owner' });
  const owner = async () => {
    const claim = await prepared();
    await auth.acceptOwnerBootstrap({ token: claim.token, password: PASSWORD });
    const login = await auth.login({ email: 'owner@example.test', password: PASSWORD });
    await auth.activateNamedMode({ ownerId: claim.user.id });
    return { ...login, principal: await auth.authenticate(login.token) };
  };
  return { db, pg, store, auth, owner, prepared, advance: ms => { now += ms; } };
}

for (const rest of [false, true]) {
  const adapter = rest ? 'REST RPC' : 'PGlite';
  test(`${adapter}: owner bootstrap is bound, single-use, separate from shared access, and requires proven login before cutover`, async t => {
    const { auth, db, store, prepared } = await fixture(t, rest);
    assert.equal(await auth.mode(), 'legacy');
    await store.addAdmin(digest('legacy-shared-cookie'), Date.now() + 86_400_000);
    await assert.rejects(auth.authenticate('legacy-shared-cookie'), { status: 401 });
    await assert.rejects(auth.listUsers({ id: 'claimed-master', role: 'master' }), { status: 401 });
    const claim = await prepared();
    const details = await auth.invitationDetails({ token: claim.token });
    assert.equal(details.email, 'owner@example.test'); assert.equal(details.kind, 'owner_bootstrap');
    assert.equal(details.role, undefined); assert.equal(details.token, undefined);
    const authority = await store.kvGet('admin-auth:authority');
    await store.kvSet('admin-auth:authority', { mode: 'legacy' });
    await assert.rejects(auth.acceptOwnerBootstrap({ token: claim.token, password: PASSWORD }), { status: 409 });
    await store.kvSet('admin-auth:authority', authority);
    await assert.rejects(auth.prepareOwnerBootstrap({ email: 'attacker@example.test', name: 'Other' }), { status: 409 });
    await assert.rejects(auth.acceptInvite({ token: claim.token, password: PASSWORD }), { status: 400 });
    await auth.acceptOwnerBootstrap({ token: claim.token, password: PASSWORD });
    await assert.rejects(auth.acceptOwnerBootstrap({ token: claim.token, password: PASSWORD }), { status: 400 });
    await assert.rejects(auth.activateNamedMode({ ownerId: claim.user.id }), { status: 409 });
    const login = await auth.login({ email: 'OWNER@example.test', password: PASSWORD });
    assert.equal(login.pendingCutover, true);
    await assert.rejects(auth.authenticate(login.token), { status: 403 });
    await assert.rejects(auth.listUsers(login.principal), { status: 403 });
    assert.equal((await auth.activateNamedMode({ ownerId: claim.user.id })).mode, 'named');
    assert.equal(await auth.mode(), 'named');
    assert.equal(await store.isAdmin(digest('legacy-shared-cookie')), false);
    const principal = await auth.authenticate(login.token);
    assert.equal(principal.role, 'master');
    assert.doesNotMatch(JSON.stringify(principal), /token|hash|salt|sessionHash/);
    await assert.rejects(prepared(), { status: 409 });
    assert.equal((await db.query('select count(*)::int as n from bob.auth_users'))[0].n, 1);
  });

  test(`${adapter}: invites bind permissions, reject escalation, expire/revoke, and store only token hashes`, async t => {
    const { auth, db, owner, advance } = await fixture(t, rest);
    const master = await owner();
    await assert.rejects(auth.invite(master.principal, { email: 'new@example.test', name: 'New', permissions: ['unknown.permission'] }), { status: 400 });
    await assert.rejects(auth.invite(master.principal, { email: 'new@example.test', name: 'New', permissions: ['users.manage'] }), { status: 400 });
    const invitation = await auth.invite(master.principal, { email: 'member@example.test', name: 'Member', permissions: ['appointments.view'] });
    const stored = (await db.query('select * from bob.auth_invitations where id=$1', [invitation.invitation.id]))[0];
    assert.equal(stored.token_hash, digest(invitation.token)); assert.equal(stored.token, undefined);
    await auth.acceptInvite({ token: invitation.token, password: MEMBER_PASSWORD, role: 'master', permissions: ['users.manage'] });
    const member = await auth.login({ email: 'member@example.test', password: MEMBER_PASSWORD });
    assert.equal(member.principal.role, 'member'); assert.deepEqual(member.principal.permissions, ['appointments.view']);
    await assert.rejects(auth.listUsers(member.principal), { status: 403 });
    await assert.rejects(auth.invite(member.principal, { email: 'forbidden@example.test', name: 'Forbidden' }), { status: 403 });
    const revoked = await auth.invite(master.principal, { email: 'revoked@example.test', name: 'Revoked' });
    await auth.revokeInvite(master.principal, revoked.invitation.id);
    await assert.rejects(auth.acceptInvite({ token: revoked.token, password: MEMBER_PASSWORD }), { status: 400 });
    const expired = await auth.invite(master.principal, { email: 'expired@example.test', name: 'Expired' });
    advance(86_400_001);
    await assert.rejects(auth.acceptInvite({ token: expired.token, password: MEMBER_PASSWORD }), { status: 400 });
    await assert.rejects(auth.authenticate(member.token), { status: 401 });
    const audit = await db.query('select * from bob.auth_audit');
    assert.ok(audit.some(row => row.action === 'invite' && row.actor_id === master.principal.id));
    assert.doesNotMatch(JSON.stringify(audit), new RegExp(invitation.token));
  });

  test(`${adapter}: edits, disable/removal, password changes, reset/reissue invalidate sessions and OAuth references`, async t => {
    const { auth, db, owner } = await fixture(t, rest);
    const master = await owner();
    const issued = await auth.invite(master.principal, { email: 'worker@example.test', name: 'Worker', permissions: ['appointments.view','account.password'] });
    await auth.acceptInvite({ token: issued.token, password: MEMBER_PASSWORD });
    let worker = await auth.login({ email: 'worker@example.test', password: MEMBER_PASSWORD });
    const reference = auth.sessionReference(worker.principal);
    assert.equal((await auth.authenticateReference(reference)).id, worker.principal.id);
    const edited = await auth.updateUser(master.principal, worker.principal.id, { version: worker.principal.version, permissions: ['inbox.view'] });
    await assert.rejects(auth.revalidate(worker.principal), { status: 401 });
    await assert.rejects(auth.authenticateReference(reference), { status: 401 });
    await assert.rejects(auth.updateUser(master.principal, worker.principal.id, { version: worker.principal.version, status: 'disabled' }), { status: 409 });
    worker = await auth.login({ email: 'worker@example.test', password: MEMBER_PASSWORD });
    const disabled = await auth.updateUser(master.principal, worker.principal.id, { version: edited.user.version, status: 'disabled' });
    await assert.rejects(auth.authenticate(worker.token), { status: 401 });
    await assert.rejects(auth.login({ email: 'worker@example.test', password: MEMBER_PASSWORD }), { status: 401 });
    await auth.updateUser(master.principal, worker.principal.id, { version: disabled.user.version, status: 'active' });
    worker = await auth.login({ email: 'worker@example.test', password: MEMBER_PASSWORD });
    const reset1 = await auth.resetInvite(master.principal, worker.principal.id);
    await assert.rejects(auth.authenticate(worker.token), { status: 401 });
    const reset2 = await auth.resetInvite(master.principal, worker.principal.id);
    await assert.rejects(auth.acceptInvite({ token: reset1.token, password: PASSWORD }), { status: 400 });
    await auth.acceptInvite({ token: reset2.token, password: PASSWORD });
    await assert.rejects(auth.login({ email: 'worker@example.test', password: MEMBER_PASSWORD }), { status: 401 });
    worker = await auth.login({ email: 'worker@example.test', password: PASSWORD });
    await assert.rejects(auth.changePassword(worker.principal, { currentPassword: 'wrong', newPassword: MEMBER_PASSWORD }), { status: 403 });
    await auth.changePassword(worker.principal, { currentPassword: PASSWORD, newPassword: MEMBER_PASSWORD });
    assert.equal((await db.query('select password_scheme from bob.auth_users where id=$1', [worker.principal.id]))[0].password_scheme, ADMIN_AUTH_PASSWORD_SCHEME);
    await assert.rejects(auth.authenticate(worker.token), { status: 401 });
    worker = await auth.login({ email: 'worker@example.test', password: MEMBER_PASSWORD });
    await auth.updateUser(master.principal, worker.principal.id, { version: worker.principal.version, status: 'removed' });
    await assert.rejects(auth.authenticate(worker.token), { status: 401 });
    await assert.rejects(auth.resetInvite(master.principal, worker.principal.id), { status: 409 });
  });

  test(`${adapter}: current actor authorization and concurrent last-master edits are atomic`, async t => {
    const { auth, db, owner } = await fixture(t, rest);
    const first = await owner();
    await assert.rejects(auth.updateUser(first.principal, first.principal.id, { version: first.principal.version, status: 'removed' }), { status: 409 });
    await assert.rejects(auth.updateUser(first.principal, first.principal.id, { version: first.principal.version, role: 'member' }), { status: 409 });
    const pending = await auth.invite(first.principal, { email: 'pending-master@example.test', name: 'Pending', role: 'master' });
    const disabledPending = await auth.updateUser(first.principal, pending.user.id, { version: pending.user.version, status: 'disabled' });
    const enabledPending = await auth.updateUser(first.principal, pending.user.id, { version: disabledPending.user.version, status: 'active' });
    assert.equal(enabledPending.user.status, 'pending');
    await assert.rejects(auth.updateUser(first.principal, first.principal.id, { version: first.principal.version, status: 'disabled' }), { status: 409 });
    const invited = await auth.invite(first.principal, { email: 'second@example.test', name: 'Second', role: 'master' });
    const consumed = await Promise.allSettled([auth.acceptInvite({ token: invited.token, password: PASSWORD }),auth.acceptInvite({ token: invited.token, password: PASSWORD })]);
    assert.equal(consumed.filter(x => x.status === 'fulfilled').length, 1);
    const second = await auth.login({ email: 'second@example.test', password: PASSWORD });
    const results = await Promise.allSettled([
      auth.updateUser(first.principal, first.principal.id, { version: first.principal.version, status: 'disabled' }),
      auth.updateUser(second.principal, second.principal.id, { version: second.principal.version, status: 'disabled' }),
    ]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal((await db.query("select count(*)::int as n from bob.auth_users where role='master' and status='active'"))[0].n, 1);
    const disabled = results[0].status === 'fulfilled' ? first : second;
    await assert.rejects(auth.invite(disabled.principal, { email: 'bad@example.test', name: 'Bad' }), { status: 401 });
    const survivor = disabled === first ? second : first;
    await auth.logout(survivor.token);
    await assert.rejects(auth.revalidate(survivor.principal), { status: 401 });
  });

  test(`${adapter}: malformed mode and database failures never fall back to shared auth`, async t => {
    const { auth, store, db, owner } = await fixture(t, rest);
    const master = await owner();
    await db.query('delete from bob.kv where key=$1', ['admin-auth:authority']);
    await assert.rejects(auth.mode(), { status: 503 });
    await assert.rejects(auth.authenticate(master.token), { status: 503 });
    await assert.rejects(auth.invitationDetails({ token: 'a'.repeat(43) }), { status: 503 });
    await assert.rejects(auth.mode(), { status: 503 });
    assert.equal((await db.query('select value from bob.kv where key=$1', ['admin-auth:authority'])).length, 0);
    await store.kvSet('admin-auth:authority', { mode: 'unexpected' });
    await assert.rejects(auth.mode(), { status: 503 });
    await assert.rejects(auth.prepareOwnerBootstrap({ email: 'owner@example.test', name: 'Owner' }), { status: 503 });
    const broken = createAdminAuth({ store: { db: { query: async () => { throw new Error('synthetic outage'); } } } });
    await assert.rejects(broken.mode(), { status: 503 });
    await assert.rejects(broken.authenticate('a'.repeat(43)), { status: 503 });
  });

  test(`${adapter}: named password scheme pins required work factors and rejects unknown or missing schemes`, async t => {
    const { auth, db, owner } = await fixture(t, rest);
    const master = await owner();
    const [stored] = await db.query('select password_salt,password_hash,password_scheme from bob.auth_users where id=$1', [master.principal.id]);
    assert.equal(stored.password_scheme, 'scrypt-v1-N16384-r8-p5-l64');
    assert.equal(stored.password_hash, scryptSync(PASSWORD, stored.password_salt, 64, { N: 16384, r: 8, p: 5, maxmem: 32 * 1024 * 1024 }).toString('hex'));
    for (const scheme of ['unknown-scheme', null]) {
      await db.query('update bob.auth_users set password_scheme=$1 where id=$2', [scheme, master.principal.id]);
      await assert.rejects(auth.login({ email: 'owner@example.test', password: PASSWORD }), { status: 401 });
    }
    await assert.rejects(auth.login({ email: 'missing@example.test', password: PASSWORD }), { status: 401 });
    await db.query('update bob.auth_users set password_scheme=$1 where id=$2', [ADMIN_AUTH_PASSWORD_SCHEME, master.principal.id]);
    assert.equal((await auth.login({ email: 'owner@example.test', password: PASSWORD })).principal.id, master.principal.id);
  });
}
