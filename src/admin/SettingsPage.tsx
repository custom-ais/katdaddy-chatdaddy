import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Technician } from './DashboardContext';
import { BookOpen, Building2, CalendarClock, CheckCircle2, Code, Download, KeyRound, Loader2, Link2, MapPin, Plus, Route, Save, ShieldCheck, Tag, Trash2, Users } from 'lucide-react';
import { api, saveText } from '../lib/api';
import { useDashboard } from './DashboardContext';
import { ErrorNote, Field, Modal, Section, Toggle, inputClass, primaryButton, secondaryButton, subtleButton } from './ui';
import { money } from '../../shared/domain.mjs';
import { PACKAGES } from '../../shared/catalog.mjs';

const int = (v: string) => (v === '' ? 0 : Math.round(Number(v)));
const cents = (v: string) => Math.round(Number(v || 0) * 100);
const list = (v: string) => v.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

function Num({ label, value, onChange, hint, step = 1, min = 0, suffix }: { label: string; value: number; onChange: (n: number) => void; hint?: React.ReactNode; step?: number; min?: number; suffix?: string }) {
  return (
    <Field label={suffix ? `${label} (${suffix})` : label} hint={hint}>
      <input className={inputClass} type="number" inputMode="numeric" step={step} min={min} value={Number.isFinite(value) ? value : 0} onChange={(e) => onChange(int(e.target.value))} />
    </Field>
  );
}
function Dollars({ label, value, onChange, hint, disabled }: { label: string; value: number; onChange: (c: number) => void; hint?: React.ReactNode; disabled?: boolean }) {
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

function Connections() {
  const { data, mutate, showToast } = useDashboard();
  const i = data.integrations || {};
  const [busy, setBusy] = useState(false);
  const disconnect = async () => {
    if (!confirm('Disconnect Jobber? Online booking pauses until you reconnect.')) return;
    setBusy(true);
    try { await mutate('/api/admin/jobber/disconnect', {}, 'POST', 'Jobber disconnected'); } catch (e) { showToast({ type: 'error', title: "Couldn't disconnect", description: (e as Error).message }); } finally { setBusy(false); }
  };
  const rows: [string, boolean, React.ReactNode, React.ReactNode?][] = [
    ['Jobber', !!i.jobber?.connected,
      i.jobber?.connected ? 'Reading the live calendar and creating scheduled jobs with visits.' : i.jobber?.appConfigured ? 'Not connected yet. Online booking stays off until it is.' : 'Add JOBBER_CLIENT_ID, JOBBER_CLIENT_SECRET and JOBBER_REDIRECT_URI in Vercel first.',
      i.jobber?.appConfigured && (i.jobber?.connected ? <button className={subtleButton} onClick={disconnect} disabled={busy}>Disconnect</button> : <a className={primaryButton} href="/api/admin/jobber/connect">Connect Jobber</a>)],
    ['LeadConnector', !!i.leadConnector?.configured && !i.leadConnector?.issue,
      <>{i.leadConnector?.configured ? 'Sends verification codes, confirmations and approval texts, and saves contacts and requests.' : 'Add LC_PRIVATE_TOKEN and LC_LOCATION_ID in Vercel. Phone verification needs it, so online booking waits for it.'}
        {i.leadConnector?.configured && ['jwt', 'other'].includes(i.leadConnector?.tokenKind) && <span className="block mt-1 font-semibold text-amber-800">LC_PRIVATE_TOKEN doesn't look like a Private Integration token (those start with “pit-”).{i.leadConnector.tokenKind === 'jwt' ? ' It looks like an older API key or app token.' : ''} Copy the token from the sub-account's Settings → Private Integrations.</span>}
        {i.leadConnector?.issue && <span className="block mt-1 font-semibold text-amber-800">{when(i.leadConnector.issue.at)}: {i.leadConnector.issue.message}</span>}</>],
    ['Smart chat', !!i.assistant?.configured, i.assistant?.configured ? `Gemini (${i.assistant.model}) reads typed messages. It can't set prices or book — BOB's rules do that.` : 'Add GEMINI_API_KEY in Vercel. Until then BOB uses buttons and keyword matching.'],
    ['Maps', i.maps?.provider === 'google' && !i.maps?.issue,
      <>{i.maps?.provider === 'google' ? 'Google finds addresses and drive times enforce the drive-time rules. If Google refuses, the free Census lookup is used.' : 'Free Census address lookup with straight-line drive estimates. Add GOOGLE_MAPS_API_KEY for real drive times.'}
        {i.maps?.issue && <span className="block mt-1 font-semibold text-amber-800">Address lookup failed {when(i.maps.issue.at)}: {i.maps.issue.message}</span>}</>],
    ['Database', !!i.database, i.database === 'supabase-rest' ? 'Supabase (ChatDaddy project), through the service key.' : i.database === 'postgres' ? 'Postgres connection string.' : 'Local test database — data is not kept.'],
    ...(i.lastError ? [['Last server error', false, <span className="text-rose-800">{when(i.lastError.at)} on {i.lastError.path}: {i.lastError.message}</span>] as [string, boolean, React.ReactNode]] : []),
  ];
  return (
    <Section icon={<Link2 size={18} />} title="Connections" description="Keys live in Vercel environment variables. Nothing secret is shown here.">
      <div className="divide-y divide-slate-100">
        {rows.map(([name, ok, detail, action]) => (
          <div key={name} className="flex items-start justify-between gap-3 py-3">
            <div className="flex items-start gap-3"><Dot ok={ok} /><div><p className="text-sm font-extrabold text-slate-900">{name}</p><div className="text-xs text-slate-500 leading-snug max-w-xl">{detail}</div></div></div>
            {action}
          </div>
        ))}
      </div>
    </Section>
  );
}

/** Edits are saved by the floating Save button with the rest of the page. */
function Technicians({ techs, onChange }: { techs: Technician[]; onChange: (next: Technician[]) => void }) {
  const { data } = useDashboard();
  const [users, setUsers] = useState<any[] | null>(null);
  useEffect(() => {
    if (data.integrations?.jobber?.connected) api('/api/admin/jobber/users').then((r) => setUsers(r.users)).catch(() => setUsers([]));
  }, [data.integrations?.jobber?.connected]);
  const edit = (i: number, patch: any) => onChange(techs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
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
              <Field label="Phone"><input className={inputClass} type="tel" value={t.phone} onChange={(e) => edit(i, { phone: e.target.value })} /></Field>
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
            <Field label="Short bio for the office"><textarea rows={2} className={inputClass} value={t.bio || ''} onChange={(e) => edit(i, { bio: e.target.value })} /></Field>
            {techs.length > 1 && !data.appointments.some((a) => a.technicianId === t.id) && (
              <button className={`${subtleButton} text-rose-700`} onClick={() => onChange(techs.filter((_, j) => j !== i))}><Trash2 size={14} />Remove</button>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}

function Answers() {
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
      {editing && (
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
  const [current, setCurrent] = useState(''), [next, setNext] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try { await api('/api/admin/password', { method: 'POST', body: { currentPassword: current, newPassword: next } }); location.href = '/admin'; } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Section icon={<KeyRound size={18} />} title="Dashboard password" description="Changing it signs everyone out. If you signed in with the ADMIN_PASSWORD from Vercel, enter that as the current password — the new one replaces it for this dashboard.">
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

export function SettingsPage() {
  const { data, mutate } = useDashboard();
  const [c, setC] = useState<any>(() => structuredClone(data.config));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [text, setText] = useState(() => ({ zips: data.config.serviceZips.join(', '), blocked: data.config.blockedDates.join(', '), weekday: data.config.weekdayStarts.join(', '), saturday: data.config.saturdayStarts.join(', ') }));
  const [address, setAddress] = useState(''), [check, setCheck] = useState<any>(null);
  const [techs, setTechs] = useState<Technician[]>(data.technicians), [techDirty, setTechDirty] = useState(false);
  useEffect(() => { if (!techDirty) setTechs(data.technicians); }, [data.technicians, techDirty]);
  useEffect(() => {
    if (dirty) return;
    setC(structuredClone(data.config));
    setText({ zips: data.config.serviceZips.join(', '), blocked: data.config.blockedDates.join(', '), weekday: data.config.weekdayStarts.join(', '), saturday: data.config.saturdayStarts.join(', ') });
  }, [data.config, dirty]);

  const update = (key: string, value: any) => { setC((s: any) => ({ ...s, [key]: value })); setDirty(true); };
  const nested = (key: 'sameDay' | 'overflow' | 'approver', patch: any) => { setC((s: any) => ({ ...s, [key]: { ...s[key], ...patch } })); setDirty(true); };
  const updateService = (id: string, patch: any) => update('services', c.services.map((x: any) => (x.id === id ? { ...x, ...patch } : x)));
  const categories = useMemo(() => [...new Set(c.services.map((x: any) => x.category))] as string[], [c.services]);
  const families = useMemo(() => [...new Set(c.services.map((x: any) => x.family))].filter((f) => (PACKAGES as any)[f as string]) as string[], [c.services]);
  const westValley: string[] = data.westValleyZips || [];
  const missingWestValley = westValley.filter((z) => !c.serviceZips.includes(z));

  const changed = [dirty && 'settings', techDirty && 'technicians'].filter(Boolean) as string[];
  // Technicians first, so a newly added tech exists before the settings that may name them.
  const save = async () => {
    if (!changed.length || busy) return;
    setBusy(true); setError('');
    const done = changed.length > 1 ? 'Settings and technicians saved' : techDirty ? 'Technicians saved' : 'Settings saved';
    try {
      if (techDirty) { await mutate('/api/admin/technicians', { technicians: techs }, 'POST', dirty ? '' : done); setTechDirty(false); }
      if (dirty) { await mutate('/api/admin/config', c, 'PATCH', done); setDirty(false); }
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const discard = () => { setDirty(false); setTechDirty(false); setError(''); };
  const checkAddress = async () => {
    setCheck(null);
    try { setCheck(await api('/api/admin/geo/check', { method: 'POST', body: { address } })); } catch (e) { setCheck({ error: (e as Error).message }); }
  };
  const embed = `<script src="${location.origin}/embed.js" defer></script>`;
  const readiness = [
    [c.scheduleAcknowledged, 'Schedule source confirmed'],
    [c.pricesAcknowledged, 'Prices approved'],
    [c.serviceZips.length > 0, 'Service ZIPs entered'],
    [c.activeTechnicianIds.length > 0, 'A technician takes bookings'],
    [c.scheduleSource !== 'Jobber' || data.integrations?.jobber?.connected, 'Jobber connected'],
    [!c.requirePhoneVerification || data.integrations?.leadConnector?.configured, 'Phone verification can send codes'],
  ] as [boolean, string][];

  return (
    <div className="space-y-6 animate-in pb-32">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div><h2 className="text-2xl font-black text-slate-900 tracking-tight">Settings</h2><p className="text-sm text-slate-500">Saved changes apply to the next customer right away.</p></div>
        <a className={secondaryButton} href="/api/admin/export"><Download size={15} />Download backup</a>
      </div>

      <Connections />

      <Section icon={<CalendarClock size={18} />} title="Online booking" description="Customers can only confirm a visit when everything on the right is in place."
        action={<span className={`text-xs font-black px-3 py-1 rounded-full border ${c.bookingEnabled ? 'bg-emerald-50 text-emerald-800 border-emerald-300' : 'bg-slate-100 text-slate-600 border-slate-300'}`}>{c.bookingEnabled ? 'Online booking on' : 'Online booking off'}</span>}>
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-6">
          <div>
            <Field label="Where open times come from">
              <select className={inputClass} value={c.scheduleSource} onChange={(e) => update('scheduleSource', e.target.value)}>
                <option value="Jobber">Jobber — read the live calendar and book scheduled jobs</option>
                <option value="BOB">BOB only — BOB's own schedule, no Jobber</option>
              </select>
            </Field>
            <Toggle checked={c.scheduleAcknowledged} onChange={(v) => update('scheduleAcknowledged', v)} label="The schedule source above is accurate and kept up to date" />
            <Toggle checked={c.bookingEnabled} onChange={(v) => update('bookingEnabled', v)} label="Let customers book visits online" detail="When off, BOB still answers questions and takes callback requests." />
            <Toggle checked={c.requirePhoneVerification} onChange={(v) => update('requirePhoneVerification', v)} label="Text a code to verify the customer's phone before booking" detail="Rulebook requirement. Sent through LeadConnector." />
            <Toggle checked={c.aiAssistant} onChange={(v) => update('aiAssistant', v)} label="Smart chat (Gemini) reads typed messages" detail="Off = buttons and keyword matching only. Prices and booking never depend on it." />
            <div className="flex flex-wrap gap-x-6">
              <Toggle checked={c.smsConfirmations} onChange={(v) => update('smsConfirmations', v)} label="Text confirmations" detail="Only to customers who agree to texts." />
              <Toggle checked={c.emailConfirmations} onChange={(v) => update('emailConfirmations', v)} label="Email confirmations" />
            </div>
          </div>
          <ul className="space-y-2 bg-slate-50 rounded-2xl border border-slate-200 p-4 self-start">
            {readiness.map(([ok, label]) => <li key={label} className="flex items-start gap-2 text-xs font-semibold text-slate-700"><Dot ok={ok} />{label}</li>)}
          </ul>
        </div>
      </Section>

      <Section icon={<ShieldCheck size={18} />} title="Approvals" description="These services wait for a named person's yes before they're booked. The customer's time is held for up to 30 minutes, and 5 PM overflow visits always need approval.">
        <div className="flex flex-wrap gap-x-6">
          {families.map((f) => (
            <Toggle key={f} checked={c.approvalServices.includes(f)} label={(PACKAGES as any)[f].short}
              onChange={(v) => update('approvalServices', v ? [...c.approvalServices, f] : c.approvalServices.filter((x: string) => x !== f))} />
          ))}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="Approver name"><input className={inputClass} value={c.approver?.name || ''} onChange={(e) => nested('approver', { name: e.target.value })} /></Field>
          <Field label="Approver mobile" hint="Gets a text with the details and a link."><input className={inputClass} type="tel" value={c.approver?.phone || ''} onChange={(e) => nested('approver', { phone: e.target.value })} /></Field>
          <Field label="Approver email"><input className={inputClass} type="email" value={c.approver?.email || ''} onChange={(e) => nested('approver', { email: e.target.value })} /></Field>
        </div>
      </Section>

      <Section icon={<Route size={18} />} title="Route rules" description="From the scheduling workbook. Same-day and 5 PM overflow start off; turn them on when the crew is ready.">
        <Toggle checked={c.routeScoring} onChange={(v) => update('routeScoring', v)} label="Rank open times by route fit" detail="Same micro-zone and short hops first; an isolated stop or a third zone in a day ranks lower." />
        <Toggle checked={c.nearbyFirst} onChange={(v) => update('nearbyFirst', v)} label="Offer times next to jobs already booked nearby first" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="rounded-2xl border border-slate-200 p-4 space-y-2">
            <Toggle checked={c.sameDay.enabled} onChange={(v) => nested('sameDay', { enabled: v })} label="Same-day regular visits" />
            <div className="grid grid-cols-2 gap-3">
              <Num label="Book before" suffix="hour, 24h" value={c.sameDay.cutoffHour} onChange={(n) => nested('sameDay', { cutoffHour: n })} />
              <Num label="Notice" suffix="hours" value={c.sameDay.minNoticeHours} onChange={(n) => nested('sameDay', { minNoticeHours: n })} />
            </div>
            <Toggle checked={c.sameDay.requireNearby} onChange={(v) => nested('sameDay', { requireNearby: v })} label="Only next to a job already booked" />
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
                    <td className="py-1.5 pr-2"><input aria-label={`${x.name} price`} className={inputClass} type="number" min={0} step={1} value={x.priceCents / 100} onChange={(e) => updateService(x.id, { priceCents: cents(e.target.value) })} /></td>
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
          <Num label="Emergency notice" suffix="hours" value={c.emergencyLeadHours} onChange={(n) => update('emergencyLeadHours', n)} />
        </div>
        <Toggle checked={c.pricesAcknowledged} onChange={(v) => update('pricesAcknowledged', v)} label="These prices are approved for customers to see and book" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <Field label="How BOB describes a See-It-Clean visit"><textarea rows={3} className={inputClass} value={c.cleaningProcess} onChange={(e) => update('cleaningProcess', e.target.value)} /></Field>
          <Field label="How BOB describes an assessment"><textarea rows={3} className={inputClass} value={c.assessmentProcess} onChange={(e) => update('assessmentProcess', e.target.value)} /></Field>
        </div>
      </Section>

      <Section icon={<MapPin size={18} />} title="Service area and drive time" description="Customers outside these ZIP codes or past the drive limit are sent to the team instead of a calendar.">
        <Field label="Approved ZIP codes" hint={`${c.serviceZips.length} ZIP code${c.serviceZips.length === 1 ? '' : 's'}`}>
          <textarea rows={3} className={inputClass} value={text.zips} placeholder="85326, 85338, 85374…" onChange={(e) => { setText({ ...text, zips: e.target.value }); update('serviceZips', list(e.target.value)); }} />
        </Field>
        {missingWestValley.length > 0 && (
          <button className={secondaryButton} onClick={() => { const next = [...new Set([...c.serviceZips, ...westValley])]; update('serviceZips', next); setText({ ...text, zips: next.join(', ') }); }}>
            <Plus size={15} />Add the {missingWestValley.length} West Valley ZIP{missingWestValley.length === 1 ? '' : 's'} from the territory map
          </button>
        )}
        <Field label="Where the truck starts (base address)" hint="Used for the farthest-drive limit and travel fees."><input className={inputClass} value={c.baseAddress} onChange={(e) => update('baseAddress', e.target.value)} /></Field>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Num label="Farthest drive from base" suffix="min" value={c.maxDriveFromBaseMin} onChange={(n) => update('maxDriveFromBaseMin', n)} />
          <Num label="Drive between jobs under" suffix="min" value={c.maxDriveBetweenJobsMin} onChange={(n) => update('maxDriveBetweenJobsMin', n)} />
          <Num label="Minimum gap between jobs" suffix="min" value={c.bufferMinutes} onChange={(n) => update('bufferMinutes', n)} hint="Used when it's longer than the drive." />
        </div>
        <div className="space-y-2">
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
        </div>
        <div className="rounded-2xl bg-slate-50 border border-slate-200 p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3 items-end">
            <Field label="Check an address against the saved settings" hint="Street, City, AZ ZIP"><input className={inputClass} value={address} onChange={(e) => setAddress(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && address.trim() && checkAddress()} /></Field>
            <button className={secondaryButton} onClick={checkAddress} disabled={!address.trim()}>Check</button>
          </div>
          {check && (
            <div className={`text-sm rounded-xl p-3 border ${check.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-rose-50 border-rose-200 text-rose-900'}`} role="status">
              {check.error || (check.ok
                ? <>Bookable. {check.driveFromBaseMin != null && `${check.driveFromBaseMin} min from base. `}Travel fee {money(check.travelFeeCents || 0)}. ZIP {check.zipApproved ? 'approved' : 'not on the list'}.</>
                : check.reason === 'not_found' ? 'Address not found.' : <>Outside the area{check.driveFromBaseMin != null ? ` (${check.driveFromBaseMin} min from base)` : ''}.</>)}
              {check.territory && <span className="block text-xs mt-1 opacity-80">{check.territory.city} · zone {check.territory.zone}{check.territory.micro ? ` · ${check.territory.micro}` : ''}{check.territory.corridor ? ` · ${check.territory.corridor}` : ''}{check.territory.fringe ? ' · fringe' : ''}</span>}
            </div>
          )}
        </div>
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

      <Section icon={<Building2 size={18} />} title="Office contact and visit prep">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Office phone" hint="Shown in confirmations and when online booking can't help."><input className={inputClass} type="tel" value={c.phone} onChange={(e) => update('phone', e.target.value)} /></Field>
          <Field label="Office email"><input className={inputClass} type="email" value={c.email} onChange={(e) => update('email', e.target.value)} /></Field>
        </div>
        <Field label="What customers should do before the visit"><textarea rows={3} className={inputClass} value={c.preparation} onChange={(e) => update('preparation', e.target.value)} /></Field>
      </Section>

      <Technicians techs={techs} onChange={(next) => { setTechs(next); setTechDirty(true); }} />
      <Answers />

      <Section icon={<Code size={18} />} title="Add BOB to dryerventsquadaz.com" description="Paste this before the closing </body> tag on the website. It adds the chat button; the office dashboard is never exposed.">
        <pre className="text-xs bg-slate-900 text-orange-200 rounded-2xl p-4 overflow-x-auto">{embed}</pre>
        <div className="flex gap-2">
          <button className={secondaryButton} onClick={() => navigator.clipboard?.writeText(embed)}>Copy</button>
          <button className={subtleButton} onClick={() => saveText('BOB-website-embed.html', embed, 'text/html')}><Download size={15} />Download</button>
        </div>
      </Section>

      <Password />

      <SaveDock changed={changed} busy={busy} error={error} onSave={save} onDiscard={discard} />
    </div>
  );
}
