import React, { useEffect, useState } from 'react';
import { Users } from 'lucide-react';
import { PERMISSIONS } from '../../shared/admin-permissions.mjs';
import { api } from '../lib/api';
import { useDashboard } from './DashboardContext';
import { ErrorNote, Field, Modal, Section, inputClass, primaryButton, secondaryButton } from './ui';

type User = { id: string; email: string; name: string; role: string; status: string; permissions: string[]; version: number };
type Invitation = { id: string; userId: string; email: string; name: string; kind: string; status: string; expires: number };
const masterOnly = new Set(['users.manage', 'integrations.manage', 'ownerSms.manage', 'exports.download']);
const memberPermissions = PERMISSIONS.filter((permission: any) => !masterOnly.has(permission.key));

export function updatePermissionSelection(current: string[], key: string, checked: boolean): string[] {
  const next = new Set(current);
  if (checked) {
    next.add(key);
    if (key.endsWith('.manage')) next.add(key.replace(/\.manage$/, '.view'));
    if (key === 'appointments.send') next.add('appointments.view');
    if (['analytics.view', 'activity.view', 'settings.answers.view', 'settings.answers.manage', 'settings.templates.view', 'settings.templates.manage', 'settings.services.manage'].includes(key)) next.add('finance.view');
  } else {
    next.delete(key);
    if (key.endsWith('.view')) next.delete(key.replace(/\.view$/, '.manage'));
    if (key === 'appointments.view') next.delete('appointments.send');
    if (key === 'finance.view') { for (const dependent of ['analytics.view', 'activity.view', 'settings.answers.view', 'settings.answers.manage', 'settings.templates.view', 'settings.templates.manage', 'settings.services.manage']) next.delete(dependent); }
  }
  return [...next].filter(value => memberPermissions.some((permission: any) => permission.key === value));
}

function Permissions({ selected, onChange, disabled = false }: { selected: string[]; onChange: (next: string[]) => void; disabled?: boolean }) {
  const groups = [...new Set(memberPermissions.map((permission: any) => permission.group))] as string[];
  return <fieldset disabled={disabled} className="space-y-4">
    <legend className="text-sm font-bold text-slate-900 mb-2">Pages and actions</legend>
    <p className="text-xs text-slate-500">Choose access explicitly. Viewing a page does not permit changes. Selecting Analytics, activity, answers, templates, or Edit services also selects financial access. Creating office bookings requires financial access too. New pages start with no access.</p>
    <p className="text-xs text-slate-500">Manual confirmation access controls the manual send button. Booking and approval actions can still send configured automatic notifications; consent and sending holds still apply.</p>
    <div className="grid gap-3 sm:grid-cols-2">{groups.map(group => <div key={group} className="rounded-xl border border-slate-200 p-3 space-y-2">
      <p className="text-sm font-bold text-slate-800">{group}</p>
      {memberPermissions.filter((permission: any) => permission.group === group).map((permission: any) => <label key={permission.key} className="flex items-start gap-2 text-sm text-slate-700">
        <input type="checkbox" className="mt-1 accent-orange-500" checked={selected.includes(permission.key)} onChange={event => onChange(updatePermissionSelection(selected, permission.key, event.target.checked))} />{permission.label}
      </label>)}
    </div>)}</div>
  </fieldset>;
}

