import { canViewSettings, CONFIG_FIELD_PERMISSIONS } from '../../shared/admin-permissions.mjs';
import { changedConfig, firstAllowedSettings } from './access';
import { OwnerSmsConsent } from './OwnerSmsConsent';
import { MessageTemplates } from './MessageTemplates';
import { ClientHubSettings } from './ClientHubSettings';
import { PhoneInput } from '../components/PhoneInput';
import React, { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Technician } from './DashboardContext';
import { BookOpen, Building2, CalendarClock, Check, CheckCircle2, Code, Download, KeyRound, Loader2, Link2, Mail, MapPin, MessageSquare, Pencil, Plus, RotateCcw, Route, Save, ShieldCheck, Sparkles, Tag, Target, Trash2, Users, X, AlertTriangle } from 'lucide-react';
import { api, saveText } from '../lib/api';
import { askConfirm } from '../components/ConfirmDialog';
import { useDashboard } from './DashboardContext';
import { ErrorNote, Field, Modal, Section, Toggle, inputClass, primaryButton, secondaryButton, subtleButton } from './ui';
import { money } from '../../shared/domain.mjs';
import { DEFAULT_UPSELLS, PACKAGES } from '../../shared/catalog.mjs';
import { WEEKDAYS, businessWeek, weekSummary, timeOffLabel, validTimeOffEntry, scheduleGaps, dayHours, toOpenWeek, arrivalSpacing, ARRIVAL_SPACINGS, hasOwnHours, startTimesSummary } from '../../shared/tech-schedule.mjs';
import { displayPhone } from '../customer/appointmentCard';
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
  const { cutoffHour } = c.sameDay;
  const minNoticeHours = Math.max(12, c.sameDay.minNoticeHours);
  const bookedAt = Math.min(8, cutoffHour - 1);
  const earliest = bookedAt + minNoticeHours;
  const weekdayStarts = [1, 2, 3, 4, 5].map((i) => dayHours(c, i).starts).find((list) => list.length) || [];
  const first = weekdayStarts.find((t) => Number(t.split(':')[0]) + Number(t.split(':')[1] || 0) / 60 >= earliest);
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
    if (!(await askConfirm({ danger: true, title: 'Disconnect Jobber?', message: 'Online booking pauses until you reconnect.', confirmLabel: 'Disconnect' }))) return;
    setBusy(true);
    try { await mutate('/api/admin/jobber/disconnect', {}, 'POST', 'Jobber disconnected'); } catch (e) { showToast({ type: 'error', title: "Couldn't disconnect", description: (e as Error).message }); } finally { setBusy(false); }
  };
  const enabled = (key: string) => config.integrations?.[key] !== false;
  const offWarning: Record<string, string> = {
    jobber: 'Turning Jobber off pauses online booking. Existing appointments and the connected account remain unchanged. Turn it off in your draft?',
    maps: 'Turning Maps off stops address and routing calls and pauses all online booking, including ZIP-based coverage. Turn it off in your draft?',
    verification: 'Turning Verify off blocks bookings that require verification; it never bypasses the code check. Turn it off in your draft?',
  };
  const switchFor = (key: string, label: string) => <Toggle checked={enabled(key)} onChange={async (value) => {
    if (!value && offWarning[key] && !(await askConfirm({ danger: true, title: `Turn off ${label}?`, message: offWarning[key].replace(/ Turn it off in your draft\?$/, ''), confirmLabel: 'Turn off in draft' }))) return;
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
      <>{!enabled('sms') ? 'Off in these settings: appointment, owner-alert and company approval texts are suppressed.' : i.sms?.virtualPhone ? <b className="text-amber-800">Test mode: every text goes to the Twilio Virtual Phone (Twilio Console → Messaging → Virtual Phone), marked with who it was for. No real phone gets a text.</b> : i.sms?.configured ? 'Approved sender configuration present. Delivery is not verified by this status.' : 'Unavailable: configure an approved texting sender on the server before texts can be sent.'}<p className="mt-1">Customer texts require consent. Emergency same-day approval and optional owner booking alerts remain separate rules. Verification codes use the separate Verify switch.</p></>, switchFor('sms', 'appointment texts')],
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
const phoenixToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/** An on/off switch: a knob with a check when on and an X when off. */
function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border-2 transition-colors focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-orange-200 disabled:opacity-50 ${checked ? 'bg-orange-500 border-orange-500' : 'bg-slate-100 border-slate-300'}`}>
      <span aria-hidden="true" className={`absolute size-5 rounded-full flex items-center justify-center shadow transition-transform ${checked ? 'translate-x-[1.375rem] bg-white text-orange-600' : 'translate-x-0.5 bg-slate-700 text-white'}`}>
        {checked ? <Check size={12} strokeWidth={3.5} /> : <X size={12} strokeWidth={3.5} />}
      </span>
    </button>
  );
}

/** A time box with its label inside; greyed out (but still showing the time) on a day off. */
function TimeBox({ label, value, onChange, disabled, invalid }: { label: string; value: string; onChange: (v: string) => void; disabled?: boolean; invalid?: boolean }) {
  return (
    <label className={`block min-w-0 rounded-xl border px-3 py-1.5 transition-colors ${disabled ? 'bg-slate-100 border-slate-200' : invalid ? 'bg-white border-rose-400 ring-2 ring-rose-100' : 'bg-white border-slate-300 focus-within:border-orange-400 focus-within:ring-2 focus-within:ring-orange-100'}`}>
      <span className={`block text-[11px] font-semibold ${disabled ? 'text-slate-400' : 'text-slate-500'}`}>{label}</span>
      <input type="time" step={900} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-label={label}
        className="w-full min-w-0 bg-transparent text-sm font-semibold text-slate-900 outline-none disabled:text-slate-400" />
    </label>
  );
}

/** One day in a weekly hours dialog: an on/off switch, then its two times (greyed out, still shown, when off). */
function DayRow({ index, day, busy, switchLabel, startLabel, endLabel, badText, onChange, note }: { index: number; day: { on: boolean; start: string; end: string }; busy: boolean; switchLabel: string; startLabel: string; endLabel: string; badText: string; onChange: (patch: any) => void; note?: React.ReactNode }) {
  const bad = day.on && (!day.start || !day.end || day.start >= day.end);
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[9.5rem_1fr] gap-2 sm:items-center">
      <div className="flex items-center justify-between sm:justify-start gap-3">
        <span className="w-24 text-sm font-bold text-slate-800">{WEEKDAYS[index]}</span>
        <Switch checked={day.on} onChange={(v) => onChange({ on: v })} label={switchLabel} disabled={busy} />
      </div>
      <div>
        <div className="grid grid-cols-2 gap-2" data-day={WEEKDAYS[index]}>
          <TimeBox label={startLabel} value={day.start} disabled={!day.on || busy} invalid={bad} onChange={(v) => onChange({ start: v })} />
          <TimeBox label={endLabel} value={day.end} disabled={!day.on || busy} invalid={bad} onChange={(v) => onChange({ end: v })} />
        </div>
        {bad && <p role="alert" className="mt-1 text-xs font-semibold text-rose-700">{badText}</p>}
        {note}
      </div>
    </div>
  );
}

const spacingLabel = (mins: number) => (mins < 60 ? `${mins} minutes` : mins === 60 ? '1 hour' : mins === 90 ? '1½ hours' : `${mins / 60} hours`);

/**
 * The company's "Business hours" dialog, laid out like a technician's schedule: each day open or
 * closed with its opening and closing time, and how often BOB offers a start time from opening.
 * Save writes it straight away.
 */
function BusinessHoursEditor({ config, onCancel, onSave }: { config: any; onCancel: () => void; onSave: (patch: { openWeek: string[]; arrivalEveryMins: number }) => Promise<void> }) {
  const [week, setWeek] = useState(() => businessWeek(config).map((d: any) => ({ ...d })));
  const [every, setEvery] = useState<number>(() => arrivalSpacing(config));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const set = (i: number, patch: any) => setWeek((w) => w.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const bad = (d: any) => d.on && (!d.start || !d.end || d.start >= d.end);
  const noneOpen = !week.some((d) => d.on);
  const preview = { ...config, openWeek: toOpenWeek(week.map((d) => (bad(d) ? { ...d, on: false } : d))), arrivalEveryMins: every };
  const replacesLists = !hasOwnHours(config) && WEEKDAYS.some((_, i) => dayHours(preview, i).starts.join() !== dayHours(config, i).starts.join());
  const save = async () => {
    setBusy(true); setError('');
    try { await onSave({ openWeek: toOpenWeek(week), arrivalEveryMins: every }); } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <Modal title="Business hours" subtitle="Arizona time" onClose={busy ? () => {} : onCancel}
      footer={
        <div className="flex justify-end gap-2 w-full">
          <button type="button" className={secondaryButton} disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="button" className={primaryButton} disabled={busy || noneOpen || week.some(bad)} onClick={() => void save()}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}Save</button>
        </div>
      }>
      <div className="space-y-3" data-business-hours-editor>
        <p className="text-xs text-slate-500 -mt-1">When BOB offers visits. Technicians on business hours follow these too.</p>
        {week.map((d, i) => (
          <DayRow key={i} index={i} day={d} busy={busy} switchLabel={`Open ${WEEKDAYS[i]}`} startLabel="Opens" endLabel="Closes"
            badText="Closing time needs to be after opening time." onChange={(patch) => set(i, patch)}
            note={d.on && !bad(d) ? <p className="mt-1 text-[11px] font-semibold text-slate-500" data-start-times={WEEKDAYS[i]}>Start times: {dayHours(preview, i).starts.map(clock).join(', ')}</p> : null} />
        ))}
        <div className="max-w-xs">
          <Field label="Offer a start time every">
            <select className={inputClass} value={every} disabled={busy} onChange={(e) => setEvery(Number(e.target.value))}>
              {ARRIVAL_SPACINGS.map((m) => <option key={m} value={m}>{spacingLabel(m)}</option>)}
            </select>
          </Field>
        </div>
        {noneOpen && <p role="alert" className="text-xs font-semibold text-rose-700">Keep at least one day open. To stop online booking for a while, turn it off under Online booking.</p>}
        {replacesLists && <p className="text-xs font-semibold text-amber-800">Saving replaces your typed-in start times with the ones shown here.</p>}
        <p className="text-xs text-slate-500 leading-snug">BOB offers a start time only when the whole visit fits before closing: a 2-hour visit at 3 PM needs you open until 5 PM. Closed dates, each tech's schedule and Jobber still apply.</p>
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    </Modal>
  );
}

/**
 * The "Edit schedule" dialog: every day of the week with an on/off switch and its start and end
 * times. Save writes it straight away; "Use business hours" goes back to the default.
 */
function ScheduleEditor({ name, initial, config, onCancel, onSave }: { name: string; initial: Technician['workWeek']; config: any; onCancel: () => void; onSave: (week: Technician['workWeek']) => Promise<void> }) {
  const [week, setWeek] = useState(() => (Array.isArray(initial) && initial.length === 7 ? initial : businessWeek(config)).map((d: any) => ({ ...d })));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const set = (i: number, patch: any) => setWeek((w) => w.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const bad = (d: any) => d.on && (!d.start || !d.end || d.start >= d.end);
  const anyBad = week.some(bad);
  const save = async (value: Technician['workWeek']) => {
    setBusy(true); setError('');
    try { await onSave(value); } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <Modal title="Edit schedule" subtitle={`${name || 'Technician'} · Arizona time`} onClose={busy ? () => {} : onCancel}
      footer={
        <div className="flex justify-end gap-2 w-full">
          <button type="button" className={secondaryButton} disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="button" className={primaryButton} disabled={busy || anyBad} onClick={() => void save(week)}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}Save</button>
        </div>
      }>
      <div className="space-y-3" data-schedule-editor>
        <div className="flex flex-wrap items-center justify-between gap-2 -mt-1">
          <p className="text-xs text-slate-500">{Array.isArray(initial) ? 'Their own hours.' : 'Starting from your business hours.'}</p>
          {Array.isArray(initial) && <button type="button" className={subtleButton} disabled={busy} onClick={() => void save(null)}><RotateCcw size={14} />Use business hours</button>}
        </div>
        {week.map((d, i) => (
          <DayRow key={i} index={i} day={d} busy={busy} switchLabel={`${name || 'Technician'} works ${WEEKDAYS[i]}`} startLabel="Start time" endLabel="End time"
            badText="End time needs to be after the start time." onChange={(patch) => set(i, patch)} />
        ))}
        <p className="text-xs text-slate-500 leading-snug">BOB only offers {name || 'this tech'} when the whole visit fits: a 90-minute visit at 3 PM needs them until 4:30 PM. Jobber is still checked before every booking.</p>
        {error && <ErrorNote>{error}</ErrorNote>}
      </div>
    </Modal>
  );
}

/**
 * Warns before a customer sees "no openings" because of who's scheduled: nobody takes online
 * bookings, a tech who does has no working days, an open weekday nobody online works, or upcoming
 * dates when everyone online is off. Uses the edits on the page, saved or not.
 */
function ScheduleGaps({ techs, config }: { techs: Technician[]; config: any }) {
  const gaps = scheduleGaps({ technicians: techs, config, today: phoenixToday(), days: Math.min(60, Math.max(1, Number(config?.horizonDays) || 45)) });
  const name = (id: string) => techs.find((t) => t.id === id)?.name || 'A technician';
  const and = (list: string[]) => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);
  const day = (d: string) => new Date(`${d}T12:00:00-07:00`).toLocaleDateString('en-US', { timeZone: 'America/Phoenix', weekday: 'short', month: 'short', day: 'numeric' });
  const items: string[] = [];
  if (gaps.noOnline) items.push('No technician takes online bookings, so customers see no openings. Turn someone on under "Technicians taking online bookings" above.');
  for (const id of gaps.idle) items.push(`${name(id)} takes online bookings but has no working days in their schedule, so BOB never offers them.`);
  if (gaps.weekdays.length) items.push(`Nobody who takes online bookings works ${and(gaps.weekdays.map((i: number) => `${WEEKDAYS[i]}s`))}, so customers see no times on those days.`);
  if (gaps.dates.length) items.push(`Everyone who takes online bookings is off on ${and(gaps.dates.slice(0, 6).map(day))}${gaps.dates.length > 6 ? ` and ${gaps.dates.length - 6} more day${gaps.dates.length - 6 === 1 ? '' : 's'}` : ''}, so customers see no times then.`);
  if (!items.length) return null;
  return (
    <div role="alert" data-schedule-gaps className="rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <p className="font-extrabold flex items-center gap-2"><AlertTriangle size={16} className="shrink-0" />Customers won't see some days</p>
      <ul className="mt-1.5 list-disc pl-6 space-y-1">{items.map((item) => <li key={item}>{item}</li>)}</ul>
      <p className="mt-1.5 text-xs text-amber-800">Fix it with Edit schedule or Time off on the cards below, or by changing who takes online bookings.</p>
    </div>
  );
}

/**
 * One technician's work schedule and time off. BOB only offers this tech for a visit that fits in
 * their hours that day and doesn't touch their time off; Jobber is still checked before booking.
 */
function TechSchedule({ tech, online, onChange, onSaveSchedule }: { tech: Technician; online: boolean; onChange: (patch: Partial<Technician>) => void; onSaveSchedule: (week: Technician['workWeek']) => Promise<void> }) {
  const { data } = useDashboard();
  const week = Array.isArray(tech.workWeek) && tech.workWeek.length === 7 ? tech.workWeek : null;
  const today = phoenixToday();
  const upcoming = (tech.timeOff || []).filter((t) => t.to >= today);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ from: today, to: today, allDay: true, start: '12:00', end: '17:00', note: '' });
  const [draftError, setDraftError] = useState('');
  const addTimeOff = () => {
    const entry = { id: `off-${crypto.randomUUID().slice(0, 8)}`, from: draft.from, to: draft.to || draft.from, start: draft.allDay ? '' : draft.start, end: draft.allDay ? '' : draft.end, note: draft.note.trim() };
    if (!validTimeOffEntry(entry)) { setDraftError(entry.from > entry.to ? 'The last day is before the first day.' : !draft.allDay && entry.start >= entry.end ? 'The end time needs to be after the start time.' : 'Check the dates and times.'); return; }
    if (entry.to < today) { setDraftError('That time off has already passed.'); return; }
    setDraftError('');
    onChange({ timeOff: [...(tech.timeOff || []), entry].sort((a, b) => a.from.localeCompare(b.from)) });
    setDraft({ ...draft, note: '' });
  };
  return (
    <div className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-100" data-tech-schedule={tech.id}>
      <div className="flex items-start justify-between gap-3 px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-sm font-bold text-slate-800">Work schedule</p>
          <p className="text-xs font-semibold text-slate-500" data-schedule-summary>{week ? weekSummary(week) : 'Business hours (whenever the business is open)'}</p>
          {online && week && !week.some((d) => d.on) && <p className="mt-1 text-xs font-bold text-amber-800 flex items-center gap-1.5" data-no-working-days><AlertTriangle size={13} className="shrink-0" />Takes online bookings but has no working days, so BOB never offers them.</p>}
        </div>
        <button type="button" className={`${secondaryButton} shrink-0`} onClick={() => setEditing(true)}><CalendarClock size={14} />Edit schedule</button>
      </div>
      <details className="px-3 py-2.5">
        <summary className="cursor-pointer select-none text-sm font-bold text-slate-800">Time off <span className="text-xs font-semibold text-slate-500">· {upcoming.length ? `${upcoming.length} upcoming` : 'none coming up'}</span></summary>
        <div className="mt-2 space-y-2">
          {upcoming.length > 0 && (
            <ul className="space-y-1.5">
              {upcoming.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 border border-slate-200 px-2.5 py-1.5 text-sm">
                  <span className="min-w-0"><span className="font-semibold text-slate-800">{timeOffLabel(t)}</span>{t.note && <span className="block text-xs text-slate-500 truncate">{t.note}</span>}</span>
                  <button type="button" className="shrink-0 text-xs font-bold text-rose-700 hover:text-rose-900" onClick={() => onChange({ timeOff: (tech.timeOff || []).filter((x) => x.id !== t.id) })} aria-label={`Remove time off ${timeOffLabel(t)}`}>Remove</button>
                </li>
              ))}
            </ul>
          )}
          <div className="rounded-lg border border-dashed border-slate-300 p-2.5 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <Field label="First day"><input type="date" min={today} className={`${inputClass} !py-1.5`} value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value, to: draft.to < e.target.value ? e.target.value : draft.to })} /></Field>
              <Field label="Last day"><input type="date" min={draft.from || today} className={`${inputClass} !py-1.5`} value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} /></Field>
            </div>
            <label className="flex items-center gap-2 text-sm font-semibold text-slate-700"><input type="checkbox" className="size-4 accent-orange-500" checked={draft.allDay} onChange={(e) => setDraft({ ...draft, allDay: e.target.checked })} />All day</label>
            {!draft.allDay && (
              <div className="grid grid-cols-2 gap-2">
                <TimeBox label="Starts" value={draft.start} onChange={(v) => setDraft({ ...draft, start: v })} />
                <TimeBox label="Ends" value={draft.end} onChange={(v) => setDraft({ ...draft, end: v })} />
              </div>
            )}
            <input className={`${inputClass} !py-1.5`} maxLength={120} placeholder="Note (optional), e.g. Vacation" value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} aria-label="Time off note" />
            {draftError && <p role="alert" className="text-xs font-semibold text-rose-700">{draftError}</p>}
            <button type="button" className={secondaryButton} onClick={addTimeOff}><Plus size={14} />Add time off</button>
            <p className="text-[11px] text-slate-400">Time off is saved with the Save button at the bottom of the page.</p>
          </div>
        </div>
      </details>
      {editing && <ScheduleEditor name={tech.name} initial={tech.workWeek ?? null} config={data.config} onCancel={() => setEditing(false)} onSave={async (next) => { await onSaveSchedule(next); setEditing(false); }} />}
    </div>
  );
}

const TECH_STATUS: Record<string, string> = { available: 'Available', on_route: 'On the way', on_job: 'On a job', off_duty: 'Off duty' };

/** Add or edit one technician's details. Save writes it straight away. */
function TechEditor({ tech, isNew, users, taken, onCancel, onSave }: { tech: Technician; isNew: boolean; users: any[] | null; taken: Record<string, string>; onCancel: () => void; onSave: (tech: Technician) => Promise<void> }) {
  const { can } = useDashboard();
  const [t, setT] = useState<Technician>(() => ({ ...tech }));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const phoneProtected = tech.id === 'tech-ryan' && !can('integrations.manage');
  const set = (patch: Partial<Technician>) => {
    if (phoneProtected && 'phone' in patch) return;
    if (!can('finance.view') && 'bio' in patch) return;
    setT((x) => ({ ...x, ...patch }));
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!t.name.trim()) { setError('Add their name.'); return; }
    setBusy(true); setError('');
    try { await onSave({ ...t, name: t.name.trim() }); } catch (err) { setError((err as Error).message); setBusy(false); }
  };
  return (
    <Modal title={isNew ? 'Add technician' : 'Edit technician'} subtitle={isNew ? undefined : tech.name} onClose={busy ? () => {} : onCancel}>
      <form className="space-y-3" onSubmit={save} data-tech-editor>
        <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
          <Field label="Name"><input className={inputClass} maxLength={100} value={t.name} disabled={busy} onChange={(e) => set({ name: e.target.value })} /></Field>
          <Field label="Color"><input type="color" className="h-[42px] w-14 rounded-xl border border-slate-200 bg-white p-1" value={t.color} disabled={busy} onChange={(e) => set({ color: e.target.value })} /></Field>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Phone" hint={phoneProtected ? 'Master Admin controls this SMS recipient number.' : undefined}><PhoneInput className={inputClass} type="tel" value={t.phone} disabled={phoneProtected || busy} onValueChange={(value) => set({ phone: value })} /></Field>
          <Field label="Truck or van"><input className={inputClass} value={t.vehicle || ''} disabled={busy} onChange={(e) => set({ vehicle: e.target.value })} placeholder="Van 2" /></Field>
          <Field label="Home area"><input className={inputClass} value={t.zone} disabled={busy} onChange={(e) => set({ zone: e.target.value })} /></Field>
          <Field label="Status today" hint="Off duty only keeps them off today's openings. Other days follow their work schedule and their Jobber calendar.">
            <select className={inputClass} value={t.status} disabled={busy} onChange={(e) => set({ status: e.target.value as Technician['status'] })}>
              {Object.entries(TECH_STATUS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Jobber user" hint={users ? 'BOB checks this person\'s Jobber calendar before booking and assigns the visit to them.' : 'Connect Jobber to link technicians.'}>
          <select className={inputClass} value={t.jobberUserId || ''} disabled={!users || busy} onChange={(e) => set({ jobberUserId: e.target.value })}>
            <option value="">Not linked (uses the whole crew calendar)</option>
            {(users || []).map((u) => <option key={u.id} value={u.id} disabled={!!taken[u.id]}>{u.name}{taken[u.id] ? ` (linked to ${taken[u.id]})` : ''}</option>)}
          </select>
        </Field>
        <Field label="Short bio for the office" hint={!can('finance.view') ? 'Restricted: viewing and editing office bios requires financial and unrestricted notes access.' : undefined}><textarea rows={2} className={inputClass} disabled={!can('finance.view') || busy} placeholder={!can('finance.view') ? 'Restricted' : undefined} value={can('finance.view') ? t.bio || '' : ''} onChange={(e) => set({ bio: e.target.value })} /></Field>
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="flex justify-end gap-2.5">
          <button type="button" className={secondaryButton} disabled={busy} onClick={onCancel}>Cancel</button>
          <button className={primaryButton} disabled={busy}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}{isNew ? 'Add technician' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

function Technicians({ techs, config, onChange, onSaveSchedule, onSaveTech, onRemoveTech }: { techs: Technician[]; config: any; onChange: (next: Technician[]) => void; onSaveSchedule: (id: string, week: Technician['workWeek']) => Promise<void>; onSaveTech: (tech: Technician) => Promise<void>; onRemoveTech: (id: string) => Promise<void> }) {
  const { data, can, showToast } = useDashboard();
  const [users, setUsers] = useState<any[] | null>(null);
  const [editing, setEditing] = useState<{ tech: Technician; isNew: boolean } | null>(null);
  useEffect(() => {
    if (can('integrations.manage') && data.integrations?.jobber?.connected) api('/api/admin/jobber/users').then((r) => setUsers(r.users)).catch(() => setUsers([]));
  }, [data.integrations?.jobber?.connected, can]);
  const recipientProtected = (tech: Technician) => tech.id === 'tech-ryan' && !can('integrations.manage');
  // Time off is still edited on the card and saved with the page.
  const edit = (i: number, patch: any) => onChange(techs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const jobberName = (t: Technician) => (!t.jobberUserId ? 'Not linked to Jobber' : `Jobber: ${users?.find((u) => u.id === t.jobberUserId)?.name || 'linked'}`);
  const upcoming = (t: Technician) => (data.appointments || []).filter((a: any) => a.technicianId === t.id && !['cancelled', 'failed'].includes(a.status) && Date.parse(a.scheduledAt) > Date.now()).length;
  const remove = async (t: Technician) => {
    if (recipientProtected(t) || techs.length < 2) return;
    const name = t.name || 'this technician', n = upcoming(t);
    const message = n
      ? `${name} has ${n} upcoming visit${n === 1 ? '' : 's'} booked through BOB. ${n === 1 ? 'It stays' : 'They stay'} booked in Jobber, so reassign ${n === 1 ? 'it' : 'them'} there. Past visits keep their name.`
      : 'BOB stops offering them right away. Past visits keep their name.';
    if (!(await askConfirm({ danger: true, title: `Remove ${name}?`, message, confirmLabel: 'Remove' }))) return;
    try { await onRemoveTech(t.id); } catch (e) { showToast({ type: 'error', title: "Couldn't remove", description: (e as Error).message }); }
  };
  const taken = (id: string) => Object.fromEntries(techs.filter((x) => x.id !== id && x.jobberUserId).map((x) => [x.jobberUserId, x.name]));
  return (
    <Section icon={<Users size={18} />} title="Technicians" description="Set each tech's work schedule and time off here: BOB only offers a tech when the whole visit falls on their shift. Link each tech to their Jobber user so BOB also checks their Jobber calendar, fresh, before every booking and assigns the visit to them. Visits for a Jobber user no tech is linked to (or no one) block every tech."
      action={<button className={secondaryButton} onClick={() => setEditing({ tech: { id: `tech-${crypto.randomUUID().slice(0, 8)}`, name: '', phone: '', zone: 'West Valley', status: 'off_duty', color: '#3b82f6', jobberUserId: '', vehicle: '', bio: '', workWeek: null, timeOff: [] } as Technician, isNew: true })}><Plus size={15} />Add technician</button>}>
      <ScheduleGaps techs={techs} config={config} />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {techs.map((t, i) => (
          <div key={t.id} className="rounded-2xl border border-slate-200 p-4 space-y-3 bg-slate-50/50" data-tech={t.id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span aria-hidden="true" className="size-3 rounded-full shrink-0 ring-2 ring-white shadow" style={{ background: t.color }} />
                  <h4 className="text-base font-extrabold text-slate-900 truncate">{t.name || 'Unnamed technician'}</h4>
                  <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${t.status === 'off_duty' ? 'bg-slate-100 text-slate-600 border-slate-200' : 'bg-emerald-50 text-emerald-800 border-emerald-200'}`}>{TECH_STATUS[t.status] || t.status}</span>
                </div>
                <p className="text-xs text-slate-600 mt-1" data-tech-details>{[t.phone ? displayPhone(t.phone) : '', t.vehicle, t.zone].filter(Boolean).join(' · ') || 'No phone or truck yet'}</p>
                <p className="text-xs text-slate-500">{jobberName(t)} · {(config?.activeTechnicianIds || []).includes(t.id) ? 'Takes online bookings' : 'Not taking online bookings'}</p>
              </div>
              <div className="flex flex-wrap justify-end gap-1.5 shrink-0">
                <button type="button" className={secondaryButton} aria-label={`Edit ${t.name || 'technician'}`} onClick={() => setEditing({ tech: t, isNew: false })}><Pencil size={14} />Edit</button>
                {techs.length > 1 && (
                  <button type="button" className={`${subtleButton} text-rose-700`} aria-label={`Remove ${t.name || 'technician'}`} disabled={recipientProtected(t)} title={recipientProtected(t) ? 'Master Admin controls this SMS recipient.' : undefined} onClick={() => void remove(t)}><Trash2 size={14} />Remove</button>
                )}
              </div>
            </div>
            <TechSchedule tech={t} online={(config?.activeTechnicianIds || []).includes(t.id)} onChange={(patch) => edit(i, patch)} onSaveSchedule={(week) => onSaveSchedule(t.id, week)} />
          </div>
        ))}
      </div>
      {editing && <TechEditor tech={editing.tech} isNew={editing.isNew} users={users} taken={taken(editing.tech.id)} onCancel={() => setEditing(null)} onSave={async (tech) => { await onSaveTech(tech); setEditing(null); }} />}
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
  const remove = async (f: any) => { if (await askConfirm({ danger: true, title: 'Remove this answer?', message: f.question, confirmLabel: 'Remove' })) void write(faqs.filter((x) => x.id !== f.id), 'Answer removed'); };
  const reset = async () => {
    if (!(await askConfirm({ danger: true, title: 'Reset all answers?', message: 'Every answer is replaced with the starting set. Your edits are lost.', confirmLabel: 'Reset answers' }))) return;
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
            <Field label="Answer" hint="Don't include prices here — BOB quotes prices from Services and prices."><textarea rows={Math.min(12, Math.max(5, Math.ceil(String(editing.answer || '').length / 80) + 1))} required className={inputClass} value={editing.answer} onChange={(e) => setEditing({ ...editing, answer: e.target.value })} /></Field>
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

/** Master Admin: send a sample booking report to check the email arrives. */
const weekLabel = (ms: number) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Phoenix', month: 'short', day: 'numeric' }).format(ms);
/**
 * The revenue minimum BOB paces the schedule to, with this week and the next two against it. The
 * preview uses the values being edited, before they're saved.
 */
/**
 * Extra Jobber team members put on every visit BOB books, beside the technician doing it, so the
 * visit shows on their own Jobber schedule (an owner or office login). Who does the job doesn't change.
 */
function AlsoAssign({ value, techs, onChange, disabled }: { value: string[]; techs: Technician[]; onChange: (next: string[]) => void; disabled?: boolean }) {
  const { data } = useDashboard();
  const connected = Boolean(data.integrations?.jobber?.connected);
  const [users, setUsers] = useState<any[] | null>(null), [error, setError] = useState('');
  useEffect(() => {
    if (!connected) return;
    api('/api/admin/jobber/users').then((r) => { setUsers(r.users || []); setError(''); }, (e) => { setUsers([]); setError((e as Error).message); });
  }, [connected]);
  const chosen = value || [];
  const techFor = (id: string) => techs.find((t) => t.jobberUserId === id);
  const gone = users ? chosen.filter((id) => !users.some((u) => u.id === id)) : [];
  return (
    <Section icon={<Users size={18} />} title="Also put on every BOB visit"
      description="Each visit BOB books goes to the technician doing it. Add yourself or the office here and the same visit also shows on your Jobber schedule. It doesn't change who does the job or which times are open. Jobber sends its usual visit notice to everyone on the visit.">
      {!connected ? <p className="text-sm text-slate-600">Connect Jobber to choose team members.</p>
        : users === null ? <p className="text-sm text-slate-500 flex items-center gap-2"><Loader2 size={14} className="animate-spin" />Loading Jobber team members…</p>
        : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
            {users.map((u) => {
              const tech = techFor(u.id);
              return <Toggle key={u.id} checked={chosen.includes(u.id)} disabled={disabled || (!chosen.includes(u.id) && chosen.length >= 10)} label={u.name}
                detail={tech ? `Linked to ${tech.name || 'a technician'}: they'll be on every visit, and those times count as busy on their calendar too.` : undefined}
                onChange={(v) => onChange(v ? [...chosen, u.id] : chosen.filter((id) => id !== u.id))} />;
            })}
          </div>
        )}
      {gone.length > 0 && <p className="text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">{gone.length === 1 ? 'One person' : `${gone.length} people`} chosen here {gone.length === 1 ? 'is' : 'are'} no longer in your Jobber account and {gone.length === 1 ? 'is' : 'are'} skipped. <button type="button" className="underline" disabled={disabled} onClick={() => onChange(chosen.filter((id) => !gone.includes(id)))}>Remove</button></p>}
      {error && <ErrorNote>{error}</ErrorNote>}
    </Section>
  );
}

