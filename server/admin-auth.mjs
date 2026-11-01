import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { PERMISSION_KEYS, MASTER_ONLY_PERMISSIONS } from '../shared/admin-permissions.mjs';
import { ADMIN_AUTH_PASSWORD_SCHEME } from './admin-auth-schema.mjs';

const derive = promisify(scrypt);
// OWASP's 16 MiB scrypt profile; explicit parameters must not drift with runtime defaults.
const PASSWORD_OPTIONS = Object.freeze({ N: 16384, r: 8, p: 5, maxmem: 32 * 1024 * 1024 });
const SESSION = Symbol('authenticated account session');
const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const keys = new Set(PERMISSION_KEYS);
const reserved = new Set(MASTER_ONLY_PERMISSIONS);
const DAY = 86_400_000;
const publicPrincipal = (value, sessionHash) => {
  const principal = { ...value };
  Object.defineProperty(principal, SESSION, { value: sessionHash });
  return principal;
};
const cleanEmail = value => {
  if (typeof value !== 'string') throw fail('Enter a valid account email.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail('Enter a valid account email.');
  return email;
};
const cleanName = value => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) throw fail('Enter a name of at most 100 characters.');
  return value.trim();
};
const permissions = value => {
  if (!Array.isArray(value) || value.some(key => typeof key !== 'string' || !keys.has(key) || reserved.has(key))) {
    throw fail('Choose only the available member permissions.');
  }
  return [...new Set(value)].sort();
};
const role = value => {
  if (!['master', 'member'].includes(value)) throw fail('Choose a valid account role.');
  return value;
};
const tokenHash = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw fail('This invitation or session is invalid.', 400);
  return hash(value);
};
async function passwordRecord(password) {
  if (typeof password !== 'string' || password.length < 14 || password.length > 200) throw fail('Use a password of 14 to 200 characters.');
  const salt = token();
  return { salt, hash: (await derive(password, salt, 64, PASSWORD_OPTIONS)).toString('hex'), scheme: ADMIN_AUTH_PASSWORD_SCHEME };
}
async function passwordMatches(password, record) {
  // Missing users still perform the password derivation; responses do not identify accounts.
  const text = typeof password === 'string' && password.length <= 200 ? password : '';
  const known = record?.password_scheme === ADMIN_AUTH_PASSWORD_SCHEME && typeof record?.password_salt === 'string' && /^[a-f\d]{128}$/i.test(record?.password_hash || '');
  const salt = known ? record.password_salt : 'chatdaddy-nonexistent-account-salt';
  // Missing accounts and unknown schemes use the same cost and cannot fall back to a weaker hash.
  const computed = await derive(text, salt, 64, PASSWORD_OPTIONS);
  const saved = known ? Buffer.from(record.password_hash, 'hex') : Buffer.alloc(64);
  const matches = timingSafeEqual(computed, saved);
  return known && matches;
}

