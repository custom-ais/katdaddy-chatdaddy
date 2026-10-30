import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bird, Bot, Building, Calendar, Check, CheckCircle, ChevronDown, ChevronRight, Clock,
  Download, Droplet, Flame, HelpCircle, Home, Layers, List, Loader2, MapPin, MessageCircle, MoreHorizontal, Pencil, Phone, RotateCcw,
  Search, Send, Shield, ShieldCheck, Sparkles, Star, Thermometer, Timer, User, Wind, Wrench, X, Zap,
} from 'lucide-react';
import { api, ApiError, saveText } from '../lib/api';
import { money, phoenixDate } from '../../shared/domain.mjs';

const TZ = 'America/Phoenix';
type Msg = { role: 'user' | 'model'; text: string; info?: string[]; local?: boolean };

/** "Thursday, Sep 24" and "8:30–9:30 AM arrival". */
export function windowParts(iso: string) {
  const t = Date.parse(iso);
  const day = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long', month: 'short', day: 'numeric' }).format(t);
  const f = (ms: number) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(ms);
  return { day, time: `${f(t - 1_800_000)}–${f(t + 1_800_000)} arrival` };
}

// ---- expandable info panels (from the dashboard design) ------------------------------------

function Expandable({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3 border border-slate-200/80 rounded-2xl overflow-hidden bg-white shadow-xs w-full">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="w-full flex items-center justify-between p-3.5 text-[14px] font-extrabold text-slate-700 hover:bg-slate-50">
        <span className="flex items-center gap-2.5"><HelpCircle size={19} className="text-orange-500" />{title}</span>
        {open ? <ChevronDown size={18} className="text-orange-500" /> : <ChevronRight size={18} className="text-slate-400" />}
      </button>
      {open && <div className="p-4 text-[14px] text-slate-600 bg-slate-50 border-t border-slate-100 leading-relaxed animate-in">{children}</div>}
    </div>
  );
}

const INFO: Record<string, () => React.ReactElement> = {
  pricing: () => (
    <Expandable title="What could affect pricing?">
      <p>Most visits are completed at the package price. If the technician finds the vent is unusually long, damaged, out of code, or severely clogged, you get an updated quote to approve before any extra work starts.</p>
    </Expandable>
  ),
  gas_electric: () => (
    <Expandable title="How to tell if it's gas or electric?">
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="flex-1 bg-white p-4 rounded-2xl border border-blue-100">
          <div className="flex items-center gap-2 mb-2 font-extrabold text-blue-900"><Zap size={20} className="text-blue-500" /> Electric dryer</div>
          <ul className="text-sm text-slate-500 space-y-2 list-disc pl-5 marker:text-blue-300">
            <li>A <strong className="text-slate-700">very thick</strong>, heavy-duty power cord.</li>
            <li>Plugs into a large 240V outlet with 3 or 4 big slots.</li>
            <li>No metal tube running to the wall.</li>
          </ul>
        </div>
        <div className="flex-1 bg-white p-4 rounded-2xl border border-orange-100">
          <div className="flex items-center gap-2 mb-2 font-extrabold text-orange-900"><Flame size={20} className="text-orange-500" /> Gas dryer</div>
          <ul className="text-sm text-slate-500 space-y-2 list-disc pl-5 marker:text-orange-300">
            <li>A regular-size power cord.</li>
            <li>A <strong className="text-slate-700">flexible metal or yellow-coated line</strong> from the back of the dryer to a gas valve.</li>
          </ul>
          <img src="/gas-line-connector.jpg" alt="A yellow-coated flexible gas line with metal fittings at each end" width={600} height={600} loading="lazy" decoding="async" className="mt-3 w-full max-w-[220px] mx-auto rounded-xl border border-orange-100 bg-white" />
        </div>
      </div>
      <p className="mt-3 text-xs text-slate-500">Only look if you can see it easily. Don't move the dryer to check — “I don't know” is fine.</p>
    </Expandable>
  ),
  why_we_ask: () => (
    <Expandable title="Why are we asking this?">
      <p className="mb-2">Gas connections, stacked units, and pedestals need specific safety steps, tools, and a little more time.</p>
      <p>Knowing your setup up front gives you an accurate price and lets your technician arrive ready.</p>
    </Expandable>
  ),
};

/** BOB's own picture, as in the original chat. */
function BobFace({ size }: { size: number }) {
  return (
    <span className="block rounded-full bg-white border border-sky-100 overflow-hidden shrink-0 shadow-sm" style={{ width: size, height: size }}>
      <img src="/bob-avatar.png" alt="" width={size} height={size} decoding="async" className="w-full h-full object-cover" />
    </span>
  );
}

function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*\*.*?\*\*)/g).map((part, i) =>
        part.startsWith('**') && part.endsWith('**') ? (
          <strong key={i} className="font-extrabold text-slate-900">{part.slice(2, -2)}</strong>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </>
  );
}

