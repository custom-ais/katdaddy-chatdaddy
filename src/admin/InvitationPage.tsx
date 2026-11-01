import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { ErrorNote, Field, inputClass, primaryButton, secondaryButton } from './ui';

type Details = { email: string; name: string; kind: 'invite' | 'reset' | 'owner_bootstrap'; expires: number };
export function InvitationPage({ invitation }: { invitation: { kind: 'invite' | 'bootstrap'; token: string } }) {
  const [token, setToken] = useState(invitation.token);
  const [details, setDetails] = useState<Details | null>(null);
  const [password, setPassword] = useState(''), [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [accepted, setAccepted] = useState(false);
  useEffect(() => {
    // Keep a bearer invitation out of subsequent navigation, copy/share URLs and browser history.
    history.replaceState(null, '', '/admin');
    let active = true;
    if (!token) { setError('This invitation link is incomplete. Ask the Master Admin for a new private link.'); return; }
    void api('/api/admin/invite/details', { method: 'POST', body: { token } }).then(result => {
      if (!active) return;
      if ((result.kind === 'owner_bootstrap') !== (invitation.kind === 'bootstrap')) throw new Error('This link is not valid for this account setup.');
      setDetails(result);
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);
  const accept = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !details || !token) return;
    if (password !== again) { setError('The passwords do not match.'); return; }
    setBusy(true); setError('');
    try {
      await api(invitation.kind === 'bootstrap' ? '/api/admin/owner-bootstrap/accept' : '/api/admin/invite/accept', { method: 'POST', body: { token, password } });
      setToken(''); setPassword(''); setAgain(''); setAccepted(true);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <main className="min-h-dvh bg-slate-100 flex items-center justify-center p-4"><div className="max-w-lg w-full rounded-3xl bg-white border border-slate-200 p-7 space-y-5">
    <h1 className="text-2xl font-black text-slate-900">{accepted ? 'Account password saved' : details?.kind === 'reset' ? 'Reset your account password' : 'Accept your account invitation'}</h1>
    {accepted ? <><p role="status" className="text-sm text-slate-700">Your password is saved for {details?.email}. {invitation.kind === 'bootstrap' ? 'Owner setup is still awaiting the separately authorized authentication cutover.' : 'Sign in with this account email and your new password.'}</p><button type="button" className={primaryButton} onClick={async () => { try { await api('/api/admin/logout', { method: 'POST', body: {} }); } catch {} location.assign('/admin?account=1'); }}>Continue to sign in</button></> : details ? <form className="space-y-4" onSubmit={accept}>
      <p className="text-sm text-slate-700">This private link is for <strong>{details.name || details.email}</strong> ({details.email}). Your account and access were selected by the administrator. If this is not your account, close this page.</p>
      <p className="text-xs text-slate-500">Expires {new Date(details.expires).toLocaleString()}. The link can be used once.</p>
      <Field label="New password (14+ characters)"><input className={inputClass} type="password" autoComplete="new-password" minLength={14} maxLength={200} required value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></Field>
      <Field label="Repeat new password"><input className={inputClass} type="password" autoComplete="new-password" minLength={14} maxLength={200} required value={again} disabled={busy} onChange={event => setAgain(event.target.value)} /></Field>
      <button className={primaryButton} disabled={busy}>{busy ? 'Saving…' : 'Save my account password'}</button>
    </form> : !error && <p className="text-sm text-slate-600">Checking this invitation…</p>}
    {error && <ErrorNote>{error}</ErrorNote>}
    {!accepted && <a className={secondaryButton} href="/admin">Return to sign in</a>}
  </div></main>;
}
