import React, { useEffect, useRef, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { PhoneInput } from '../components/PhoneInput';
import { api } from '../lib/api';
import { useDashboard } from './DashboardContext';
import { ErrorNote, Field, Section, inputClass, primaryButton, secondaryButton } from './ui';

type ConsentSnapshot = { revision: number; effectiveActive?: boolean; matchesConfiguredPhone?: boolean; current: any; disclosure: {version: string; text: string; purposes: string[]}; readiness: {stopHelpVerified: boolean; automaticActivation: boolean} };
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
    try { const result = await api('/api/admin/owner-sms-consent'); if (mounted.current && generation.current === request) { if (result.revision !== snapshot?.revision) setNotice(''); setSnapshot(result); setAgreed(false); } }
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
      setNotice(action === 'grant' ? 'Consent saved. No SMS was sent and alerts were not activated. Owner SMS is held pending separate Custom-AIs setup and activation.' : 'Consent revoked. Owner SMS is blocked; existing alert switches are unchanged. No text was sent.');
    } catch (e) { if (mounted.current && generation.current === request) setError((e as Error).message); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  return <Section icon={<MessageSquare size={18} />} title="Custom-AIs owner SMS consent" description="Planned Custom-AIs program: explicit opt-in for owner-only transactional notifications about confirmed ChatDaddy bookings and actionable failures. This form records consent only; it does not activate alerts, change customer messaging or send texts.">
    <p className="text-sm text-amber-800">Setup review required: the owner SMS privacy section and SMS program terms have been published. STOP/HELP sender behavior has not been verified. Do not treat this form as proof the SMS program is ready to launch.</p>
    <div className="space-y-1 text-sm"><p><a className="font-semibold text-orange-700 underline" href="https://custom-ais.com/privacy#sms-privacy" target="_blank" rel="noreferrer">Privacy policy — owner SMS section</a></p><p><a className="font-semibold text-orange-700 underline" href="https://custom-ais.com/sms-terms" target="_blank" rel="noreferrer">SMS program terms</a></p><p>Support: <a className="font-semibold text-orange-700 underline" href="mailto:support@custom-ais.com">support@custom-ais.com</a>. This is a support email, not verified SMS HELP handling.</p><p className="text-xs text-slate-500">The policy pages are published, but public accessibility has not been confirmed in this review.</p></div>
    <Field label="Owner mobile number for this consent" hint="Starts with the saved owner-alert recipient. Changing it here does not change that setting; save a new recipient in Owner booking alerts first. A phone change requires new consent."><PhoneInput className={inputClass} type="tel" autoComplete="tel" value={phone} disabled={busy || !snapshot} onValueChange={value => { generation.current++; setPhone(value); setAgreed(false); setNotice(''); }} /></Field>
    {snapshot ? <>
      <p className="whitespace-pre-wrap text-sm text-slate-700">{snapshot.disclosure.text}</p>
      <p className="text-xs text-slate-500">Message frequency varies. Message and data rates may apply. STOP is intended to opt out and HELP to request assistance; these responses must be verified with the sender before alerts can be activated. Consent is optional.</p>
      <label className="flex items-start gap-3 text-sm font-semibold text-slate-800"><input type="checkbox" className="mt-1" checked={agreed} disabled={busy} onChange={event => setAgreed(event.target.checked)} />I control this number and explicitly agree to the Custom-AIs transactional owner SMS purposes and disclosure above.</label>
      {snapshot.current && <div className="rounded-xl bg-slate-50 p-3 text-sm"><p>Recorded consent: {snapshot.current.active ? snapshot.matchesConfiguredPhone === false ? 'not effective for the configured phone' : 'active receipt — owner SMS held pending activation' : 'inactive or revoked'}.</p><p>Phone: {snapshot.current.phone}</p><p>Recorded at: {snapshot.current.at}</p><p>Disclosure version: {snapshot.current.disclosureVersion}</p></div>}
      <div className="flex flex-wrap gap-2"><button type="button" className={primaryButton} disabled={busy || !agreed || !phone.trim()} onClick={() => void submit('grant')}>{busy ? 'Saving…' : 'Save explicit consent'}</button><button type="button" className={secondaryButton} disabled={busy || !snapshot.current?.active} onClick={() => void submit('revoke')}>Revoke recorded consent</button><button type="button" className={secondaryButton} disabled={busy} onClick={() => void load()}>Refresh consent receipt</button></div>
    </> : <div className="space-y-2"><p className="text-sm text-slate-500">{error ? 'The saved disclosure and consent receipt could not be loaded.' : 'Loading the saved disclosure and consent receipt…'}</p><button type="button" className={secondaryButton} disabled={busy} onClick={() => void load()}>Retry loading consent form</button></div>}
    {error && <ErrorNote>{error}</ErrorNote>}
    {notice && <p role="status" className="rounded-xl bg-blue-50 p-3 text-sm text-blue-900">{notice}</p>}
    <p className="text-xs text-slate-500">This separate consent receipt does not preselect from older booking-alert settings. Existing alert switches remain unchanged. Once this planned-program receipt exists, owner SMS stays held until separate setup and activation; revocation blocks owner SMS. Review the linked privacy policy and SMS program terms before recording consent.</p>
  </Section>;
}
