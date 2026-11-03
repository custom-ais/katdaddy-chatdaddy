import React, { useEffect, useMemo, useState } from 'react';
import { CheckCircle, Clock, Loader2, MapPin, Moon, Phone, XCircle } from 'lucide-react';
import { api } from '../lib/api';
import { money } from '../../shared/domain.mjs';

const TZ = 'America/Phoenix';
const azTime = (ms: number) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(ms);
const azDayTime = (ms: number | string) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
/** "19:30" as the next such moment in Arizona time (no daylight saving there). */
function nextArizonaTime(hhmm: string, now = Date.now()) {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const at = Date.parse(`${ymd}T${hhmm}:00-07:00`);
  return Number.isFinite(at) && at < now - 10 * 60_000 ? at + 24 * 3600_000 : at;
}
/** Quick arrival choices, rounded up to the next 15 minutes. */
const QUICK = [30, 60, 90, 120].map((m) => ({ label: m < 60 ? `In ${m} min` : `In ${m / 60 === 1 ? '1 hour' : m / 60 === 1.5 ? '1½ hours' : `${m / 60} hours`}`, minutes: m }));
const roundUp = (ms: number) => Math.ceil(ms / (15 * 60_000)) * 15 * 60_000;
const prettyPhone = (p: string) => { const d = String(p || '').replace(/\D/g, '').slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p; };

/**
 * The page behind the after-hours email's "Yes, I can go" / "No, can't make it" buttons. No login:
 * the signed link is good for this one request while it's open. Nothing changes until a button here is pressed.
 */
export function RespondPage() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const a = params.get('a') || '', s = params.get('s') || '';
  const [choice, setChoice] = useState<'yes' | 'no'>(params.get('c') === 'no' ? 'no' : 'yes');
  const [info, setInfo] = useState<any>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [quick, setQuick] = useState<number | null>(60), [custom, setCustom] = useState('');
  const [techId, setTechId] = useState(''), [name, setName] = useState('');

  useEffect(() => {
    document.title = 'After-hours request · Dryer Vent Squad';
    api(`/api/approvals/respond?a=${encodeURIComponent(a)}&s=${encodeURIComponent(s)}`).then((r) => {
      setInfo(r); setTechId(r.technicians?.[0]?.id || ''); setName(r.approverName || '');
    }, (err) => setError((err as Error).message));
  }, [a, s]);

  const arrivalAt = custom ? nextArizonaTime(custom) : quick != null ? roundUp(Date.now() + quick * 60_000) : NaN;
  const answer = async (decision: 'approve' | 'decline') => {
    setBusy(true); setError('');
    try { setInfo({ ...info, ...(await api('/api/approvals/respond', { method: 'POST', body: { a, s, decision, arrivalAt, technicianId: techId, name } })) }); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };

  const r = info?.request, c = r?.customer || {};
  const first = String(c.name || '').split(/\s+/)[0] || 'The customer';
  return (
    <div className="min-h-dvh bg-[#eef2f7] px-4 py-6 sm:py-10">
      <div className="max-w-lg mx-auto bg-white rounded-3xl overflow-hidden shadow-xl shadow-slate-900/10">
        <div className="bg-[#083653] px-6 py-6 text-white">
          <p className="text-[11px] font-bold tracking-[.14em] uppercase text-sky-200">Dryer Vent Squad · West Valley</p>
          <h1 className="text-2xl font-extrabold mt-1.5 flex items-center gap-2"><Moon size={22} className="text-orange-300" />After-hours request</h1>
          {r && r.status === 'pending' && <p className="text-sm text-sky-100 mt-1.5">{first} is waiting in the chat for your answer.</p>}
        </div>
        <div className="p-5 sm:p-6">
          {!info && !error && <p className="flex items-center gap-2 text-slate-500"><Loader2 size={18} className="animate-spin" />Loading the request…</p>}
          {error && <div role="alert" className="mb-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm font-semibold text-rose-700">{error}</div>}
          {r && (
            <>
              <Status r={r} first={first} />
              <div className="rounded-2xl border border-slate-200 p-4 space-y-2 text-sm">
                <p className="font-extrabold text-slate-900 text-base">{c.name}</p>
                <a className="flex items-center gap-2 font-bold text-sky-700" href={`tel:${c.phone}`}><Phone size={16} />Call {prettyPhone(c.phone)}</a>
                <a className="flex items-start gap-2 text-slate-700" target="_blank" rel="noreferrer" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${c.address}, ${c.city}, AZ ${c.zip}`)}`}><MapPin size={16} className="mt-0.5 shrink-0 text-slate-400" />{c.address}, {c.city}, AZ {c.zip}</a>
                {r.concerns?.length > 0 && <p className="text-slate-600"><b>Customer said:</b> {r.concerns.join(' · ')}</p>}
              </div>
              <div className="mt-3 rounded-2xl border border-slate-200 divide-y divide-slate-100 text-sm">
                {r.lineItems.map((l: any, i: number) => <div key={i} className="flex justify-between gap-3 px-4 py-2.5"><span className="text-slate-600">{l.name}</span><span className="font-bold">{money(l.cents)}</span></div>)}
                <div className="flex justify-between px-4 py-2.5 font-black"><span>Total</span><span className="text-orange-600">{money(r.totalCents)}</span></div>
              </div>

              {r.status === 'pending' && (
                <div className="mt-5">
                  <div className="grid grid-cols-2 gap-2 p-1 rounded-2xl bg-slate-100" role="radiogroup" aria-label="Can you go?">
                    <button type="button" role="radio" aria-checked={choice === 'yes'} onClick={() => setChoice('yes')} className={`py-3 rounded-xl font-extrabold ${choice === 'yes' ? 'bg-emerald-600 text-white shadow' : 'text-slate-600'}`}>Yes, I can go</button>
                    <button type="button" role="radio" aria-checked={choice === 'no'} onClick={() => setChoice('no')} className={`py-3 rounded-xl font-extrabold ${choice === 'no' ? 'bg-slate-800 text-white shadow' : 'text-slate-600'}`}>No, can't make it</button>
                  </div>
                  {choice === 'yes' ? (
                    <div className="mt-4 space-y-4">
                      <div>
                        <p className="text-sm font-extrabold text-slate-800 mb-2">When will you get there?</p>
                        <div className="grid grid-cols-2 gap-2">
                          {QUICK.map((q) => (
                            <button key={q.minutes} type="button" onClick={() => { setQuick(q.minutes); setCustom(''); }} className={`py-3 rounded-xl border-2 font-bold text-sm ${!custom && quick === q.minutes ? 'border-emerald-600 bg-emerald-50 text-emerald-800' : 'border-slate-200 text-slate-700'}`}>
                              {q.label}<span className="block text-xs font-semibold text-slate-500">{azTime(roundUp(Date.now() + q.minutes * 60_000))}</span>
                            </button>
                          ))}
                        </div>
                        <label className="mt-2 flex items-center gap-2 text-sm font-semibold text-slate-600">Or a time:
                          <input type="time" step={900} value={custom} onChange={(e) => setCustom(e.target.value)} className="flex-1 border border-slate-200 rounded-xl px-3 py-2 font-semibold text-slate-800" />
                        </label>
                      </div>
                      {info.technicians.length > 1 && (
                        <label className="block text-sm font-extrabold text-slate-800">Who's going?
                          <select value={techId} onChange={(e) => setTechId(e.target.value)} className="mt-1.5 w-full border border-slate-200 rounded-xl px-3 py-2.5 font-semibold">
                            {info.technicians.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}
                          </select>
                        </label>
                      )}
                      <label className="block text-sm font-extrabold text-slate-800">Your name
                        <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" className="mt-1.5 w-full border border-slate-200 rounded-xl px-3 py-2.5 font-semibold" />
                      </label>
                      <button type="button" disabled={busy || !Number.isFinite(arrivalAt)} onClick={() => void answer('approve')} className="w-full py-4 rounded-2xl bg-emerald-600 hover:bg-emerald-700 text-white font-extrabold text-base flex items-center justify-center gap-2 disabled:opacity-60">
                        {busy ? <><Loader2 size={20} className="animate-spin" />Booking…</> : <><CheckCircle size={20} />Book it for {Number.isFinite(arrivalAt) ? azTime(arrivalAt) : '…'}</>}
                      </button>
                      <p className="text-xs text-slate-500">This books the visit with the after-hours premium{info.technicians.length === 1 ? ` for ${info.technicians[0].name}` : ''}, and {first} sees the confirmation in the chat.</p>
                    </div>
                  ) : (
                    <div className="mt-4 space-y-3">
                      <p className="text-sm text-slate-600">{first} will be offered our soonest regular openings instead.</p>
                      <button type="button" disabled={busy} onClick={() => void answer('decline')} className="w-full py-4 rounded-2xl bg-slate-800 hover:bg-slate-900 text-white font-extrabold text-base flex items-center justify-center gap-2 disabled:opacity-60">
                        {busy ? <><Loader2 size={20} className="animate-spin" />Sending…</> : <><XCircle size={20} />Tell them I can't make it</>}
                      </button>
                    </div>
                  )}
                  <p className="mt-4 text-xs text-slate-400 flex items-center gap-1.5"><Clock size={13} />The request closes at {azTime(r.expiresAt)} if nobody answers.</p>
                </div>
              )}
            </>
          )}
        </div>
        <p className="px-6 py-4 bg-slate-50 text-xs text-slate-500">Sent by ChatDaddy for {info?.businessName || 'Dryer Vent Squad West Valley'}</p>
      </div>
    </div>
  );
}