export function UsersPage() {
  const { can, data } = useDashboard();
  const [users, setUsers] = useState<User[]>([]), [invitations, setInvitations] = useState<Invitation[]>([]);
  const [name, setName] = useState(''), [email, setEmail] = useState(''), [permissions, setPermissions] = useState<string[]>([]);
  const [editing, setEditing] = useState<User | null>(null), [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [delivery, setDelivery] = useState<{ email: string; link: string; expires: number } | null>(null);
  const allowed = can('users.manage');
  const load = async () => {
    if (!allowed) return;
    const result = await api('/api/admin/users');
    setUsers(result.users); setInvitations(result.invitations);
  };
  useEffect(() => { let active = true; if (allowed) void load().catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, [allowed]);
  const run = async (action: () => Promise<void>) => {
    if (busy || !allowed) return;
    setBusy(true); setError(''); setNotice('');
    try { await action(); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const showInvitation = (result: any) => {
    if (typeof result.token !== 'string' || !result.token) throw new Error('The invitation link was not returned. Refresh users before trying again.');
    setDelivery({ email: result.user.email, expires: result.invitation.expires, link: `${location.origin}/admin?invite=1#token=${encodeURIComponent(result.token)}` });
  };
  const invite = (event: React.FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const result = await api('/api/admin/users/invite', { method: 'POST', body: { email, name, permissions, role: 'member' } });
      showInvitation(result); setName(''); setEmail(''); setPermissions([]);
    });
  };
  const update = (user: User, patch: any) => run(async () => {
    await api(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: 'PATCH', body: { version: user.version, ...patch } });
    setEditing(null); setNotice('User updated. Their existing sessions and invitation links have been invalidated. Create a replacement link if they still need to set their password.');
  });
  if (!allowed) return <p role="alert" className="rounded-xl bg-white p-5">You do not have access to user management.</p>;
  return <div className="space-y-6">
    <Section icon={<Users size={18} />} title="Users" description="Master Admin controls named accounts and their page access. Provider management and owner SMS remain Master Admin only." action={<button type="button" className={secondaryButton} disabled={busy} onClick={() => void run(async () => {})}>Refresh users</button>}>
      {error && <ErrorNote>{error}</ErrorNote>}{notice && <p role="status" className="rounded-xl bg-blue-50 p-3 text-sm text-blue-900">{notice}</p>}
      <div className="space-y-3">{users.map(user => <article key={user.id} className="rounded-xl border border-slate-200 p-4 space-y-2">
        <div><p className="font-bold text-slate-900">{user.name || user.email}{user.id === data.access?.id ? ' (you)' : ''}</p><p className="text-sm text-slate-600">{user.email} · {user.role === 'master' ? 'Master Admin' : 'Member'} · {user.status}</p></div>
        {user.role === 'master' ? <p className="text-xs text-slate-500">Full access. Master Admin recovery and role changes require the protected administration process.</p> : user.status !== 'removed' && <div className="flex flex-wrap gap-2">
          <button type="button" className={secondaryButton} disabled={busy} onClick={() => { setEditing(user); setSelected(user.permissions); }}>Edit access</button>
          {user.status !== 'pending' && <button type="button" className={secondaryButton} disabled={busy} onClick={() => void update(user, { status: user.status === 'disabled' ? 'active' : 'disabled' })}>{user.status === 'disabled' ? 'Enable user' : 'Disable user'}</button>}
          <button type="button" className={secondaryButton} disabled={busy} onClick={() => void run(async () => showInvitation(await api(`/api/admin/users/${encodeURIComponent(user.id)}/reset-invite`, { method: 'POST', body: {} })))}>{user.status === 'pending' ? 'Replace invitation' : 'Create password reset link'}</button>
          <button type="button" className={`${secondaryButton} text-rose-700`} disabled={busy} onClick={() => { if (confirm(`Remove access for ${user.email}? Their sessions and invitations will be revoked.`)) void update(user, { status: 'removed' }); }}>Remove access</button>
        </div>}
      </article>)}</div>
      {invitations.some(invite => invite.status === 'pending') && <div className="space-y-2"><h4 className="text-sm font-bold">Pending links</h4>{invitations.filter(invite => invite.status === 'pending').map(invite => <div key={invite.id} className="flex flex-wrap items-center justify-between gap-3 text-sm rounded-xl bg-slate-50 p-3"><p>{invite.email} · {invite.kind === 'reset' ? 'Password reset' : 'Invitation'} · expires {new Date(invite.expires).toLocaleString()}</p><button type="button" className={secondaryButton} disabled={busy} onClick={() => void run(async () => { await api(`/api/admin/invitations/${encodeURIComponent(invite.id)}/revoke`, { method: 'POST', body: {} }); setNotice('Invitation revoked.'); })}>Revoke link</button></div>)}</div>}
    </Section>
    <Section title="Invite a user" description="Create a private, expiring invitation link. No email is sent. The recipient chooses their own password and cannot choose their permissions.">
      <form className="space-y-5" onSubmit={invite}>
        <div className="grid gap-3 sm:grid-cols-2"><Field label="Name"><input className={inputClass} required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></Field><Field label="Account email"><input className={inputClass} type="email" required autoComplete="off" maxLength={254} value={email} onChange={event => setEmail(event.target.value)} /></Field></div>
        <Permissions selected={permissions} onChange={setPermissions} disabled={busy} />
        <button className={primaryButton} disabled={busy}>{busy ? 'Working…' : 'Create invitation link'}</button>
      </form>
    </Section>
    {editing && <Modal title={`Access for ${editing.name || editing.email}`} onClose={() => setEditing(null)}>
      <div className="space-y-4"><Permissions selected={selected} onChange={setSelected} disabled={busy} />{error && <ErrorNote>{error}</ErrorNote>}<div className="flex flex-wrap gap-2"><button type="button" className={primaryButton} disabled={busy} onClick={() => void update(editing, { permissions: selected })}>Save access and invalidate sessions</button><button type="button" className={secondaryButton} onClick={() => setEditing(null)}>Cancel</button></div></div>
    </Modal>}
    {delivery && <Modal title="Private invitation link" onClose={() => setDelivery(null)}>
      <div className="space-y-4"><p className="text-sm">Share this link only with <strong>{delivery.email}</strong>. It expires {new Date(delivery.expires).toLocaleString()} and can be used once. No email has been sent.</p><Field label="Private link" hint="This link is shown only now. Closing this window removes it from this view."><textarea className={inputClass} readOnly rows={3} value={delivery.link} onFocus={event => event.target.select()} /></Field><div className="flex gap-2"><button type="button" className={primaryButton} onClick={async () => { try { await navigator.clipboard.writeText(delivery.link); setNotice('Private link copied.'); } catch { setError('Copy was unavailable. Select the link and copy it manually.'); } }}>Copy private link</button><button type="button" className={secondaryButton} onClick={() => setDelivery(null)}>Close</button></div></div>
    </Modal>}
  </div>;
}
