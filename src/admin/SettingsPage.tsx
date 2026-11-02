import { canViewSettings, CONFIG_FIELD_PERMISSIONS } from '../../shared/admin-permissions.mjs';
import { changedConfig, firstAllowedSettings } from './access';
import { OwnerSmsConsent } from './OwnerSmsConsent';
import { MessageTemplates } from './MessageTemplates';
import { ClientHubSettings } from './ClientHubSettings';
import { PhoneInput } from '../components/PhoneInput';
import React, { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Technician } from './DashboardContext';
import { BookOpen, Building2, CalendarClock, CheckCircle2, Code, Download, KeyRound, Loader2, Link2, MapPin, MessageSquare, Plus, RotateCcw, Route, Save, ShieldCheck, Tag, Trash2, Users } from 'lucide-react';
import { api, saveText } from '../lib/api';
import { useDashboard } from './DashboardContext';
import { ErrorNote, Field, Modal, Section, Toggle, inputClass, primaryButton, secondaryButton, subtleButton } from './ui';
import { money } from '../../shared/domain.mjs';
import { PACKAGES } from '../../shared/catalog.mjs';
import { COVERAGE_IN, COVERAGE_TRAVEL } from '../../shared/coverage.mjs';

const ServiceAreaMap = lazy(() => import('./ServiceAreaMap').then((m) => ({ default: m.ServiceAreaMap })));

const int = (v: string) => (v === '' ? 0 : Math.round(Number(v)));
const cents = (v: string) => Math.round(Number(v || 0) * 100);
const list = (v: string) => v.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

function Num({ label, value, onChange, hint, step = 1, min = 0, max, suffix, disabled }: { label: string; value: number; onChange: (n: number) => void; hint?: React.ReactNode; step?: number; min?: number; max?: number; suffix?: string; disabled?: boolean }) {
  // Typing is free; leaving the field snaps an out-of-range number back inside the allowed range.
  const clamp = (n: number) => Math.min(max ?? Infinity, Math.max(min, Number.isFinite(n) ? n : min));
  return (
    <Field label={suffix ? `${label} (${suffix})` : label} hint={hint}>
      <input className={inputClass} type="number" inputMode="numeric" step={step} min={min} max={max} disabled={disabled} value={Number.isFinite(value) ? value : 0} onChange={(e) => onChange(int(e.target.value))} onBlur={() => { const n = clamp(value); if (n !== value) onChange(n); }} />
    </Field>
  );
}