function iconFor(label: string) {
  const l = label.toLowerCase();
  const c = 'shrink-0';
  if (/^accept|book this|book assessment|include assessment/.test(l)) return <CheckCircle size={18} className={`${c} text-emerald-500`} />;
  if (l.includes('compare')) return <List size={18} className={`${c} text-purple-500`} />;
  if (/question|faq/.test(l)) return <MessageCircle size={18} className={`${c} text-blue-500`} />;
  if (/edit|gate code|back to/.test(l)) return <Pencil size={18} className={`${c} text-slate-400`} />;
  if (/don't know|not sure/.test(l)) return <HelpCircle size={18} className={`${c} text-slate-400`} />;
  if (/callback|contact the team|person/.test(l)) return <Phone size={18} className={`${c} text-slate-500`} />;
  if (/more services|other/.test(l)) return <MoreHorizontal size={18} className={`${c} text-slate-400`} />;
  if (l.includes('1-story')) return <Home size={18} className={`${c} text-blue-500`} />;
  if (l.includes('2-story')) return <Building size={18} className={`${c} text-blue-500`} />;
  if (l.includes('1st floor')) return <ArrowDown size={18} className={`${c} text-orange-500`} />;
  if (l.includes('2nd floor')) return <ArrowUp size={18} className={`${c} text-orange-500`} />;
  if (l.includes('roof')) return <ArrowUp size={18} className={`${c} text-amber-500`} />;
  if (l.includes('side wall')) return <ArrowRight size={18} className={`${c} text-emerald-500`} />;
  if (/one normal cycle|no signs|have dryer|^yes$|no gate code|cleaning only/.test(l)) return <Check size={18} className={`${c} text-emerald-500`} />;
  if (/^no$|no dryer|^no thanks/.test(l)) return <X size={18} className={`${c} text-rose-500`} />;
  if (l.includes('express')) return <Timer size={18} className={`${c} text-teal-500`} />;
  if (l.includes('essential')) return <Wind size={18} className={`${c} text-blue-500`} />;
  if (l.includes('performance')) return <Star size={18} className={`${c} text-orange-500`} />;
  if (l.includes('total')) return <Shield size={18} className={`${c} text-indigo-500`} />;
  if (/emergency|same-day/.test(l)) return <AlertTriangle size={18} className={`${c} text-red-500`} />;
  if (/nest|restoration|animals/.test(l)) return <Bird size={18} className={`${c} text-amber-600`} />;
  if (l.includes('gas')) return <Flame size={18} className={`${c} text-orange-500`} />;
  if (l.includes('electric')) return <Zap size={18} className={`${c} text-blue-500`} />;
  if (/stacked|pedestal|standard/.test(l)) return <Layers size={18} className={`${c} text-indigo-400`} />;
  if (l.includes('2 cycles')) return <Timer size={18} className={`${c} text-orange-400`} />;
  if (l.includes('3 or more')) return <AlertTriangle size={18} className={`${c} text-red-500`} />;
  if (/overheat|shutting off/.test(l)) return <Thermometer size={18} className={`${c} text-red-500`} />;
  if (l.includes('error')) return <Droplet size={18} className={`${c} text-blue-400`} />;
  if (l.includes('post-service')) return <Wrench size={18} className={`${c} text-slate-500`} />;
  return <ChevronRight size={18} className={`${c} text-slate-400`} />;
}

const WELCOME_CARDS: [string, React.ReactElement][] = [
  ['Dryer Vent Cleaning', <Wind strokeWidth={2} size={26} />],
  ['Repair / Reroute / Upgrade', <Wrench strokeWidth={2} size={26} />],
  ['Emergency Clog / Overheating', <AlertTriangle strokeWidth={2} size={26} />],
  ['Pest / Nest Removal', <Shield strokeWidth={2} size={26} />],
  ['Ask a Question (FAQs)', <HelpCircle strokeWidth={2} size={26} />],
  ['Help Me Choose', <Search strokeWidth={2} size={26} />],
];

// ---- contact details, collected one question at a time ---------------------------------------

type ContactStep = 'name' | 'phone' | 'email' | 'address' | 'city' | 'notes' | 'addons' | 'sms';
const CONTACT_PROMPTS: Record<ContactStep, string> = {
  name: "What's your first and last name?",
  phone: "What's the best mobile number? We'll text a code to confirm it.",
  email: "What's your email for the confirmation? It's optional.",
  address: "What's the service street address? Include a unit number if there is one.",
  city: 'And the city?',
  notes: 'Any gate code, parking, or pet notes for the technician?',
  addons: 'Want to add anything to your visit?',
  sms: 'Can we text you about this appointment — the confirmation and an on-the-way heads-up? Not marketing. Message and data rates may apply; reply STOP anytime.',
};
const INPUT_FOR: Partial<Record<ContactStep, { type: string; autoComplete: string; placeholder: string; inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'] }>> = {
  name: { type: 'text', autoComplete: 'name', placeholder: 'First and last name' },
  phone: { type: 'tel', autoComplete: 'tel', placeholder: 'Mobile number', inputMode: 'tel' },
  email: { type: 'email', autoComplete: 'email', placeholder: 'Email address' },
  address: { type: 'text', autoComplete: 'street-address', placeholder: 'Street address' },
  city: { type: 'text', autoComplete: 'address-level2', placeholder: 'City' },
  notes: { type: 'text', autoComplete: 'off', placeholder: 'Gate code, parking, pets…' },
};

// ---- pieces ---------------------------------------------------------------------------------

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-white border border-slate-200 p-5 sm:p-6 rounded-3xl shadow-xl shadow-slate-200/40 animate-in ${className}`}>{children}</div>;
}

function LineItems({ items, total }: { items: any[]; total: number }) {
  return (
    <div className="divide-y divide-slate-100 text-sm">
      {items.map((l: any) => (
        <div key={l.id || l.name} className="flex justify-between gap-4 py-2"><span className="text-slate-600">{l.name}</span><span className="font-bold text-slate-800">{money(l.cents)}</span></div>
      ))}
      <div className="flex justify-between gap-4 pt-3 font-black text-slate-900"><span>Total</span><span>{money(total)}</span></div>
    </div>
  );
}

function RequestForm({ token, session, onDone }: { token: string; session: any; onDone: (id: string) => void }) {
  const [form, setForm] = useState({ name: session?.contact?.name || '', phone: session?.contact?.phone || '', email: session?.contact?.email || '', zip: session?.zip || '', message: session?.concerns?.join('\n') || '', preference: 'phone', smsConsent: false });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const id = useRef(crypto.randomUUID());
  const input = 'w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm font-semibold text-slate-800 focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20 outline-none';
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const r = await api('/api/requests', { method: 'POST', token, body: { ...form, idempotencyKey: id.current } });
      onDone(r.request.id);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Card>
      <form onSubmit={submit} className="space-y-3">
        <h3 className="font-extrabold text-slate-800 text-lg flex items-center gap-2"><Phone size={20} className="text-orange-500" />Send the team a request</h3>
        <p className="text-sm text-slate-500">It goes straight to the Dryer Vent Squad office. It isn't a booking or a change to one — the team will call or email you.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="text-xs font-bold text-slate-700">Full name<input className={input} required autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="text-xs font-bold text-slate-700">Callback number<input className={input} required type="tel" autoComplete="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
          <label className="text-xs font-bold text-slate-700">Email (optional)<input className={input} type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
          <label className="text-xs font-bold text-slate-700">Service ZIP (optional)<input className={input} autoComplete="postal-code" value={form.zip} onChange={(e) => setForm({ ...form, zip: e.target.value })} /></label>
        </div>
        <label className="block text-xs font-bold text-slate-700">What do you need?<textarea className={`${input} min-h-24`} required maxLength={4000} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} /></label>
        <label className="block text-xs font-bold text-slate-700">Best way to reach you
          <select className={input} value={form.preference} onChange={(e) => setForm({ ...form, preference: e.target.value })}><option value="phone">Phone call</option><option value="email">Email</option></select>
        </label>
        <p className="text-xs text-slate-400">Your details and this conversation go to the DVS team for follow-up. Don't include payment details.</p>
        {error && <div role="alert" className="text-sm font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-xl p-3">{error}</div>}
        <button className="w-full bg-gradient-to-r from-orange-500 to-orange-600 text-white font-extrabold py-3.5 rounded-2xl shadow-lg shadow-orange-500/30 disabled:opacity-60" disabled={busy}>{busy ? 'Sending…' : 'Send request'}</button>
      </form>
    </Card>
  );
}

function VerifyPhone({ token, verification, onVerified, onEdit, onRequest }: { token: string; verification: any; onVerified: (s: any) => void; onEdit: () => void; onRequest: () => void }) {
  const [code, setCode] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [info, setInfo] = useState<any>(verification), [now, setNow] = useState(Date.now());
  const [sentAt, setSentAt] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const wait = Math.max(0, 30 - Math.floor((now - sentAt) / 1000));
  if (!info?.available) {
    return (
      <Card>
        <h3 className="font-extrabold text-slate-800 text-lg">We can't send a text code right now</h3>
        <p className="text-sm text-slate-500 mt-1 mb-4">Online booking needs a quick phone check. Send the team a request and they'll get you on the schedule.</p>
        <button className="w-full bg-gradient-to-r from-orange-500 to-orange-600 text-white font-extrabold py-3.5 rounded-2xl" onClick={onRequest}>Send a booking request</button>
      </Card>
    );
  }
  const check = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || code.replace(/\D/g, '').length !== 6) return;
    setBusy(true); setError('');
    try {
      const r = await api('/api/verify/check', { method: 'POST', token, body: { code } });
      onVerified(r.session);
    } catch (err) { setError((err as Error).message); setCode(''); } finally { setBusy(false); }
  };
  const resend = async () => {
    if (busy || wait > 0) return;
    setBusy(true); setError('');
    try {
      const r = await api('/api/verify/send', { method: 'POST', token, body: {} });
      setInfo(r.verification); setSentAt(Date.now());
      if (!r.verification.sent && r.verification.retryInSeconds) setError(`You can request another code in ${r.verification.retryInSeconds} seconds.`);
      else if (!r.verification.sent) setError("We couldn't send the code. Try again, or send the team a request.");
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <Card>
      <h3 className="font-extrabold text-slate-800 text-lg flex items-center gap-2.5"><ShieldCheck size={22} className="text-orange-500" />Confirm your phone</h3>
      <p className="text-sm text-slate-500 mt-1">{info.sent || info.reused ? `We texted a 6-digit code to ${info.to}.` : `Send a code to ${info.to}.`} It expires in 10 minutes.</p>
      <form onSubmit={check} className="mt-4 flex gap-2">
        <input
          aria-label="Verification code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          className="flex-1 min-w-0 text-center tracking-[0.5em] text-2xl font-black text-slate-900 border-2 border-slate-200 focus:border-orange-500 rounded-2xl py-3 outline-none"
          placeholder="••••••"
        />
        <button className="px-5 bg-gradient-to-r from-orange-500 to-orange-600 text-white font-extrabold rounded-2xl disabled:opacity-50" disabled={busy || code.length !== 6}>{busy ? <Loader2 className="animate-spin" size={20} /> : 'Verify'}</button>
      </form>
      {error && <div role="alert" className="mt-3 text-sm font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-xl p-3">{error}</div>}
      <div className="mt-4 flex items-center justify-between text-sm">
        <button type="button" className="font-bold text-orange-600 disabled:text-slate-400" onClick={resend} disabled={busy || wait > 0}>{wait > 0 ? `Resend code in ${wait}s` : 'Resend code'}</button>
        <button type="button" className="font-bold text-slate-500 hover:text-slate-800" onClick={onEdit}>Wrong number?</button>
      </div>
      <p className="mt-3 text-xs text-slate-400">This only proves the phone is yours for this booking. Enter the code here, not in the chat.</p>
    </Card>
  );
}

function SlotPicker({ token, session, config, onBooked, onApproval, onRequest, onEdit }: { token: string; session: any; config: any; onBooked: (r: any, pending: boolean) => void; onApproval: (a: any) => void; onRequest: () => void; onEdit: () => void }) {
  const [slots, setSlots] = useState<any[]>([]), [cursor, setCursor] = useState<number | null>(0), [date, setDate] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [hold, setHold] = useState<any>(null), [approved, setApproved] = useState(false), [enabled, setEnabled] = useState(true), [now, setNow] = useState(Date.now()), [quote, setQuote] = useState<any>(null);
  const idem = useRef(crypto.randomUUID()), generation = useRef(0), busyRef = useRef(false);
  const load = useCallback(async (nextCursor = 0, searchDate = '') => {
    const n = ++generation.current;
    setBusy(true); setError('');
    try {
      const r = await api(`/api/availability?cursor=${nextCursor}&date=${encodeURIComponent(searchDate)}`, { token });
      if (n !== generation.current) return;
      setSlots(r.slots); setCursor(r.nextCursor); setEnabled(r.enabled); if (r.quote) setQuote(r.quote);
    } catch (err) { if (n === generation.current) setError((err as Error).message); } finally { if (n === generation.current) setBusy(false); }
  }, [token]);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const seconds = hold ? Math.max(0, Math.ceil((hold.expiresAt - now) / 1000)) : 0;

  const choose = async (slot: any) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      const r = await api('/api/holds', { method: 'POST', token, body: { scheduledAt: slot.scheduledAt } });
      setHold(r.hold); setApproved(false); setNow(Date.now()); idem.current = crypto.randomUUID();
    } catch (err) { setError((err as Error).message); void load(0, date); } finally { setBusy(false); busyRef.current = false; }
  };
  const confirm = async () => {
    if (!hold || !approved || seconds <= 0 || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError('');
    try {
      if (hold.approvalRequired) {
        const r = await api('/api/approvals', { method: 'POST', token, body: { holdId: hold.id, approved: true } });
        onApproval(r.approval);
      } else {
        const r = await api('/api/bookings', { method: 'POST', token, body: { holdId: hold.id, idempotencyKey: idem.current, approved: true } });
        onBooked(r.receipt, Boolean(r.pending));
      }
    } catch (err) {
      setError((err as Error).message);
      if (err instanceof ApiError && err.status === 409) { setHold(null); setApproved(false); void load(0, date); }
    } finally { setBusy(false); busyRef.current = false; }
  };
  const release = async () => {
    if (busy) return;
    setBusy(true);
    try { await api('/api/holds', { method: 'DELETE', token }); setHold(null); setApproved(false); await load(0, date); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  if (!enabled) {
    return (
      <Card>
        <h3 className="font-extrabold text-slate-800 text-lg">Online booking is paused</h3>
        <p className="text-sm text-slate-500 mt-1 mb-4">The office can still get you on the schedule. Send your preferred day and time and they'll confirm it with you.</p>
        <button className="w-full bg-gradient-to-r from-orange-500 to-orange-600 text-white font-extrabold py-3.5 rounded-2xl" onClick={onRequest}>Send a booking request</button>
      </Card>
    );
  }

  if (hold) {
    const w = windowParts(hold.scheduledAt);
    const c = session.contact || {};
    return (
      <Card>
        <div className="flex justify-between items-center mb-4 gap-3">
          <h3 className="font-extrabold text-slate-800 flex items-center gap-2.5 text-lg"><CheckCircle size={22} className="text-orange-500" />Review your visit</h3>
          <span role="timer" className={`text-xs font-mono px-3 py-1.5 rounded-full flex items-center gap-1.5 font-bold border ${seconds > 0 ? 'bg-orange-50 text-orange-700 border-orange-200/50' : 'bg-rose-50 text-rose-700 border-rose-200'}`}>
            <Clock size={14} />{seconds > 0 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : 'Expired'}
          </span>
        </div>
        <p className="text-sm text-slate-500 mb-4">{seconds > 0 ? 'This time is held for you for 5 minutes while you review.' : 'The hold ran out. Pick a time again.'}</p>
        <div className="rounded-2xl bg-slate-50 border border-slate-200 p-4 space-y-4">
          <div className="flex items-start gap-3"><Calendar size={20} className="text-orange-500 mt-0.5" /><div><div className="font-black text-slate-900">{w.day}</div><div className="text-sm font-semibold text-slate-600">{w.time} · Arizona time</div></div></div>
          <LineItems items={hold.quote.lineItems} total={hold.quote.totalCents} />
          {hold.quote.priceNote && <p className="text-xs text-slate-500">{hold.quote.priceNote}</p>}
          {hold.quote.route !== 'cleaning' && <p className="text-xs font-bold text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">Repairs and parts are quoted separately.</p>}
          <div className="flex items-start gap-3 text-sm text-slate-700"><MapPin size={18} className="text-slate-400 mt-0.5" /><div>{c.name}<br />{c.address}<br />{c.city}, AZ {c.zip}<div className="text-slate-500">{c.phone}{c.email ? ` · ${c.email}` : ''}</div></div></div>
        </div>
        {hold.approvalRequired && (
          <p className="mt-4 text-sm text-slate-700 bg-sky-50 border border-sky-200 rounded-xl p-3">
            {hold.overflow ? 'A 5 PM visit' : 'This service'} needs a quick approval from {config?.approverName || 'our team'} before it's booked. We'll hold this time while they review it — usually just a few minutes.
          </p>
        )}
        <label className="mt-4 flex items-start gap-3 text-sm font-semibold text-slate-700">
          <input type="checkbox" className="mt-1 size-4 accent-orange-500" checked={approved} disabled={seconds <= 0 || busy} onChange={(e) => setApproved(e.target.checked)} />
          <span>The service, price, address, and arrival window are correct.</span>
        </label>
        {error && <div role="alert" className="mt-3 text-sm font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-xl p-3">{error}</div>}
        <button className="w-full mt-5 bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 text-white font-extrabold py-4 rounded-2xl shadow-lg shadow-orange-500/30 flex justify-center items-center gap-2 disabled:opacity-60 text-base" disabled={!approved || busy || seconds <= 0} onClick={confirm}>
          {busy ? <><Loader2 className="animate-spin" size={20} />{hold.approvalRequired ? 'Sending for approval…' : 'Booking your visit…'}</> : hold.approvalRequired ? 'Request approval' : 'Confirm & book'}
        </button>
        <div className="mt-3 flex justify-center gap-5 text-sm font-bold text-slate-500">
          <button onClick={release} disabled={busy} className="hover:text-slate-800">{seconds > 0 ? 'Pick a different time' : 'See open times again'}</button>
          <button onClick={onEdit} disabled={busy} className="hover:text-slate-800">Edit details</button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex justify-between items-center mb-3">
        <h3 className="font-extrabold text-slate-800 flex items-center gap-2.5 text-lg"><Calendar size={22} className="text-orange-500" />Select a time</h3>
        <span className="text-xs font-bold text-slate-400">Arizona time</span>
      </div>
      {quote && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-2xl bg-orange-50/60 border border-orange-200/60 px-4 py-3">
          <span className="text-sm font-bold text-slate-700">{quote.name}{quote.lineItems?.length > 1 && <span className="block text-xs font-semibold text-slate-500">{quote.lineItems.slice(1).map((l: any) => l.name).join(', ')} included</span>}</span>
          <span className="text-lg font-black text-orange-600">{money(quote.totalCents)}</span>
        </div>
      )}
      {error && <div role="alert" className="mb-3 text-sm font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-xl p-3">{error}</div>}
      <div className="space-y-3" aria-busy={busy}>
        {slots.map((slot) => {
          const w = windowParts(slot.scheduledAt);
          return (
            <button key={slot.scheduledAt} onClick={() => choose(slot)} disabled={busy} className="w-full flex items-center justify-between gap-3 p-4 rounded-2xl border-2 text-left bg-white border-slate-100 hover:border-orange-300 hover:bg-orange-50/30 active:scale-[0.99] transition-all disabled:opacity-60">
              <span>
                <span className="block font-extrabold text-slate-800">{w.day}</span>
                <span className="block text-sm font-semibold text-slate-500">{w.time}</span>
                <span className="flex flex-wrap gap-1.5 mt-1.5">
                  {slot.bestFit && <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">Best fit for our route</span>}
                  {slot.nearby && !slot.bestFit && <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-sky-50 text-sky-700 border border-sky-200 flex items-center gap-1"><MapPin size={11} />We're nearby that day</span>}
                  {slot.sameDay && <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200">Today</span>}
                  {slot.approval && <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">Needs team approval</span>}
                </span>
              </span>
              <ChevronRight size={20} className="text-slate-300 shrink-0" />
            </button>
          );
        })}
      </div>
      {busy && <p role="status" className="mt-3 text-sm font-semibold text-slate-400 flex items-center gap-2"><Loader2 size={16} className="animate-spin" />Checking the live schedule…</p>}
      {!busy && slots.length === 0 && <p className="text-sm text-slate-500 mt-2">No openings match. Try another date, or send the team a request.</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <button className="px-4 py-2 rounded-xl text-sm font-extrabold bg-slate-100 hover:bg-slate-200 text-slate-700 disabled:opacity-50" onClick={() => load(cursor || 0, date)} disabled={busy || cursor === null}>More times</button>
        <button className="px-4 py-2 rounded-xl text-sm font-extrabold text-slate-500 hover:text-slate-800" onClick={() => { setDate(''); void load(); }} disabled={busy}>Soonest first</button>
      </div>
      <form className="mt-4 flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); void load(0, date); }}>
        <label className="flex-1 text-xs font-bold text-slate-600">Looking for a specific day?
          <input type="date" value={date} min={phoenixDate()} onChange={(e) => setDate(e.target.value)} className="mt-1 w-full border border-slate-200 rounded-xl px-3 py-2 text-sm font-semibold text-slate-800" />
        </label>
        <button className="px-4 py-2.5 rounded-xl text-sm font-extrabold bg-slate-900 text-white disabled:opacity-40" disabled={busy || !date}>Check day</button>
      </form>
      <p className="mt-4 text-xs text-slate-400">Picking a time holds it for five minutes while you review. Nothing is booked until you confirm.</p>
      <button className="mt-2 w-full text-sm font-bold text-slate-500 hover:text-slate-800" onClick={onEdit} disabled={busy}>Edit details</button>
    </Card>
  );
}

function ApprovalWait({ token, initial, onBooked, onEnded }: { token: string; initial: any; onBooked: (r: any, pending: boolean) => void; onEnded: (status: string) => void }) {
  const [approval, setApproval] = useState<any>(initial), [error, setError] = useState('');
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const r = await api('/api/approvals/current', { token });
        if (stop) return;
        setApproval(r.approval);
        if (r.receipt) return onBooked(r.receipt, Boolean(r.pending));
        if (['declined', 'expired', 'failed'].includes(r.approval.status)) return onEnded(r.approval.status);
      } catch (err) { if (!stop) setError((err as Error).message); }
      if (!stop) timer = setTimeout(tick, 8000);
    };
    let timer = setTimeout(tick, 4000);
    return () => { stop = true; clearTimeout(timer); };
  }, [token, onBooked, onEnded]);
  const w = windowParts(approval.scheduledAt);
  return (
    <Card>
      <div className="flex items-start gap-4">
        <div className="size-11 rounded-2xl bg-sky-50 text-sky-600 flex items-center justify-center shrink-0"><Loader2 className="animate-spin" size={22} /></div>
        <div>
          <h3 className="font-extrabold text-slate-800 text-lg">Waiting for approval</h3>
          <p className="text-sm text-slate-500 mt-1">{approval.approverName || 'Our team'} has your request for <b className="text-slate-700">{approval.service}</b> on <b className="text-slate-700">{w.day}, {w.time}</b>. Keep this page open — you'll see the answer here.</p>
          <p className="text-xs text-slate-400 mt-2">Reference {approval.id}. Not booked yet. The request closes at {new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(approval.expiresAt)} if there's no answer.</p>
          {error && <p className="text-xs text-rose-600 mt-2">{error}</p>}
        </div>
      </div>
    </Card>
  );
}

function Receipt({ receipt, pending, onRestart }: { receipt: any; pending: boolean; onRestart: () => void }) {
  const w = windowParts(receipt.scheduledAt);
  const text = () =>
    [receipt.id, `${w.day}, ${w.time} (Arizona time)`, ...(receipt.lineItems || []).map((l: any) => `${l.name}: ${money(l.cents)}`), `Total: ${money(receipt.priceCents)}`, receipt.name, receipt.address, `${receipt.city}, AZ ${receipt.zip}`, receipt.route !== 'cleaning' ? 'Repairs and parts are quoted separately.' : '', '', receipt.preparation].join('\n');
  return (
    <div className={`border p-6 rounded-3xl space-y-4 animate-in ${pending ? 'bg-amber-50 border-amber-200' : 'bg-emerald-50 border-emerald-200'}`}>
      <div className="text-center space-y-1">
        {pending ? <Clock size={44} className="text-amber-500 mx-auto" /> : <CheckCircle size={44} className="text-emerald-500 mx-auto" />}
        <h3 className={`text-xl font-black ${pending ? 'text-amber-900' : 'text-emerald-900'}`}>{pending ? 'Almost there — not confirmed yet' : "You're booked!"}</h3>
        <p className={`text-sm font-medium ${pending ? 'text-amber-800' : 'text-emerald-800'}`}>Reference <b>{receipt.id}</b>{receipt.jobberJobNumber ? ` · Job #${receipt.jobberJobNumber}` : ''}</p>
      </div>
      <div className="bg-white/80 rounded-2xl p-4 space-y-3">
        <div className="flex items-start gap-3"><Calendar size={20} className="text-orange-500 mt-0.5" /><div><div className="font-black text-slate-900">{w.day}</div><div className="text-sm font-semibold text-slate-600">{w.time} · Arizona time</div></div></div>
        <LineItems items={receipt.lineItems?.length ? receipt.lineItems : [{ name: receipt.service, cents: receipt.priceCents }]} total={receipt.priceCents} />
        {receipt.route !== 'cleaning' && <p className="text-xs font-bold text-amber-800">Repairs and parts are quoted separately.</p>}
        <div className="flex items-start gap-3 text-sm text-slate-700"><MapPin size={18} className="text-slate-400 mt-0.5" /><div>{receipt.name}<br />{receipt.address}<br />{receipt.city}, AZ {receipt.zip}</div></div>
      </div>
      <p className="text-sm text-slate-700"><b>Before we arrive:</b> {receipt.preparation}</p>
      <p className="text-xs text-slate-500">{receipt.notification}</p>
      <div className="flex flex-wrap gap-2 justify-center">
        <button className="px-4 py-2.5 bg-white border border-slate-200 text-slate-700 font-extrabold text-sm rounded-xl flex items-center gap-2" onClick={() => saveText(`${receipt.id}.txt`, text())}><Download size={16} />Save confirmation</button>
        <button className="px-4 py-2.5 text-slate-500 font-extrabold text-sm rounded-xl" onClick={onRestart}>Start over</button>
      </div>
    </div>
  );
}

