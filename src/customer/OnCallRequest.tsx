import React, { useEffect, useRef, useState } from 'react';
import { Clock, Loader2, Phone } from 'lucide-react';
import { api } from '../lib/api';

export function OnCallRequest({ token, texting, onChanged }: { token: string; texting: boolean; onChanged: () => void }) {
  const [request, setRequest] = useState<any>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const status = useRef(''), changed = useRef(onChanged); changed.current = onChanged;
  function receive(r: any) { setRequest(r); if (r?.status !== status.current) { status.current = r?.status || ''; if (['accepted', 'follow_up'].includes(r?.status)) changed.current(); } }
  useEffect(() => {
    let active = true, loading = false;
    const load = async () => {
      if (loading || document.visibilityState === 'hidden') return;
      loading = true;
      try { const r = await api('/api/on-call/current', { token }); if (active) { receive(r.request); setError(''); } }
      catch (e) { if (active) setError((e as Error).message); } finally { loading = false; }
    };
    void load(); const poll = window.setInterval(() => void load(), 5000), timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => { active = false; clearInterval(poll); clearInterval(timer); };
  }, [token]);
  async function start() { setBusy(true); setError(''); try { receive((await api('/api/on-call', { method: 'POST', token, body: {} })).request); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  const seconds = request ? Math.max(0, Math.ceil((request.expiresAt - now) / 1000)) : 0;
  return <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-slate-800 space-y-3">
    <h3 className="font-extrabold flex items-center gap-2"><Phone size={18} />Need emergency or same-day help?</h3>
    {!request && <><p className="text-sm leading-relaxed">{texting ? 'Ask the technicians on call whether they can take your visit. We’ll wait up to five minutes for a response, then check the live schedule.' : 'Emergency and same-day booking is temporarily paused. Send your request to the office for follow-up.'}</p><button disabled={busy} onClick={() => void start()} className="rounded-xl bg-slate-900 text-white font-bold px-4 py-3 text-sm flex gap-2 items-center disabled:opacity-50">{busy && <Loader2 className="animate-spin" size={16} />}{texting ? 'Check emergency / same-day availability' : 'Send an urgent availability request'}</button></>}
    {request?.status === 'pending' && <p className="text-sm" role="status"><Clock className="inline mr-2" size={16} />We’ve contacted the on-call team. {seconds ? `Waiting for a reply: ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}.` : 'The response window has ended. Checking the result…'} You can leave this page; your request stays on record.</p>}
    {request?.status === 'accepted' && <p className="text-sm" role="status"><strong>{request.acceptedBy}</strong> can take a visit, subject to the live schedule. Choose an opening for today below and confirm your booking.</p>}
    {request?.status === 'follow_up' && <div className="text-sm space-y-2" role="status"><p>{request.reason}</p><p>We created support ticket <strong>{request.ticketId}</strong> for West Valley. This request has not booked an appointment.</p></div>}
    {error && <p className="text-sm text-rose-700" role="alert">{error}</p>}
    <p className="text-xs text-slate-600">For smoke, flames, or a gas smell, leave the building and call 911 from a safe location.</p>
  </div>;
}