// "13:00" or 13 → "1 PM", "13:30" → "1:30 PM", 12 → "noon".
function clock(t: string | number) {
  const [h, m = 0] = typeof t === 'number' ? [t, 0] : t.split(':').map(Number);
  if (h === 12 && !m) return 'noon';
  const hour = h % 12 || 12;
  return `${hour}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

// One plain-words example of what the two same-day numbers do together, using the real start times.
function sameDayExample(c: any) {
  const { cutoffHour, minNoticeHours } = c.sameDay;
  if (minNoticeHours >= c.leadHours) return `Notice is as long as your regular booking notice (${c.leadHours} hours), so same-day adds nothing. Use fewer hours.`;
  const bookedAt = Math.min(8, cutoffHour - 1);
  const earliest = bookedAt + minNoticeHours;
  const first = (c.weekdayStarts as string[]).find((t) => Number(t.split(':')[0]) + Number(t.split(':')[1] || 0) / 60 >= earliest);
  const offer = first ? `the first same-day time they can get is ${clock(first)}` : 'no start times are left today';
  return `Example: a customer booking at ${clock(bookedAt)} on a weekday — ${offer}. From ${clock(cutoffHour)} on, same-day times stop showing.`;
}
function Dollars({ label, value, onChange, hint, disabled }: { label: string; value: number; onChange: (c: number) => void; hint?: React.ReactNode; disabled?: boolean }) {
  const { can } = useDashboard();
  if (!can('finance.view')) return <Field label={label}><span className="text-sm text-slate-500">Restricted</span></Field>;
  return (
    <Field label={`${label} ($)`} hint={hint}>
      <input className={inputClass} type="number" inputMode="decimal" step="1" min={0} disabled={disabled} value={value / 100} onChange={(e) => onChange(cents(e.target.value))} />
    </Field>
  );
}

function Dot({ ok }: { ok: boolean }) {
  return <span className={`mt-1.5 w-2.5 h-2.5 rounded-full shrink-0 ${ok ? 'bg-emerald-500' : 'bg-slate-300'}`} />;
}

const when = (ms: number) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/Phoenix', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Historical diagnostics never imply a current failure or a successful connection. */
function RecordedHealth({ configured, health, legacyIssue }: { configured: boolean; health?: any; legacyIssue?: any }) {
  const checked = Number.isFinite(health?.checkedAt) && health.checkedAt > 0;
  const success = Number.isFinite(health?.lastSuccessAt) && health.lastSuccessAt > 0;
  const active = health?.status === 'error' ? health.activeIssue : null;
  const operationNames: Record<string, string> = { geocode: 'Address lookup', places: 'Address suggestions', routes: 'Driving routes' };
  const operations = Object.entries(health?.operations || {}) as [string, any][];
  const operationSucceeded = (op: any) => configured && op?.status === 'healthy' && op.stale !== true && op.fresh !== false && Number.isFinite(op.lastSuccessAt) && op.lastSuccessAt > 0;
  const partialSuccess = configured && health?.status === 'unknown' && !operations.some(([, op]) => op?.status === 'error') && operations.some(([, op]) => operationSucceeded(op)) && operations.some(([, op]) => !operationSucceeded(op));
  const history = [...(Array.isArray(health?.history) ? health.history : []), health?.lastIssue, legacyIssue]
    .filter((entry, index, all) => entry?.message && !(active && entry.at === active.at && entry.message === active.message) && all.findIndex((other) => other?.at === entry.at && other?.message === entry.message) === index);
  return <div className="mt-2 space-y-1">
    <p className="font-semibold text-slate-700">{!configured ? 'Configuration missing' : health?.status === 'healthy' && success ? 'Configuration present · last recorded check succeeded' : health?.status === 'error' && active ? 'Configuration present · active recorded failure' : partialSuccess ? 'Some recorded checks succeeded; other checks unverified/stale' : 'Configuration present · unverified'}</p>
    <p>Last checked: {checked ? when(health.checkedAt) : 'not yet recorded'}.{success ? ` Last success: ${when(health.lastSuccessAt)}.` : ''} This is recorded status, not a live connection test.</p>
    {operations.length > 0 && <ul className="space-y-1">{operations.map(([name, op]) => <li key={name}><span className="font-semibold">{operationNames[name] || name}:</span> {!configured ? 'configuration missing; unverified' : op?.status === 'error' ? 'recorded failure' : operationSucceeded(op) ? `last recorded check succeeded (${when(op.lastSuccessAt)})` : op?.stale || op?.fresh === false ? 'stale; current status unverified' : Number.isFinite(op?.checkedAt) && op.checkedAt > 0 ? 'unverified' : 'never checked; unverified'}{configured && op?.status === 'error' && op.activeIssue?.message ? ` — ${op.activeIssue.message}` : ''}</li>)}</ul>}
    {active && <p className="font-semibold text-amber-800">Active failure{Number.isFinite(active.at) ? ` (${when(active.at)})` : ''}: {active.message}</p>}
    {history.length > 0 && <details className="pt-1 text-slate-500">
      <summary className="cursor-pointer font-semibold">Previous errors ({history.length}) — history only</summary>
      <ul className="mt-1 space-y-1">{history.map((entry, index) => <li key={`${entry.at}-${index}`}>{Number.isFinite(entry.at) ? `${when(entry.at)}: ` : ''}{entry.message}</li>)}</ul>
    </details>}
  </div>;
}

function AccountIdentity({ account }: { account?: { status?: string; displayName?: string; checkedAt?: number } }) {
  const name = typeof account?.displayName === 'string' ? account.displayName : '';
  const checked = Number.isFinite(account?.checkedAt) && account!.checkedAt! > 0;
  return <p className="mt-2 text-xs text-slate-600">{account?.status === 'verified' && name ? <>Verified account name: <span className="font-semibold">{name}</span></> : account?.status === 'unavailable' ? 'Account name unavailable at the last lookup' : checked ? 'Account name not verified at the last lookup' : 'Account name not yet looked up'}{checked ? ` · checked ${when(account!.checkedAt!)}` : ''}. Optional name lookup only — not a connection or delivery test.</p>;
}

function ConnectionStatus() {
  const { data, refresh, loading } = useDashboard();
  const names: [string, string][] = [['jobber', 'Jobber'], ['verification', 'Verification'], ['sms', 'Appointment texts'], ['email', 'Appointment email'], ['maps', 'Maps'], ['assistant', 'Smart chat']];
  return <Section icon={<Link2 size={18} />} title="Connection status" description="Recorded status only. Provider management, account lookups and messaging controls are restricted to Master Admin." action={<button type="button" className={secondaryButton} disabled={loading} onClick={() => void refresh()}>Refresh recorded status</button>}>
    <dl className="divide-y divide-slate-100">{names.map(([key, label]) => { const state = data.integrations?.[key]; return <div key={key} className="flex justify-between gap-4 py-3 text-sm"><dt className="font-bold">{label}</dt><dd>{!state ? 'Status unavailable' : state.enabled === false ? 'Off' : state.connected === true ? 'Connected' : state.configured === true || state.appConfigured === true ? 'Configuration present' : 'Setup required'}</dd></div>; })}</dl>
    <p className="text-xs text-slate-500">Configuration presence does not verify provider operation or message delivery.</p>
  </Section>;
}

function Connections({ config, onChange }: { config: any; onChange: (key: string, value: any) => void }) {
  const { data, mutate, showToast, refresh, loading } = useDashboard();
  const i = data.integrations || {};
  const accounts: Record<string, any> = { Jobber: i.accounts?.jobber, 'Twilio Verify': i.accounts?.twilio, 'Twilio appointment texts': i.accounts?.twilio };
  const [accountsBusy, setAccountsBusy] = useState(false), [accountsError, setAccountsError] = useState('');
  const [checksBusy, setChecksBusy] = useState(false), [checksError, setChecksError] = useState('');
  const refreshChecks = async () => {
    if (checksBusy) return;
    setChecksBusy(true); setChecksError('');
    try { await mutate('/api/admin/connections/refresh', {}, 'POST', 'Connection status refreshed'); }
    catch (error) { setChecksError((error as Error).message); } finally { setChecksBusy(false); }
  };
  const refreshAccounts = async () => {
    if (accountsBusy) return;
    setAccountsBusy(true); setAccountsError('');
    try { await api('/api/admin/integration-accounts', { method: 'POST', body: {} }); await refresh(); }
    catch (error) { setAccountsError((error as Error).message); }
    finally { setAccountsBusy(false); }
  };
  const [busy, setBusy] = useState(false);
  const disconnect = async () => {
    if (!confirm('Disconnect Jobber? Online booking pauses until you reconnect.')) return;
    setBusy(true);
    try { await mutate('/api/admin/jobber/disconnect', {}, 'POST', 'Jobber disconnected'); } catch (e) { showToast({ type: 'error', title: "Couldn't disconnect", description: (e as Error).message }); } finally { setBusy(false); }
  };
  const enabled = (key: string) => config.integrations?.[key] !== false;
  const offWarning: Record<string, string> = {
    jobber: 'Turning Jobber off pauses online booking. Existing appointments and the connected account remain unchanged. Turn it off in your draft?',
    maps: 'Turning Maps off stops address and routing calls and pauses all online booking, including ZIP-based coverage. Turn it off in your draft?',
    verification: 'Turning Verify off blocks bookings that require verification; it never bypasses the code check. Turn it off in your draft?',
  };
  const switchFor = (key: string, label: string) => <Toggle checked={enabled(key)} onChange={(value) => {
    if (!value && offWarning[key] && !confirm(offWarning[key])) return;
    onChange('integrations', { ...config.integrations, [key]: value });
  }} label={`Enable ${label}`} detail="Changes apply after Save. Unconfigured providers stay unavailable." />;
  const aiProvider = config.aiProvider === 'openai' ? 'openai' : 'gemini';
  const ai = i.assistant?.providers?.[aiProvider];
  const aiName = aiProvider === 'openai' ? 'OpenAI (ChatGPT models)' : 'Gemini';
  const statusFor = (name: string) => {
    const key = ({ Jobber: 'jobber', 'Twilio Verify': 'verification', 'Twilio appointment texts': 'sms', 'SendGrid appointment emails': 'email', Maps: 'maps' } as Record<string, string>)[name];
    const on = name === 'Smart chat' ? config.aiAssistant !== false : key ? enabled(key) : true;
    const savedOn = name === 'Smart chat' ? data.config?.aiAssistant !== false : key ? data.config?.integrations?.[key] !== false : true;
    const draft = on !== savedOn || (name === 'Smart chat' && aiProvider !== (data.config?.aiProvider === 'openai' ? 'openai' : 'gemini'));
    let status = !on ? 'Off' : name === 'Jobber' ? (i.jobber?.connected ? 'Connected' : i.jobber?.appConfigured ? 'Configured — connect account' : 'Setup required') : name === 'Smart chat' ? (ai?.configured ? 'Configured' : 'Setup required') : name === 'Maps' ? (i.maps?.configured || i.maps?.provider === 'google' ? 'Configured' : 'Setup required — Census only') : name === 'Database' ? (['supabase-rest', 'postgres'].includes(i.database) ? 'Configured' : 'Local test storage') : name === 'Server error history' ? 'History' : i[key]?.configured ? 'Configured' : 'Setup required';
    const observedKey = name === 'Smart chat' ? 'assistant' : name === 'Database' ? 'database' : key;
    const observed = name === 'Maps' ? i.maps?.health : i.observed?.[observedKey];
    const fresh = on && !draft && observed?.stale !== true && observed?.fresh !== false && Number.isFinite(observed?.checkedAt) && observed.checkedAt > 0;
    const working = fresh && observed.status === 'healthy' && Number.isFinite(observed.lastSuccessAt) && observed.lastSuccessAt > 0;
    if (working) status = ['sms', 'email'].includes(observedKey) ? 'Accepted recently — delivery unconfirmed' : 'API working — recent operation succeeded';
    else if (fresh && observed.status === 'error') status = 'Recent operation failed';
    return { label: status + (draft ? ' · unsaved draft' : ''), connected: status === 'Connected' || working, configured: status === 'Configured', checkedAt: fresh ? observed.checkedAt : null };
  };
  const configureLinks: Record<string, [string, string][]> = {
    Jobber: [['Server environment', 'https://vercel.com/dashboard']],
    'Twilio Verify': [['Twilio console', 'https://console.twilio.com/'], ['Server environment', 'https://vercel.com/dashboard']],
    'Twilio appointment texts': [['Twilio console', 'https://console.twilio.com/'], ['Server environment', 'https://vercel.com/dashboard']],
    'SendGrid appointment emails': [['SendGrid console', 'https://app.sendgrid.com/'], ['Server environment', 'https://vercel.com/dashboard']],
    'Smart chat': [['Server environment', 'https://vercel.com/dashboard']],
    Maps: [['Server environment', 'https://vercel.com/dashboard']],
    Database: [['Server environment', 'https://vercel.com/dashboard']],
  };
  const rows: [string, boolean, React.ReactNode, React.ReactNode?][] = [
    ['Jobber', enabled('jobber') && !!i.jobber?.connected,
      <>{!enabled('jobber') ? 'Off in these settings: online booking stays paused. Turning this off does not disconnect the saved account.' : i.jobber?.connected ? 'Account connected for the live calendar and scheduled visits.' : i.jobber?.appConfigured ? 'Not connected yet. Online booking stays off until it is.' : 'Unavailable: add JOBBER_CLIENT_ID, JOBBER_CLIENT_SECRET and JOBBER_REDIRECT_URI in the server environment.'}
        {i.jobber?.appConfigured && <div className="mt-2">{i.jobber?.connected ? <button className={subtleButton} onClick={disconnect} disabled={busy}>Disconnect account</button> : <a className={primaryButton} href="/api/admin/jobber/connect">Connect Jobber account</a>}</div>}</>, switchFor('jobber', 'Jobber')],
    ['Twilio Verify', false,
      <>{!enabled('verification') ? 'Off in these settings: required verification blocks online booking; it is never bypassed.' : i.verification?.configured ? 'Configuration present for booking codes by text or email. Delivery is not verified by this status.' : 'Unavailable: server-side Twilio Verify configuration is required. Online booking stays blocked.'}<p className="mt-1">Email verification verifies only email. Verify sends codes, not booking confirmations. Keys stay on the server.</p></>, switchFor('verification', 'verification')],
    ['Twilio appointment texts', false,
      <>{!enabled('sms') ? 'Off in these settings: appointment, owner-alert and company approval texts are suppressed.' : i.sms?.configured ? 'Approved sender configuration present. Delivery is not verified by this status.' : 'Unavailable: configure an approved texting sender on the server before texts can be sent.'}<p className="mt-1">Customer texts require consent. Emergency same-day approval and optional owner booking alerts remain separate rules. Verification codes use the separate Verify switch.</p></>, switchFor('sms', 'appointment texts')],
    ['SendGrid appointment emails', false,
      <>{!enabled('email') ? 'Off in these settings: appointment confirmation emails are suppressed. Verification codes are unaffected.' : i.email?.configured ? 'Sender configuration present. Delivery is not verified by this status.' : 'Unavailable: configure SendGrid and a verified sender on the server before confirmation emails can be sent.'}<p className="mt-1">Uses separate built-in HTML and plain-text appointment messages, not the verification-code template. Independent of SMS. API keys stay server-side.</p></>, switchFor('email', 'appointment emails')],
    ['Smart chat', false,
      <><p>{config.aiAssistant === false ? 'Off: buttons and keyword rules handle the chat.' : ai?.configured ? `${aiName} configuration present${ai.model ? ` (${ai.model})` : ''}. Provider availability is not verified here.` : `${aiName} is unavailable until its API key is configured on the server. The rules-based booking flow remains available.`}</p>
        <Field label="Smart chat provider"><select className={inputClass} value={aiProvider} onChange={(event) => onChange('aiProvider', event.target.value)}><option value="gemini">Gemini</option><option value="openai">OpenAI (ChatGPT models)</option></select></Field>
        <p>OpenAI API usage is billed separately; a ChatGPT subscription does not include API usage. API keys stay server-side, never in this form. AI cannot set prices or book appointments.</p></>,
      <Toggle checked={config.aiAssistant !== false} onChange={(value) => onChange('aiAssistant', value)} label="Enable Smart chat" detail="Changes apply after Save." />],
    ['Maps', enabled('maps') && i.maps?.provider === 'google' && i.maps?.health?.status === 'healthy' && Number.isFinite(i.maps?.health?.lastSuccessAt) && i.maps.health.lastSuccessAt > 0,
      <>{!enabled('maps') ? 'Off in these settings: address and routing calls stop. All online booking is paused, including ZIP-based coverage.' : i.maps?.provider === 'google' ? 'Google configuration is present for address and measured-route lookups.' : 'Census address lookup only. Measured driving routes are unavailable; automatic bookings that need a travel check stay blocked. Add GOOGLE_MAPS_API_KEY for measured driving routes.'}
        {enabled('maps') ? <RecordedHealth configured={i.maps?.configured === true || i.maps?.provider === 'google'} health={i.maps?.health} legacyIssue={i.maps?.issue} /> : <details className="mt-2"><summary className="cursor-pointer">Recorded check history — not current enabled status</summary><RecordedHealth configured={i.maps?.configured === true || i.maps?.provider === 'google'} health={i.maps?.health} legacyIssue={i.maps?.issue} /></details>}</>, switchFor('maps', 'Maps')],
    ['Database', !!i.database, <>{i.database === 'supabase-rest' ? 'Supabase, through the server-side service key.' : i.database === 'postgres' ? 'Postgres connection.' : 'Local test database — data is not kept.'}<p className="mt-1 font-semibold">Required for safe booking state; no on/off switch.</p></>],
    ...(i.lastError ? [['Server error history', false, <details><summary className="cursor-pointer">Previous server error — not a current health check</summary><p>{when(i.lastError.at)} on {i.lastError.path}: {i.lastError.message}</p></details>] as [string, boolean, React.ReactNode]] : []),
  ];
  return (
    <Section icon={<Link2 size={18} />} title="Connections" description="Switches and provider choice are drafts until Save. Configured means server setup is present, not proven operation or delivery. Connected means Jobber account authorization is present. Keys stay server-side. Refresh recorded status reloads the snapshot only; it does not run external provider checks." action={<button type="button" className={subtleButton} disabled={busy || loading} onClick={() => void refresh()}>{loading ? 'Refreshing recorded status…' : 'Refresh recorded status'}</button>}>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={subtleButton} disabled={accountsBusy || busy} onClick={() => void refreshAccounts()}>{accountsBusy ? 'Loading account names…' : 'Refresh account names'}</button>
        <p className="text-xs text-slate-500">Reads account names only. Does not send messages or test routing. Optional Jobber and Twilio account-name lookup only; unavailable names do not mean the integration failed.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3"><button type="button" className={secondaryButton} disabled={checksBusy || busy || loading} onClick={() => void refreshChecks()}>{checksBusy ? 'Checking connections…' : 'Refresh connection status'}</button><p className="text-xs text-slate-500">Checks database access and reads connected account names. Other statuses use recent recorded operations. No test messages, AI requests or Maps calls are made.</p></div>
      {checksError && <ErrorNote>{checksError}</ErrorNote>}
      {accountsError && <ErrorNote>{accountsError}</ErrorNote>}
      <div className="divide-y divide-slate-100">
        {rows.map(([name, _ok, detail, action]) => (
          <div key={name} className="flex flex-col sm:flex-row items-start justify-between gap-3 py-3">
            <div className="flex items-start gap-3"><div><p className="text-sm font-extrabold text-slate-900">{name}</p><span className={`inline-flex my-1 rounded-full px-2 py-0.5 text-xs font-semibold ${statusFor(name).connected ? 'bg-emerald-50 text-emerald-800' : statusFor(name).configured ? 'bg-blue-50 text-blue-800' : 'bg-slate-100 text-slate-600'}`}>{statusFor(name).label}</span>{statusFor(name).checkedAt && <p className="text-xs text-slate-500">Last operation: {when(statusFor(name).checkedAt)}</p>}<div className="text-xs text-slate-500 leading-snug max-w-xl">{detail}{Object.prototype.hasOwnProperty.call(accounts, name) && <AccountIdentity account={accounts[name]} />}</div></div></div>
            <div className="space-y-2">{action}{configureLinks[name] && <div className="flex flex-wrap gap-2">{configureLinks[name].map(([label, href]) => <a key={href} className={subtleButton} href={href} target="_blank" rel="noreferrer">Configure: {label}</a>)}</div>}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}

/** Edits are saved by the floating Save button with the rest of the page. */
function Technicians({ techs, onChange }: { techs: Technician[]; onChange: (next: Technician[]) => void }) {
  const { data, can } = useDashboard();
  const [users, setUsers] = useState<any[] | null>(null);
  useEffect(() => {
    if (can('integrations.manage') && data.integrations?.jobber?.connected) api('/api/admin/jobber/users').then((r) => setUsers(r.users)).catch(() => setUsers([]));
  }, [data.integrations?.jobber?.connected, can]);
  const recipientProtected = (tech: Technician) => tech.id === 'tech-ryan' && !can('integrations.manage');
  const edit = (i: number, patch: any) => {
    if (recipientProtected(techs[i]) && 'phone' in patch) return;
    if (!can('finance.view') && 'bio' in patch) return;
    onChange(techs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  };
  return (
    <Section icon={<Users size={18} />} title="Technicians" description="Link each tech to their Jobber user so BOB reads their own calendar and assigns visits to them."
      action={<button className={secondaryButton} onClick={() => onChange([...techs, { id: `tech-${crypto.randomUUID().slice(0, 8)}`, name: '', phone: '', zone: 'West Valley', status: 'off_duty', color: '#3b82f6', jobberUserId: '', vehicle: '', bio: '' } as Technician])}><Plus size={15} />Add technician</button>}>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {techs.map((t, i) => (
          <div key={t.id} className="rounded-2xl border border-slate-200 p-4 space-y-3 bg-slate-50/50">
            <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
              <Field label="Name"><input className={inputClass} value={t.name} onChange={(e) => edit(i, { name: e.target.value })} /></Field>
              <Field label="Color"><input type="color" className="h-[42px] w-14 rounded-xl border border-slate-200 bg-white p-1" value={t.color} onChange={(e) => edit(i, { color: e.target.value })} /></Field>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Phone" hint={recipientProtected(t) ? 'Master Admin controls this SMS recipient number.' : undefined}><PhoneInput className={inputClass} type="tel" value={t.phone} disabled={recipientProtected(t)} onValueChange={(value) => edit(i, { phone: value })} /></Field>
              <Field label="Truck or van"><input className={inputClass} value={t.vehicle || ''} onChange={(e) => edit(i, { vehicle: e.target.value })} placeholder="Van 2" /></Field>
              <Field label="Home area"><input className={inputClass} value={t.zone} onChange={(e) => edit(i, { zone: e.target.value })} /></Field>
              <Field label="Status">
                <select className={inputClass} value={t.status} onChange={(e) => edit(i, { status: e.target.value })}>
                  <option value="available">Available</option><option value="on_route">On the way</option><option value="on_job">On a job</option><option value="off_duty">Off duty</option>
                </select>
              </Field>
            </div>
            <Field label="Jobber user" hint={users ? undefined : 'Connect Jobber to link technicians.'}>
              <select className={inputClass} value={t.jobberUserId || ''} disabled={!users} onChange={(e) => edit(i, { jobberUserId: e.target.value })}>
                <option value="">Not linked (uses the whole crew calendar)</option>
                {(users || []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </Field>
            <Field label="Short bio for the office" hint={!can('finance.view') ? 'Restricted: viewing and editing office bios requires financial and unrestricted notes access.' : undefined}><textarea rows={2} className={inputClass} disabled={!can('finance.view')} placeholder={!can('finance.view') ? 'Restricted' : undefined} value={can('finance.view') ? t.bio || '' : ''} onChange={(e) => edit(i, { bio: e.target.value })} /></Field>
            {techs.length > 1 && !data.appointments.some((a) => a.technicianId === t.id) && (
              <button className={`${subtleButton} text-rose-700`} disabled={recipientProtected(t)} title={recipientProtected(t) ? 'Master Admin controls this SMS recipient.' : undefined} onClick={() => { if (!recipientProtected(t)) onChange(techs.filter((_, j) => j !== i)); }}><Trash2 size={14} />Remove</button>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}

function Answers({ active = true }: { active?: boolean }) {
  const { data, mutate, showToast } = useDashboard();
  const [editing, setEditing] = useState<any>(null);
  const [filter, setFilter] = useState<'all' | 'draft'>('all');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const faqs: any[] = data.faqs || [];
  const drafts = faqs.filter((f) => f.status === 'draft');
  const shown = filter === 'draft' ? drafts : faqs;
  const write = async (next: any[], success: string) => {
    setBusy(true); setError('');
    try { await mutate('/api/admin/faqs', { faqs: next }, 'POST', success); return true; } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const next = faqs.some((f) => f.id === editing.id) ? faqs.map((f) => (f.id === editing.id ? editing : f)) : [...faqs, editing];
    if (await write(next, 'Answer saved')) setEditing(null);
  };
  const setStatus = (f: any, status: string) => write(faqs.map((x) => (x.id === f.id ? { ...x, status } : x)), status === 'approved' ? 'Answer approved' : 'Moved to drafts');
  const remove = (f: any) => { if (confirm('Remove this answer?')) void write(faqs.filter((x) => x.id !== f.id), 'Answer removed'); };
  const reset = async () => {
    if (!confirm('Replace every answer with the starting set? Your edits are lost.')) return;
    try { await mutate('/api/admin/faqs/reset', {}, 'POST', 'Answers reset'); } catch (e) { showToast({ type: 'error', title: "Couldn't reset", description: (e as Error).message }); }
  };
  return (
    <Section icon={<BookOpen size={18} />} title="Answers BOB can give" description="Only approved answers are shown to customers or given to the smart chat. Drafts wait for your review. Prices, safety and booking rules always come from the settings above."
      action={<div className="flex gap-2"><button className={subtleButton} onClick={reset}>Reset</button><button className={secondaryButton} onClick={() => setEditing({ id: `faq-${crypto.randomUUID().slice(0, 8)}`, question: '', answer: '', category: 'General', subcategory: 'General', keywords: [], status: 'approved', isCustom: true })}><Plus size={15} />Add answer</button></div>}>
      <div className="flex gap-1.5">
        {(['all', 'draft'] as const).map((k) => (
          <button key={k} onClick={() => setFilter(k)} className={`px-3 py-1.5 rounded-xl text-xs font-extrabold border ${filter === k ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>{k === 'all' ? `All (${faqs.length})` : `Needs review (${drafts.length})`}</button>
        ))}
      </div>
      <div className="divide-y divide-slate-100">
        {shown.map((f) => (
          <article key={f.id} className="py-3.5 flex flex-col sm:flex-row sm:items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap"><span className="text-[11px] font-bold text-slate-400">{f.category}</span>{f.status === 'draft' && <span className="text-[10px] font-black text-amber-800 bg-amber-50 border border-amber-300 px-1.5 rounded">Draft</span>}</div>
              <h4 className="text-sm font-extrabold text-slate-900">{f.question}</h4>
              <p className="text-xs text-slate-600 leading-relaxed mt-0.5 line-clamp-3">{f.answer}</p>
              {f.reviewNote && <p className="text-[11px] text-amber-800 mt-1">Review: {f.reviewNote}</p>}
            </div>
            <div className="flex gap-1.5 shrink-0">
              {f.status === 'draft' ? <button className={secondaryButton} disabled={busy} onClick={() => setStatus(f, 'approved')}>Approve</button> : <button className={subtleButton} disabled={busy} onClick={() => setStatus(f, 'draft')}>Unpublish</button>}
              <button className={subtleButton} onClick={() => { setError(''); setEditing({ ...f }); }}>Edit</button>
              <button className={`${subtleButton} text-rose-700`} onClick={() => remove(f)} aria-label={`Remove ${f.question}`}><Trash2 size={14} /></button>
            </div>
          </article>
        ))}
      </div>
      {error && !editing && <ErrorNote>{error}</ErrorNote>}
      {editing && active && (
        <Modal title={faqs.some((f) => f.id === editing.id) ? 'Edit answer' : 'New answer'} onClose={() => setEditing(null)}>
          <form className="space-y-4" onSubmit={save}>
            <Field label="Question"><input className={inputClass} required value={editing.question} onChange={(e) => setEditing({ ...editing, question: e.target.value })} /></Field>
            <Field label="Answer" hint="Don't include prices here — BOB quotes prices from Services and prices."><textarea rows={5} required className={inputClass} value={editing.answer} onChange={(e) => setEditing({ ...editing, answer: e.target.value })} /></Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Category"><input className={inputClass} value={editing.category} onChange={(e) => setEditing({ ...editing, category: e.target.value })} /></Field>
              <Field label="Status"><select className={inputClass} value={editing.status || 'approved'} onChange={(e) => setEditing({ ...editing, status: e.target.value })}><option value="approved">Approved — customers see it</option><option value="draft">Draft — hidden</option></select></Field>
            </div>
            <Field label="Words customers might use" hint="Comma separated. Helps BOB match questions."><input className={inputClass} value={(editing.keywords || []).join(', ')} onChange={(e) => setEditing({ ...editing, keywords: e.target.value.split(',').map((s) => s.trim()) })} /></Field>
            {error && <ErrorNote>{error}</ErrorNote>}
            <div className="flex justify-end gap-2.5"><button type="button" className={secondaryButton} onClick={() => setEditing(null)}>Cancel</button><button className={primaryButton} disabled={busy}>{busy ? 'Saving…' : 'Save answer'}</button></div>
          </form>
        </Modal>
      )}
    </Section>
  );
}