// ---- the bot -----------------------------------------------------------------------------------

export function BookingBot({ embedded = false, preview = false }: { embedded?: boolean; preview?: boolean }) {
  const [token, setToken] = useState(''), [session, setSession] = useState<any>(null), [config, setConfig] = useState<any>(null);
  const [messages, setMessages] = useState<Msg[]>([]), [options, setOptions] = useState<string[]>([]), [multi, setMulti] = useState(false), [suggested, setSuggested] = useState('');
  const [picked, setPicked] = useState<string[]>([]), [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [ready, setReady] = useState(false);
  const [action, setAction] = useState(''), [receipt, setReceipt] = useState<any>(null), [pending, setPending] = useState(false), [requestId, setRequestId] = useState(''), [faqOpen, setFaqOpen] = useState(false);
  const [contactStep, setContactStep] = useState<ContactStep | null>(null), [draft, setDraft] = useState<any>({}), [verification, setVerification] = useState<any>(null), [approval, setApproval] = useState<any>(null);
  const scroll = useRef<HTMLDivElement>(null), busyRef = useRef(false), mounted = useRef(true);
  const storageKey = preview ? 'bob.preview.session' : 'bob.session';

  const initialize = useCallback(async (fresh = false) => {
    setReady(false); setError(''); setReceipt(null); setPending(false); setRequestId(''); setAction(''); setContactStep(null); setVerification(null); setApproval(null);
    try {
      let stored = '';
      try { stored = fresh ? '' : sessionStorage.getItem(storageKey) || ''; } catch {}
      let r: any = null;
      if (stored) { try { r = await api('/api/session', { token: stored }); r.token = stored; } catch { r = null; } }
      if (!r) r = await api('/api/session', { method: 'POST', body: {} });
      if (!mounted.current) return;
      setToken(r.token);
      try { sessionStorage.setItem(storageKey, r.token); } catch {}
      const s = r.session;
      setSession(s); setConfig(r.config);
      setMessages((s.history || []).map((m: any) => ({ role: m.role === 'user' ? 'user' : 'model', text: m.text })));
      setOptions(s.options || []); setMulti(false); setSuggested('');
      if (r.receipt) { setReceipt(r.receipt); setPending(r.receipt.status === 'action_needed'); }
      else if (s.stage === 'approval' && s.approvalId) {
        try { const a = await api('/api/approvals/current', { token: r.token }); if (a.receipt) { setReceipt(a.receipt); setPending(Boolean(a.pending)); } else if (a.approval.status === 'pending') { setApproval(a.approval); setAction('approval'); } else setAction('request'); } catch {}
      } else if (s.stage === 'slots') setAction('slots');
      else if (s.stage === 'verify') { setAction('verify'); setVerification({ available: true, sent: false, to: 'your phone' }); }
      else if (s.stage === 'contact') { setAction('contact'); startContact(s); }
      else if (s.stage === 'review') setAction('request');
      setReady(true);
    } catch (err) { setError((err as Error).message); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);
  useEffect(() => { mounted.current = true; void initialize(); return () => { mounted.current = false; }; }, [initialize]);
  // A new reply opens at its first line, so long answers are read from the top. Everything else (the customer's own message, the typing indicator, cards) scrolls to the latest point.
  const seen = useRef(0);
  useEffect(() => {
    const box = scroll.current;
    if (!box) return;
    const t = setTimeout(() => {
      const fresh = messages.length !== seen.current;
      seen.current = messages.length;
      const newest = messages[messages.length - 1];
      const el = box.querySelector<HTMLElement>(`[data-msg="${messages.length - 1}"]`);
      if (fresh && newest?.role === 'model' && el) {
        const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
        box.scrollTo({ top: Math.max(0, top - 12), behavior: 'smooth' });
      } else {
        box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
      }
    }, 120);
    return () => clearTimeout(t);
  }, [messages, busy, action, receipt, requestId, contactStep, options.length]);

  const say = (role: Msg['role'], t: string, extra: Partial<Msg> = {}) => setMessages((m) => [...m, { role, text: t, local: true, ...extra }]);
  const onApprovalBooked = useCallback((r: any, p: boolean) => { setReceipt(r); setPending(p); setAction(''); }, []);
  const onApprovalEnded = useCallback((status: string) => {
    setApproval(null);
    setAction('request');
    setMessages((m) => [...m, {
      role: 'model', local: true,
      text: status === 'declined' ? "The team couldn't approve that visit. Send a request below and they'll find another option with you."
        : status === 'expired' ? "The approval request timed out before the team answered. Send a request and they'll reach out."
        : 'That time is no longer available. Send a request and the team will find another time.',
    }]);
  }, []);
  const addOnLabels = (s: any) =>
    (config?.addOns || [])
      .filter((a: any) => !(a.key === 'fogging' && s?.package === 'restoration'))
      .map((a: any) => `${a.name}${config?.pricesApproved ? ` · +${money(a.cents)}` : ''}`);

  const send = async (message = text) => {
    if (!message.trim() || busyRef.current || !ready || receipt) return;
    if (contactStep) return answerContact(message);
    busyRef.current = true; setBusy(true); setError(''); setText(''); setPicked([]);
    setMessages((m) => [...m, { role: 'user', text: message }]);
    try {
      const r = await api('/api/chat', { method: 'POST', token, body: { message } });
      setSession(r.session);
      setMessages((m) => [...m, { role: 'model', text: r.reply, info: r.info }]);
      setOptions(r.options || []); setMulti(Boolean(r.multi)); setSuggested(r.suggested || '');
      if (r.action === 'contact') { setAction('contact'); startContact(r.session); }
      else if (r.action === 'request') setAction('request');
      else if (r.action === 'emergency') setAction('emergency');
      else if (!['contact', 'verify', 'slots'].includes(r.session.stage)) setAction('');
    } catch (err) {
      setError((err as Error).message);
      if (err instanceof ApiError && err.status === 401) setReady(false);
    } finally { setBusy(false); busyRef.current = false; }
  };

  // -- contact capture --------------------------------------------------------------------------
  const stepsFor = (s: any): ContactStep[] => ['name', 'phone', 'email', 'address', 'city', 'notes', ...(s?.route === 'cleaning' && addOnLabels(s).length ? (['addons'] as ContactStep[]) : []), 'sms'];
  const askContact = (step: ContactStep) => {
    setContactStep(step);
    say('model', CONTACT_PROMPTS[step]);
    setOptions(step === 'email' ? ['Skip'] : step === 'notes' ? ['No gate code or notes'] : step === 'sms' ? ['Yes, text me', 'No texts'] : step === 'addons' ? [...addOnLabels(session), 'No add-ons'] : []);
    setMulti(step === 'addons');
    setSuggested('');
  };
  function startContact(s: any) {
    setDraft({ name: s?.contact?.name || '', phone: s?.contact?.phone || '', email: s?.contact?.email || '', address: s?.contact?.address || '', city: s?.contact?.city || '', zip: s?.zip || s?.contact?.zip || '', notes: '', addOns: {}, smsConsent: false });
    setTimeout(() => askContact('name'), 50);
  }
  const nextContact = (step: ContactStep, d: any) => {
    const order = stepsFor(session);
    const i = order.indexOf(step);
    if (i < order.length - 1) return askContact(order[i + 1]);
    void submitContact(d);
  };
  const answerContact = (raw: string) => {
    const step = contactStep!;
    const value = raw.trim();
    setText('');
    const d = { ...draft };
    if (step === 'addons') {
      const chosen = value === 'No add-ons' ? [] : value.split(/,\s*/);
      d.addOns = Object.fromEntries((config?.addOns || []).map((a: any) => [a.key, chosen.some((c) => c.startsWith(a.name))]));
      say('user', value);
    } else if (step === 'sms') {
      d.smsConsent = /^yes/i.test(value);
      say('user', d.smsConsent ? 'Yes, text me' : 'No texts');
    } else if (step === 'email' && /^skip$/i.test(value)) {
      d.email = '';
      say('user', 'Skip');
    } else if (step === 'notes' && /^no gate code/i.test(value)) {
      d.notes = '';
      say('user', value);
    } else {
      if (step === 'phone' && value.replace(/\D/g, '').length < 10) { say('user', value); say('model', 'That number looks short. Please enter a 10-digit mobile number.'); return; }
      if (step === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) { say('user', value); say('model', "That email doesn't look right. Enter it again, or choose Skip."); return; }
      if (step === 'address' && !/^\d+\s+\S/.test(value)) { say('user', value); say('model', 'Please include the house number and street, like “15420 W Bell Rd”.'); return; }
      if (step === 'name' && value.length < 2) return;
      d[step] = value;
      say('user', value);
    }
    setDraft(d);
    setPicked([]);
    nextContact(step, d);
  };
  const submitContact = async (d: any) => {
    setContactStep(null); setOptions([]); setMulti(false);
    setBusy(true); busyRef.current = true; setError('');
    try {
      const r = await api('/api/contact', { method: 'POST', token, body: d });
      setSession(r.session);
      say('model', `Got it — ${r.address || `${d.address}, ${d.city}, AZ ${d.zip}`}.`);
      if (r.verification?.required) { setVerification(r.verification); setAction('verify'); }
      else setAction('slots');
    } catch (err) {
      const msg = (err as Error).message;
      say('model', msg);
      if (err instanceof ApiError && (err as any).status === 409) setAction('request');
      else if (/phone|number/i.test(msg)) askContact('phone');
      else if (/address|street/i.test(msg)) askContact('address');
      else if (/city/i.test(msg)) askContact('city');
      else if (/email/i.test(msg)) askContact('email');
      else if (/name/i.test(msg)) askContact('name');
      else setAction('request');
    } finally { setBusy(false); busyRef.current = false; }
  };
  const editDetails = () => { setAction('contact'); setVerification(null); startContact(session); };

  const restart = () => {
    if ((messages.length || receipt) && !confirm('Start over? A visit you already booked stays booked.')) return;
    void api('/api/holds', { method: 'DELETE', token }).catch(() => {});
    setMessages([]); void initialize(true);
  };
  const toggle = (label: string) => setPicked((p) => (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]));
  const last = messages[messages.length - 1];
  const inputHints = contactStep ? INPUT_FOR[contactStep] : undefined;
  const showOptions = !busy && !receipt && !requestId && action !== 'emergency' && options.length > 0 && (last?.role === 'model' || !!contactStep);
  const started = messages.length > 0;

  const shell = embedded ? 'h-dvh rounded-none border-0' : preview ? 'h-[780px] rounded-3xl max-w-4xl mx-auto' : 'h-[min(820px,calc(100dvh-2rem))] rounded-3xl max-w-3xl mx-auto';

  return (
    <div className={`bg-slate-900 border border-slate-800 shadow-2xl overflow-hidden flex flex-col relative text-white ${shell}`}>
      <div className="bg-slate-800/90 backdrop-blur-md px-4 py-3 border-b border-slate-700/60 flex items-center justify-between z-20">
        <div className="flex items-center gap-3">
          <BobFace size={40} />
          <div>
            <h1 className="font-extrabold text-base text-white tracking-tight leading-none">Dryer Vent Squad West Valley</h1>
            <p className="text-[11px] font-semibold text-orange-400 mt-1 flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${ready ? 'bg-emerald-400' : 'bg-slate-500'}`} />
              {ready ? (config?.smartChat ? 'BOB · AI booking assistant' : 'BOB · Booking assistant') : error ? 'Not connected yet' : 'Connecting…'}
              {ready && <span className="text-slate-300 font-medium">· {config?.bookingEnabled ? 'Live schedule' : 'Requests'}</span>}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setFaqOpen(!faqOpen)} aria-expanded={faqOpen} className={`text-xs font-bold px-3 py-1.5 rounded-xl border flex items-center gap-1.5 ${faqOpen ? 'bg-orange-500 text-white border-orange-500' : 'text-slate-300 hover:text-white bg-slate-700/50 hover:bg-slate-700 border-slate-600'}`}>
            <HelpCircle size={14} className={faqOpen ? 'text-white' : 'text-orange-400'} /><span>FAQs</span>
          </button>
          <button onClick={restart} className="text-xs font-bold text-slate-300 hover:text-white px-3 py-1.5 rounded-xl bg-slate-700/50 hover:bg-slate-700 flex items-center gap-1.5" aria-label="Start over"><RotateCcw size={13} /><span className="hidden sm:inline">Reset</span></button>
        </div>
      </div>

      {faqOpen && (
        <div className="bg-slate-800 border-b border-slate-700 p-4 max-h-64 overflow-y-auto z-20 space-y-2 animate-in">
          <div className="flex items-center justify-between pb-1 border-b border-slate-700">
            <span className="text-xs font-black text-orange-400 flex items-center gap-1.5"><HelpCircle size={14} />Tap a question to ask BOB</span>
            <button onClick={() => setFaqOpen(false)} className="text-slate-400 hover:text-white text-xs font-bold">Close</button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
            {(config?.faqs || []).slice(0, 12).map((f: any) => (
              <button key={f.id} disabled={!ready || !!contactStep} onClick={() => { setFaqOpen(false); void send(f.question); }} className="text-left p-2.5 bg-slate-700/60 hover:bg-slate-700 border border-slate-600/60 hover:border-orange-500/50 rounded-xl text-xs font-bold text-slate-200 disabled:cursor-wait">
                <span className="text-[10px] text-orange-400 font-extrabold block mb-0.5">{f.category}</span>{f.question}
              </button>
            ))}
          </div>
        </div>
      )}

      <div ref={scroll} className={`flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 ${started ? 'bg-slate-50 text-slate-800' : 'bg-slate-900'}`} aria-live="polite" aria-relevant="additions text">
        {!started ? (
          <div className="flex flex-col items-center max-w-xl mx-auto py-4 animate-in">
            <div className="mb-5"><BobFace size={112} /></div>
            <h2 className="text-2xl sm:text-3xl font-black text-white mb-2 text-center tracking-tight">Hi, we're glad you're here.</h2>
            <p className="text-slate-300 text-center mb-6 text-sm max-w-sm leading-relaxed">I'm BOB. Pick an option or just type what's going on — I'll get you an exact price and a real opening on our schedule.</p>
            {error && <div role="alert" className="mb-4 w-full text-sm font-semibold text-rose-200 bg-rose-950/60 border border-rose-400/40 rounded-xl p-3">{error} <button className="ml-2 underline font-bold" onClick={() => initialize()}>Reconnect</button></div>}
            <div className="w-full flex flex-col gap-3">
              {WELCOME_CARDS.map(([label, icon]) => (
                <button key={label} disabled={!ready} onClick={() => send(label)} className="w-full flex items-center gap-4 p-4 bg-slate-800/90 hover:bg-slate-800 border border-slate-700/70 rounded-2xl hover:border-orange-500/50 transition-all active:scale-[0.99] group text-left disabled:cursor-wait">
                  <div className="bg-slate-700 text-slate-300 p-3 rounded-xl group-hover:bg-orange-500 group-hover:text-white transition-all">{icon}</div>
                  <span className="font-extrabold text-slate-200 text-base flex-1 group-hover:text-white">{label}</span>
                  <ChevronRight size={20} className="text-slate-500 group-hover:text-orange-400" />
                </button>
              ))}
            </div>
            <p className="mt-6 text-xs text-slate-300 text-center">Smoke, fire, or a gas smell? Leave the house and call 911 from outside.</p>
          </div>
        ) : (
          <>
            {messages.map((msg, i) => {
              const model = msg.role === 'model';
              return (
                <div key={i} data-msg={i} className={`flex w-full ${model ? 'justify-start' : 'justify-end'} animate-in`}>
                  <div className={`flex max-w-[90%] sm:max-w-[80%] gap-2.5 ${model ? 'flex-row' : 'flex-row-reverse'}`}>
                    <div className="shrink-0 mt-auto mb-1">
                      {model ? <BobFace size={32} /> : <div className="bg-slate-700 text-slate-300 p-2 rounded-full border border-slate-600"><User size={16} /></div>}
                    </div>
                    <div className="min-w-0">
                      <div className={`p-4 rounded-2xl text-sm sm:text-[15px] leading-relaxed whitespace-pre-wrap shadow-xs ${model ? 'bg-white text-slate-800 border border-slate-200/90 rounded-bl-xs' : 'bg-gradient-to-r from-orange-500 to-orange-600 text-white rounded-br-xs font-medium'}`}>
                        <Rich text={msg.text} />
                      </div>
                      {model && i === messages.length - 1 && msg.info?.map((key) => <React.Fragment key={key}>{INFO[key]?.()}</React.Fragment>)}
                    </div>
                  </div>
                </div>
              );
            })}

            {busy && (
              <div className="flex items-center gap-2 text-slate-400 text-xs font-bold pl-10" role="status">
                {[0, 150, 300].map((d) => <div key={d} className="w-2 h-2 rounded-full bg-orange-400 animate-bounce" style={{ animationDelay: `${d}ms` }} />)}
                <span>BOB is thinking…</span>
              </div>
            )}
            {error && <div role="alert" className="ml-10 text-sm font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-xl p-3">{error}{!ready && <button className="ml-2 underline" onClick={() => initialize()}>Reconnect</button>}</div>}

            {showOptions && (
              <div className="flex flex-col gap-2 pt-1 pl-9 sm:pl-10">
                {multi ? (
                  <div className="bg-white p-5 rounded-3xl border border-slate-200 shadow-sm space-y-3">
                    <p className="text-xs font-black text-orange-600 flex items-center gap-1"><Check size={14} />Select all that apply</p>
                    <div className="flex flex-wrap gap-2">
                      {options.filter((o) => !/^no add-ons$/i.test(o)).map((o) => {
                        const on = picked.includes(o);
                        return <button key={o} onClick={() => toggle(o)} aria-pressed={on} className={`flex items-center gap-2 px-3.5 py-2.5 rounded-xl text-xs sm:text-sm font-bold border-2 transition-all ${on ? 'bg-orange-50 border-orange-500 text-orange-900' : 'bg-white border-slate-200 text-slate-700 hover:border-orange-300'}`}>{iconFor(o)}{o}</button>;
                      })}
                    </div>
                    <div className="pt-1 flex justify-end gap-2">
                      {options.some((o) => /^no add-ons$/i.test(o)) && <button onClick={() => send('No add-ons')} className="px-4 py-2.5 rounded-xl font-extrabold text-xs sm:text-sm text-slate-500 hover:text-slate-800">No add-ons</button>}
                      <button onClick={() => send(picked.join(', '))} disabled={!picked.length} className="bg-gradient-to-r from-orange-500 to-orange-600 text-white px-5 py-2.5 rounded-xl font-extrabold text-xs sm:text-sm shadow-md shadow-orange-500/20 disabled:opacity-50">Confirm selection</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {options.map((o) => {
                      const star = suggested && o === suggested;
                      const primary = /^(accept & continue|book assessment|include assessment)$/i.test(o);
                      return (
                        <button key={o} onClick={() => send(o)} disabled={!ready} className={`flex items-center gap-2 px-4 py-3 rounded-2xl font-extrabold text-xs sm:text-sm transition-all border-2 active:scale-95 ${primary ? 'bg-gradient-to-r from-orange-500 to-orange-600 border-orange-500 text-white shadow-md shadow-orange-500/20' : star ? 'bg-orange-50 border-orange-500 text-orange-900 shadow-sm' : 'bg-white border-slate-200 text-slate-700 hover:border-orange-400 hover:bg-orange-50/20'}`}>
                          {primary ? <CheckCircle size={18} className="text-white" /> : iconFor(o)}
                          <span>{o}</span>
                          {star && <span className="text-[10px] bg-orange-500 text-white px-2 py-0.5 rounded-full ml-1">Suggested</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            <div className="pl-9 sm:pl-10 space-y-4">
              {!receipt && !requestId && action === 'verify' && verification && <VerifyPhone token={token} verification={verification} onVerified={(s) => { setSession(s); setVerification(null); setAction('slots'); say('model', 'Thanks — your phone is confirmed. Here are the soonest openings for the full visit.'); }} onEdit={editDetails} onRequest={() => setAction('request')} />}
              {!receipt && !requestId && action === 'slots' && <SlotPicker token={token} session={session} config={config} onBooked={(r, p) => { setReceipt(r); setPending(p); setAction(''); setOptions([]); }} onApproval={(a) => { setApproval(a); setAction('approval'); setOptions([]); }} onRequest={() => setAction('request')} onEdit={editDetails} />}
              {!receipt && !requestId && action === 'approval' && approval && <ApprovalWait token={token} initial={approval} onBooked={onApprovalBooked} onEnded={onApprovalEnded} />}
              {!receipt && !requestId && action === 'request' && <RequestForm token={token} session={session} onDone={(id) => { setRequestId(id); setAction(''); setOptions([]); }} />}
              {requestId && (
                <Card>
                  <h3 className="font-extrabold text-slate-800 text-lg flex items-center gap-2"><Sparkles size={20} className="text-orange-500" />Request sent</h3>
                  <p className="text-sm text-slate-500 mt-1">Reference <b className="text-slate-800">{requestId}</b>. The office has it and will reach out. This isn't a booked visit yet.</p>
                  <button className="mt-4 px-4 py-2.5 bg-slate-100 hover:bg-slate-200 rounded-xl font-extrabold text-sm text-slate-700" onClick={restart}>Start a new conversation</button>
                </Card>
              )}
              {receipt && <Receipt receipt={receipt} pending={pending} onRestart={restart} />}
            </div>
          </>
        )}
        <div className="h-2" />
      </div>

      <div className="p-3 sm:p-4 bg-slate-800/90 border-t border-slate-700/60 shrink-0">
        <form onSubmit={(e) => { e.preventDefault(); void send(); }} className="relative flex items-center max-w-3xl mx-auto">
          <input
            aria-label="Message BOB" maxLength={2000} value={text} onChange={(e) => setText(e.target.value)}
            type={inputHints?.type || 'text'} autoComplete={inputHints?.autoComplete || 'off'} inputMode={inputHints?.inputMode}
            disabled={!ready || busy || !!receipt || !!requestId || contactStep === 'sms' || contactStep === 'addons'}
            placeholder={receipt ? 'Your visit is booked.' : inputHints?.placeholder || 'Type your message or answer…'}
            className="w-full bg-slate-900/90 border-2 border-slate-700 focus:border-orange-500 rounded-full pl-5 pr-14 py-3.5 text-sm font-semibold text-white placeholder-slate-400 outline-none transition-all disabled:opacity-50"
          />
          <button type="submit" aria-label="Send" disabled={!ready || busy || !text.trim() || !!receipt || !!requestId} className="absolute right-1.5 p-2.5 rounded-full bg-orange-500 hover:bg-orange-600 disabled:bg-slate-700 text-white transition-all disabled:opacity-50"><Send size={16} /></button>
        </form>
        <div className="mt-2 flex items-center justify-between max-w-3xl mx-auto text-[11px] text-slate-300">
          <span>BOB is Dryer Vent Squad's automated assistant</span>
          <button className="font-bold text-slate-200 hover:text-white disabled:text-slate-400" onClick={() => send('Request a callback')} disabled={!ready || !!receipt || !!contactStep}>Contact the team</button>
        </div>
      </div>
    </div>
  );
}

export function CustomerPage() {
  const embedded = new URLSearchParams(location.search).has('embed');
  if (embedded) return <BookingBot embedded />;
  return (
    <div className="min-h-dvh bg-slate-100 px-4 py-4 sm:py-8">
      <div className="max-w-3xl mx-auto mb-3 flex items-center justify-between text-sm">
        <a href="https://dryerventsquadaz.com" className="font-bold text-slate-600 hover:text-slate-900 flex items-center gap-1.5"><ArrowLeft size={16} />Dryer Vent Squad West Valley</a>
        <span className="text-slate-400 font-semibold hidden sm:inline">Veteran-owned · West Valley, AZ</span>
      </div>
      <BookingBot />
    </div>
  );
}
