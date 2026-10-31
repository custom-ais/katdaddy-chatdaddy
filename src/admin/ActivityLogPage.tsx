import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Download, Loader2, RefreshCw, Search } from 'lucide-react';
import { api, saveText } from '../lib/api';
import { ErrorNote, Field, inputClass, secondaryButton } from './ui';

export function ActivityLogPage() {
  const [items, setItems] = useState<any[]>([]), [cursor, setCursor] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [session, setSession] = useState(''), [filter, setFilter] = useState(''), [level, setLevel] = useState('');
  const generation = useRef(0);
  const load = useCallback(async (more = '') => {
    const current = ++generation.current;
    setBusy(true); setError('');
    try { const q = new URLSearchParams({ session: filter, level, ...(more ? { cursor: more } : {}) }); const r = await api(`/api/admin/activity?${q}`); if (current !== generation.current) return; setItems((old) => more ? [...old, ...r.items] : r.items); setCursor(r.nextCursor); }
    catch (e) { if (current === generation.current) setError((e as Error).message); } finally { if (current === generation.current) setBusy(false); }
  }, [filter, level]);
  useEffect(() => { void load(); }, [load]);
  return <div className="space-y-5 animate-in">
    <div className="flex flex-wrap justify-between gap-3 items-start"><div><h1 className="text-2xl font-black text-slate-900 flex items-center gap-2"><Activity className="text-orange-500" />BOB activity</h1><p className="text-sm text-slate-500 mt-1">Saved conversations, availability inquiries, message attempts and errors. Times are shown in Arizona time.</p></div><div className="flex gap-2"><button className={secondaryButton} onClick={() => void load()} disabled={busy}><RefreshCw size={16} />Refresh</button><button className={secondaryButton} disabled={!items.length} onClick={() => saveText(`bob-activity-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ exportedAt: new Date().toISOString(), loadedRecords: items.length, hasMore: Boolean(cursor), items }, null, 2), 'application/json')}><Download size={16} />Export loaded records</button></div></div>
    <form className="flex flex-wrap items-end gap-3 bg-white border border-slate-200 p-4 rounded-2xl" onSubmit={(e) => { e.preventDefault(); setFilter(session.trim()); }}><div className="min-w-0 flex-1"><Field label="Conversation ID"><input className={inputClass} value={session} onChange={(e) => setSession(e.target.value)} placeholder="All conversations" /></Field></div><Field label="Level"><select className={inputClass} value={level} onChange={(e) => setLevel(e.target.value)}><option value="">All events</option><option value="error">Errors</option><option value="warning">Warnings</option><option value="info">Information</option></select></Field><button className={secondaryButton}><Search size={16} />Filter</button></form>
    {error && <ErrorNote>{error}</ErrorNote>}
    {busy && !items.length && <p role="status" className="flex items-center gap-2 text-slate-500"><Loader2 className="animate-spin" size={18} />Loading saved activity…</p>}
    {!busy && !items.length && !error && <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-slate-500">No saved activity matches this filter. New activity appears here after BOB is used.</div>}
    <div className="space-y-3">{items.map((item) => <article key={item.id} className={`bg-white border rounded-2xl p-4 ${item.level === 'error' ? 'border-rose-200' : 'border-slate-200'}`}><div className="flex flex-wrap justify-between gap-2 text-xs"><strong className={item.level === 'error' ? 'text-rose-700' : 'text-slate-800'}>{item.kind}</strong><time className="text-slate-500" dateTime={new Date(item.created).toISOString()}>{new Date(item.created).toLocaleString('en-US', { timeZone: 'America/Phoenix' })}</time></div>{item.sessionId && <button className="text-xs font-mono text-blue-700 mt-2 hover:underline" onClick={() => { setSession(item.sessionId); setFilter(item.sessionId); }}>Conversation {item.sessionId}</button>}{item.details?.text && <p className="mt-3 text-sm whitespace-pre-wrap text-slate-700"><span className="font-bold">{item.details.role === 'user' ? 'Customer: ' : item.details.role === 'assistant' ? 'BOB: ' : ''}</span>{item.details.text}</p>}<details className="mt-2 text-xs text-slate-500"><summary className="cursor-pointer">Event details{item.details?.status ? ` · ${item.details.status}` : ''}</summary><pre className="mt-2 p-3 rounded-xl bg-slate-50 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(item.details, null, 2)}</pre><p className="font-mono mt-2">Request {item.requestId || '—'} · Event {item.id}</p></details></article>)}</div>
    {cursor && <button className={secondaryButton} disabled={busy} onClick={() => void load(cursor)}>{busy ? 'Loading…' : 'Load older activity'}</button>}
  </div>;
}