function Password() {
  const { data } = useDashboard();
  const named = data.access?.role !== 'legacy';
  const [current, setCurrent] = useState(''), [next, setNext] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try { await api('/api/admin/password', { method: 'POST', body: { currentPassword: current, newPassword: next } }); location.href = '/admin'; } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Section icon={<KeyRound size={18} />} title={named ? "Your account password" : "Dashboard password"} description={named ? "Changing your password signs out every session for your account. Other users keep their own passwords and access." : "Changing it signs everyone out. If you signed in with the ADMIN_PASSWORD from Vercel, enter that as the current password — the new one replaces it for this dashboard."}>
      <form onSubmit={submit} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-3 items-end">
        <Field label="Current password"><input className={inputClass} type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
        <Field label="New password (14+ characters)"><input className={inputClass} type="password" autoComplete="new-password" minLength={14} required value={next} onChange={(e) => setNext(e.target.value)} /></Field>
        <button className={secondaryButton} disabled={busy}>Change and sign out</button>
      </form>
      {error && <ErrorNote>{error}</ErrorNote>}
    </Section>
  );
}

/** Floating Save button, always on screen while the settings page is open. Rendered on <body>:
 *  the page's entrance animation leaves a transform that would pin a fixed child to the page instead of the screen. */
function SaveDock({ changed, busy, error, onSave, onDiscard }: { changed: string[]; busy: boolean; error: string; onSave: () => void; onDiscard: () => void }) {
  const pending = changed.length > 0;
  // Lift toasts above the dock while it is on screen.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--save-dock-space', '5.5rem');
    return () => { root.style.removeProperty('--save-dock-space'); };
  }, []);
  const message = error || (busy ? 'Saving your changes…' : pending ? 'Unsaved changes' : 'All changes saved');
  const detail = pending && !error && !busy ? ` to ${changed.join(' and ')}` : ''; // shown from tablet width up
  const icon = busy ? <Loader2 size={16} className="animate-spin shrink-0" />
    : pending || error ? <span className={`size-2.5 rounded-full shrink-0 ${error ? 'bg-rose-400' : 'bg-orange-400'}`} />
    : <CheckCircle2 size={16} className="text-emerald-500 shrink-0" />;
  return createPortal(
    <div className="fixed z-50 inset-x-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] sm:inset-x-auto sm:right-6 sm:bottom-6 pointer-events-none flex justify-end">
      <div className={`pointer-events-auto w-full sm:w-auto flex items-center gap-3 pl-4 pr-2 py-2 rounded-2xl border shadow-xl transition-colors ${pending || error
        ? 'bg-slate-900 border-slate-900 text-white shadow-slate-900/25'
        : 'bg-white border-slate-200 text-slate-600 shadow-slate-900/10'}`}>
        <p className={`flex-1 sm:flex-none flex items-center gap-2 text-sm font-bold min-w-0 ${error ? 'text-rose-300' : ''}`} role="status" aria-live="polite">
          {icon}<span className={`${error ? 'line-clamp-3' : 'truncate'} sm:max-w-[22rem]`}>{message}{detail && <span className="hidden sm:inline">{detail}</span>}</span>
        </p>
        {pending && !busy && (
          <button type="button" onClick={onDiscard} className="px-3 py-2 rounded-xl text-sm font-bold text-slate-300 hover:text-white hover:bg-white/10 transition-colors">Discard</button>
        )}
        <button type="button" onClick={onSave} disabled={!pending || busy} className={`${primaryButton} shadow-none disabled:from-slate-200 disabled:to-slate-200 disabled:text-slate-500 disabled:opacity-100`}>
          <Save size={15} />{busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>,
    document.body,
  );
}

