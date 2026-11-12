import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertTriangle, CheckCircle2, Download, Info, Loader2, MessageSquare, RefreshCw, Search, X, XCircle } from 'lucide-react';
import { api, saveText } from '../lib/api';
import { describeActivity } from '../../shared/activity-text.mjs';
import { ErrorNote, Field, inputClass, secondaryButton } from './ui';

const AZ = 'America/Phoenix';
const dayKey = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: AZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

/** "Today", "Yesterday", or "Tuesday, November 10" (with the year when it isn't this year), in Arizona time. */
export function dayHeading(ms: number, now = Date.now()) {
  const key = dayKey(ms);
  if (key === dayKey(now)) return 'Today';
  if (key === dayKey(now - 86_400_000)) return 'Yesterday';
  return new Date(ms).toLocaleDateString('en-US', { timeZone: AZ, weekday: 'long', month: 'long', day: 'numeric', ...(key.slice(0, 4) !== dayKey(now).slice(0, 4) ? { year: 'numeric' } : {}) });
}
const timeOfDay = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { timeZone: AZ, hour: 'numeric', minute: '2-digit' });

const TONES = {
  problem: { label: 'Problem', Icon: XCircle, card: 'border-rose-200 bg-rose-50/40', badge: 'bg-rose-100 text-rose-800', icon: 'text-rose-600' },
  attention: { label: 'Worth a look', Icon: AlertTriangle, card: 'border-amber-200 bg-amber-50/30', badge: 'bg-amber-100 text-amber-800', icon: 'text-amber-600' },
  good: { label: '', Icon: CheckCircle2, card: 'border-slate-200 bg-white', badge: '', icon: 'text-emerald-600' },
  info: { label: '', Icon: Info, card: 'border-slate-200 bg-white', badge: '', icon: 'text-slate-400' },
} as const;
const SPEAKERS: Record<string, string> = { customer: 'Customer', bob: 'BOB', error: 'Message shown' };

type Item = { id: string; kind: string; created: number; level?: string; sessionId?: string; requestId?: string; details?: any };

/** The raw record, kept out of the way for whoever is helping troubleshoot. */
function TechnicalDetails({ item }: { item: Item }) {
  return <details className="text-xs text-slate-500">
    <summary className="cursor-pointer select-none hover:text-slate-700">Technical details (for support)</summary>
    <p className="font-mono mt-2">Event type: {item.kind}</p>
    <pre className="mt-2 p-3 rounded-xl bg-slate-50 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(item.details, null, 2)}</pre>
    <p className="font-mono mt-2 break-all">{item.sessionId ? `Conversation ${item.sessionId} · ` : ''}Request {item.requestId || '—'} · Event {item.id}</p>
  </details>;
}

/** One activity record in plain English. */
export function ActivityEntry({ item, showConversation, onShowConversation }: { item: Item; showConversation?: boolean; onShowConversation?: (id: string) => void }) {
  const text = describeActivity(item);
  const tone = TONES[text.tone as keyof typeof TONES] || TONES.info;
  const Icon = text.chat ? MessageSquare : tone.Icon;
  const when = <time className="text-xs text-slate-500 whitespace-nowrap" dateTime={new Date(item.created).toISOString()}>{timeOfDay(item.created)}</time>;
  if (text.routine) return <article className="flex items-start gap-2 px-4 py-2 text-xs text-slate-500">
    <Icon size={14} className={`mt-0.5 shrink-0 ${tone.icon}`} aria-hidden="true" />
    <div className="min-w-0 flex-1"><span className="font-semibold text-slate-600">{text.title}</span>{text.detail && <span> · {text.detail}</span>}<div className="mt-1"><TechnicalDetails item={item} /></div></div>
    {when}
  </article>;
  return <article className={`border rounded-2xl p-4 ${tone.card}`}>
    <div className="flex items-start gap-3">
      <Icon size={20} className={`mt-0.5 shrink-0 ${text.chat ? 'text-blue-500' : tone.icon}`} aria-hidden="true" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <h3 className="text-sm font-bold text-slate-900">{tone.label && <span className={`inline-block mr-2 px-2 py-0.5 rounded-full text-[11px] font-extrabold align-middle ${tone.badge}`}>{tone.label}</span>}{text.title}</h3>
          {when}
        </div>
        {text.quote?.text && <blockquote className={`text-sm whitespace-pre-wrap rounded-xl px-3 py-2 border-l-4 ${text.quote.who === 'bob' ? 'bg-orange-50 border-orange-300 text-slate-800' : text.quote.who === 'error' ? 'bg-white border-rose-300 text-slate-800' : 'bg-slate-50 border-blue-300 text-slate-800'}`}><span className="font-bold">{SPEAKERS[text.quote.who] || 'Said'}: </span>{text.quote.text}</blockquote>}
        {text.detail && <p className="text-sm text-slate-600">{text.detail}</p>}
        <div className="flex flex-wrap items-start gap-x-4 gap-y-1">
          {showConversation && item.sessionId && <button type="button" className="text-xs font-bold text-blue-700 hover:underline" onClick={() => onShowConversation?.(item.sessionId!)}>See this whole conversation</button>}
          <TechnicalDetails item={item} />
        </div>
      </div>
    </div>
  </article>;
}