function RevenuePacing({ value, onChange }: { value: any; onChange: (patch: any) => void }) {
  const { can } = useDashboard();
  const rp = { enabled: false, period: 'month', targetCents: 0, outsideJobCents: 0, ...(value || {}) };
  const weekly = Math.round(rp.period === 'week' ? rp.targetCents : rp.targetCents / 4), daily = Math.round(weekly / 5);
  const [pace, setPace] = useState<any>(null), [error, setError] = useState('');
  const canMoney = can('finance.view');
  useEffect(() => {
    if (!canMoney || !(rp.targetCents > 0)) { setPace(null); return; }
    let live = true;
    const t = setTimeout(() => {
      api(`/api/admin/revenue-pace?period=${rp.period}&target=${rp.targetCents}&outside=${rp.outsideJobCents}`)
        .then((r) => { if (live) { setPace(r.pace); setError(''); } }, (e) => { if (live) setError((e as Error).message); });
    }, 400);
    return () => { live = false; clearTimeout(t); };
  }, [canMoney, rp.period, rp.targetCents, rp.outsideJobCents]);
  const thisWeek = pace?.weeks?.[0];
  return (
    <Section icon={<Target size={18} />} title="Revenue target" description="Set a minimum for the month or the week. BOB fills a week that's behind first, and once a week's minimum is in, he keeps the rest of that week for stops close to the route.">
      <Toggle checked={rp.enabled} onChange={(v) => onChange({ enabled: v })} label="Pace the schedule to a revenue minimum"
        detail={rp.enabled ? 'On: open times are ordered by how each week is doing against the minimum, along with route fit. Your drive limits and jobs per day still apply.' : 'Off: open times are ordered by route fit only.'} />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Dollars label="Minimum revenue" value={rp.targetCents} onChange={(n) => onChange({ targetCents: n })} />
        <Field label="Per">
          <select className={inputClass} value={rp.period} onChange={(e) => onChange({ period: e.target.value })}>
            <option value="month">Month</option>
            <option value="week">Week</option>
          </select>
        </Field>
        <Dollars label="Value of jobs booked outside BOB" value={rp.outsideJobCents} onChange={(n) => onChange({ outsideJobCents: n })} hint="Jobs the office puts in Jobber. $0 uses BOB's average job." />
      </div>
      {canMoney && rp.targetCents > 0 && (
        <p className="text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
          {rp.period === 'month' ? `${money(rp.targetCents)} a month is ` : ''}<b>{money(weekly)} a week</b> and <b>{money(daily)} a weekday</b> (Mon–Fri).
        </p>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      {pace && (
        <div className="space-y-2.5">
          {pace.weeks.map((w: any, i: number) => {
            const pct = Math.min(100, Math.round((w.bookedCents / Math.max(1, pace.weeklyTargetCents)) * 100));
            return (
              <div key={w.start}>
                <div className="flex justify-between text-sm"><span className="font-bold text-slate-800">{i === 0 ? 'This week' : i === 1 ? 'Next week' : 'Week after'} <span className="font-semibold text-slate-500">· {weekLabel(w.start)}</span></span><span className={`font-bold ${w.met ? 'text-emerald-700' : 'text-slate-700'}`}>{money(w.bookedCents)} of {money(pace.weeklyTargetCents)}{w.met ? ' · met' : ''}</span></div>
                <div className="mt-1 h-2.5 rounded-full bg-slate-100 overflow-hidden"><div className={`h-full rounded-full ${w.met ? 'bg-emerald-500' : 'bg-orange-500'}`} style={{ width: `${pct}%` }} /></div>
                <p className="text-xs text-slate-500 mt-0.5">{w.jobs} job{w.jobs === 1 ? '' : 's'} booked</p>
              </div>
            );
          })}
          <p className="text-xs text-slate-600">
            {!rp.enabled ? 'Turn pacing on to use these numbers. ' : thisWeek?.met ? "This week's minimum is in, so BOB is saving the rest of this week for stops close to the route and offering farther customers next week first. " : "This week is behind, so BOB is offering this week's openings first. "}
            Jobs the office booked outside BOB count at {money(pace.jobCents)} each{pace.jobCentsFrom === 'average' ? " (BOB's average job)" : pace.jobCentsFrom === 'default' ? ' until BOB has bookings to average' : ''}.
          </p>
        </div>
      )}
    </Section>
  );
}

/** Wording only: the on/off switches and amounts stay as they are when this is restored. */
const UPSELL_WORDING = ['dryerflexTitle', 'dryerflexBadge', 'dryerflexPoints', 'dryerflexLink', 'foggingTitle', 'foggingDescription', 'ultimatePitch'] as const;

/**
 * The optional add-ons offered on the review screen before booking (and again in the confirmation
 * email): which ones show and what they say. Their prices stay in the Services table.
 */
function Upsells({ value, services, onChange, editable }: { value: any; services: any[]; onChange: (patch: any) => void; editable: (path: string) => boolean }) {
  const { can } = useDashboard();
  const u: any = { ...DEFAULT_UPSELLS, ...(value || {}) };
  const row = (variant: string) => services.find((x: any) => x.family === 'addon' && x.variant === variant);
  const priceNote = (r: any) => !r ? 'There is no matching add-on in the Services table, so this offer can\'t show.'
    : r.active === false ? `${r.name} is turned off in the Services table, so this offer can't show.`
    : can('finance.view') ? `Price ${money(r.priceCents)}, from "${r.name}" in the Services table.` : `Price comes from "${r.name}" in the Services table.`;
  const off = (key: string) => !editable(`upsells.${key}`);
  const text = (key: string, label: string, max: number, hint?: React.ReactNode) => (
    <Field label={label} hint={hint}><input className={inputClass} value={u[key]} maxLength={max} disabled={off(key)} onChange={(e) => onChange({ [key]: e.target.value })} /></Field>
  );
  const area = (key: string, label: string, max: number, rows: number, hint?: React.ReactNode) => (
    <Field label={label} hint={hint}><textarea rows={rows} className={inputClass} value={u[key]} maxLength={max} disabled={off(key)} onChange={(e) => onChange({ [key]: e.target.value })} /></Field>
  );
  const box = (on: boolean) => `rounded-2xl border p-4 space-y-3 ${on ? 'border-slate-200' : 'border-dashed border-slate-300 bg-slate-50/70'}`;
  const df = row('dryerflex'), fog = row('fogging');
  const changedWording = UPSELL_WORDING.some((k) => u[k] !== (DEFAULT_UPSELLS as any)[k]);
  return (
    <Section icon={<Sparkles size={18} />} title="Upsells at checkout"
      description="Optional add-ons offered on the review screen before the customer books, and again in the confirmation email. Turn one off to hide it everywhere. Prices come from the Services table above."
      action={changedWording && UPSELL_WORDING.every((k) => !off(k)) ? <button type="button" className={subtleButton} onClick={() => onChange(Object.fromEntries(UPSELL_WORDING.map((k) => [k, (DEFAULT_UPSELLS as any)[k]])))}><RotateCcw size={14} />Restore default wording</button> : undefined}>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className={box(u.dryerflexEnabled)} data-upsell="dryerflex">
          <Toggle checked={u.dryerflexEnabled} disabled={off('dryerflexEnabled')} onChange={(v) => onChange({ dryerflexEnabled: v })} label="Show the DryerFlex hose upgrade"
            detail={`${priceNote(df)} Not offered with Ultimate or Restoration (already included) or Express.`} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {text('dryerflexTitle', 'Name', 80)}
            {text('dryerflexBadge', 'Badge', 40, 'The small tag above the name. Leave blank for none.')}
          </div>
          <Dollars label="Regular price, shown crossed out" value={u.dryerflexWasCents} disabled={off('dryerflexWasCents')} onChange={(n) => onChange({ dryerflexWasCents: n })} hint="Only shown when it's higher than the add-on price. $0 hides it." />
          {area('dryerflexPoints', 'Selling points, one per line', 800, 5, 'The first line is shown in bold with a shield.')}
          {text('dryerflexLink', '"Learn more" link', 300, 'Must start with https://. Leave blank to hide the link.')}
        </div>
        <div className="space-y-4">
          <div className={box(u.foggingEnabled)} data-upsell="fogging">
            <Toggle checked={u.foggingEnabled} disabled={off('foggingEnabled')} onChange={(v) => onChange({ foggingEnabled: v })} label="Show the sanitizing fog treatment"
              detail={`${priceNote(fog)} Not offered with Restoration (already included).`} />
            {text('foggingTitle', 'Name', 80)}
            {area('foggingDescription', 'Description', 400, 3)}
          </div>
          <div className={box(u.bundleEnabled && u.dryerflexEnabled && u.foggingEnabled)} data-upsell="bundle">
            <Toggle checked={u.bundleEnabled} disabled={off('bundleEnabled')} onChange={(v) => onChange({ bundleEnabled: v })} label="Bundle deal when both are added"
              detail={!u.dryerflexEnabled || !u.foggingEnabled ? 'Needs both DryerFlex and the fog treatment showing.' : `Shown as "Add both and save ${money(u.bundleSavingsCents)}". The savings come off the fog line, never below $0.`} />
            <Dollars label="Savings" value={u.bundleSavingsCents} disabled={off('bundleSavingsCents')} onChange={(n) => onChange({ bundleSavingsCents: n })} />
          </div>
          <div className={box(u.ultimateEnabled)} data-upsell="ultimate">
            <Toggle checked={u.ultimateEnabled} disabled={off('ultimateEnabled')} onChange={(v) => onChange({ ultimateEnabled: v })} label="Offer the Ultimate upgrade to Premium customers"
              detail="The extra cost is the difference between the customer's Premium and Ultimate prices in the Services table." />
            {area('ultimatePitch', 'What Ultimate adds', 400, 3, 'Shown as "Adds …". List what Premium doesn\'t include.')}
          </div>
        </div>
      </div>
    </Section>
  );
}

function BookingReportTest() {
  const [busy, setBusy] = useState(false), [result, setResult] = useState<{ status: string; to: string } | null>(null), [error, setError] = useState('');
  const send = async () => {
    setBusy(true); setError(''); setResult(null);
    try { setResult(await api('/api/admin/booking-report/test', { method: 'POST', body: {} })); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const message = !result ? '' : result.status === 'accepted' ? `SendGrid accepted the test email to ${result.to}. Check that inbox, and its spam folder.`
    : result.status === 'off' ? 'The booking report is turned off (BOOKING_REPORT_EMAIL is "off").'
    : result.status === 'not_configured' ? 'SendGrid isn\'t fully set up, so no email was sent. Check the SendGrid settings in Vercel.'
    : result.status === 'rejected' ? `SendGrid rejected the email to ${result.to}. Check the sender verification in SendGrid.`
    : `SendGrid didn't confirm the email to ${result.to}. Check SendGrid's activity feed before trying again.`;
  return (
    <Section icon={<Mail size={18} />} title="Booking report email" description="Every confirmed ChatDaddy booking emails the operator the customer, the job, and running counts, revenue and commission. Send a test to check it arrives.">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={secondaryButton} disabled={busy} onClick={() => void send()}>{busy ? 'Sending…' : 'Send test report'}</button>
        {message && <p role="status" className={`text-sm font-semibold ${result?.status === 'accepted' ? 'text-emerald-700' : 'text-amber-800'}`}>{message}</p>}
      </div>
      {error && <ErrorNote>{error}</ErrorNote>}
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
  const [text, setText] = useState(() => ({ zips: data.config.serviceZips.join(', '), travel: (data.config.travelZips || []).join(', '), blocked: data.config.blockedDates.join(', ') }));
  const [address, setAddress] = useState(''), [check, setCheck] = useState<any>(null);
  const [hoursOpen, setHoursOpen] = useState(false);
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
    setText({ zips: data.config.serviceZips.join(', '), travel: (data.config.travelZips || []).join(', '), blocked: data.config.blockedDates.join(', ') });
  }, [data.config, dirty]);

  const editable = (path: string) => { const permission = (CONFIG_FIELD_PERMISSIONS as Record<string, string>)[path]; return !!permission && can(permission); };
  const update = (key: string, value: any) => {
    if (!manage(page)) return;
    if (key in CONFIG_FIELD_PERMISSIONS && !editable(key)) { setError('You do not have permission to change this setting.'); return; }
    setC((s: any) => ({ ...s, [key]: value })); setDirty(true);
  };
  const nested = (key: 'sameDay' | 'overflow' | 'approver' | 'revenuePacing' | 'upsells', patch: any) => { if (!manage(page) || Object.keys(patch).some(field => !editable(`${key}.${field}`))) return; setC((s: any) => ({ ...s, [key]: { ...s[key], ...patch } })); setDirty(true); };
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
  const stripTech = (tech: Technician) => { const next: any = { ...tech }; if (!can('integrations.manage')) delete next.jobberUserId; if (!can('finance.view')) delete next.bio; return next; };
  /** The schedule dialog saves one tech's hours straight away, leaving other unsaved edits as they are. */
  const saveSchedule = async (id: string, workWeek: Technician['workWeek']) => {
    const apply = (list: Technician[]) => list.map((t) => (t.id === id ? { ...t, workWeek } : t));
    if (!data.technicians.some((t) => t.id === id)) { setTechs(apply); setTechDirty(true); return; } // a new tech: saved with the page
    await mutate('/api/admin/technicians', { technicians: apply(data.technicians).map(stripTech) }, 'POST', `${techs.find((t) => t.id === id)?.name || 'Technician'}'s schedule saved`);
    setTechs(apply);
  };
  /** The technician dialog adds or updates one tech straight away; other unsaved edits (time off) stay as they are. */
  const saveTech = async (tech: Technician) => {
    const exists = data.technicians.some((t) => t.id === tech.id);
    const details = { name: tech.name, color: tech.color, phone: tech.phone, vehicle: tech.vehicle, zone: tech.zone, status: tech.status, jobberUserId: tech.jobberUserId, bio: tech.bio };
    const apply = (list: Technician[]) => (list.some((t) => t.id === tech.id) ? list.map((t) => (t.id === tech.id ? { ...t, ...details } : t)) : [...list, tech]);
    await mutate('/api/admin/technicians', { technicians: apply(data.technicians).map(stripTech) }, 'POST', exists ? `${tech.name} saved` : `${tech.name} added`);
    setTechs(apply);
  };
  const removeTech = async (id: string) => {
    const name = techs.find((t) => t.id === id)?.name || 'Technician';
    await mutate('/api/admin/technicians', { technicians: data.technicians.filter((t) => t.id !== id).map(stripTech) }, 'POST', `${name} removed`);
    setTechs((list) => list.filter((t) => t.id !== id));
    // Also off the "taking online bookings" list (the server drops them on the next save too).
    savedConfig.current = { ...savedConfig.current, activeTechnicianIds: (savedConfig.current.activeTechnicianIds || []).filter((x: string) => x !== id) };
    setC((cur: any) => ({ ...cur, activeTechnicianIds: (cur.activeTechnicianIds || []).filter((x: string) => x !== id) }));
  };
  /** The Business hours dialog saves straight away; other unsaved settings on the page stay as they are. */
  const saveHours = async (patch: { openWeek: string[]; arrivalEveryMins: number }) => {
    const r = await mutate('/api/admin/config', { version: savedConfig.current.version, ...patch }, 'PATCH', 'Business hours saved');
    const version = r?.config?.version ?? savedConfig.current.version + 1;
    savedConfig.current = { ...savedConfig.current, ...patch, version };
    setC((cur: any) => ({ ...cur, ...patch, version }));
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

      {data.access?.role === 'master' && <div id="owner-sms-consent" tabIndex={-1} className="scroll-mt-40"><OwnerSmsConsent /></div>}
      {data.access?.role === 'master' && <BookingReportTest />}</>}

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
              detail={c.sameDay.enabled ? 'Visits today still require at least 12 hours of notice and the rules below.' : 'Off: no visits today. Every booking also requires at least 12 hours of notice.'}
            />
            <div className={`grid grid-cols-2 gap-3 ${c.sameDay.enabled ? '' : 'opacity-60'}`}>
              <Num label="Book before" suffix="hour, 24h" min={6} max={20} disabled={!c.sameDay.enabled} value={c.sameDay.cutoffHour} onChange={(n) => nested('sameDay', { cutoffHour: n })} hint="Same-day stops showing at this hour. 6–20; 12 = noon, 14 = 2 PM." />
              <Num label="Notice" suffix="hours" min={12} max={12} disabled={!c.sameDay.enabled} value={Math.max(12, c.sameDay.minNoticeHours)} onChange={(n) => nested('sameDay', { minNoticeHours: n })} hint="A 12-hour minimum applies to every visit, including same-day and emergency service." />
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

      <RevenuePacing value={c.revenuePacing} onChange={(patch) => nested('revenuePacing', patch)} />

            <Section icon={<CalendarClock size={18} />} title="Hours and capacity" description="Arizona time. Jobber's calendar still decides which of these times are actually open.">
        <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 flex flex-wrap items-start justify-between gap-3" data-business-hours>
          <div className="min-w-0">
            <p className="text-sm font-bold text-slate-800">Business hours</p>
            <p className="text-xs font-semibold text-slate-600" data-hours-summary>{weekSummary(businessWeek(c))}</p>
            <p className="text-xs text-slate-500" data-hours-starts>{hasOwnHours(c) ? `A start time every ${spacingLabel(arrivalSpacing(c))}, from opening` : `Start times: ${startTimesSummary(c)}`}</p>
          </div>
          <button type="button" className={`${secondaryButton} shrink-0`} disabled={!editable('openWeek')} onClick={() => setHoursOpen(true)}><CalendarClock size={14} />Edit hours</button>
        </div>
        {hoursOpen && <BusinessHoursEditor config={c} onCancel={() => setHoursOpen(false)} onSave={async (patch) => { await saveHours(patch); setHoursOpen(false); }} />}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Num label="Most jobs per day" value={c.maxJobsPerDay} onChange={(n) => update('maxJobsPerDay', n)} />
          <Num label="Booking notice" suffix="hours" min={12} value={Math.max(12, c.leadHours)} onChange={(n) => update('leadHours', n)} hint="At least 12 hours for every booking. Longer notice still applies." />
          <Num label="Book up to" suffix="days ahead" value={c.horizonDays} onChange={(n) => update('horizonDays', n)} />
        </div>
        <div className="max-w-sm"><Num label="Count every calendar visit as at least" suffix="min" value={c.minVisitMinutes ?? 90} onChange={(n) => update('minVisitMinutes', n)} hint="Jobber visits and assessments BOB didn't book (BidBee, the office) block at least this long, even when Jobber shows less. 0 uses Jobber's times exactly." /></div>
        <div>
          <p className="text-xs font-bold text-slate-700">Technicians taking online bookings</p>
          <div className="flex flex-wrap gap-x-6">
            {data.technicians.map((t) => <Toggle key={t.id} checked={c.activeTechnicianIds.includes(t.id)} label={t.name} onChange={(v) => update('activeTechnicianIds', v ? [...c.activeTechnicianIds, t.id] : c.activeTechnicianIds.filter((id: string) => id !== t.id))} />)}
          </div>
        </div>
        <Field label="Closed dates" hint="YYYY-MM-DD, comma separated"><textarea rows={2} className={inputClass} value={text.blocked} onChange={(e) => { setText({ ...text, blocked: e.target.value }); update('blockedDates', list(e.target.value)); }} /></Field>
      </Section>

            <Technicians techs={techs} config={c} onChange={(next) => { setTechs(next); setTechDirty(true); }} onSaveSchedule={saveSchedule} onSaveTech={saveTech} onRemoveTech={removeTech} />
            {can('integrations.manage') && <AlsoAssign value={c.alsoAssignJobberUserIds || []} techs={techs} disabled={!editable('alsoAssignJobberUserIds')} onChange={(next) => update('alsoAssignJobberUserIds', next)} />}
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
          <Dollars label="Assessment added to a cleaning" value={c.bundleAssessmentCents ?? 6000} onChange={(n) => update('bundleAssessmentCents', n)} hint="Cleaning + Assessment = the Premium 1-2-3 price for the home plus this amount ($179 + $60 = $239 for a 1-story home)." />
          <Num label="Emergency notice" suffix="hours" min={12} value={Math.max(12, c.emergencyLeadHours)} disabled={!editable('emergencyLeadHours')} onChange={(n) => update('emergencyLeadHours', n)} hint="Emergency visits also require at least 12 hours of notice." />
        </div>
        <Toggle checked={c.pricesAcknowledged} onChange={(v) => update('pricesAcknowledged', v)} label="These prices are approved for customers to see and book" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <Field label="How BOB describes a See-It-Clean visit"><textarea rows={3} className={inputClass} value={c.cleaningProcess} disabled={!editable('cleaningProcess')} onChange={(e) => update('cleaningProcess', e.target.value)} /></Field>
          <Field label="How BOB describes an assessment"><textarea rows={3} className={inputClass} value={c.assessmentProcess} disabled={!editable('assessmentProcess')} onChange={(e) => update('assessmentProcess', e.target.value)} /></Field>
        </div>
      </Section>
      <Upsells value={c.upsells} services={c.services} editable={editable} onChange={(patch) => nested('upsells', patch)} />
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