export const SETTINGS_PAGES = [
  ['connections', 'Connections'], ['booking', 'Booking & messages'], ['schedule', 'Scheduling & team'],
  ['services', 'Services & prices'], ['coverage', 'Service area'], ['business', 'Business & website'],
  ['answers', 'Answers'], ['templates', 'Templates'], ['security', 'Security'],
] as const;
type SettingsPageId = typeof SETTINGS_PAGES[number][0];
export function settingsPageFromSearch(search: string): SettingsPageId {
  const value = new URLSearchParams(search).get('settings');
  return SETTINGS_PAGES.some(([id]) => id === value) ? value as SettingsPageId : 'connections';
}

export function SettingsPage({ active = true }: { active?: boolean }) {
  const { data, mutate, can } = useDashboard();
  const view = (id: string) => canViewSettings(data.access, id);
  const requestedPage = () => (new URLSearchParams(location.search).get('settings') || firstAllowedSettings(data.access, SETTINGS_PAGES) || 'connections') as SettingsPageId;
  const manage = (id: string) => id === 'connections' ? can('integrations.manage') : id === 'security' ? can('account.password') : can(`settings.${id}.manage`) && view(id) && (id !== 'services' || can('finance.view'));
  const [page, setPage] = useState<SettingsPageId>(requestedPage);
  const heading = React.useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const restore = () => setPage(requestedPage());
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);
  useEffect(() => {
    let frame = 0;
    const scrollToConsent = () => {
      window.cancelAnimationFrame(frame);
      // Let browser history restore its position before applying this explicit destination.
      frame = window.requestAnimationFrame(() => {
        if (active && page === 'booking' && location.hash === '#owner-sms-consent') {
          const target = document.getElementById('owner-sms-consent');
          target?.focus({ preventScroll: true });
          target?.scrollIntoView({ block: 'start' });
        }
      });
    };
    scrollToConsent();
    window.addEventListener('hashchange', scrollToConsent);
    return () => { window.cancelAnimationFrame(frame); window.removeEventListener('hashchange', scrollToConsent); };
  }, [active, page]);
  const navigate = (next: SettingsPageId) => {
    if (next === page || !view(next)) return;
    const url = new URL(location.href);
    url.searchParams.set('tab', 'settings'); url.searchParams.set('settings', next);
    history.pushState(null, '', `${url.pathname}${url.search}${url.hash}`);
    setPage(next); heading.current?.focus(); window.scrollTo({ top: 0 });
  };
  const [c, setC] = useState<any>(() => structuredClone(data.config));
  const savedConfig = React.useRef(structuredClone(data.config));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [text, setText] = useState(() => ({ zips: data.config.serviceZips.join(', '), travel: (data.config.travelZips || []).join(', '), blocked: data.config.blockedDates.join(', '), weekday: data.config.weekdayStarts.join(', '), saturday: data.config.saturdayStarts.join(', ') }));
  const [address, setAddress] = useState(''), [check, setCheck] = useState<any>(null);
  const [techs, setTechs] = useState<Technician[]>(data.technicians), [techDirty, setTechDirty] = useState(false);
  useEffect(() => {
    if (!dirty && !techDirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, techDirty]);
  useEffect(() => { if (dirty && !Object.keys(changedConfig(savedConfig.current, c)).length) setDirty(false); }, [c, dirty]);
  useEffect(() => { if (!techDirty) setTechs(data.technicians); }, [data.technicians, techDirty]);
  useEffect(() => {
    if (dirty) return;
    savedConfig.current = structuredClone(data.config);
    setC(structuredClone(data.config));
    setText({ zips: data.config.serviceZips.join(', '), travel: (data.config.travelZips || []).join(', '), blocked: data.config.blockedDates.join(', '), weekday: data.config.weekdayStarts.join(', '), saturday: data.config.saturdayStarts.join(', ') });
  }, [data.config, dirty]);

  const editable = (path: string) => { const permission = (CONFIG_FIELD_PERMISSIONS as Record<string, string>)[path]; return !!permission && can(permission); };
  const update = (key: string, value: any) => {
    if (!manage(page)) return;
    if (key in CONFIG_FIELD_PERMISSIONS && !editable(key)) { setError('You do not have permission to change this setting.'); return; }
    setC((s: any) => ({ ...s, [key]: value })); setDirty(true);
  };
  const nested = (key: 'sameDay' | 'overflow' | 'approver', patch: any) => { if (!manage(page) || Object.keys(patch).some(field => !editable(`${key}.${field}`))) return; setC((s: any) => ({ ...s, [key]: { ...s[key], ...patch } })); setDirty(true); };
  const updateService = (id: string, patch: any) => update('services', c.services.map((x: any) => (x.id === id ? { ...x, ...patch } : x)));
  const categories = useMemo(() => [...new Set(c.services.map((x: any) => x.category))] as string[], [c.services]);
  const families = useMemo(() => [...new Set(c.services.map((x: any) => x.family))].filter((f) => (PACKAGES as any)[f as string]) as string[], [c.services]);
  const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
  const offCoverage = !same(c.serviceZips, COVERAGE_IN) || !same(c.travelZips || [], COVERAGE_TRAVEL);
  const restoreCoverage = () => {
    update('serviceZips', [...COVERAGE_IN]); update('travelZips', [...COVERAGE_TRAVEL]);
    setText({ ...text, zips: COVERAGE_IN.join(', '), travel: COVERAGE_TRAVEL.join(', ') });
  };

  const changed = [dirty && 'settings', techDirty && 'technicians'].filter(Boolean) as string[];
  // Technicians first, so a newly added tech exists before the settings that may name them.
  const save = async () => {
    if (!changed.length || busy) return;
    setBusy(true); setError('');
    const done = changed.length > 1 ? 'Settings and technicians saved' : techDirty ? 'Technicians saved' : 'Settings saved';
    try {
      if (techDirty) { await mutate('/api/admin/technicians', { technicians: techs.map(tech => { const next: any = { ...tech }; if (!can('integrations.manage')) delete next.jobberUserId; if (!can('finance.view')) delete next.bio; return next; }) }, 'POST', dirty ? '' : done); setTechDirty(false); }
      if (dirty) { const patch = changedConfig(savedConfig.current, c); if (Object.keys(patch).length) await mutate('/api/admin/config', { version: c.version, ...patch }, 'PATCH', done); setDirty(false); }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const discard = () => { setDirty(false); setTechDirty(false); setError(''); };
  const checkAddress = async () => {
    setCheck(null);
    try { setCheck(await api('/api/admin/geo/check', { method: 'POST', body: { address } })); } catch (e) { setCheck({ error: (e as Error).message }); }
  };
  const embed = `<script src="${location.origin}/embed.js" defer></script>`;
  const verificationRequired = data.integrations?.verification?.provider === 'twilio' || c.requirePhoneVerification !== false;
  const verificationReady = !verificationRequired || (c.integrations?.verification !== false && !!data.integrations?.verification?.configured);
  const readiness = [
    [c.scheduleAcknowledged, 'Schedule source confirmed'],
    [c.pricesAcknowledged, 'Prices approved'],
    [['driving_distance', 'radius'].includes(c.serviceAreaMode) ? Boolean(c.baseAddress.trim() || c.baseLocation) : c.serviceZips.length > 0, 'Service area configured'],
    [c.activeTechnicianIds.length > 0, 'A technician takes bookings'],
    [c.integrations?.jobber !== false && (c.scheduleSource !== 'Jobber' || data.integrations?.jobber?.connected), 'Jobber enabled and connected when required'],
    [verificationReady, 'Selected verification provider configured'],
  ] as [boolean, string][];

  return (
    <div className="space-y-6 animate-in pb-32">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div><h2 className="text-2xl font-black text-slate-900 tracking-tight">Settings</h2><p className="text-sm text-slate-500">Saved changes apply to the next customer right away.</p></div>
        {can('exports.download') && <a className={secondaryButton} href="/api/admin/export"><Download size={15} />Download backup</a>}
      </div>

      <nav aria-label="Settings sections" className="flex flex-wrap gap-2 rounded-2xl border border-slate-200 bg-white p-3">
        {SETTINGS_PAGES.filter(([id]) => view(id)).map(([id, label]) => <button key={id} type="button" aria-current={page === id ? 'page' : undefined} onClick={() => navigate(id)} className={`rounded-xl px-3 py-2 text-sm font-bold transition-colors ${page === id ? 'bg-orange-500 text-white' : 'text-slate-600 hover:bg-slate-100'}`}>{label}</button>)}
      </nav>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 ref={heading} tabIndex={-1} className="text-lg font-extrabold text-slate-800 outline-none">{SETTINGS_PAGES.find(([id]) => id === page)?.[1]}</h3>
        {changed.length > 0 && <p role="status" className="text-sm font-semibold text-amber-800">Unsaved {changed.join(' and ')} — kept as you switch sections.</p>}
      </div>
      {!view(page) && <p role="alert" className="rounded-xl border border-slate-200 bg-white p-5">You do not have access to this settings page.</p>}
      {view(page) && !manage(page) && page !== 'connections' && <p className="text-sm text-slate-600">View only. Editing requires additional access from your Master Admin.</p>}
      {view('connections') && <div hidden={page !== 'connections'} className="space-y-6" data-settings-panel="connections"><fieldset disabled={false} className="space-y-6 min-w-0">
            {can('integrations.manage') ? <><Connections config={c} onChange={update} /><ClientHubSettings /></> : <ConnectionStatus />}
      </fieldset></div>}

      {view('booking') && <div hidden={page !== 'booking'} className="space-y-6" data-settings-panel="booking"><fieldset disabled={!manage('booking')} className="space-y-6 min-w-0">
            <Section icon={<CalendarClock size={18} />} title="Online booking" description="Customers can only confirm a visit when everything on the right is in place."
        action={<span className={`text-xs font-black px-3 py-1 rounded-full border ${c.bookingEnabled ? 'bg-emerald-50 text-emerald-800 border-emerald-300' : 'bg-slate-100 text-slate-600 border-slate-300'}`}>{c.bookingEnabled ? 'Online booking on' : 'Online booking off'}</span>}>
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-6">
          <div>
            {can('integrations.manage') && <Field label="Where open times come from">
              <select className={inputClass} value={c.scheduleSource} disabled={!can('integrations.manage')} onChange={(e) => update('scheduleSource', e.target.value)}>
                <option value="Jobber">Jobber — read the live calendar and book scheduled jobs</option>
                <option value="BOB">BOB only — BOB's own schedule, no Jobber</option>
              </select>
            </Field>}
            <Toggle checked={c.scheduleAcknowledged} onChange={(v) => update('scheduleAcknowledged', v)} label="The schedule source above is accurate and kept up to date" />
            <Toggle checked={c.bookingEnabled} onChange={(v) => update('bookingEnabled', v)} label="Let customers book visits online" detail="When off, BOB still answers questions and takes callback requests." />
            <Toggle checked={verificationRequired} disabled onChange={() => {}} label="Verify by text or email before booking" detail={verificationRequired ? "Required independently of appointment texts. Turning Verify off in Connections pauses booking rather than skipping verification." : "Not required by the saved policy. Selecting Twilio Verify makes verification mandatory independently of appointment texts."} />
            {can('integrations.manage') && <Toggle checked={c.aiAssistant !== false} onChange={(v) => update('aiAssistant', v)} label="Smart chat reads typed messages" detail="Choose Gemini or OpenAI in Connections. Off = buttons and keyword matching. Prices and booking never depend on AI." />}
            {can('integrations.manage') && <div className="flex flex-wrap gap-x-6">
              <Toggle checked={c.smsConfirmations} disabled={!can('integrations.manage')} onChange={(v) => update('smsConfirmations', v)} label="Text confirmations" detail="Only to customers who agree to appointment texts. Requires appointment texts enabled in Connections; verification codes remain separate." />
              <Toggle checked={c.emailConfirmations} disabled={!can('integrations.manage')} onChange={(v) => update('emailConfirmations', v)} label="Email confirmations" detail={c.integrations?.email === false ? "Appointment emails are off in Connections. Verification codes are unaffected." : data.integrations?.email?.configured ? "SendGrid sender configuration is present; delivery is not yet verified. Uses an appointment message, not the code template." : "Unavailable until SendGrid and a verified confirmation-email sender are configured. Verify email sends verification codes only."} />
            </div>}
          </div>
          {can('integrations.manage') && <ul className="space-y-2 bg-slate-50 rounded-2xl border border-slate-200 p-4 self-start">
            {readiness.map(([ok, label]) => <li key={label} className="flex items-start gap-2 text-xs font-semibold text-slate-700"><Dot ok={ok} />{label}</li>)}
          </ul>}
        </div>
      </Section>

            {can('ownerSms.manage') && <><Section icon={<MessageSquare size={18} />} title="Owner booking alerts" description="Optional texts to you after ChatDaddy confirms an appointment, and when something needs your attention. These are separate from emergency same-day approval requests and never hold up a booking.">
        <Toggle checked={c.bookingOwnerSmsEnabled === true} onChange={(v) => update('bookingOwnerSmsEnabled', v)} label="Text me when an appointment is booked" detail="Off by default. Also needs the text message consent below for this number and an approved Twilio sender. Saving this setting does not send a test text." />
        <Toggle checked={c.ownerErrorSmsEnabled === true} onChange={(v) => update('ownerErrorSmsEnabled', v)} label="Text me about service errors" detail="Off by default. Texts you when a ChatDaddy booking needs your review, a customer can't finish booking because of a Jobber error, or the Jobber, phone-code, AI or email connection fails. At most one text per problem every 6 hours and 10 per day. Uses the number below and needs the text message consent below." />
        <div className="max-w-md">
          <Field label="Your mobile number for booking alerts" hint="Required when enabled. Enter the number that should receive these alerts; no approver or customer number is used automatically.">
            <PhoneInput className={inputClass} type="tel" inputMode="tel" autoComplete="off" placeholder="Recipient mobile number" value={c.bookingOwnerSmsPhone || ''} onValueChange={(value) => update('bookingOwnerSmsPhone', value)} />
          </Field>
        </div>
        {(c.bookingOwnerSmsEnabled === true || c.ownerErrorSmsEnabled === true) && !String(c.bookingOwnerSmsPhone || '').trim() && <p role="status" className="text-sm font-semibold text-amber-800">Enter your recipient mobile number before saving this option.</p>}
        {(c.bookingOwnerSmsEnabled === true || c.ownerErrorSmsEnabled === true) && !data.integrations?.sms?.configured && <p role="status" className="text-sm font-semibold text-amber-800">The selected texting provider is not ready. Alerts cannot be sent until its sender is configured.</p>}
      </Section>

      {data.access?.role === 'master' && <div id="owner-sms-consent" tabIndex={-1} className="scroll-mt-40"><OwnerSmsConsent /></div>}</>}

            <Section icon={<ShieldCheck size={18} />} title="Approvals" description="Only emergency same-day visits use online approval and company approval texts. The time is held for up to 30 minutes. Other configured approval-only services and unsafe overflow exceptions remain office-only; these selections do not bypass those safeguards.">
        <div className="flex flex-wrap gap-x-6">
          {families.map((f) => (
            <Toggle key={f} checked={c.approvalServices.includes(f)} label={(PACKAGES as any)[f].short}
              onChange={(v) => update('approvalServices', v ? [...c.approvalServices, f] : c.approvalServices.filter((x: string) => x !== f))} />
          ))}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Approver name"><input className={inputClass} value={c.approver?.name || ''} onChange={(e) => nested('approver', { name: e.target.value })} /></Field>
          <Field label="Approver mobile" hint="Emergency same-day requests only: details and a review link."><PhoneInput className={inputClass} type="tel" disabled={!can('integrations.manage')} value={c.approver?.phone || ''} onValueChange={(value) => nested('approver', { phone: value })} /></Field>
          <Field label="Approver email"><input className={inputClass} type="email" disabled={!can('integrations.manage')} value={c.approver?.email || ''} onChange={(e) => nested('approver', { email: e.target.value })} /></Field>
        </div>
      </Section>
      </fieldset></div>}

      {view('schedule') && <div hidden={page !== 'schedule'} className="space-y-6" data-settings-panel="schedule"><fieldset disabled={!manage('schedule')} className="space-y-6 min-w-0">
            <Section icon={<Route size={18} />} title="Route rules" description="From the scheduling workbook. Same-day and 5 PM overflow start off; turn them on when the crew is ready.">
        <Toggle checked={c.routeScoring} onChange={(v) => update('routeScoring', v)} label="Rank open times by route fit" detail="Same micro-zone and short hops first; an isolated stop or a third zone in a day ranks lower." />
        <Toggle checked={c.nearbyFirst} onChange={(v) => update('nearbyFirst', v)} label="Offer times next to jobs already booked nearby first" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="rounded-2xl border border-slate-200 p-4 space-y-2">
            <Toggle
              checked={c.sameDay.enabled}
              onChange={(v) => nested('sameDay', { enabled: v })}
              label="Same-day regular visits"
              detail={c.sameDay.enabled ? 'Customers can book a visit for later today, using the rules below.' : `Off: customers only see times at least ${c.leadHours} hours away. Turn on to use the settings below.`}
            />
            <div className={`grid grid-cols-2 gap-3 ${c.sameDay.enabled ? '' : 'opacity-60'}`}>
              <Num label="Book before" suffix="hour, 24h" min={6} max={20} disabled={!c.sameDay.enabled} value={c.sameDay.cutoffHour} onChange={(n) => nested('sameDay', { cutoffHour: n })} hint="Same-day stops showing at this hour. 6–20; 12 = noon, 14 = 2 PM." />
              <Num label="Notice" suffix="hours" min={0} max={12} disabled={!c.sameDay.enabled} value={c.sameDay.minNoticeHours} onChange={(n) => nested('sameDay', { minNoticeHours: n })} hint="Gap between booking and the visit starting. 0–12; 2–4 is typical." />
            </div>
            {c.sameDay.enabled && (
              <p className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 leading-snug">
                {sameDayExample(c)}{c.sameDay.requireNearby ? ' Only offered when a job is already booked nearby.' : ''}
              </p>
            )}
            <Toggle checked={c.sameDay.requireNearby} disabled={!c.sameDay.enabled} onChange={(v) => nested('sameDay', { requireNearby: v })} label="Only next to a job already booked" />
          </div>
          <div className="rounded-2xl border border-slate-200 p-4 space-y-2">
            <Toggle checked={c.overflow.enabled} onChange={(v) => nested('overflow', { enabled: v })} label="5 PM overflow visits" detail="One per day, never a normal slot, always approved." />
            <div className="grid grid-cols-3 gap-3">
              <Field label="Starts"><input className={inputClass} type="time" value={c.overflow.start} onChange={(e) => nested('overflow', { start: e.target.value })} /></Field>
              <Num label="Longest" suffix="min" value={c.overflow.maxDurationMins} onChange={(n) => nested('overflow', { maxDurationMins: n })} />
              <Dollars label="Min ticket" value={c.overflow.minTicketCents} onChange={(n) => nested('overflow', { minTicketCents: n })} />
            </div>
            <Toggle checked={c.overflow.requireNearby} onChange={(v) => nested('overflow', { requireNearby: v })} label="Only next to a job already booked" />
          </div>
        </div>
        <div className="max-w-xs"><Dollars label="Daily revenue target per tech" value={c.dailyRevenueTargetCents} onChange={(n) => update('dailyRevenueTargetCents', n)} hint="Shown on the dashboard only. Never affects booking." /></div>
      </Section>

            <Section icon={<CalendarClock size={18} />} title="Hours and capacity" description="Arizona time. Jobber's calendar still decides which of these times are actually open.">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Mon–Fri start times" hint="24-hour, comma separated"><input className={inputClass} value={text.weekday} onChange={(e) => { setText({ ...text, weekday: e.target.value }); update('weekdayStarts', list(e.target.value)); }} /></Field>
          <Field label="Mon–Fri close"><input className={inputClass} type="time" value={c.weekdayClose} onChange={(e) => update('weekdayClose', e.target.value)} /></Field>
          <Field label="Saturday start times"><input className={inputClass} value={text.saturday} onChange={(e) => { setText({ ...text, saturday: e.target.value }); update('saturdayStarts', list(e.target.value)); }} /></Field>
          <Field label="Saturday close"><input className={inputClass} type="time" value={c.saturdayClose} onChange={(e) => update('saturdayClose', e.target.value)} /></Field>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Num label="Most jobs per day" value={c.maxJobsPerDay} onChange={(n) => update('maxJobsPerDay', n)} />
          <Num label="Booking notice" suffix="hours" value={c.leadHours} onChange={(n) => update('leadHours', n)} />
          <Num label="Book up to" suffix="days ahead" value={c.horizonDays} onChange={(n) => update('horizonDays', n)} />
        </div>
        <div>
          <p className="text-xs font-bold text-slate-700">Technicians taking online bookings</p>
          <div className="flex flex-wrap gap-x-6">
            {data.technicians.map((t) => <Toggle key={t.id} checked={c.activeTechnicianIds.includes(t.id)} label={t.name} onChange={(v) => update('activeTechnicianIds', v ? [...c.activeTechnicianIds, t.id] : c.activeTechnicianIds.filter((id: string) => id !== t.id))} />)}
          </div>
        </div>
        <Field label="Closed dates" hint="YYYY-MM-DD, comma separated"><textarea rows={2} className={inputClass} value={text.blocked} onChange={(e) => { setText({ ...text, blocked: e.target.value }); update('blockedDates', list(e.target.value)); }} /></Field>
      </Section>

            <Technicians techs={techs} onChange={(next) => { setTechs(next); setTechDirty(true); }} />
      </fieldset></div>}

      {view('services') && <div hidden={page !== 'services'} className="space-y-6" data-settings-panel="services"><fieldset disabled={!manage('services')} className="space-y-6 min-w-0">
            <Section icon={<Tag size={18} />} title="Services and prices" description="BOB picks the 1-story, 2-story or upstairs version from the customer's answers and adds the Gas Appliance Safety Procedure for gas dryers on cleanings. Names match your Jobber products.">
        {categories.map((cat) => (
          <div key={cat} className="overflow-x-auto">
            <table className="w-full text-sm min-w-[560px]">
              <caption className="text-left text-xs font-extrabold text-slate-500 pb-2">{cat}</caption>
              <thead><tr className="text-left text-[11px] text-slate-400"><th className="font-bold pb-1">Service</th><th className="font-bold pb-1 w-28">Price ($)</th><th className="font-bold pb-1 w-24">Minutes</th><th className="font-bold pb-1 w-16 text-center">Offered</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {c.services.filter((x: any) => x.category === cat).map((x: any) => (
                  <tr key={x.id}>
                    <td className="py-1.5 pr-2"><input aria-label={`${x.name} name`} className={inputClass} value={x.name} onChange={(e) => updateService(x.id, { name: e.target.value })} /></td>
                    <td className="py-1.5 pr-2">{can('finance.view') ? <input aria-label={`${x.name} price`} className={inputClass} type="number" min={0} step={1} value={x.priceCents / 100} onChange={(e) => updateService(x.id, { priceCents: cents(e.target.value) })} /> : <span className="text-slate-500">Restricted</span>}</td>
                    <td className="py-1.5 pr-2"><input aria-label={`${x.name} minutes`} className={inputClass} type="number" min={0} step={5} value={x.minutes} onChange={(e) => updateService(x.id, { minutes: int(e.target.value) })} /></td>
                    <td className="py-1.5 text-center"><input aria-label={`Offer ${x.name}`} type="checkbox" className="size-4 accent-orange-500" checked={x.active} onChange={(e) => updateService(x.id, { active: e.target.checked })} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <Dollars label="Assessment" value={c.assessmentPriceCents} onChange={(n) => update('assessmentPriceCents', n)} />
          <Num label="Assessment" suffix="min" value={c.assessmentMinutes} onChange={(n) => update('assessmentMinutes', n)} />
          <Dollars label="Assessment with a cleaning" value={Math.round(c.assessmentPriceCents / 2)} onChange={() => {}} disabled hint="Always 50% off the assessment, added to the cleaning package's price." />
          <Num label="Emergency notice" suffix="hours" value={c.emergencyLeadHours} disabled={!editable('emergencyLeadHours')} onChange={(n) => update('emergencyLeadHours', n)} />
        </div>
        <Toggle checked={c.pricesAcknowledged} onChange={(v) => update('pricesAcknowledged', v)} label="These prices are approved for customers to see and book" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <Field label="How BOB describes a See-It-Clean visit"><textarea rows={3} className={inputClass} value={c.cleaningProcess} disabled={!editable('cleaningProcess')} onChange={(e) => update('cleaningProcess', e.target.value)} /></Field>
          <Field label="How BOB describes an assessment"><textarea rows={3} className={inputClass} value={c.assessmentProcess} disabled={!editable('assessmentProcess')} onChange={(e) => update('assessmentProcess', e.target.value)} /></Field>
        </div>
      </Section>
      </fieldset></div>}

      {view('coverage') && <div hidden={page !== 'coverage'} className="space-y-6" data-settings-panel="coverage"><fieldset disabled={!manage('coverage')} className="space-y-6 min-w-0">
            <Section icon={<MapPin size={18} />} title="Service area map" description="Move the base point, adjust distance limits, and draw included or excluded areas. Every customer address is checked against your saved map rules.">
        <Field label="Coverage method" hint="Save settings to activate a changed coverage method."><select className={inputClass} value={c.serviceAreaMode} onChange={(e) => update('serviceAreaMode', e.target.value)}><option value="driving_distance">Driving distance from base</option><option value="radius">Radius from base</option><option value="zip">Existing ZIP-code coverage</option></select></Field>
        <Suspense fallback={<p className="text-sm text-slate-500">Loading service area map…</p>}>{manage('coverage') ? <ServiceAreaMap config={c} onChange={update} /> : <p className="text-sm text-slate-600">Map editing and address checks require service-area edit access.</p>}</Suspense>
        {c.serviceAreaMode === 'zip' && <details className="rounded-xl border border-slate-200 p-4"><summary className="font-bold text-sm text-slate-700 cursor-pointer">Existing ZIP-code coverage settings</summary><div className="space-y-4 mt-4">
        <Field label="Approved ZIP codes" hint={`${c.serviceZips.length} ZIP code${c.serviceZips.length === 1 ? '' : 's'}`}>
          <textarea rows={3} className={inputClass} value={text.zips} placeholder="85326, 85338, 85374…" onChange={(e) => { setText({ ...text, zips: e.target.value }); update('serviceZips', list(e.target.value)); }} />
        </Field>
        {offCoverage && (
          <button className={secondaryButton} onClick={restoreCoverage}>
            <RotateCcw size={15} />Restore the coverage list ({COVERAGE_IN.length} in the area, {COVERAGE_TRAVEL.length} with a travel charge)
          </button>
        )}
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_200px] gap-3">
          <Field label="Just outside the service area (travel charge)" hint={`${(c.travelZips || []).length} ZIP code${(c.travelZips || []).length === 1 ? '' : 's'}. BOB tells these customers they're just outside the area, mentions the travel charge, and lets them continue or find someone more local.`}>
            <textarea rows={3} className={inputClass} value={text.travel} placeholder="85033, 85043…" onChange={(e) => { setText({ ...text, travel: e.target.value }); update('travelZips', list(e.target.value)); }} />
          </Field>
          <Dollars label="Travel charge" value={c.travelZoneFeeCents || 0} onChange={(v) => update('travelZoneFeeCents', v)} hint={c.travelZoneFeeCents ? 'Added to the booking as a travel fee.' : 'Not set: BOB says there is a travel charge without an amount, and the booking is flagged for you to confirm it.'} />
        </div>
        <Field label="Where the truck starts (base address)" hint="Used for the farthest-drive limit and travel fees."><input className={inputClass} value={c.baseAddress} onChange={(e) => update('baseAddress', e.target.value)} /></Field>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Num label="Farthest drive from base" suffix="min" value={c.maxDriveFromBaseMin} onChange={(n) => update('maxDriveFromBaseMin', n)} />
          <Num label="Drive between jobs under" suffix="min" value={c.maxDriveBetweenJobsMin} onChange={(n) => update('maxDriveBetweenJobsMin', n)} />
          <Num label="Minimum gap between jobs" suffix="min" value={c.bufferMinutes} onChange={(n) => update('bufferMinutes', n)} hint="Used when it's longer than the drive." />
        </div>
        {can('finance.view') ? <div className="space-y-2">
          <p className="text-xs font-bold text-slate-700">Travel fee by drive time from base</p>
          {!c.travelFeeTiers.length && <p className="text-xs text-slate-500">No travel fee. BOB never adds one on its own.</p>}
          {c.travelFeeTiers.map((tier: any, i: number) => (
            <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-3 items-end max-w-lg">
              <Num label="Up to" suffix="min" value={tier.upToMin} onChange={(n) => update('travelFeeTiers', c.travelFeeTiers.map((t: any, j: number) => (j === i ? { ...t, upToMin: n } : t)))} />
              <Dollars label="Fee" value={tier.feeCents} onChange={(n) => update('travelFeeTiers', c.travelFeeTiers.map((t: any, j: number) => (j === i ? { ...t, feeCents: n } : t)))} />
              <button className={`${subtleButton} text-rose-700 mb-0.5`} onClick={() => update('travelFeeTiers', c.travelFeeTiers.filter((_: any, j: number) => j !== i))} aria-label="Remove travel fee row"><Trash2 size={15} /></button>
            </div>
          ))}
          <button className={secondaryButton} onClick={() => update('travelFeeTiers', [...c.travelFeeTiers, { upToMin: (c.travelFeeTiers.at(-1)?.upToMin || 30) + 15, feeCents: 0 }])}><Plus size={15} />Add a travel fee row</button>
        </div> : <p className="text-sm text-slate-500">Travel fee amounts are restricted.</p>}
        <div className="rounded-2xl bg-slate-50 border border-slate-200 p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 items-end">
            <Field label="Check an address against the saved settings" hint="Street, City, AZ ZIP"><input className={inputClass} value={address} onChange={(e) => setAddress(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && address.trim() && checkAddress()} /></Field>
            <button className={secondaryButton} onClick={checkAddress} disabled={!address.trim()}>Check</button>
          </div>
          {check && (
            <div className={`text-sm rounded-xl p-3 border ${check.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-rose-50 border-rose-200 text-rose-900'}`} role="status">
              {check.error || (check.ok
                ? <>Bookable. {check.driveFromBaseMin != null && `${check.driveFromBaseMin} min from base. `}Travel fee {can('finance.view') ? money(check.travelFeeCents || 0) : 'restricted'}. ZIP {check.zipApproved ? 'approved' : 'not on the list'}.</>
                : check.reason === 'not_found' ? 'Address not found.' : <>Outside the area{check.driveFromBaseMin != null ? ` (${check.driveFromBaseMin} min from base)` : ''}.</>)}
              {check.territory && <span className="block text-xs mt-1 opacity-80">{check.territory.city} · zone {check.territory.zone}{check.territory.micro ? ` · ${check.territory.micro}` : ''}{check.territory.corridor ? ` · ${check.territory.corridor}` : ''}{check.territory.fringe ? ' · fringe' : ''}</span>}
            </div>
          )}
        </div>
        </div></details>}
        {['driving_distance', 'radius'].includes(c.serviceAreaMode) && <div className="grid sm:grid-cols-2 gap-3"><Num label="Drive between jobs under" suffix="min" value={c.maxDriveBetweenJobsMin} onChange={(n) => update('maxDriveBetweenJobsMin', n)} /><Num label="Minimum gap between jobs" suffix="min" value={c.bufferMinutes} onChange={(n) => update('bufferMinutes', n)} /></div>}
        <p className="text-sm font-semibold text-slate-700">Same-day emergency requests must be received before 2 p.m. Arizona time. Technician availability and final booking approval are required.</p>
      </Section>
      </fieldset></div>}

      {view('business') && <div hidden={page !== 'business'} className="space-y-6" data-settings-panel="business"><fieldset disabled={!manage('business')} className="space-y-6 min-w-0">
            <Section icon={<Building2 size={18} />} title="Office contact and visit prep">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Office phone" hint="Shown in confirmations and when online booking can't help."><PhoneInput className={inputClass} type="tel" value={c.phone} onValueChange={(value) => update('phone', value)} /></Field>
          <Field label="Office email"><input className={inputClass} type="email" value={c.email} onChange={(e) => update('email', e.target.value)} /></Field>
        </div>
        <Field label="What customers should do before the visit"><textarea rows={3} className={inputClass} value={c.preparation} onChange={(e) => update('preparation', e.target.value)} /></Field>
      </Section>

            <Section icon={<Code size={18} />} title="Add BOB to dryerventsquadaz.com" description="Paste this before the closing </body> tag on the website. It adds the chat button; the office dashboard is never exposed.">
        <pre className="text-xs bg-slate-900 text-orange-200 rounded-2xl p-4 overflow-x-auto">{embed}</pre>
        <div className="flex gap-2">
          <button className={secondaryButton} onClick={() => navigator.clipboard?.writeText(embed)}>Copy</button>
          <button className={subtleButton} onClick={() => saveText('BOB-website-embed.html', embed, 'text/html')}><Download size={15} />Download</button>
        </div>
      </Section>
      </fieldset></div>}

      {view('answers') && <div hidden={page !== 'answers'} className="space-y-6" data-settings-panel="answers"><fieldset disabled={!manage('answers')} className="space-y-6 min-w-0">
            <Answers active={active && page === 'answers'} />
      </fieldset></div>}

      {view('templates') && <div hidden={page !== 'templates'} className="space-y-6" data-settings-panel="templates"><fieldset disabled={!manage('templates')} className="space-y-6 min-w-0">
        <MessageTemplates config={c} integrations={data.integrations} allowOwner={can('ownerSms.manage')} allowMessaging={can('integrations.manage')} onPatch={(patch) => { if (!manage('templates')) return; setC((current: any) => ({ ...current, ...patch })); setDirty(true); }} />
      </fieldset></div>}

      {view('security') && <div hidden={page !== 'security'} className="space-y-6" data-settings-panel="security"><fieldset disabled={!manage('security')} className="space-y-6 min-w-0">
            <Password />
      </fieldset></div>}

      {active && <SaveDock changed={changed} busy={busy} error={error} onSave={save} onDiscard={discard} />}
    </div>
  );
}