function Status({ r, first }: { r: any; first: string }) {
  if (r.status === 'pending') return null;
  const box = 'mb-4 rounded-2xl border p-4 text-sm font-semibold';
  if (r.status === 'booked' || r.status === 'action_needed') {
    return <div className={`${box} border-emerald-200 bg-emerald-50 text-emerald-900`}><p className="font-extrabold text-base flex items-center gap-2"><CheckCircle size={18} />Booked{r.scheduledAt ? ` for ${azDayTime(r.scheduledAt)}` : ''}</p><p className="mt-1">{r.technicianName ? `${r.technicianName} is going. ` : ''}{first} sees the confirmation in the chat.{r.status === 'action_needed' ? ' Check Jobber: the visit needs a quick look there.' : ''}</p></div>;
  }
  if (r.status === 'declined') return <div className={`${box} border-slate-200 bg-slate-50 text-slate-800`}>Done. {first} is being offered our regular openings.{r.decision?.by ? ` (Answered by ${r.decision.by}.)` : ''}</div>;
  if (r.status === 'cancelled') return <div className={`${box} border-slate-200 bg-slate-50 text-slate-800`}>{first} cancelled this request and is booking a regular time.</div>;
  if (r.status === 'expired') return <div className={`${box} border-amber-200 bg-amber-50 text-amber-900`}>This request closed without an answer, so {first} was offered our regular times.</div>;
  return <div className={`${box} border-rose-200 bg-rose-50 text-rose-800`}>It couldn't be booked{r.failure ? `: ${r.failure}` : '.'} Call {first} to sort it out.</div>;
}
