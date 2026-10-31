import React, { useEffect, useState } from 'react';
import { Activity, ArrowLeft, MessageSquare, Pause, Play, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { ErrorNote, secondaryButton } from './ui';

type Event = { id: string; created: number; kind: string; conversation_id?: string; customer?: string; data: any };
const when = (ms: number) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/Phoenix', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });

function EventCard({ event, onOpen }: { event: Event; onOpen?: () => void }) {
  const d = event.data, decision = d.decision;
  return <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 mb-3">
      <span className="flex items-center gap-2"><span className={`rounded-full px-2.5 py-1 font-bold ${decision?.aiError || d.status >= 400 ? 'bg-amber-100 text-amber-800' : 'bg-blue-50 text-blue-800'}`}>{decision ? decision.aiError ? 'AI fallback' : decision.via === 'ai' ? 'AI + booking rules' : 'Guided rules' : event.kind === 'message' ? 'Browser-reported message' : event.kind === 'operation' ? 'Booking activity' : 'Conversation started'}</span>{event.customer || 'Customer'}</span>
      <time>{when(event.created)} AZ</time>
    </div>
    {d.user && <p className="mb-3 text-sm text-slate-700 whitespace-pre-wrap"><strong>Customer:</strong> {d.user}</p>}
    {(d.reply || d.text || d.summary) && <p className="text-sm leading-relaxed text-slate-800 whitespace-pre-wrap"><strong>{d.role === 'user' ? 'Customer' : d.reply || d.role === 'assistant' ? 'BOB' : 'Result'}:</strong> {d.reply || d.text || d.summary}</p>}
    {decision && <div className="mt-4 rounded-xl bg-slate-50 border border-slate-200 p-4">
      <p className="text-xs font-extrabold uppercase tracking-wider text-slate-500 mb-2">Decision &amp; reasons</p>
      <ul className="space-y-1 text-sm text-slate-600">{decision.reasons?.map((reason: string, index: number) => <li key={index}>• {reason}</li>)}</ul>
      {!!Object.keys(decision.facts || {}).length && <div className="mt-3 flex flex-wrap gap-2">{Object.entries(decision.facts).map(([key, value]) => <span key={key} className="rounded-lg bg-white border border-slate-200 px-2 py-1 text-xs text-slate-600">{key}: {Array.isArray(value) ? value.join(', ') : String(value)}</span>)}</div>}
    </div>}
    {onOpen && <button onClick={onOpen} className="mt-4 text-xs font-bold text-blue-700 hover:underline">Open conversation →</button>}
  </article>;
}

export function BobActivity() {
  const [view, setView] = useState<'live' | 'archive'>('live'), [paused, setPaused] = useState(false);
  const [events, setEvents] = useState<Event[]>([]), [conversations, setConversations] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null), [error, setError] = useState(''), [updated, setUpdated] = useState(0), [more, setMore] = useState(false);
  const [paged, setPaged] = useState(false);
  useEffect(() => {
    let active = true, fetching = false;
    const load = async () => {
      if (fetching || paused || (view === 'archive' && paged) || document.visibilityState === 'hidden') return;
      fetching = true;
      try {
        const response = await api(view === 'live' ? '/api/admin/activity' : '/api/admin/conversations');
        if (!active) return;
        if (view === 'live') setEvents(response.events);
        else { setConversations(response.conversations); setMore(response.conversations.length === 50); }
        setUpdated(Date.now()); setError('');
      } catch (e) { if (active) setError((e as Error).message); }
      finally { fetching = false; }
    };
    void load(); const timer = window.setInterval(() => void load(), view === 'live' ? 3000 : 15000);
    return () => { active = false; clearInterval(timer); };
  }, [view, paused, paged]);
  useEffect(() => {
    if (!selected?.id || paused) return;
    let active = true;
    const timer = setInterval(() => { if (document.visibilityState === 'visible') api(`/api/admin/conversations/${encodeURIComponent(selected.id)}`).then((r) => { if (active) setSelected(r.conversation); }).catch(() => {}); }, 3000);
    return () => { active = false; clearInterval(timer); };
  }, [selected?.id, paused]);
  const open = async (id: string) => {
    try { const r = await api(`/api/admin/conversations/${encodeURIComponent(id)}`); setSelected(r.conversation); setError(''); }
    catch (e) { setError((e as Error).message); }
  };
  const loadMore = async () => {
    try {
      setPaged(true);
      const last = conversations.at(-1);
      const r = await api(`/api/admin/conversations?before=${last?.updated}&beforeId=${encodeURIComponent(last?.id || '')}`);
      setConversations((previous) => [...previous, ...r.conversations]); setMore(r.conversations.length === 50);
    } catch (e) { setError((e as Error).message); }
  };
  return <div className="space-y-5 animate-in">
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><h2 className="text-2xl font-black text-slate-900">BOB activity</h2><p className="mt-1 text-sm text-slate-500">Customer messages, BOB’s replies, rule decisions, and booking outcomes.</p></div>
      <button className={secondaryButton} onClick={() => { setPaged(false); setPaused(!paused); }}>{paused ? <Play size={15} /> : <Pause size={15} />}{paused ? 'Resume updates' : 'Pause updates'}</button>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex gap-2">{(['live', 'archive'] as const).map((value) => <button key={value} onClick={() => { setView(value); setSelected(null); }} className={`rounded-xl border px-4 py-2 text-sm font-bold ${view === value ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200'}`}>{value === 'live' ? <Activity className="inline mr-2" size={16} /> : <MessageSquare className="inline mr-2" size={16} />}{value === 'live' ? 'Live activity' : 'Conversation archive'}</button>)}</div>
      <span className="text-xs text-slate-500">{paused || paged ? 'Updates paused' : view === 'live' ? 'Updates every 3 seconds' : 'Updates every 15 seconds'}{updated ? ` · Last update ${when(updated)}` : ''}</span>
    </div>
    {error && <ErrorNote>{error}</ErrorNote>}
    <p className="text-xs text-slate-500">Messages are retained for a rolling 60 days. Inactive conversation records expire after 60 days. Decision explanations describe observed facts and booking rules. The archive starts when this feature is deployed.</p>
    {selected ? <div className="space-y-4">
      <button className={secondaryButton} onClick={() => setSelected(null)}><ArrowLeft size={15} />Back to {view === 'live' ? 'live activity' : 'archive'}</button>
      <div className="rounded-2xl bg-slate-900 text-white p-5"><h3 className="font-extrabold">{selected.data.contact?.name || 'Customer conversation'}</h3><p className="mt-1 text-sm text-slate-300">{selected.data.contact?.email || selected.data.contact?.phone || 'Contact details not supplied'} · {selected.data.stage}</p><p className="mt-2 text-xs text-slate-400">Started {when(selected.created)} · Expires {when(selected.expires)}</p></div>
      {selected.events.map((event: Event) => <EventCard event={event} key={event.id} />)}
    </div> : view === 'live' ? <div className="space-y-4">{events.map((event) => <EventCard key={event.id} event={event} onOpen={() => event.conversation_id && void open(event.conversation_id)} />)}{!events.length && <div className="rounded-2xl bg-white border border-slate-200 p-8 text-center text-slate-500">Waiting for BOB’s next conversation.</div>}</div>
      : <div className="space-y-3">{conversations.map((c) => <button key={c.id} onClick={() => void open(c.id)} className="w-full rounded-2xl border border-slate-200 bg-white p-5 text-left hover:border-blue-300"><div className="flex flex-wrap justify-between gap-2"><strong className="text-slate-900">{c.data.contact?.name || 'Customer conversation'}</strong><span className="text-xs text-slate-500">{when(c.updated)}</span></div><div className="mt-2 text-sm text-slate-500">{c.data.package || c.data.route || 'Service not selected'} · {c.data.stage}{c.data.bookingId ? ` · ${c.data.bookingId}` : ''}</div></button>)}{more && <button onClick={() => void loadMore()} className={secondaryButton}><RefreshCw size={14} />Load older conversations</button>}{!conversations.length && <div className="rounded-2xl bg-white p-8 text-center text-slate-500">No conversations have been archived yet.</div>}</div>}
  </div>;
}
