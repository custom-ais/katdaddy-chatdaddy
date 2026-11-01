import React, { useEffect, useState } from 'react';
import { Link2 } from 'lucide-react';
import { normalizeClientHubUrl } from '../../shared/client-hub.mjs';
import { api } from '../lib/api';
import { useDashboard } from './DashboardContext';
import { ErrorNote, Field, Section, inputClass, primaryButton, secondaryButton } from './ui';

export function ClientHubSettings() {
  const { data, mutate } = useDashboard();
  const saved = data.integrations?.clientHub;
  const [url, setUrl] = useState(saved?.url || '');
  const [dirty, setDirty] = useState(false);
  const [identity, setIdentity] = useState<{accountName: string; confirmationToken: string} | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { if (!dirty) setUrl(saved?.url || ''); }, [saved?.url, dirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const verify = async () => {
    setBusy(true); setError(''); setIdentity(null); setConfirmed(false);
    try { setIdentity(await api('/api/admin/jobber/client-hub/identity', { method: 'POST', body: {} })); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const save = async () => {
    setError('');
    try {
      const normalized = normalizeClientHubUrl(url);
      if (normalized && (!identity || !confirmed)) throw new Error('Verify the connected account and confirm where you copied the link first.');
      setBusy(true);
      await mutate('/api/admin/jobber/client-hub', { url: normalized, confirmAccount: normalized ? confirmed : false, ...(normalized ? { confirmationToken: identity!.confirmationToken } : {}) }, 'POST', 'Client Hub link saved');
      setUrl(normalized); setDirty(false); setConfirmed(false); setIdentity(null);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <Section icon={<Link2 size={18} />} title="Client Hub link in confirmation emails" description="Optional. Added only to post-booking confirmation emails, never verification codes or texts. Blank disables the link; it does not disconnect Jobber.">
    <p className="text-sm text-slate-600">{saved?.enabled ? `Saved for ${saved.accountName || 'the connected Jobber account'}.` : 'No active Client Hub email link.'} {saved?.reason && 'If the account changed or is unavailable, verify it again before saving a link.'}</p>
    <Field label="Public Client Hub shared-login URL" hint="Copy the shared login link from this Jobber account’s Settings → Client hub. Do not paste a personal customer, invoice or token link.">
      <input className={inputClass} type="url" autoComplete="off" value={url} disabled={busy} placeholder="Optional — leave blank to disable" onChange={event => { setUrl(event.target.value); setDirty(true); setConfirmed(false); }} />
    </Field>
    <button type="button" className={secondaryButton} disabled={busy || !url} onClick={verify}>Verify account for link</button>
    {identity && <div className="space-y-2 text-sm"><p>Verified connected account: <strong>{identity.accountName}</strong></p><label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => { setConfirmed(event.target.checked); setDirty(true); }} />I copied this shared-login URL from {identity.accountName}’s Settings → Client hub.</label></div>}
    <p className="text-xs text-slate-500">Account verification does not prove ownership of the pasted URL. Your confirmation identifies its source. Saving checks the account again; if it changed or verification expired, verify again.</p>
    {error && <ErrorNote>{error}</ErrorNote>}
    {dirty && <p role="status" className="text-sm font-semibold text-amber-800">Unsaved Client Hub link — kept as you switch sections.</p>}
    <div className="flex gap-2"><button type="button" className={primaryButton} disabled={busy || !dirty || (!!url && (!identity || !confirmed))} onClick={save}>{busy ? 'Working…' : 'Save Client Hub'}</button><button type="button" className={secondaryButton} disabled={busy || !dirty} onClick={() => { setUrl(saved?.url || ''); setDirty(false); setIdentity(null); setConfirmed(false); setError(''); }}>Discard Client Hub changes</button></div>
    <p className="text-xs text-slate-500">Client Hub changes use Save Client Hub. Other settings use the page’s Save button. Saving does not send a test email.</p>
  </Section>;
}