export function createAdminAuth({ store, clock = Date.now }) {
  const query = async (sql, args) => {
    try { return await store.db.query(sql, args); }
    catch { throw fail('Account access is temporarily unavailable. Please retry.', 503); }
  };
  const command = async (operation, payload = {}) => {
    const rows = await query('select bob.admin_auth_command($1,$2::jsonb,$3) as result', [operation, JSON.stringify({ ...payload, auditId: randomUUID() }), clock()]);
    const result = rows[0]?.result;
    if (!result || typeof result !== 'object') throw fail('Account access is temporarily unavailable.', 503);
    if (result.error) throw fail(result.error, result.status || 503);
    return result;
  };
  const actor = principal => {
    if (!principal?.[SESSION]) throw fail('Please sign in to your account.', 401);
    return { sessionHash: principal[SESSION] };
  };
  const invitation = () => {
    const raw = token();
    return { raw, fields: { invitationId: randomUUID(), tokenHash: hash(raw), expires: clock() + DAY } };
  };
  async function mode() {
    const rows = await query('select value from bob.kv where key=$1', ['admin-auth:authority']);
    if (!rows.length) {
      const [schema] = await query("select to_regclass('bob.auth_users') as relation", []);
      if (schema?.relation && (await query('select 1 from bob.auth_users limit 1', [])).length) {
        throw fail('Account authority is missing. Operator review is required.', 503);
      }
      return 'legacy';
    }
    const value = rows[0].value?.mode;
    if (!['legacy', 'named'].includes(value)) throw fail('Account access is temporarily unavailable.', 503);
    return value;
  }
  async function login({ email, password } = {}) {
    let normalized;
    try { normalized = cleanEmail(email); } catch { normalized = ''; }
    const rows = await query('select * from bob.auth_users where email=$1', [normalized]);
    const user = rows[0];
    if (!await passwordMatches(password, user) || user?.status !== 'active') throw fail('Invalid email or password.', 401);
    const raw = token(), sessionHash = hash(raw);
    const result = await command('login', { userId: user.id, expectedVersion: user.version, sessionHash, expires: clock() + 8 * 3_600_000 });
    return { token: raw, principal: publicPrincipal(result.principal, sessionHash), pendingCutover: result.pendingCutover === true };
  }
  async function authenticate(raw) {
    let sessionHash;
    try { sessionHash = tokenHash(raw); } catch { throw fail('Please sign in to your account.', 401); }
    const user = await command('authenticate', { sessionHash });
    return publicPrincipal(user, sessionHash);
  }
  async function revalidate(principal) {
    const current = await command('authenticate', actor(principal));
    return publicPrincipal(current, principal[SESSION]);
  }
  // References are for server-held OAuth state only; never return them in API data.
  function sessionReference(principal) { return actor(principal).sessionHash; }
  async function authenticateReference(reference) {
    if (typeof reference !== 'string' || !/^[a-f\d]{64}$/.test(reference)) throw fail('Please sign in to your account.', 401);
    return publicPrincipal(await command('authenticate', { sessionHash: reference }), reference);
  }
  async function logout(raw) {
    let sessionHash;
    try { sessionHash = tokenHash(raw); } catch { return { signedOut: true }; }
    try { return await command('logout', { sessionHash }); }
    catch (error) { if (error.status === 401) return { signedOut: true }; throw error; }
  }
  // Operator-only methods. Deliberately no public HTTP route issues these capabilities.
  async function prepareOwnerBootstrap({ email, name, ttlMs = 3_600_000 } = {}) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 300_000 || ttlMs > 3_600_000) throw fail('Owner bootstrap must expire within one hour.');
    const prepared = invitation();
    const result = await command('prepare_owner', { email: cleanEmail(email), name: cleanName(name), userId: randomUUID(), ...prepared.fields, expires: clock() + ttlMs });
    return { ...result, token: prepared.raw };
  }
  async function activateNamedMode({ ownerId } = {}) {
    if (typeof ownerId !== 'string' || !ownerId) throw fail('Specify the verified prepared owner account.');
    return command('activate_named', { ownerId });
  }
  async function invitationDetails({ token: raw } = {}) {
    return command('invitation_details', { tokenHash: tokenHash(raw) });
  }
  async function accept(raw, password, owner) {
    const digest = tokenHash(raw);
    const record = await passwordRecord(password);
    return command(owner ? 'accept_owner' : 'accept_invite', { tokenHash: digest, ...record });
  }
  async function acceptOwnerBootstrap({ token: raw, password } = {}) { return accept(raw, password, true); }
  async function acceptInvite({ token: raw, password } = {}) { return accept(raw, password, false); }
  async function listUsers(principal) { return command('list_users', actor(principal)); }
  async function invite(principal, { email, name, permissions: granted = [], role: assignedRole = 'member' } = {}) {
    const prepared = invitation();
    const result = await command('invite', { ...actor(principal), email: cleanEmail(email), name: cleanName(name), permissions: permissions(granted), role: role(assignedRole), userId: randomUUID(), ...prepared.fields });
    return { ...result, token: prepared.raw };
  }
  async function updateUser(principal, id, patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['version','name','permissions','role','status'].includes(key))) throw fail('Invalid account update.');
    if (!Number.isSafeInteger(patch.version) || patch.version < 1) throw fail('Refresh the account before saving.');
    const update = { ...actor(principal), userId: id, version: patch.version };
    if ('name' in patch) update.name = cleanName(patch.name);
    if ('permissions' in patch) update.permissions = permissions(patch.permissions);
    if ('role' in patch) update.role = role(patch.role);
    if ('status' in patch) {
      if (!['active','disabled','removed'].includes(patch.status)) throw fail('Choose a valid account status.');
      update.status = patch.status;
    }
    return command('update_user', update);
  }
  async function revokeInvite(principal, id) { return command('revoke_invite', { ...actor(principal), invitationId: id }); }
  async function resetInvite(principal, id) {
    const prepared = invitation();
    const result = await command('reset_invite', { ...actor(principal), userId: id, ...prepared.fields });
    return { ...result, token: prepared.raw };
  }
  async function changePassword(principal, { currentPassword, newPassword } = {}) {
    const session = actor(principal);
    const [user] = await query('select * from bob.auth_users where id=$1', [principal.id]);
    if (!await passwordMatches(currentPassword, user)) throw fail('Current password is incorrect.', 403);
    const record = await passwordRecord(newPassword);
    return command('change_password', { ...session, expectedVersion: user.version, ...record });
  }
  return { mode, login, authenticate, revalidate, sessionReference, authenticateReference, logout, prepareOwnerBootstrap, acceptOwnerBootstrap, activateNamedMode,
    invitationDetails, acceptInvite, listUsers, invite, updateUser, revokeInvite, resetInvite, changePassword };
}
