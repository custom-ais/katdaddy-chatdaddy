import React, { useEffect, useRef, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { PhoneInput } from '../components/PhoneInput';
import { api } from '../lib/api';
import { useDashboard } from './DashboardContext';
import { ErrorNote, Field, Section, inputClass, primaryButton, secondaryButton } from './ui';
import { formatUsPhone } from '../../shared/phone-display.mjs';
import { OWNER_SMS_PROGRAM, OWNER_SMS_TERMS_URL, OWNER_SMS_PRIVACY_URL, OWNER_SMS_SUPPORT_EMAIL } from '../../shared/owner-sms-consent.mjs';

type ConsentReceipt = { id: string; revision: number; action: 'grant' | 'revoke'; active: boolean; phone: string; at: string; disclosureVersion: string; disclosure: string; purposes: string[]; actor: {type: 'authenticated_admin_user' | 'authenticated_admin_session'; userId?: string; reference: string}; requestFingerprint: string };
type ConsentSnapshot = { revision: number; effectiveActive: boolean; matchesConfiguredPhone: boolean; currentVersion: boolean; covers?: string[]; current: ConsentReceipt | null; disclosure: {version: string; text: string; purposes: string[]; termsUrl: string; privacyUrl: string} };
const receiptDate = (at: string) => new Date(at).toLocaleDateString('en-US', { timeZone: 'America/Phoenix', year: 'numeric', month: 'long', day: 'numeric' });
function linkedDisclosure(text: string) {
  return text.split(/(https:\/\/\S+)/g).map((part, index) => part === OWNER_SMS_TERMS_URL || part === OWNER_SMS_PRIVACY_URL
    ? <a key={index} className="break-all text-orange-700 underline" href={part} target="_blank" rel="noreferrer">{part}</a>
    : part);
}
export function OwnerSmsConsent() {
  const { data } = useDashboard();
  const configuredPhone = data.config.bookingOwnerSmsPhone || '';
  const [phone, setPhone] = useState(configuredPhone);
  const [agreed, setAgreed] = useState(false);
  const [snapshot, setSnapshot] = useState<ConsentSnapshot | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const pending = useRef(false);
  const generation = useRef(0), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const load = async () => {
    const request = ++generation.current;
    setError(''); setAgreed(false);
    try { const result = await api('/api/admin/owner-sms-consent'); if (mounted.current && generation.current === request) { if (result.revision !== snapshot?.revision || result.currentVersion !== snapshot?.currentVersion || result.matchesConfiguredPhone !== snapshot?.matchesConfiguredPhone) setNotice(''); setSnapshot(result); setAgreed(false); } }
    catch (e) { if (mounted.current && generation.current === request) setError((e as Error).message); }
  };
  useEffect(() => { setPhone(configuredPhone); setAgreed(false); setNotice(''); void load(); }, [configuredPhone]);
  const submit = async (action: 'grant' | 'revoke') => {
    if (pending.current || !snapshot || (action === 'grant' && !agreed)) return;
    const request = ++generation.current;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const result = await api('/api/admin/owner-sms-consent', { method: 'POST', body: { action, revision: snapshot.revision, idempotencyKey: crypto.randomUUID(), ...(action === 'grant' ? {phone,consent:true,disclosureVersion:snapshot.disclosure.version} : {}) } });
      if (!mounted.current || generation.current !== request) return;
      setSnapshot(result); setAgreed(false);
      setNotice(action === 'grant'
        ? result.effectiveActive === true ? 'Consent saved. Owner alerts will go to this number while Owner booking alerts are on.' : ''
        : result.current?.active === false ? 'Consent withdrawn. No owner alerts will be sent to this number.' : '');
    } catch (e) { if (mounted.current && generation.current === request) setError((e as Error).message); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  return <Section icon={<MessageSquare size={18} />} title={`${OWNER_SMS_PROGRAM} — text message consent`} description="Optional. Check the box below to get text alerts on this phone. You can withdraw consent here at any time or reply STOP to any alert.">
    <Field label="Mobile number for owner alerts" hint="Must match the number saved in Owner booking alerts above. A different number needs new consent."><PhoneInput className={inputClass} type="tel" autoComplete="tel" value={phone} disabled={busy || !snapshot} onValueChange={value => { generation.current++; setPhone(value); setAgreed(false); setNotice(''); }} /></Field>
    {snapshot ? <>
      <label className="flex items-start gap-3 text-sm font-semibold text-slate-800"><input type="checkbox" className="mt-1" checked={agreed} disabled={busy} onChange={event => setAgreed(event.target.checked)} /><span>{linkedDisclosure(snapshot.disclosure.text)}</span></label>
      {snapshot.current && <div className="rounded-xl bg-slate-50 p-3 text-sm"><p>{snapshot.current.active ? snapshot.currentVersion === false ? snapshot.covers?.includes('booking_success') ? 'Consent on file covers booking alerts and service errors. To also get after-hours emergency requests by text, check the box and save again.' : 'Consent on file uses an older version of these terms. Check the box and save again to receive alerts.' : snapshot.matchesConfiguredPhone === false ? 'Consent on file is for a different number. Save consent for the number above to receive alerts.' : `Consent on file for ${formatUsPhone(snapshot.current.phone)} since ${receiptDate(snapshot.current.at)}.` : `Consent withdrawn on ${receiptDate(snapshot.current.at)}.`}</p><p>Terms version: {snapshot.current.disclosureVersion}</p></div>}
      <div className="flex flex-wrap gap-2"><button type="button" className={primaryButton} disabled={busy || !agreed || !phone.trim()} onClick={() => void submit('grant')}>{busy ? 'Saving…' : 'Save consent'}</button><button type="button" className={secondaryButton} disabled={busy || !snapshot.current?.active} onClick={() => void submit('revoke')}>Withdraw consent</button><button type="button" className={secondaryButton} disabled={busy} onClick={() => void load()}>Refresh status</button></div>
    </> : <div className="space-y-2"><p className="text-sm text-slate-500">{error ? 'The saved disclosure and consent receipt could not be loaded.' : 'Loading the saved disclosure and consent receipt…'}</p><button type="button" className={secondaryButton} disabled={busy} onClick={() => void load()}>Retry loading consent form</button></div>}
    {error && <ErrorNote>{error}</ErrorNote>}
    {notice && <p role="status" className="rounded-xl bg-blue-50 p-3 text-sm text-blue-900">{notice}</p>}
    <p className="text-xs text-slate-500">Questions? Email <a className="text-orange-700 underline" href={`mailto:${OWNER_SMS_SUPPORT_EMAIL}`}>{OWNER_SMS_SUPPORT_EMAIL}</a>.</p>
  </Section>;
}