export function ActivityLogPage() {
  const [items, setItems] = useState<Item[]>([]), [cursor, setCursor] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [session, setSession] = useState(''), [filter, setFilter] = useState(''), [level, setLevel] = useState(''), [showRoutine, setShowRoutine] = useState(false);
  const generation = useRef(0);
  const load = useCallback(async (more = '') => {
    const current = ++generation.current;
    setBusy(true); setError('');
    try { const q = new URLSearchParams({ session: filter, level, ...(more ? { cursor: more } : {}) }); const r = await api(`/api/admin/activity?${q}`); if (current !== generation.current) return; setItems((old) => more ? [...old, ...r.items] : r.items); setCursor(r.nextCursor); }
    catch (e) { if (current === generation.current) setError((e as Error).message); } finally { if (current === generation.current) setBusy(false); }
  }, [filter, level]);
  useEffect(() => { void load(); }, [load]);
  const openConversation = (id: string) => { setSession(id); setFilter(id); };
  const shown = useMemo(() => showRoutine ? items : items.filter((item) => !describeActivity(item).routine), [items, showRoutine]);
  const hidden = items.length - shown.length;
  const days = useMemo(() => {
    const out: { heading: string; items: Item[] }[] = [];
    for (const item of shown) {
      const heading = dayHeading(item.created);
      if (out.at(-1)?.heading === heading) out.at(-1)!.items.push(item); else out.push({ heading, items: [item] });
    }
    return out;
  }, [shown]);
  const download = () => saveText(`bob-activity-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ exportedAt: new Date().toISOString(), loadedRecords: items.length, hasMore: Boolean(cursor), items: items.map((item) => ({ summary: describeActivity(item).title, ...item })) }, null, 2), 'application/json');
  return <div className="space-y-5 animate-in">
    <div className="flex flex-wrap justify-between gap-3 items-start"><div><h1 className="text-2xl font-black text-slate-900 flex items-center gap-2"><Activity className="text-orange-500" />BOB activity</h1><p className="text-sm text-slate-500 mt-1 max-w-2xl">Everything BOB has done: customer chats, bookings, texts and emails it sent, and anything that went wrong. Newest first, in Arizona time.</p></div><div className="flex gap-2"><button className={secondaryButton} onClick={() => void load()} disabled={busy}><RefreshCw size={16} />Refresh</button><button className={secondaryButton} disabled={!items.length} onClick={download} title="Saves what's loaded below as a file you can send to support"><Download size={16} />Download for support</button></div></div>
    <form className="flex flex-wrap items-end gap-3 bg-white border border-slate-200 p-4 rounded-2xl" onSubmit={(e) => { e.preventDefault(); setFilter(session.trim()); }}>
      <div className="min-w-0 w-full sm:w-auto sm:flex-1"><Field label="Conversation" hint={'Leave blank to see everything, or choose "See this whole conversation" on any entry.'}><input className={inputClass} value={session} onChange={(e) => setSession(e.target.value)} placeholder="All conversations" /></Field></div>
      <Field label="Show"><select className={inputClass} value={level} onChange={(e) => setLevel(e.target.value)}><option value="">Everything</option><option value="error">Problems only</option><option value="warning">Things worth a look</option><option value="info">Normal activity</option></select></Field>
      <button className={secondaryButton}><Search size={16} />Filter</button>
      <label className="basis-full flex items-center gap-2 text-sm text-slate-600 cursor-pointer"><input type="checkbox" className="size-4 accent-orange-500" checked={showRoutine} onChange={(e) => setShowRoutine(e.target.checked)} />Show behind-the-scenes steps (each tap and screen a customer goes through)</label>
    </form>
    {filter && <div className="flex flex-wrap items-center gap-2 text-sm bg-blue-50 border border-blue-200 text-blue-900 rounded-2xl px-4 py-2.5"><MessageSquare size={16} aria-hidden="true" /><span>Showing one conversation, in order from newest to oldest.</span><button type="button" className="ml-auto inline-flex items-center gap-1 font-bold hover:underline" onClick={() => { setSession(''); setFilter(''); }}><X size={14} />Show everything</button></div>}
    {error && <ErrorNote>{error}</ErrorNote>}
    {busy && !items.length && <p role="status" className="flex items-center gap-2 text-slate-500"><Loader2 className="animate-spin" size={18} />Loading saved activity…</p>}
    {!busy && !items.length && !error && <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-slate-500">Nothing to show for this filter yet. New activity appears here as customers use BOB.</div>}
    {!!items.length && !shown.length && <div className="bg-white border border-slate-200 rounded-2xl p-6 text-center text-slate-500">Only behind-the-scenes steps here. {cursor ? 'Load older activity below, or tick the box above to see them.' : 'Tick the box above to see them.'}</div>}
    {days.map((day) => <section key={day.heading} className="space-y-3"><h2 className="text-xs font-extrabold uppercase tracking-wide text-slate-500 pt-2">{day.heading}</h2>{day.items.map((item) => <ActivityEntry key={item.id} item={item} showConversation={!filter} onShowConversation={openConversation} />)}</section>)}
    {hidden > 0 && !!shown.length && <p className="text-xs text-slate-500 text-center">{hidden} behind-the-scenes step{hidden === 1 ? '' : 's'} hidden. <button type="button" className="font-bold text-blue-700 hover:underline" onClick={() => setShowRoutine(true)}>Show them</button></p>}
    {cursor && <button className={secondaryButton} disabled={busy} onClick={() => void load(cursor)}>{busy ? 'Loading…' : 'Load older activity'}</button>}
  </div>;
}
