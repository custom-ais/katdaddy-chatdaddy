import { PhoneInput } from '../components/PhoneInput';
import { askConfirm } from '../components/ConfirmDialog';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bird, Bot, Building, Calendar, Check, CheckCircle, ChevronDown, ChevronRight, Clock,
  Download, Droplet, Flame, HelpCircle, Home, Layers, List, Loader2, MapPin, MessageCircle, Minus, Moon, MoreHorizontal, Plus, Pencil, Phone, RotateCcw,
  Search, Send, Shield, ShieldCheck, Sparkles, Star, Thermometer, Timer, User, Wind, Wrench, X, Zap,
} from 'lucide-react';
import { api, ApiError, saveBlob, saveText } from '../lib/api';
import { renderAppointmentCard } from './appointmentCard';
import { money, phoenixDate, properName } from '../../shared/domain.mjs';
import { CODE_DIGITS } from '../../shared/verification-code.mjs';

const TZ = 'America/Phoenix';
// logged: the server already saved it in BOB activity (a /api/chat turn or restored history).
// Everything else is sent to /api/transcript so the office can read the whole conversation.
type Msg = { role: 'user' | 'model'; text: string; info?: string[]; card?: any; local?: boolean; logged?: boolean; options?: string[] };

/** "8:30 AM" and "9:30 AM" → "8:30–9:30 AM"; "11:30 AM" and "12:30 PM" stay whole. */
export const timeRange = (a: string, b: string) => {
  const [ta, pa] = a.split(/\s+/), [, pb] = b.split(/\s+/);
  return pa && pa === pb ? `${ta}–${b}` : `${a}–${b}`;
};

/**
 * "Thursday, Sep 24", the visit's start "9:00 AM", its arrival window "8:30–9:30 AM", and the
 * one-line "9:00 AM (arrival window 8:30–9:30 AM)" for text exports.
 */
export function windowParts(iso: string) {
  const t = Date.parse(iso);
  const day = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long', month: 'short', day: 'numeric' }).format(t);
  const f = (ms: number) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(ms);
  const start = f(t), window = timeRange(f(t - 1_800_000), f(t + 1_800_000));
  return { day, start, window, time: `${start} (arrival window ${window})` };
}

/** The start time in bold with the arrival window small beside it, wrapping below on narrow screens. */
function StartTime({ w, tone = 'text-slate-900', sub = 'text-slate-500', size = 'text-lg', suffix = '' }: { w: ReturnType<typeof windowParts>; tone?: string; sub?: string; size?: string; suffix?: string }) {
  return (
    <span className="flex flex-wrap items-baseline gap-x-2">
      <span className={`${size} font-black leading-tight ${tone}`}>{w.start}</span>
      <span className={`text-xs font-semibold ${sub}`}>Arrival window {w.window}{suffix}</span>
    </span>
  );
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
          <img src="/gas-line.webp" alt="A yellow-coated flexible gas line with a brass fitting on the end" width={640} height={204} loading="lazy" decoding="async" className="mt-3 w-full max-w-[260px] mx-auto" />
        </div>
      </div>
      <p className="mt-3 text-xs text-slate-500">Only look if you can see it easily. Don't move the dryer to check — “I don't know” is fine.</p>
    </Expandable>
  ),
  why_we_ask: () => (
    <Expandable title="Why are we asking this?">
      <ul className="mb-2 space-y-1.5 list-disc pl-5 marker:text-orange-300">
        <li><strong className="text-slate-700">Gas dryers:</strong> we shut off the gas, safely disconnect the dryer, reconnect it after cleaning, and perform a gas leak test before we leave.</li>
        <li><strong className="text-slate-700">Stacked units:</strong> we move them with air sleds so the washer and dryer slide out safely and go back into place.</li>
        <li><strong className="text-slate-700">Fixed pedestals:</strong> the raised dryer is heavier to handle, so moving the dryer and pedestal out together without tipping, reaching the vent, and setting it back securely takes extra time and care.</li>
      </ul>
      <p>Knowing your setup up front gives you an accurate price and lets your technician arrive ready.</p>
    </Expandable>
  ),
};

/**
 * BOB's picture on a soft white-to-blue circle: his head and shoulders at small sizes (so his face
 * reads next to a message), the whole robot at his laptop when there's room. status adds the
 * online / offline dot on the corner.
 */
function BobFace({ size, full = size >= 96, status }: { size: number; full?: boolean; status?: 'online' | 'offline' }) {
  const dot = Math.max(10, Math.round(size * 0.24));
  return (
    <span className="relative block shrink-0" style={{ width: size, height: size }}>
      <span className="block w-full h-full rounded-full overflow-hidden bg-gradient-to-b from-white to-sky-100 ring-1 ring-sky-200/90 shadow-md shadow-sky-950/15">
        <img src={full ? '/bob-full.webp' : '/bob-face.webp'} alt="" width={size} height={size} decoding="async" className={`w-full h-full ${full ? 'object-contain p-[7%]' : 'object-cover'}`} />
      </span>
      {status && <span aria-hidden="true" className={`absolute bottom-0 right-0 rounded-full ring-2 ring-slate-800 ${status === 'online' ? 'bg-emerald-400' : 'bg-slate-500'}`} style={{ width: dot, height: dot }} />}
    </span>
  );
}

/** Emergencies are handled by phone: a big tap-to-call button for the office (Settings → phone). */
function CallOffice({ phone }: { phone?: string }) {
  const given = String(phone || '').replace(/\D/g, '').slice(-10);
  const digits = given.length === 10 ? given : '6232941826';
  return (
    <a href={`tel:+1${digits}`} className="flex items-center justify-center gap-2.5 w-full rounded-2xl bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 text-white font-extrabold py-4 text-base shadow-lg shadow-orange-500/30">
      <Phone size={20} />Call the office · ({digits.slice(0, 3)}) {digits.slice(3, 6)}-{digits.slice(6)}
    </a>
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

/** Estimated airflow from the customer's answers: Clear / Restricted / Severe. */
function AirflowGauge({ a }: { a: { score: number; level: string; headline: string; efficiency?: string; factors?: string[] } }) {
  const pct = Math.max(3, Math.min(97, a.score));
  return (
    <div className="rounded-2xl bg-[#0b2742] text-white p-4 sm:p-5" role="img" aria-label={`${a.headline}. ${a.efficiency || ''} Estimated from your answers.`}>
      <div className="relative pt-1">
        <div className="h-3 rounded-full overflow-hidden flex" aria-hidden="true">
          <span className="flex-1 bg-sky-300" />
          <span className="flex-1 bg-orange-300" />
          <span className="flex-1 bg-orange-500" />
        </div>
        <span className="absolute top-0 w-2 h-5 -ml-1 rounded-full bg-white shadow ring-2 ring-[#0b2742]" style={{ left: `${pct}%` }} aria-hidden="true" />
      </div>
      <div className="flex justify-between mt-2 text-[11px] font-bold text-sky-100/80" aria-hidden="true"><span>Clear</span><span>Restricted</span><span>Severe</span></div>
      <p className="font-display text-xl sm:text-2xl font-extrabold leading-tight mt-3">{a.headline}</p>
      {a.efficiency && <p className="text-sm font-bold text-orange-200 mt-1">{a.efficiency}</p>}
      {a.factors?.length ? (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Based on">
          {a.factors.map((f) => <li key={f} className="text-[11px] font-bold bg-white/10 text-sky-50 rounded-full px-2.5 py-1">{f}</li>)}
        </ul>
      ) : null}
      <p className="text-xs text-sky-100/80 mt-3 leading-relaxed">Estimated from your answers.</p>
    </div>
  );
}

/** What a clear vent could save: two numbers, estimated from the customer's drying cycles and typical use. */
function SavingsTile({ s }: { s: { hoursPerWeek: number; dollarsPerYear: number | null; basis: string } }) {
  const stat = (value: string, unit: string) => (
    <div className="rounded-xl bg-white border border-emerald-100 px-3 py-2.5">
      <p className="font-display text-2xl font-extrabold text-slate-900 leading-none">{value}</p>
      <p className="mt-1 text-xs font-bold text-slate-500">{unit}</p>
    </div>
  );
  return (
    <div className="rounded-2xl bg-emerald-50 border border-emerald-200 p-4" title={s.basis}>
      <p className="font-extrabold text-emerald-900 text-sm">A clear vent could save you</p>
      <div className={`mt-2.5 grid gap-2.5 ${s.dollarsPerYear != null ? 'grid-cols-2' : 'grid-cols-1'}`}>
        {s.dollarsPerYear != null && stat(`$${s.dollarsPerYear}`, 'a year')}
        {stat(`${s.hoursPerWeek} hrs`, 'of drying a week')}
      </div>
      <p className="text-[11px] text-emerald-800/70 mt-2">Estimate based on typical use.</p>
    </div>
  );
}

/**
 * One optional add-on. It has its own Add / Remove button and never looks like a checkbox, so it
 * can't be mistaken for the booking confirmation below it.
 */
function Tile({ on, onClick, disabled, children, label, note }: { on: boolean; onClick: () => void; disabled?: boolean; children: React.ReactNode; label: string; note?: string }) {
  return (
    <div className={`rounded-xl border p-3.5 transition-colors ${on ? 'border-emerald-300 bg-emerald-50/70' : 'border-slate-200 bg-white'} ${disabled ? 'opacity-70' : ''}`}>
      {children}
      <div className="mt-3 flex items-center justify-end gap-3">
        {note && <span className="text-xs font-bold text-emerald-700 mr-auto">{note}</span>}
        <button type="button" aria-pressed={on} aria-label={on ? `Remove ${label}` : `Add ${label}`} disabled={disabled} onClick={onClick}
          className={`inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-extrabold border transition-colors disabled:cursor-not-allowed ${on ? 'bg-emerald-600 border-emerald-600 text-white hover:bg-emerald-700' : 'bg-white border-slate-400 text-slate-800 hover:border-slate-600 hover:bg-slate-50'}`}>
          {on ? <><Check size={15} strokeWidth={3} />Added · Remove</> : <><Plus size={15} strokeWidth={3} />Add</>}
        </button>
      </div>
    </div>
  );
}

/** End-of-booking upgrades: DryerFlex (promo), the sanitizing fog, a deal for both, and Ultimate for Premium. */
type Extras = { dryerflex: boolean; fogging: boolean; ultimate: boolean };
/**
 * live: on the review screen each tap updates the held visit right away (the total above changes),
 * so there's no "Add" button. Without it, the old one-shot panel with Add / No thanks.
 */
function UpsellOffer({ upsell, onDone, live }: { upsell: any; onDone?: (sel: Extras) => void; live?: { value: Extras; onChange: (sel: Extras) => void; busy: boolean } }) {
  const [own, setOwn] = useState<Extras>({ dryerflex: false, fogging: false, ultimate: false });
  const sel = live ? live.value : own;
  const flip = (k: keyof Extras) => { const next = { ...sel, [k]: !sel[k] }; if (live) live.onChange(next); else setOwn(next); };
  const df = upsell.dryerflex, fog = upsell.fogging, up = upsell.ultimate;
  const dfOn = Boolean(df && sel.dryerflex && !sel.ultimate);
  const deal = dfOn && sel.fogging && upsell.bundleSavingsCents ? upsell.bundleSavingsCents : 0;
  const extra = (sel.ultimate && up ? up.extraCents : 0) + (dfOn ? df.cents : 0) + (sel.fogging && fog ? fog.cents : 0) - deal;
  const any = sel.ultimate || dfOn || sel.fogging;
  // Wording from Settings → Upsells at checkout; the defaults cover sessions saved before it existed.
  const dfTitle: string = df?.title || 'DryerFlex hose upgrade';
  const dfPoints: string[] = Array.isArray(df?.points) ? df.points : ['Backed by our 3-year warranty', 'UL 2158A listed, with zero flame spread', 'Crush-resistant 5-layer aluminum keeps the full 4-inch airflow', 'Replaces foil or vinyl hoses that kink behind the dryer, installed with airtight clamps'];
  const fogTitle: string = fog?.title || 'Sanitizing fog treatment';
  const fogText: string = typeof fog?.description === 'string' ? fog.description : '';
  return (
    <div className={live ? 'mt-6' : ''}>
    <Card className={live ? '!p-4 !shadow-none !border-2 !border-dashed !border-slate-300 !bg-slate-50/70 !rounded-2xl' : '!p-4 sm:!p-5'}>
      <section aria-labelledby="bob-addons-title">
      {!live && <p className="text-xs font-extrabold uppercase tracking-wide text-slate-500">Optional add-ons</p>}
      <h3 id="bob-addons-title" className="font-extrabold text-slate-900 text-lg">{live ? 'Optional add-ons' : 'Upgrade your visit'}</h3>
      {live && <p className="text-sm text-slate-600 mt-0.5">Not included unless you tap Add. Your visit is booked the same without them, and your total updates right away.</p>}
      <div className={`mt-3 space-y-2.5 ${live?.busy ? 'opacity-70 pointer-events-none' : ''}`} aria-busy={live?.busy || undefined}>
        {df && (
          <Tile on={dfOn} onClick={() => flip('dryerflex')} disabled={sel.ultimate} note={sel.ultimate ? 'Included with Ultimate' : undefined} label={`${dfTitle}, ${money(df.cents)}${df.wasCents ? `, was ${money(df.wasCents)}` : ''}`}>
            {df.badge && <span className="inline-block text-[11px] font-extrabold uppercase tracking-wide bg-amber-100 text-amber-900 rounded-full px-2.5 py-0.5">{df.badge}</span>}
            <div className={`${df.badge ? 'mt-1.5 ' : ''}flex items-start justify-between gap-3`}>
              <p className="font-extrabold text-slate-900 flex items-center gap-1.5"><Wind size={17} className="text-orange-500 shrink-0" />{dfTitle}</p>
              <p className="shrink-0 text-right leading-none">{df.wasCents ? <span className="block text-xs font-bold text-slate-400 line-through">{money(df.wasCents)}</span> : null}<span className="font-display text-2xl font-extrabold text-slate-900">{money(df.cents)}</span></p>
            </div>
            {dfPoints.length > 0 && (
              <ul className="mt-2 space-y-1 text-sm text-slate-600">
                {dfPoints.map((point, i) => i === 0
                  ? <li key={i} className="flex gap-2"><ShieldCheck size={15} className="text-emerald-600 mt-0.5 shrink-0" /><span><b className="text-slate-800">{point}</b></span></li>
                  : <li key={i} className="flex gap-2"><Check size={15} className="text-emerald-600 mt-0.5 shrink-0" />{point}</li>)}
              </ul>
            )}
          </Tile>
        )}
        {df?.learnMore && <a href={df.learnMore} target="_blank" rel="noopener noreferrer" className="block -mt-1 px-1 text-xs font-bold text-sky-700 hover:text-sky-900 underline underline-offset-2">Learn more about DryerFlex (manufacturer site)</a>}
        {fog && (
          <Tile on={sel.fogging} onClick={() => flip('fogging')} label={`${fogTitle}, ${money(fog.cents)}`}>
            <div className="flex items-start justify-between gap-3">
              <p className="font-extrabold text-slate-900 flex items-center gap-1.5"><Sparkles size={17} className="text-sky-500 shrink-0" />{fogTitle}</p>
              <p className="shrink-0 font-display text-2xl font-extrabold text-slate-900 leading-none">{money(fog.cents)}</p>
            </div>
            {fogText && <p className="mt-1.5 text-sm text-slate-600">{fogText}</p>}
          </Tile>
        )}
        {df && fog && upsell.bundleSavingsCents ? (
          <p className={`rounded-xl px-3 py-2 text-sm font-bold ${deal ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-amber-50 text-amber-900 border border-amber-200'}`}>
            {deal ? `Bundle deal applied: you save ${money(deal)}.` : sel.ultimate ? `Add the sanitizing fog to Ultimate for ${money(fog.cents)}.` : `Add both and save ${money(upsell.bundleSavingsCents)}.`}
          </p>
        ) : null}
        {up && (
          <Tile on={sel.ultimate} onClick={() => flip('ultimate')} label={`Upgrade to ${up.name}, ${money(up.extraCents)} more`}>
            <div className="flex items-start justify-between gap-3">
              <p className="font-extrabold text-slate-900 flex items-center gap-1.5"><Shield size={17} className="text-indigo-500 shrink-0" />Upgrade to {up.name}</p>
              <p className="shrink-0 font-display text-xl font-extrabold text-slate-900 leading-none">+{money(up.extraCents)}</p>
            </div>
            <p className="mt-1.5 text-sm text-slate-600">Adds {up.pitch}.</p>
          </Tile>
        )}
      </div>
      {live ? (
        <p role="status" className={`mt-3 text-sm font-bold flex items-center gap-1.5 ${any ? 'text-emerald-700' : 'text-slate-500'}`}>
          {any ? <><CheckCircle size={16} />Add-ons in your total: +{money(extra)}</> : 'No add-ons added.'}
        </p>
      ) : (
        <div className="mt-4 flex flex-col sm:flex-row gap-2">
          <button type="button" disabled={!any} onClick={() => onDone?.(sel)} className="flex-1 py-3 rounded-xl font-extrabold text-sm bg-orange-500 hover:bg-orange-600 text-white disabled:opacity-40">{any ? `Add to my visit · +${money(extra)}` : 'Choose an upgrade'}</button>
          <button type="button" onClick={() => onDone?.({ dryerflex: false, fogging: false, ultimate: false })} className="sm:w-40 py-3 rounded-xl font-extrabold text-sm bg-slate-100 hover:bg-slate-200 text-slate-700">No thanks</button>
        </div>
      )}
      </section>
    </Card>
    </div>
  );
}

/** The "everything is correct" box before booking: big, impossible to miss, green once checked. */
function ConfirmCheck({ checked, onChange, disabled, children }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <label className={`mt-5 flex items-start gap-3.5 rounded-2xl border-2 p-4 transition-colors ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'} ${checked ? 'border-emerald-500 bg-emerald-50' : 'border-orange-400 bg-orange-50 ring-4 ring-orange-100'}`}>
      <input type="checkbox" className="sr-only peer" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span aria-hidden="true" className={`size-8 shrink-0 rounded-lg border-2 flex items-center justify-center transition-colors peer-focus-visible:ring-4 peer-focus-visible:ring-orange-300 ${checked ? 'bg-emerald-500 border-emerald-500 text-white' : 'bg-white border-orange-400'}`}>{checked && <Check size={20} strokeWidth={3} />}</span>
      <span className="min-w-0">
        <span className="block text-[15px] font-extrabold text-slate-900 leading-snug">{children}</span>
        <span className={`block text-xs font-bold mt-1 ${checked ? 'text-emerald-700' : 'text-orange-700'}`}>{checked ? 'Thanks. You can book now.' : 'Tap this box to confirm, then book below.'}</span>
      </span>
    </label>
  );
}

function PackageCard({ p, onChoose, disabled }: { p: any; onChoose: (option: string) => void; disabled: boolean }) {
  const short = String(p.name).replace(/ See-It-Clean$/, '').replace(/^Dryer Vent /, '');
  return (
    <div className={`rounded-2xl border-2 bg-white p-4 sm:p-5 ${p.recommended ? 'border-orange-500 shadow-md shadow-orange-500/10' : 'border-slate-200'}`}>
      <div className="flex flex-wrap items-center gap-2 mb-1">
        {p.recommended && <p className="text-xs font-extrabold text-orange-700">BOB's pick for you</p>}
        {p.badge && <span className="text-[11px] font-extrabold uppercase tracking-wide bg-slate-100 text-slate-700 rounded-full px-2.5 py-0.5">{p.badge}</span>}
      </div>
      <div className="flex items-start justify-between gap-3">
        <h4 className="font-extrabold text-slate-900 text-base leading-snug">{p.name}</h4>
        {p.price && <span className="font-display text-2xl sm:text-[28px] font-extrabold text-slate-900 leading-none shrink-0">{p.price}</span>}
      </div>
      {p.minutes ? <p className="text-xs text-slate-500 mt-1">About {p.minutes} minutes</p> : null}
      <ul className="mt-3 space-y-1 text-sm text-slate-700 list-disc pl-5 marker:text-slate-400">
        {(p.bullets || []).map((b: string) => <li key={b}>{b}</li>)}
      </ul>
      {p.includes?.length ? <p className="text-xs text-slate-500 mt-2">Price includes {p.includes.join(' and ')}.</p> : null}
      <button type="button" onClick={() => onChoose(p.option)} disabled={disabled} className={`mt-4 w-full py-3 rounded-xl font-extrabold text-sm transition-colors disabled:opacity-60 ${p.recommended ? 'bg-orange-500 hover:bg-orange-600 text-white' : 'border-2 border-slate-800 text-slate-800 hover:bg-slate-50'}`}>
        Choose {short}
      </button>
    </div>
  );
}

function RecommendationCard({ card, onChoose, active }: { card: any; onChoose: (option: string) => void; active: boolean }) {
  return (
    <div className="space-y-3 w-full">
      {card.intro && <div className="p-4 rounded-2xl bg-white text-slate-800 border border-slate-200/90 text-sm sm:text-[15px] leading-relaxed whitespace-pre-wrap shadow-xs"><Rich text={card.intro} /></div>}
      {card.airflow && <AirflowGauge a={card.airflow} />}
      {card.summary ? (
        <div className="p-4 rounded-2xl bg-white text-slate-800 border border-slate-200/90 text-sm sm:text-[15px] leading-relaxed shadow-xs"><Rich text={card.summary} /></div>
      ) : card.lead ? (
        <div className="p-4 rounded-2xl bg-white text-slate-800 border border-slate-200/90 text-sm sm:text-[15px] leading-relaxed whitespace-pre-wrap shadow-xs"><Rich text={card.lead} /></div>
      ) : null}
      {card.savings && <SavingsTile s={card.savings} />}
      {card.question && <p className="font-extrabold text-slate-900 text-sm px-1 pt-1">{card.question}</p>}
      {(card.picks || []).map((p: any) => <PackageCard key={p.family} p={p} onChoose={onChoose} disabled={!active} />)}
      {card.note && <p className="text-xs text-slate-500 px-1">{card.note}</p>}
    </div>
  );
}

function iconFor(label: string) {
  const l = label.toLowerCase();
  const c = 'shrink-0';
  if (/^accept|book this|book assessment|include assessment|cleaning \+ assessment/.test(l)) return <CheckCircle size={18} className={`${c} text-emerald-500`} />;
  if (l.includes('compare')) return <List size={18} className={`${c} text-purple-500`} />;
  if (/question|faq/.test(l)) return <MessageCircle size={18} className={`${c} text-blue-500`} />;
  if (/edit|gate code|back to/.test(l)) return <Pencil size={18} className={`${c} text-slate-400`} />;
  if (/don't know|not sure/.test(l)) return <HelpCircle size={18} className={`${c} text-slate-400`} />;
  if (/callback|contact the team|talk to the team|person/.test(l)) return <Phone size={18} className={`${c} text-slate-500`} />;
  if (/more services|other/.test(l)) return <MoreHorizontal size={18} className={`${c} text-slate-400`} />;
  if (l.includes('1-story')) return <Home size={18} className={`${c} text-blue-500`} />;
  if (l.includes('2-story')) return <Building size={18} className={`${c} text-blue-500`} />;
  if (l.includes('1st floor')) return <ArrowDown size={18} className={`${c} text-orange-500`} />;
  if (l.includes('2nd floor')) return <ArrowUp size={18} className={`${c} text-orange-500`} />;
  if (l.includes('roof')) return <ArrowUp size={18} className={`${c} text-amber-500`} />;
  if (l.includes('side wall')) return <ArrowRight size={18} className={`${c} text-emerald-500`} />;
  if (/one normal cycle|1 normal cycle|no signs|have dryer|^yes|no gate code|no special notes|cleaning only|just the cleaning|dryer is off|turned off|everyone is safe/.test(l)) return <Check size={18} className={`${c} text-emerald-500`} />;
  if (/^no$|no dryer|^no thanks|^no,|^cancel package/.test(l)) return <X size={18} className={`${c} text-rose-500`} />;
  if (l.includes('express')) return <Timer size={18} className={`${c} text-teal-500`} />;
  if (l.includes('premium')) return <Star size={18} className={`${c} text-orange-500`} />;
  if (l.includes('ultimate')) return <Shield size={18} className={`${c} text-indigo-500`} />;
  if (l.includes('inspection')) return <Search size={18} className={`${c} text-blue-500`} />;
  if (/emergency|same-day|running \/ hot|burning/.test(l)) return <AlertTriangle size={18} className={`${c} text-red-500`} />;
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

/** The website nudge's topics, each starting the matching menu path. */
const NUDGE_STARTS: Record<string, string> = { cleaning: 'Book a Cleaning', repair: 'Repairs, Reroutes & Upgrades', emergency: 'Emergency', pest: 'Pest / Nest Removal' };
// The website nudge's "Ask a question": the chat opens its list of common questions, ready for the visitor's own.
const pageStartAllowed = (key: unknown): key is string => typeof key === 'string' && (key === 'question' || Object.hasOwn(NUDGE_STARTS, key));

const WELCOME_CARDS: [string, React.ReactElement][] = [
  ['Book a Cleaning', <Wind strokeWidth={2} size={26} />],
  ['Repairs, Reroutes & Upgrades', <Wrench strokeWidth={2} size={26} />],
  ['Emergency', <Flame strokeWidth={2} size={26} />],
  ['Pest / Nest Removal', <Bird strokeWidth={2} size={26} />],
  ['Something Else', <MessageCircle strokeWidth={2} size={26} />],
];

// ---- contact details, collected one question at a time ---------------------------------------

// Rules manual §6 / playbook §8: name → email → phone → SMS consent → street address → gate/property notes,
// one question per message, each opening with a short acknowledgment of the last answer.
type ContactStep = 'name' | 'phone' | 'email' | 'address' | 'city' | 'notes' | 'gate' | 'addons' | 'sms';
const CONTACT_ORDER: ContactStep[] = ['name', 'email', 'phone', 'sms', 'address', 'city', 'notes'];
const contactPrompt = (step: ContactStep, d: any, cfg?: any): string => {
  const first = String(d?.name || '').trim().split(/\s+/)[0];
  switch (step) {
    case 'name': return 'To reserve your appointment slot, what is your first and last name?';
    // With customer texts off, email is the only way the confirmation reaches them: say so.
    case 'email': return `${first ? `Thanks, ${first}. ` : ''}${cfg?.textMessages ? 'What is the best email address for booking contact and optional email verification?' : "What email should I send your appointment confirmation to?"}`;
    case 'phone': return cfg?.verificationChannels?.includes('email') ? `${d?.email ? 'Got it. ' : ''}What is your callback phone number (mobile or landline)? You can verify by email instead of text.` : `${d?.email ? 'Got it. ' : ''}What is your mobile phone number?${cfg?.phoneVerification === false ? '' : " We'll text a code to confirm it."}`;
    case 'sms': return `Understood. Is it okay to send automated text updates and technician arrival notifications to ${d?.phone || 'this number'}? Not marketing. Message and data rates may apply; reply STOP anytime.`;
    case 'address': return 'Thank you. What is the street address for the service location? Include a unit number if there is one.';
    case 'city': return 'And the city?';
    case 'notes': return `${d?.addressFromChat ? 'Got it.' : 'Thanks for providing that address.'} Are there any gate codes, parking instructions, or pets we should be aware of?`;
    case 'gate': return "What's the gate code, and anything else the technician should know?";
    case 'addons': return cfg?.upsellReady ? 'Before we pick a time, here are a few upgrades for your visit.' : 'Want to add anything to your visit?';
  }
};
const INPUT_FOR: Partial<Record<ContactStep, { type: string; autoComplete: string; placeholder: string; inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'] }>> = {
  name: { type: 'text', autoComplete: 'name', placeholder: 'First and last name' },
  phone: { type: 'tel', autoComplete: 'tel', placeholder: 'Callback phone number', inputMode: 'tel' },
  email: { type: 'email', autoComplete: 'email', placeholder: 'Email address' },
  address: { type: 'text', autoComplete: 'street-address', placeholder: 'Street address' },
  city: { type: 'text', autoComplete: 'address-level2', placeholder: 'City' },
  notes: { type: 'text', autoComplete: 'off', placeholder: 'Gate code, parking, pets…' },
  gate: { type: 'text', autoComplete: 'off', placeholder: 'Gate code and notes' },
};
// The address and ZIP questions come from the chat itself (session.pending), not the contact steps.
const ADDRESS_INPUT = { type: 'text', autoComplete: 'street-address', placeholder: 'Service address', inputMode: undefined as React.HTMLAttributes<HTMLInputElement>['inputMode'] };
const ZIP_INPUT = { type: 'text', autoComplete: 'postal-code', placeholder: '5-digit ZIP code', inputMode: 'numeric' as const };

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
  const [form, setForm] = useState({ name: session?.contact?.name || '', phone: session?.contact?.phone || '', email: session?.contact?.email || '', zip: session?.zip || '', message: [session?.afterHours ? 'After-hours emergency visit requested.' : '', ...(session?.concerns || [])].filter(Boolean).join('\n'), preference: 'phone', smsConsent: false });
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
          <label className="text-xs font-bold text-slate-700">Callback number<PhoneInput className={input} required type="tel" autoComplete="tel" value={form.phone} onValueChange={(value) => setForm({ ...form, phone: value })} /></label>
          <label className="text-xs font-bold text-slate-700">Email (optional)<input className={input} type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
          <label className="text-xs font-bold text-slate-700">Service ZIP (optional)<input className={input} autoComplete="postal-code" inputMode="numeric" maxLength={5} value={form.zip} onChange={(e) => setForm({ ...form, zip: e.target.value })} /></label>
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
  const notSent = verification?.available && !verification.sent && !verification.reused;
  const [code, setCode] = useState(''), [busy, setBusy] = useState(false), [info, setInfo] = useState<any>(verification), [now, setNow] = useState(Date.now());
  const busyRef = useRef(false);
  const [operation, setOperation] = useState<'send' | 'check' | ''>('');
  const [error, setError] = useState(notSent && !verification.chooseChannel && !verification.retryInSeconds ? "We couldn't send the code. Try again, or send the team a request." : '');
  const [retryAt, setRetryAt] = useState(Date.now() + (typeof verification.retryInSeconds === 'number' ? verification.retryInSeconds * 1000 : notSent ? 0 : 30_000));
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const wait = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const channels: string[] = info?.channels || verification?.channels || ['sms'];
  const channel = info?.channel || 'sms';
  const sent = Boolean(info?.sent || info?.reused);
  const email = channel === 'email';
  if (!info?.available) {
    return (
      <Card>
        <h3 className="font-extrabold text-slate-800 text-lg">We can't send a verification code right now</h3>
        <p className="text-sm text-slate-500 mt-1 mb-4">Online booking needs a quick contact check. Send the team a request and they'll get you on the schedule.</p>
        <button className="w-full bg-gradient-to-r from-orange-500 to-orange-600 text-white font-extrabold py-3.5 rounded-2xl" onClick={onRequest}>Send a booking request</button>
      </Card>
    );
  }
  const check = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busyRef.current || !sent || code.replace(/\D/g, '').length !== CODE_DIGITS) return;
    busyRef.current = true; setBusy(true); setOperation('check'); setError('');
    try {
      const r = await api('/api/verify/check', { method: 'POST', token, body: { code } });
      onVerified(r.session);
    } catch (err) { setError((err as Error).message); setCode(''); } finally { busyRef.current = false; setBusy(false); setOperation(''); }
  };
  const sendCode = async (nextChannel = channel) => {
    if (busyRef.current || Date.now() < retryAt) return;
    busyRef.current = true; setBusy(true); setOperation('send'); setError(''); setCode('');
    try {
      const r = await api('/api/verify/send', { method: 'POST', token, body: { channel: nextChannel } });
      setInfo({ ...r.verification, channels: r.verification.channels || channels });
      const delay = r.verification.retryInSeconds || (r.verification.sent ? 30 : 0);
      setRetryAt(Date.now() + delay * 1000); setNow(Date.now());
      if (!r.verification.sent && r.verification.retryInSeconds) setError(`You can request another code in ${r.verification.retryInSeconds} seconds.`);
      else if (!r.verification.sent) setError("We couldn't send the code. Try again, or send the team a request.");
    } catch (err) { setError((err as Error).message); } finally { busyRef.current = false; setBusy(false); setOperation(''); }
  };
  return (
    <Card>
      <h3 className="font-extrabold text-slate-800 text-lg flex items-center gap-2.5"><ShieldCheck size={22} className="text-orange-500" />{sent ? `Confirm your ${email ? 'email' : 'phone'}` : 'Choose how to receive your code'}</h3>
      <p className="text-sm text-slate-500 mt-1">{sent ? `We ${email ? 'emailed' : 'texted'} a ${CODE_DIGITS}-digit code to ${info.to}. ${info.expiresAt ? `It expires at ${new Date(info.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : 'Enter it within 10 minutes.'}` : channels.includes('email') ? 'Choose text or email to continue booking. A landline cannot receive a text code.' : 'Send a text verification code to continue booking. A landline cannot receive a text code. Use a mobile number, or send the team a booking request.'}</p>
      {(!sent || channels.length > 1) && <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Verification delivery method">
        {channels.map((c) => <button key={c} type="button" disabled={busy || wait > 0} onClick={() => sendCode(c)} className="px-4 py-2 rounded-xl border border-orange-200 font-bold text-orange-700 bg-orange-50 disabled:opacity-50">{sent && c === channel ? 'Resend' : 'Send'} code by {c === 'email' ? 'email' : 'text'}</button>)}
      </div>}
      {sent && <form onSubmit={check} className="mt-4 flex gap-2">
        <input
          aria-label="Verification code" inputMode="numeric" autoComplete="one-time-code" maxLength={CODE_DIGITS} value={code} disabled={busy}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, CODE_DIGITS))}
          className="flex-1 min-w-0 text-center tracking-[0.5em] text-2xl font-black text-slate-900 border-2 border-slate-200 focus:border-orange-500 rounded-2xl py-3 outline-none"
          placeholder={"•".repeat(CODE_DIGITS)}
        />
        <button className="px-5 bg-gradient-to-r from-orange-500 to-orange-600 text-white font-extrabold rounded-2xl disabled:opacity-50" disabled={busy || code.length !== CODE_DIGITS}>{busy ? <Loader2 className="animate-spin" size={20} /> : 'Verify'}</button>
      </form>}
      {busy && <p role="status" className="mt-3 flex items-center gap-2 text-sm font-semibold text-slate-500"><Loader2 className="animate-spin" size={16} />{operation === 'send' ? 'Sending your code…' : 'Checking your code…'}</p>}
      {error && <div role="alert" className="mt-3 text-sm font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-xl p-3">{error}</div>}
      <div className="mt-4 flex items-center justify-between text-sm gap-3">
        {sent && channels.length === 1 ? <button type="button" className="font-bold text-orange-600 disabled:text-slate-400" onClick={() => sendCode()} disabled={busy || wait > 0}>{wait > 0 ? `Resend code in ${wait}s` : 'Resend code'}</button> : <span className="text-slate-500" aria-live="polite">{wait > 0 ? `Another code in ${wait}s` : ''}</span>}
        <button type="button" className="font-bold text-slate-500 hover:text-slate-800 disabled:opacity-50" disabled={busy} onClick={onEdit}>Edit contact details</button>
      </div>
      <button type="button" className="mt-3 text-sm font-bold text-slate-500 disabled:opacity-50" disabled={busy} onClick={onRequest}>Need help? Send a booking request</button>
      <p className="mt-3 text-xs text-slate-400">{email ? 'This verifies only your email, not your phone.' : 'This verifies your contact method for this booking.'} It does not opt you into appointment texts. Enter the code here, not in the chat.</p>
    </Card>
  );
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const LOADING_STEPS = ['Checking the schedule for openings…', 'Calculating routes…', 'Assigning a technician…', 'Gathering optional alternatives…'];
const BOOKING_STEPS = ['Creating your account…', 'Assigning your technician…', 'Adding your visit to the schedule…', 'Sending your confirmation…'];

// How long each wait usually takes, so the steps are spread across the real wait instead of the
// first ones checking off at once and the last one spinning. From production, week of Nov 2 2026:
// openings took about 24 s (p50) and booking about 22 s. Each browser then remembers its own waits.
const TYPICAL_WAIT_MS = { openings: 22_000, booking: 22_000 } as const;
type WaitName = keyof typeof TYPICAL_WAIT_MS;
const waitKey = (name: WaitName) => `bob:wait:${name}`;
const clampWait = (ms: number) => Math.min(45_000, Math.max(3_000, ms));
function expectedWait(name: WaitName) {
  try {
    const saved = Number(localStorage.getItem(waitKey(name)));
    if (Number.isFinite(saved) && saved > 0) return clampWait(saved);
  } catch {}
  return TYPICAL_WAIT_MS[name];
}
function rememberWait(name: WaitName, ms: number) {
  // Half the previous expectation, half this wait: one fast (cached) or slow lookup doesn't swing it.
  try { localStorage.setItem(waitKey(name), String(Math.round(clampWait((expectedWait(name) + clampWait(ms)) / 2)))); } catch {}
}

/**
 * A small popup while BOB loads openings or books the visit. Each step gets an equal share of the
 * expected wait, and the bar follows the clock; when the answer arrives everything checks off. It's
 * shown on <body> so it covers the chat however the page is scrolled or animated.
 */
function ProgressPopup({ title, steps, done, expected }: { title: string; steps: string[]; done: boolean; expected: number }) {
  const [startedAt] = useState(() => Date.now());
  const [now, setNow] = useState(startedAt);
  useEffect(() => {
    if (done) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [done]);
  const elapsed = now - startedAt;
  const current = done ? steps.length : Math.min(steps.length - 1, Math.floor((elapsed / expected) * steps.length));
  // Steady to 90% by the expected time, then still creeping toward 98% if the wait runs long.
  const filled = done ? 1 : elapsed <= expected ? 0.9 * (elapsed / expected) : 0.9 + 0.08 * (1 - Math.exp(-(elapsed - expected) / expected));
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/45 backdrop-blur-[2px] p-4 animate-in" role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-full max-w-sm rounded-3xl bg-white shadow-2xl border border-slate-200 p-6">
        <div className="flex items-center gap-4">
          <div className="relative size-16 shrink-0 flex items-center justify-center" aria-hidden="true">
            <span className="absolute inset-0 rounded-full bg-orange-400/25 motion-safe:animate-ping" style={{ animationDuration: '1.8s' }} />
            <span className="relative"><BobFace size={52} /></span>
          </div>
          <h3 className="font-extrabold text-slate-900 text-lg leading-snug">{title}</h3>
        </div>
        <ul className="mt-5 space-y-3" role="status" aria-live="polite">
          {steps.map((step, k) => (
            <li key={step} className={`flex items-center gap-3 text-sm font-semibold transition-colors ${k < current ? 'text-slate-700' : k === current ? 'text-slate-900' : 'text-slate-400'}`}>
              {k < current ? <CheckCircle size={20} className="text-emerald-500 shrink-0" />
                : k === current ? <Loader2 size={20} className="text-orange-500 animate-spin shrink-0" />
                : <span className="size-5 shrink-0 rounded-full border-2 border-slate-200" aria-hidden="true" />}
              {step}
            </li>
          ))}
        </ul>
        <div className="mt-5 h-1.5 rounded-full bg-slate-100 overflow-hidden" aria-hidden="true">
          <div className="h-full bg-gradient-to-r from-orange-400 to-emerald-500 transition-[width] duration-300 ease-linear" style={{ width: `${Math.max(4, filled * 100)}%` }} />
        </div>
        <p className="mt-4 text-xs font-bold text-slate-500 text-center">Please do not navigate away from this screen.</p>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Shows a popup for at least `min` ms (so it never just flashes), then checks every step off before
 * closing. `expected` paces the steps; `run` changes on every start so a new wait starts fresh.
 */
function useProgress(name: WaitName, min: number) {
  const [state, setState] = useState<'off' | 'on' | 'done'>('off');
  const [run, setRun] = useState<{ id: number; expected: number }>({ id: 0, expected: TYPICAL_WAIT_MS[name] });
  const started = useRef(0);
  const start = useCallback(() => {
    started.current = Date.now();
    setRun((r) => ({ id: r.id + 1, expected: expectedWait(name) }));
    setState('on');
  }, [name]);
  const finish = useCallback(async () => {
    rememberWait(name, Date.now() - started.current);
    await sleep(Math.max(0, min - (Date.now() - started.current)));
    setState('done');
    await sleep(450);
    setState('off');
  }, [min, name]);
  const stop = useCallback(() => setState('off'), []);
  return { state, start, finish, stop, run: run.id, expected: run.expected };
}

function SlotPicker({ token, session, config, onBooked, onApproval, onRequest, onEdit, onSooner }: { token: string; session: any; config: any; onBooked: (r: any, pending: boolean) => void; onApproval: (a: any) => void; onRequest: () => void; onEdit: () => void; onSooner?: () => void }) {
  const [slots, setSlots] = useState<any[]>([]), [cursor, setCursor] = useState<number | null>(0), [date, setDate] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [hold, setHold] = useState<any>(null), [approved, setApproved] = useState(false), [enabled, setEnabled] = useState(true), [now, setNow] = useState(Date.now()), [quote, setQuote] = useState<any>(null);
  const idem = useRef(crypto.randomUUID()), generation = useRef(0), busyRef = useRef(false);
  const loading = useProgress('openings', 2400), booking = useProgress('booking', 2600);
  // The pressed time: outlined and filling while it's held, then solid green.
  const [picking, setPicking] = useState<string | null>(null), [held, setHeld] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<'idle' | 'working' | 'done'>('idle');
  const { start: startLoading, finish: finishLoading } = loading;
  // Upsells on the review screen: each change re-prices the held visit on the server.
  const [extras, setExtras] = useState<Extras>(() => ({ dryerflex: Boolean(session?.addOns?.dryerflex), fogging: Boolean(session?.addOns?.fogging), ultimate: session?.package === 'ultimate' && session?.upgradedFrom === 'premium' }));
  const [extrasBusy, setExtrasBusy] = useState(false);
  const changeExtras = async (next: Extras) => {
    if (!hold || extrasBusy) return;
    const before = extras;
    setExtras(next); setExtrasBusy(true); setError('');
    try {
      const r = await api('/api/holds/extras', { method: 'POST', token, body: { holdId: hold.id, ...next } });
      setHold(r.hold); setExtras(r.extras);
    } catch (err) { setExtras(before); setError((err as Error).message); }
    finally { setExtrasBusy(false); }
  };
  const load = useCallback(async (nextCursor = 0, searchDate = '') => {
    const n = ++generation.current;
    setBusy(true); setError('');
    startLoading();
    try {
      const r = await api(`/api/availability?cursor=${nextCursor}&date=${encodeURIComponent(searchDate)}`, { token });
      if (n !== generation.current) return;
      setSlots(r.slots); setCursor(r.nextCursor); setEnabled(r.enabled); if (r.quote) setQuote(r.quote);
    } catch (err) { if (n === generation.current) setError((err as Error).message); } finally {
      if (n === generation.current) { setBusy(false); void finishLoading(); }
    }
  }, [token, startLoading, finishLoading]);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const seconds = hold ? Math.max(0, Math.ceil((hold.expiresAt - now) / 1000)) : 0;

  const choose = async (slot: any) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(''); setPicking(slot.scheduledAt);
    try {
      const r = await api('/api/holds', { method: 'POST', token, body: { scheduledAt: slot.scheduledAt } });
      setHeld(slot.scheduledAt);
      await sleep(800); // let the customer see the time turn green before the review screen
      setHold(r.hold); setApproved(false); setNow(Date.now()); idem.current = crypto.randomUUID(); setConfirmState('idle');
    } catch (err) { setError((err as Error).message); void load(0, date); } finally { setPicking(null); setHeld(null); setBusy(false); busyRef.current = false; }
  };
  const confirm = async () => {
    if (!hold || !approved || seconds <= 0 || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(''); setConfirmState('working');
    try {
      if (hold.approvalRequired) {
        const r = await api('/api/approvals', { method: 'POST', token, body: { holdId: hold.id, approved: true } });
        onApproval(r.approval);
      } else {
        booking.start();
        const r = await api('/api/bookings', { method: 'POST', token, body: { holdId: hold.id, idempotencyKey: idem.current, approved: true } });
        await booking.finish();
        setConfirmState('done');
        await sleep(1000); // the button shows Confirmed before the receipt
        onBooked(r.receipt, Boolean(r.pending));
      }
    } catch (err) {
      booking.stop(); setConfirmState('idle');
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

  const popups = <>
    {loading.state !== 'off' && <ProgressPopup key={`openings-${loading.run}`} title="Finding your openings" steps={LOADING_STEPS} done={loading.state === 'done'} expected={loading.expected} />}
    {booking.state !== 'off' && <ProgressPopup key={`booking-${booking.run}`} title="Booking your visit" steps={BOOKING_STEPS} done={booking.state === 'done'} expected={booking.expected} />}
  </>;

  if (!enabled) {
    return (
      <Card>
        {popups}
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
        {popups}
        <div className="flex justify-between items-center mb-4 gap-3">
          <h3 className="font-extrabold text-slate-800 flex items-center gap-2.5 text-lg"><CheckCircle size={22} className="text-orange-500" />Review your visit</h3>
          <span role="timer" className={`text-xs font-mono px-3 py-1.5 rounded-full flex items-center gap-1.5 font-bold border ${seconds > 0 ? 'bg-orange-50 text-orange-700 border-orange-200/50' : 'bg-rose-50 text-rose-700 border-rose-200'}`}>
            <Clock size={14} />{seconds > 0 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : 'Expired'}
          </span>
        </div>
        <p className="text-sm text-slate-500 mb-4">{seconds > 0 ? 'This time is held for you for 5 minutes while you review.' : 'The hold ran out. Pick a time again.'}</p>
        <div className="rounded-2xl bg-slate-50 border border-slate-200 p-4 space-y-4">
          <div className="flex items-start gap-3"><Calendar size={20} className="text-orange-500 mt-0.5" /><div><div className="font-black text-slate-900">{w.day}</div><StartTime w={w} suffix=" · Arizona time" /></div></div>
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
        {session?.upsell && seconds > 0 && <UpsellOffer upsell={session.upsell} live={{ value: extras, onChange: (v) => void changeExtras(v), busy: extrasBusy }} />}
        {/* With add-ons in between, the summary has scrolled away: repeat exactly what is being booked next to the confirm box. */}
        {session?.upsell && seconds > 0 && <section aria-labelledby="bob-confirm-title" className="mt-6 pt-5 border-t-2 border-slate-200">
          <h4 id="bob-confirm-title" className="text-xs font-extrabold uppercase tracking-wide text-slate-500">You're booking</h4>
          <div className="mt-2 rounded-2xl bg-white border-2 border-slate-800 p-4">
            <div className="font-black text-slate-900">{w.day} · {w.start}</div>
            <div className="text-xs font-semibold text-slate-500">Arrival window {w.window} · Arizona time</div>
            <ul className="mt-1.5 text-sm text-slate-700 space-y-0.5">
              {hold.quote.lineItems.map((l: any) => <li key={l.id || l.name} className="flex justify-between gap-4"><span>{l.name}</span><span className="font-bold">{money(l.cents)}</span></li>)}
            </ul>
            <div className="mt-2 pt-2 border-t border-slate-200 flex justify-between gap-4 font-black text-slate-900"><span>Total</span><span>{money(hold.quote.totalCents)}</span></div>
          </div>
        </section>}
        <ConfirmCheck checked={approved} disabled={seconds <= 0 || busy || extrasBusy} onChange={setApproved}>The service, price, address, and arrival window above are correct.</ConfirmCheck>
        {error && <div role="alert" className="mt-3 text-sm font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-xl p-3">{error}</div>}
        <button
          className={`relative overflow-hidden w-full mt-5 font-extrabold py-4 rounded-2xl flex justify-center items-center gap-2 text-base transition-colors ${
            confirmState === 'done' ? 'bg-emerald-500 text-white border-2 border-emerald-500 shadow-lg shadow-emerald-500/30'
            : confirmState === 'working' ? 'bg-white text-emerald-800 border-2 border-emerald-500'
            : 'bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 text-white border-2 border-transparent shadow-lg shadow-orange-500/30 disabled:opacity-60'}`}
          disabled={!approved || busy || seconds <= 0 || extrasBusy} onClick={confirm} aria-live="polite">
          {confirmState === 'working' && <span className="bob-fill absolute inset-0 bg-emerald-200/70" aria-hidden="true" />}
          <span className="relative flex items-center gap-2">
            {confirmState === 'done' ? <><CheckCircle size={20} />Confirmed</>
              : confirmState === 'working' ? <><Loader2 className="animate-spin" size={20} />{hold.approvalRequired ? 'Sending for approval…' : 'Booking your visit…'}</>
              : !approved ? 'Check the box above to book'
              : hold.approvalRequired ? 'Request approval' : 'Confirm & book'}
          </span>
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
      {popups}
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
          const isHeld = held === slot.scheduledAt, isPicking = picking === slot.scheduledAt && !isHeld;
          return (
            <button key={slot.scheduledAt} onClick={() => choose(slot)} disabled={busy} aria-pressed={isPicking || isHeld}
              className={`relative overflow-hidden w-full flex items-center justify-between gap-3 p-4 rounded-2xl border-2 text-left transition-all ${
                isHeld ? 'bg-emerald-500 border-emerald-500 text-white shadow-lg shadow-emerald-500/25'
                : isPicking ? 'bg-white border-emerald-500 ring-4 ring-emerald-100'
                : 'bg-white border-slate-100 hover:border-orange-300 hover:bg-orange-50/30 active:scale-[0.99] disabled:opacity-60'}`}>
              {isPicking && <span className="bob-fill absolute inset-0 bg-emerald-100" aria-hidden="true" />}
              <span className="relative">
                <span className={`block text-sm font-bold ${isHeld ? 'text-emerald-50' : 'text-slate-600'}`}>{w.day}</span>
                <StartTime w={w} size="text-xl" tone={isHeld ? 'text-white' : 'text-slate-900'} sub={isHeld ? 'text-emerald-50' : 'text-slate-500'} />
                <span className="flex flex-wrap gap-1.5 mt-1.5">
                  {slot.bestFit && <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">Best fit for our route</span>}
                  {slot.nearby && !slot.bestFit && <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-sky-50 text-sky-700 border border-sky-200 flex items-center gap-1"><MapPin size={11} />We're nearby that day</span>}
                  {slot.sameDay && <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-amber-50 text-amber-800 border border-amber-200">Today</span>}
                  {slot.approval && <span className="text-[11px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">Needs team approval</span>}
                </span>
              </span>
              {isHeld ? <span className="relative flex items-center gap-1.5 text-sm font-extrabold shrink-0"><CheckCircle size={20} />Held for you</span>
                : isPicking ? <Loader2 size={20} className="relative text-emerald-600 animate-spin shrink-0" />
                : <ChevronRight size={20} className="text-slate-300 shrink-0" />}
            </button>
          );
        })}
      </div>
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
      {onSooner && <button type="button" className="mt-4 text-sm font-extrabold text-orange-600 hover:text-orange-700" onClick={onSooner} disabled={busy}>Need it sooner than these times?</button>}
      <p className="mt-3 text-xs text-slate-400">Picking a time holds it for five minutes while you review. Nothing is booked until you confirm.</p>
      <button className="mt-2 w-full text-sm font-bold text-slate-500 hover:text-slate-800" onClick={onEdit} disabled={busy}>Edit details</button>
    </Card>
  );
}

/**
 * A waiting screen that shows BOB is working: a pulsing animation and short updates that change
 * every few seconds. After the last update it keeps rotating the final "still waiting" lines.
 */
function WorkingScreen({ title, steps, loop = 2, every = 4500, children }: { title: string; steps: string[]; loop?: number; every?: number; children?: React.ReactNode }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => n + 1), every);
    return () => clearInterval(t);
  }, [every]);
  const tail = Math.max(1, Math.min(loop, steps.length));
  const index = i < steps.length ? i : steps.length - tail + ((i - steps.length) % tail);
  const progress = Math.min(i, steps.length - 1);
  return (
    <Card>
      <div className="flex flex-col items-center text-center py-2">
        <div className="relative size-24 flex items-center justify-center" aria-hidden="true">
          <span className="absolute inset-0 rounded-full bg-orange-400/20 motion-safe:animate-ping" style={{ animationDuration: '2.2s' }} />
          <span className="absolute inset-3 rounded-full bg-orange-400/25 motion-safe:animate-ping" style={{ animationDuration: '2.2s', animationDelay: '0.6s' }} />
          <span className="relative"><BobFace size={64} /></span>
        </div>
        <h3 className="font-extrabold text-slate-800 text-lg mt-4">{title}</h3>
        <p key={index} role="status" aria-live="polite" className="text-sm font-semibold text-slate-600 mt-1.5 min-h-[2.5rem] animate-in">{steps[index]}</p>
        <div className="flex gap-1.5 mt-3" aria-hidden="true">
          {steps.map((_, k) => <span key={k} className={`h-1.5 rounded-full transition-all duration-500 ${k <= progress ? 'w-6 bg-orange-500' : 'w-3 bg-slate-200'}`} />)}
        </div>
        {children}
      </div>
    </Card>
  );
}

const SAME_DAY_STEPS = [
  'Sending your request to the team…',
  'The team is checking which technician can get to you today…',
  "Looking at today's route and drive times…",
  'Waiting for a technician to confirm…',
  'Still working on it. Thanks for waiting.',
  'Keep this page open. The answer will show up here.',
];

const AFTER_HOURS_STEPS = [
  'Sending your request to our on-call technician…',
  'Letting the on-call technician know you’re waiting…',
  'They’re checking whether they can get to you tonight…',
  'Waiting for their answer…',
  'Still working on it. Thanks for waiting.',
  'Keep this page open. The answer will show up here.',
];

/**
 * The after-hours request, ready to send: the service, the on-call premium, the total and the
 * address. One tap sends it to the on-call technician (text and email to the account admin).
 */
function AfterHoursSend({ token, onSent, onRegular }: { token: string; onSent: (a: any) => void; onRegular: () => void }) {
  const [info, setInfo] = useState<any>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [ok, setOk] = useState(false);
  useEffect(() => {
    let live = true;
    api('/api/approvals/after-hours', { token }).then((r) => { if (live) setInfo(r); }, (err) => { if (live) setError((err as Error).message); });
    return () => { live = false; };
  }, [token]);
  const sendIt = async () => {
    setBusy(true); setError('');
    try { onSent((await api('/api/approvals/after-hours', { method: 'POST', token, body: { approved: true } })).approval); }
    catch (err) { setError((err as Error).message); setBusy(false); }
  };
  return (
    <Card>
      <h3 className="font-extrabold text-slate-800 flex items-center gap-2.5 text-lg"><Moon size={22} className="text-orange-500" />After-hours request</h3>
      <p className="text-sm text-slate-500 mt-1">Our on-call technician sets the arrival time if they can come tonight.</p>
      {info ? (
        <>
          <div className="mt-4 rounded-2xl border border-slate-200 divide-y divide-slate-100 text-sm">
            {info.quote.lineItems.map((l: any, i: number) => <div key={i} className="flex justify-between gap-3 px-4 py-2.5"><span className="text-slate-600">{l.name}</span><span className="font-bold text-slate-800">{money(l.cents)}</span></div>)}
            <div className="flex justify-between gap-3 px-4 py-2.5 font-black text-slate-900"><span>Total</span><span className="text-orange-600">{money(info.quote.totalCents)}</span></div>
          </div>
          <p className="mt-3 text-sm text-slate-600 flex gap-2"><MapPin size={16} className="text-slate-400 shrink-0 mt-0.5" />{info.address}</p>
          <ConfirmCheck checked={ok} disabled={busy} onChange={setOk}>The service, the after-hours premium and the address are correct.</ConfirmCheck>
        </>
      ) : !error && <div className="mt-4 flex items-center gap-2 text-sm text-slate-500"><Loader2 size={16} className="animate-spin" />Getting your total…</div>}
      {error && <div role="alert" className="mt-3 text-sm font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-xl p-3">{error}</div>}
      <button className="w-full mt-5 font-extrabold py-4 rounded-2xl flex justify-center items-center gap-2 text-base bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700 text-white shadow-lg shadow-orange-500/30 disabled:opacity-60"
        disabled={!info || !ok || busy} onClick={() => void sendIt()}>
        {busy ? <><Loader2 className="animate-spin" size={20} />Sending…</> : !ok && info ? 'Check the box above to send' : <><Send size={18} />Send to our on-call technician</>}
      </button>
      <p className="mt-3 text-xs text-slate-400">Nothing is booked until they confirm. If they can't come{info ? ` or don't answer within ${info.minutes} minutes` : ''}, I'll show you our soonest regular openings.</p>
      <button className="mt-2 w-full text-sm font-bold text-slate-500 hover:text-slate-800" onClick={onRegular} disabled={busy}>See regular times instead</button>
    </Card>
  );
}

function ApprovalWait({ token, initial, onBooked, onEnded, onCancelled }: { token: string; initial: any; onBooked: (r: any, pending: boolean) => void; onEnded: (status: string) => void; onCancelled: (r: any) => void }) {
  const [approval, setApproval] = useState<any>(initial), [error, setError] = useState(''), [confirming, setConfirming] = useState(false), [cancelling, setCancelling] = useState(false);
  const stopped = useRef(false);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (stopped.current) return;
      try {
        const r = await api('/api/approvals/current', { token });
        if (stop || stopped.current) return;
        setApproval(r.approval);
        if (r.receipt) return onBooked(r.receipt, Boolean(r.pending));
        if (['declined', 'expired', 'failed'].includes(r.approval.status)) return onEnded(r.approval.status);
      } catch (err) { if (!stop) setError((err as Error).message); }
      if (!stop) timer = setTimeout(tick, 8000);
    };
    let timer = setTimeout(tick, 4000);
    return () => { stop = true; clearTimeout(timer); };
  }, [token, onBooked, onEnded]);
  const cancel = async () => {
    setCancelling(true); setError('');
    try {
      stopped.current = true;
      onCancelled(await api('/api/approvals/current/cancel', { method: 'POST', token, body: {} }));
    } catch (err) {
      stopped.current = false;
      setError((err as Error).message); setConfirming(false);
    } finally { setCancelling(false); }
  };
  const afterHours = approval.kind === 'after_hours';
  const w = approval.scheduledAt ? windowParts(approval.scheduledAt) : null;
  const closes = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(approval.expiresAt);
  return (
    <WorkingScreen title={afterHours ? 'Checking with our on-call technician' : 'Checking same-day availability'} steps={afterHours ? AFTER_HOURS_STEPS : SAME_DAY_STEPS}>
      <div className="mt-4 w-full rounded-2xl bg-slate-50 border border-slate-200 p-3.5 text-left">
        <p className="text-sm text-slate-700"><b className="text-slate-900">{approval.service}</b></p>
        <p className="text-sm text-slate-600">{w ? `${w.day}, ${w.time}` : 'Tonight · the technician sets the arrival time'}</p>
        <p className="text-xs text-slate-500 mt-1">Not booked yet. Reference {approval.id}. {afterHours ? `If there's no answer by ${closes}, I'll show you our soonest regular openings.` : `If there's no answer by ${closes}, the request closes and you can book a regular visit.`} Please keep the dryer off.</p>
      </div>
      {error && <p className="text-xs text-rose-600 mt-2">{error}</p>}
      {confirming ? (
        <div className="mt-3 w-full flex flex-col sm:flex-row gap-2">
          <button className="flex-1 px-4 py-2.5 rounded-xl text-sm font-extrabold bg-slate-900 text-white disabled:opacity-60" onClick={() => void cancel()} disabled={cancelling}>{cancelling ? 'Cancelling…' : afterHours ? 'Yes, see regular times' : 'Yes, cancel same-day'}</button>
          <button className="flex-1 px-4 py-2.5 rounded-xl text-sm font-extrabold bg-slate-100 text-slate-700" onClick={() => setConfirming(false)} disabled={cancelling}>Keep waiting</button>
        </div>
      ) : (
        <button className="mt-3 text-sm font-bold text-slate-500 hover:text-slate-800" onClick={() => setConfirming(true)}>Cancel request</button>
      )}
    </WorkingScreen>
  );
}

const AUTO_CLOSE_SECONDS = 60;
/** Where the standalone chat page goes back to (and returns to after a booking). */
const SITE_URL = 'https://dryerventsquadaz.com';

function Receipt({ receipt, pending, business, autoClose, closeLabel, onAutoClose, onStay }: { receipt: any; pending: boolean; business?: { businessName?: string; phone?: string; email?: string }; autoClose?: boolean; closeLabel?: string; onAutoClose?: () => void; onStay?: () => void }) {
  const w = windowParts(receipt.scheduledAt);
  const [saving, setSaving] = useState(false);
  // After a confirmed booking the chat closes itself shortly; it pauses while the card is saved.
  const [left, setLeft] = useState(AUTO_CLOSE_SECONDS);
  const closeRef = useRef(onAutoClose); closeRef.current = onAutoClose;
  useEffect(() => {
    if (!autoClose || saving) return;
    const t = setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(t);
  }, [autoClose, saving]);
  useEffect(() => { if (autoClose && left === 0) closeRef.current?.(); }, [autoClose, left]);
  const items = receipt.lineItems?.length ? receipt.lineItems : [{ name: receipt.service, cents: receipt.priceCents }];
  const text = () =>
    [receipt.id, `${w.day}, ${w.time}, Arizona time`, ...items.map((l: any) => `${l.name}: ${money(l.cents)}`), `Total: ${money(receipt.priceCents)}`, receipt.name, receipt.address, `${receipt.city}, AZ ${receipt.zip}`, receipt.route !== 'cleaning' ? 'Repairs and parts are quoted separately.' : '', '', receipt.preparation].join('\n');
  // A designed image of the appointment. iPhones get the share sheet ("Save Image"); everything
  // else downloads the PNG. If drawing fails, the plain-text version is saved instead.
  const save = async () => {
    setSaving(true);
    try {
      const blob = await renderAppointmentCard({
        businessName: business?.businessName || 'Dryer Vent Squad West Valley', phone: business?.phone, email: business?.email,
        pending, reference: receipt.id, jobNumber: receipt.jobberJobNumber, day: w.day, time: w.start, window: w.window,
        lineItems: items, totalCents: receipt.priceCents, repairsNote: receipt.route !== 'cleaning' ? 'Repairs and parts are quoted separately.' : '',
        name: receipt.name, address: receipt.address, cityLine: `${receipt.city}, AZ ${receipt.zip}`, preparation: receipt.preparation,
      });
      const name = `${receipt.id}-appointment.png`;
      const file = typeof File === 'function' ? new File([blob], name, { type: 'image/png' }) : null;
      const ios = /iP(?:hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      if (ios && file && navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file], title: 'Your appointment' }); return; } catch (err) { if ((err as Error).name === 'AbortError') return; }
      }
      saveBlob(name, blob);
    } catch {
      saveText(`${receipt.id}.txt`, text());
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className={`border p-6 rounded-3xl space-y-4 animate-in ${pending ? 'bg-amber-50 border-amber-200' : 'bg-emerald-50 border-emerald-200'}`}>
      <div className="text-center space-y-1">
        {pending ? <Clock size={44} className="text-amber-500 mx-auto" /> : <CheckCircle size={44} className="text-emerald-500 mx-auto" />}
        <h3 className={`text-xl font-black ${pending ? 'text-amber-900' : 'text-emerald-900'}`}>{pending ? 'Almost there — not confirmed yet' : "You're booked!"}</h3>
        <p className={`text-sm font-medium ${pending ? 'text-amber-800' : 'text-emerald-800'}`}>Reference <b>{receipt.id}</b>{receipt.jobberJobNumber ? ` · Job #${receipt.jobberJobNumber}` : ''}</p>
      </div>
      <div className="bg-white/80 rounded-2xl p-4 space-y-3">
        <div className="flex items-start gap-3"><Calendar size={20} className="text-orange-500 mt-0.5" /><div><div className="font-black text-slate-900">{w.day}</div><StartTime w={w} suffix=" · Arizona time" /></div></div>
        <LineItems items={receipt.lineItems?.length ? receipt.lineItems : [{ name: receipt.service, cents: receipt.priceCents }]} total={receipt.priceCents} />
        {receipt.route !== 'cleaning' && <p className="text-xs font-bold text-amber-800">Repairs and parts are quoted separately.</p>}
        <div className="flex items-start gap-3 text-sm text-slate-700"><MapPin size={18} className="text-slate-400 mt-0.5" /><div>{receipt.name}<br />{receipt.address}<br />{receipt.city}, AZ {receipt.zip}</div></div>
      </div>
      <p className="text-sm text-slate-700"><b>Before we arrive:</b> {receipt.preparation}</p>
      <p className="text-xs text-slate-500">{receipt.notification}</p>
      <div className="flex flex-wrap gap-2 justify-center">
        <button className="px-4 py-2.5 bg-white border border-slate-200 text-slate-700 font-extrabold text-sm rounded-xl flex items-center gap-2 disabled:opacity-60" onClick={() => void save()} disabled={saving}>{saving ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}Save confirmation</button>
      </div>
      {autoClose && !pending && (
        <div className="rounded-2xl bg-white/80 border border-emerald-200 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <p role="timer" aria-live="off" className="text-sm font-semibold text-slate-600">{closeLabel || 'This chat will close'} in {left}s{saving ? ' (paused)' : ''}.</p>
            <button type="button" className="shrink-0 whitespace-nowrap text-sm font-extrabold text-emerald-700 hover:text-emerald-900" onClick={onStay}>Stay open</button>
          </div>
          <div className="mt-2 h-1 rounded-full bg-emerald-100 overflow-hidden" aria-hidden="true"><div className="h-full bg-emerald-500 transition-[width] duration-1000 ease-linear" style={{ width: `${(left / AUTO_CLOSE_SECONDS) * 100}%` }} /></div>
        </div>
      )}
    </div>
  );
}

// ---- the bot -----------------------------------------------------------------------------------

export function BookingBot({ embedded = false, preview = false }: { embedded?: boolean; preview?: boolean }) {
  const [token, setToken] = useState(''), [session, setSession] = useState<any>(null), [config, setConfig] = useState<any>(null);
  // A starting path from the website nudge (?start=repair), begun once the chat is ready and empty.
  const pageStart = useRef<string | null>(embedded ? new URLSearchParams(window.location.search).get('start') : null);
  const [startTick, setStartTick] = useState(0);
  const [autoClose, setAutoClose] = useState(false);
  const [minimized, setMinimized] = useState(() => { try { return sessionStorage.getItem(preview ? 'bob.preview.minimized' : 'bob.minimized') === '1'; } catch { return false; } });
  const expandRef = useRef<HTMLButtonElement>(null);
  const changeMinimized = (value: boolean) => {
    setMinimized(value);
    try { sessionStorage.setItem(preview ? 'bob.preview.minimized' : 'bob.minimized', value ? '1' : '0'); } catch {}
    if (token) void api('/api/activity', { method: 'POST', token, body: { kind: value ? 'widget.minimized' : 'widget.expanded' } }).catch(() => {});
    if (embedded && value && window.parent !== window) {
      let parentOrigin = '*'; try { parentOrigin = new URL(document.referrer).origin; } catch {}
      window.parent.postMessage({ type: 'bob:minimize' }, parentOrigin);
    }
    if (!value) requestAnimationFrame(() => inputRef.current?.focus());
    else requestAnimationFrame(() => expandRef.current?.focus());
  };
  useEffect(() => {
    if (!embedded) return;
    // Tell the website's widget the chat is running, so a chat window that failed to load gets reloaded when it's reopened.
    if (window.parent !== window) { let parentOrigin = '*'; try { parentOrigin = new URL(document.referrer).origin; } catch {} window.parent.postMessage({ type: 'bob:ready' }, parentOrigin); }
    const receive = (event: MessageEvent) => {
      let parentOrigin = ''; try { parentOrigin = new URL(document.referrer).origin; } catch {}
      if (event.source === window.parent && parentOrigin && event.origin === parentOrigin && event.data?.type === 'bob:restore') { setMinimized(false); try { sessionStorage.removeItem(preview ? 'bob.preview.minimized' : 'bob.minimized'); } catch {} }
      if (event.source === window.parent && parentOrigin && event.origin === parentOrigin && event.data?.type === 'bob:start' && pageStartAllowed(event.data.start)) { pageStart.current = event.data.start; setStartTick((n) => n + 1); }
    };
    window.addEventListener('message', receive); return () => window.removeEventListener('message', receive);
  }, [embedded, preview]);

  const [messages, setMessages] = useState<Msg[]>([]), [options, setOptions] = useState<string[]>([]), [multi, setMulti] = useState(false), [suggested, setSuggested] = useState('');
  const [picked, setPicked] = useState<string[]>([]), [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [ready, setReady] = useState(false);
  const [action, setAction] = useState(''), [receipt, setReceipt] = useState<any>(null), [pending, setPending] = useState(false), [requestId, setRequestId] = useState(''), [faqOpen, setFaqOpen] = useState(false);
  const [contactStep, setContactStep] = useState<ContactStep | null>(null), [draft, setDraft] = useState<any>({}), [verification, setVerification] = useState<any>(null), [approval, setApproval] = useState<any>(null);
  const approvalRef = useRef<any>(null); approvalRef.current = approval;
  const scroll = useRef<HTMLDivElement>(null), busyRef = useRef(false), mounted = useRef(true);
  // Address suggestions (Google, through BOB's server) while the customer types the street address.
  const [addrItems, setAddrItems] = useState<{ id: string; main: string; secondary: string }[]>([]), [addrActive, setAddrActive] = useState(-1), [addrLoading, setAddrLoading] = useState(false);
  const addrSession = useRef(''), inputRef = useRef<HTMLInputElement>(null), addrPicked = useRef('');
  // Back: each answer saves how the chat looked before it. Chat answers are also undone on the server.
  type Snapshot = { kind: 'server' | 'contact'; messages: Msg[]; options: string[]; multi: boolean; suggested: string; action: string; contactStep: ContactStep | null; draft: any; session: any };
  const undo = useRef<Snapshot[]>([]), [undoCount, setUndoCount] = useState(0);
  const remember = (kind: Snapshot['kind']) => { undo.current = [...undo.current.slice(-29), { kind, messages, options, multi, suggested, action, contactStep, draft, session }]; setUndoCount(undo.current.length); };
  const forget = () => { undo.current = []; setUndoCount(0); };
  const storageKey = preview ? 'bob.preview.session' : 'bob.session';

  const initialize = useCallback(async (fresh = false) => {
    setReady(false); setError(''); setReceipt(null); setPending(false); setAutoClose(false); setRequestId(''); setAction(''); setContactStep(null); setVerification(null); setApproval(null);
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
      setMessages((s.history || []).map((m: any) => ({ role: m.role === 'user' ? 'user' : 'model', text: m.text, logged: true, ...(m.card ? { card: m.card } : {}) })));
      setOptions(s.options || []); setMulti(false); setSuggested('');
      if (r.receipt) { setReceipt(r.receipt); setPending(r.receipt.status === 'action_needed'); }
      else if (s.stage === 'approval' && s.approvalId) {
        try { const a = await api('/api/approvals/current', { token: r.token }); if (a.receipt) { setReceipt(a.receipt); setPending(Boolean(a.pending)); } else if (a.approval.status === 'pending') { setApproval(a.approval); setAction('approval'); } else if (a.approval.kind === 'after_hours') { const back = await api('/api/approvals/current/cancel', { method: 'POST', token: r.token, body: {} }); setSession(back.session); setMessages((m) => [...m, { role: 'model', text: back.reply }]); setAction('slots'); } else setAction('request'); } catch {}
      } else if (s.stage === 'slots') setAction('slots');
      else if (s.stage === 'call_office') setAction('call_office');
      else if (s.stage === 'verify') {
        setAction('verify');
        if (r.config?.verificationChannels?.includes('email')) {
          const channels = r.config.verificationChannels.filter((ch: string) => ch === 'sms' ? !!s.contact?.phone : ch === 'email' && !!s.contact?.email);
          const v = s.verification;
          const destination = v?.channel === 'email' ? String(s.contact?.email || '').trim().toLowerCase() : s.contact?.phone;
          const active = v?.provider === 'twilio' && channels.includes(v.channel) && v.to === destination && v.expires > Date.now();
          const masked = active ? v.channel === 'email' ? `${String(v.to).slice(0, 1)}•••@${String(v.to).split('@')[1] || 'email'}` : `(•••) •••-${String(v.to).replace(/\D/g, '').slice(-4)}` : '';
          const retryInSeconds = Math.max(0, Math.ceil(((s.verifyLastAttempt || 0) + 30_000 - Date.now()) / 1000));
          setVerification({ available: true, required: true, sent: Boolean(active), reused: Boolean(active), chooseChannel: !active, channels, channel: active ? v.channel : null, to: masked, expiresAt: active ? v.expires : undefined, retryInSeconds });
        } else setVerification({ available: true, sent: false, to: 'your phone' });
      }
      else if (s.stage === 'contact') { setAction('contact'); startContact(s); }
      else if (s.stage === 'review') setAction('request');
      setReady(true);
    } catch (err) { setError((err as Error).message); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);
  useEffect(() => { mounted.current = true; void initialize(); return () => { mounted.current = false; }; }, [initialize]);
  useEffect(() => {
    if (error && token) void api('/api/activity', { method: 'POST', token, body: { kind: 'client.error', message: error } }).catch(() => {});
  }, [error, token]);
  // Chats open at the top. The welcome screen starts at its heading; a conversation that is loaded starts at its latest reply.
  // A new reply opens at its first line. The customer's own message, the typing indicator and cards scroll to the latest point.
  const seen = useRef(0);
  useEffect(() => {
    const box = scroll.current;
    if (!box) return;
    const t = setTimeout(() => {
      const opening = seen.current === 0;
      const fresh = messages.length !== seen.current;
      seen.current = messages.length;
      const newest = messages[messages.length - 1];
      const topOf = (i: number) => {
        const el = box.querySelector<HTMLElement>(`[data-msg="${i}"]`);
        return el ? el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 12 : null;
      };
      if (messages.length === 0) {
        box.scrollTo({ top: 0 });
      } else if (fresh && newest?.role === 'model' && topOf(messages.length - 1) !== null) {
        box.scrollTo({ top: Math.max(0, topOf(messages.length - 1) as number), behavior: 'smooth' });
      } else if (opening) {
        let lastBot = -1;
        messages.forEach((m, i) => { if (m.role === 'model') lastBot = i; });
        box.scrollTo({ top: Math.max(0, (lastBot >= 0 ? topOf(lastBot) : 0) ?? 0) });
      } else {
        box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
      }
    }, 120);
    return () => clearTimeout(t);
  }, [messages, busy, action, receipt, requestId, contactStep, options.length]);

  const say = (role: Msg['role'], t: string, extra: Partial<Msg> = {}) => setMessages((m) => [...m, { role, text: t, local: true, ...extra }]);
  // Save every message the window shows that the server didn't already save, in order, as soon as it
  // appears (a short wait groups messages added together). Leaving the page sends what's left.
  const transcript = useRef<{ token: string; entries: any[] }>({ token: '', entries: [] });
  const transcriptSeen = useRef(0), transcriptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushTranscript = useCallback((keepalive = false) => {
    if (transcriptTimer.current) { clearTimeout(transcriptTimer.current); transcriptTimer.current = null; }
    const { token: owner, entries } = transcript.current;
    transcript.current = { token: owner, entries: [] };
    if (!owner) return;
    for (let i = 0; i < entries.length; i += 25) void api('/api/transcript', { method: 'POST', token: owner, body: { entries: entries.slice(i, i + 25) }, keepalive }).catch(() => {});
  }, []);
  const queueTranscript = useCallback((entries: any[]) => {
    if (!token || !entries.length) return;
    if (transcript.current.token !== token) flushTranscript();
    transcript.current = { token, entries: [...transcript.current.entries, ...entries] };
    if (!transcriptTimer.current) transcriptTimer.current = setTimeout(() => flushTranscript(), 50);
  }, [token, flushTranscript]);
  useEffect(() => {
    if (messages.length < transcriptSeen.current) transcriptSeen.current = messages.length; // went back, or started over
    const fresh = messages.slice(transcriptSeen.current).filter((m) => !m.logged && m.text?.trim());
    transcriptSeen.current = messages.length;
    queueTranscript(fresh.map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', text: m.text, ...(m.options?.length ? { options: m.options } : {}) })));
  }, [messages, queueTranscript]);
  useEffect(() => {
    const hidden = () => { if (document.visibilityState === 'hidden') flushTranscript(true); };
    const leave = () => flushTranscript(true);
    document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', leave);
    return () => { document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', leave); flushTranscript(); };
  }, [flushTranscript]);
  const onApprovalBooked = useCallback((r: any, p: boolean) => { setReceipt(r); setPending(p); setAction(''); setAutoClose(!p && !preview); }, [preview]);
  /** Back to the package choices after a same-day request is cancelled or can't happen. */
  const showChoices = useCallback((r: any, lead = '') => {
    setApproval(null);
    setAction(r.action === 'slots' ? 'slots' : ''); // an after-hours request that ended goes back to regular times
    setSession(r.session);
    setMessages((m) => [...m, ...(lead ? [{ role: 'model' as const, local: true, text: lead }] : []), { role: 'model', text: r.reply, info: r.info, options: r.options || [], ...(r.card ? { card: r.card } : {}) }]);
    setOptions(r.options || []); setMulti(false); setSuggested(r.suggested || '');
  }, []);
  const onApprovalCancelled = useCallback((r: any) => showChoices(r), [showChoices]);
  const onApprovalEnded = useCallback(async (status: string) => {
    const afterHours = approvalRef.current?.kind === 'after_hours'; // its own reply explains what happened
    const lead = afterHours ? '' : status === 'expired' ? "The team didn't answer in time, so the same-day request closed." : status === 'failed' ? "That time couldn't be booked after all." : '';
    try {
      showChoices(await api('/api/approvals/current/cancel', { method: 'POST', token, body: {} }), lead);
    } catch {
      setApproval(null);
      setAction('request');
      setMessages((m) => [...m, { role: 'model', local: true, text: `${lead ? `${lead} ` : ''}Send a request below and the team will find another option with you.` }]);
    }
  }, [token, showChoices]);
  const addOnLabels = (s: any) =>
    (config?.addOns || [])
      .filter(() => !['emergency', 'nest', 'restoration'].includes(s?.package)) // no upgrades on these visits
      .filter((a: any) => !(a.key === 'dryerflex' && (['ultimate', 'restoration', 'express', 'inspection'].includes(s?.package) || s?.property?.hasDryer === 'No')))
      .map((a: any) => `${a.name}${config?.pricesApproved ? ` · +${money(a.cents)}` : ''}`);

  const send = async (message = text) => {
    if (!message.trim() || busyRef.current || !ready || receipt) return;
    if (contactStep) return answerContact(message);
    remember('server');
    busyRef.current = true; setBusy(true); setError(''); setText(''); setPicked([]);
    setMessages((m) => [...m, { role: 'user', text: message, logged: true }]);
    try {
      // Playbook: a short, natural pause with the typing dots before every reply (800–1500 ms).
      const pause = 800 + Math.random() * 700, began = Date.now();
      const r = await api('/api/chat', { method: 'POST', token, body: { message } });
      const wait = pause - (Date.now() - began);
      if (wait > 0) await new Promise((done) => setTimeout(done, wait));
      setSession(r.session);
      setMessages((m) => [...m, { role: 'model', text: r.reply, info: r.info, logged: true, ...(r.card ? { card: r.card } : {}) }]);
      setOptions(r.options || []); setMulti(Boolean(r.multi)); setSuggested(r.suggested || '');
      if (r.action === 'contact') { setAction('contact'); startContact(r.session); }
      else if (r.action === 'request') setAction('request');
      else if (r.action === 'emergency') setAction('emergency');
      else if (r.action === 'call_office') setAction('call_office');
      else if (!['contact', 'verify', 'slots'].includes(r.session.stage)) setAction('');
    } catch (err) {
      undo.current.pop(); setUndoCount(undo.current.length); // nothing changed on the server
      setError((err as Error).message);
      if (err instanceof ApiError && err.status === 401) setReady(false);
    } finally { setBusy(false); busyRef.current = false; }
  };
  useEffect(() => {
    const key = pageStart.current;
    if (key === 'question') {
      if (!ready) return;
      pageStart.current = null;
      setFaqOpen(true);
      requestAnimationFrame(() => inputRef.current?.focus());
      if (token) void api('/api/activity', { method: 'POST', token, body: { kind: 'widget.nudge_opened', topic: 'question' } }).catch(() => {});
      return;
    }
    if (!key || !ready || messages.length || receipt) return;
    pageStart.current = null;
    const label = NUDGE_STARTS[key];
    if (!label) return;
    void send(label);
    if (token) void api('/api/activity', { method: 'POST', token, body: { kind: 'widget.nudge_opened', topic: key } }).catch(() => {});
  }, [ready, messages.length, receipt, startTick]);
  const goBack = async () => {
    if (busyRef.current || !undo.current.length) return;
    const snap = undo.current[undo.current.length - 1];
    setError('');
    if (snap.kind === 'server') {
      busyRef.current = true; setBusy(true);
      try {
        const r = await api('/api/chat/back', { method: 'POST', token, body: {} });
        snap.session = r.session;
      } catch (err) {
        setError((err as Error).message);
        if (err instanceof ApiError && err.status === 409) forget();
        return;
      } finally { setBusy(false); busyRef.current = false; }
    }
    undo.current.pop(); setUndoCount(undo.current.length);
    if (snap.kind !== 'server') queueTranscript([{ event: 'went_back' }]); // the server records its own back steps
    setMessages(snap.messages); setOptions(snap.options); setMulti(snap.multi); setSuggested(snap.suggested);
    setAction(snap.action); setContactStep(snap.contactStep); setDraft(snap.draft); setSession(snap.session);
    setText(''); setPicked([]); setAddrItems([]); setAddrActive(-1);
    if (snap.contactStep === 'address') { addrSession.current = crypto.randomUUID(); addrPicked.current = ''; }
  };

  // -- contact capture --------------------------------------------------------------------------
  // The address from the first question isn't asked again (the summary still shows it, and Edit details can change it).
  const stepsFor = (s: any): ContactStep[] => [
    ...CONTACT_ORDER.filter((k) => !(k === 'address' && s?.serviceAddress?.street) && !(k === 'city' && s?.serviceAddress?.street && s?.serviceAddress?.city) && !(k === 'sms' && config?.textMessages === false)),
    // With an upsell, the add-ons come after the time is picked (on the review screen) instead.
    ...(['cleaning', 'bundle'].includes(s?.route) && !s?.upsell && addOnLabels(s).length ? (['addons'] as ContactStep[]) : []),
  ];
  const askContact = (step: ContactStep, d: any = draft) => {
    if (step === 'address') { addrSession.current = crypto.randomUUID(); addrPicked.current = ''; }
    setContactStep(step);
    const upsell = step === 'addons' && session?.upsell;
    say('model', contactPrompt(step, d, { ...config, upsellReady: Boolean(upsell) }));
    setOptions(step === 'email' ? ['Skip'] : step === 'notes' ? ['No special notes', 'Gate code required'] : step === 'sms' ? ['Yes, SMS updates are fine', 'No, call or email only'] : step === 'addons' && !upsell ? [...addOnLabels(session), 'No add-ons'] : []);
    setMulti(step === 'addons' && !upsell);
    setSuggested('');
  };
  function startContact(s: any) {
    const known = s?.serviceAddress || {};
    setDraft({ name: s?.contact?.name || '', phone: s?.contact?.phone || '', email: s?.contact?.email || '', address: s?.contact?.address || known.street || '', city: s?.contact?.city || known.city || '', zip: known.zip || s?.zip || s?.contact?.zip || '', notes: '', addOns: {}, smsConsent: false, ...(known.street ? { addressFromChat: true } : {}) });
    setTimeout(() => askContact('name', {}), 50);
  }
  const nextContact = (step: ContactStep, d: any) => {
    const order = stepsFor(session);
    const i = order.indexOf(step);
    if (i < order.length - 1) return askContact(order[i + 1], d);
    void submitContact(d);
  };
  const chatAddress = !contactStep && session?.pending === 'serviceAddress';
  const suggestOn = (contactStep === 'address' || chatAddress) && !!config?.addressSuggestions;
  useEffect(() => { if (chatAddress) { addrSession.current = crypto.randomUUID(); addrPicked.current = ''; } }, [chatAddress]);
  useEffect(() => {
    const q = text.trim();
    if (!suggestOn || q.length < 3 || q === addrPicked.current) { setAddrItems([]); setAddrActive(-1); return; }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const r = await api(`/api/address/suggest?q=${encodeURIComponent(q)}&s=${addrSession.current}`, { token, signal: ctrl.signal });
        setAddrItems(r.suggestions || []); setAddrActive(-1);
      } catch { /* typing still works without suggestions */ }
    }, 250);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [text, suggestOn, token]);
  const pickAddress = async (item: { id: string; main: string; secondary: string }) => {
    const forChat = chatAddress; // the first question: the picked address is sent to BOB as the answer
    if (!forChat) remember('contact');
    setAddrItems([]); setAddrActive(-1); setAddrLoading(true);
    try {
      const { address: a } = await api(`/api/address/details?id=${encodeURIComponent(item.id)}&s=${addrSession.current}`, { token });
      addrSession.current = crypto.randomUUID(); // choosing a place ends Google's billing session
      if (!a?.precise || !a.city || !a.zip) {
        // A street without a house number: keep it in the box for them to finish.
        addrPicked.current = `${item.main} `;
        setText(`${item.main} `);
        say('model', 'Please add the house number to that street, then send.');
        inputRef.current?.focus();
        return;
      }
      if (forChat) {
        setText('');
        void send(`${a.street}, ${a.city}, AZ ${a.zip}`);
        return;
      }
      const d = { ...draft, address: a.street, city: a.city, zip: a.zip };
      setText('');
      say('user', String(a.formatted || `${a.street}, ${a.city}, AZ ${a.zip}`).replace(/, USA$/, ''));
      setDraft(d);
      setPicked([]);
      nextContact('city', d); // the city came with the address
    } catch {
      addrPicked.current = item.main;
      setText(item.main);
      say('model', "I couldn't load that address. Please finish typing it and send.");
      inputRef.current?.focus();
    } finally { setAddrLoading(false); }
  };
  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!addrItems.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setAddrActive((i) => (i + 1) % addrItems.length); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAddrActive((i) => (i <= 0 ? addrItems.length - 1 : i - 1)); }
    else if (e.key === 'Escape') { setAddrItems([]); setAddrActive(-1); }
    else if (e.key === 'Enter' && addrActive >= 0) { e.preventDefault(); void pickAddress(addrItems[addrActive]); }
  };

  const answerContact = (raw: string) => {
    remember('contact');
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
      say('user', value);
    } else if (step === 'email' && /^skip$/i.test(value)) {
      d.email = '';
      say('user', 'Skip');
    } else if (step === 'notes' && /^(?:no special notes|no gate code|no\b)/i.test(value)) {
      d.notes = '';
      say('user', value);
    } else if (step === 'notes' && /^gate code required$/i.test(value)) {
      say('user', value);
      setDraft(d);
      return askContact('gate', d);
    } else if (step === 'gate') {
      if (value.length < 1) return;
      d.notes = value;
      say('user', value);
      setDraft(d);
      setPicked([]);
      return nextContact('notes', d);
    } else {
      if (step === 'phone' && value.replace(/\D/g, '').length < 10) { say('user', value); say('model', 'That number looks short. Please enter a 10-digit callback number.'); return; }
      if (step === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) { say('user', value); say('model', "That email doesn't look right. Enter it again, or choose Skip."); return; }
      if (step === 'address' && !/^\d+\s+\S/.test(value)) { say('user', value); say('model', 'Please include the house number and street, like “15420 W Bell Rd”.'); return; }
      if (step === 'name' && value.length < 2) return;
      d[step] = step === 'name' || step === 'city' ? properName(value) : value;
      say('user', value);
    }
    setDraft(d);
    setPicked([]);
    nextContact(step, d);
  };
  /** The upsell panel's answer: DryerFlex, the sanitizing fog, and/or Ultimate in place of Premium. */
  const chooseUpsell = (sel: { dryerflex: boolean; fogging: boolean; ultimate: boolean }) => {
    remember('contact');
    const d = { ...draft, addOns: { ...(draft.addOns || {}), dryerflex: sel.dryerflex && !sel.ultimate, fogging: sel.fogging, toolRetrieval: false }, upgrade: sel.ultimate ? 'ultimate' : undefined };
    const chosen = [sel.ultimate && 'the Ultimate Protection upgrade', sel.dryerflex && !sel.ultimate && 'the DryerFlex upgrade', sel.fogging && 'the sanitizing fog treatment'].filter(Boolean);
    say('user', chosen.length ? `Add ${chosen.join(' and ')}` : 'No thanks');
    setDraft(d);
    setPicked([]);
    nextContact('addons', d);
  };
  const submitContact = async (d: any) => {
    setContactStep(null); setOptions([]); setMulti(false);
    setBusy(true); busyRef.current = true; setError('');
    try {
      const r = await api('/api/contact', { method: 'POST', token, body: d });
      forget();
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

  const restart = async () => {
    if ((messages.length || receipt) && !(await askConfirm({ brand: 'chat', danger: true, title: 'Start over?', message: 'This clears our conversation. A visit you already booked stays booked.', confirmLabel: 'Start over', cancelLabel: 'Keep chatting' }))) return;
    void api('/api/holds', { method: 'DELETE', token }).catch(() => {});
    setMessages([]); forget(); void initialize(true);
  };
  const toggle = (label: string) => setPicked((p) => (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]));
  const last = messages[messages.length - 1];
  const canGoBack = undoCount > 0 && ready && !receipt && !requestId && !['verify', 'slots', 'approval', 'emergency', 'call_office'].includes(action);
  const inputHints = contactStep ? INPUT_FOR[contactStep] : session?.pending === 'serviceAddress' ? ADDRESS_INPUT : session?.pending === 'zip' ? ZIP_INPUT : undefined;
  const showOptions = !busy && !receipt && !requestId && options.length > 0 && (last?.role === 'model' || !!contactStep);
  const started = messages.length > 0;

  const shell = minimized ? 'h-auto rounded-3xl max-w-3xl mx-auto' : embedded ? 'h-dvh rounded-none border-0' : preview ? 'h-[780px] rounded-3xl max-w-4xl mx-auto' : 'h-[calc(100dvh-4.5rem)] sm:h-[calc(100dvh-6.5rem)] min-h-[520px] max-h-[1400px] rounded-3xl max-w-3xl mx-auto'; // fills the screen under the page's back link

  return (
    <div className={`bg-slate-900 border border-slate-800 shadow-2xl overflow-hidden flex flex-col relative text-white ${minimized ? 'bob-minimized' : ''} ${shell}`}>
      <div className="bg-slate-800/90 backdrop-blur-md px-4 py-3 border-b border-slate-700/60 flex items-center justify-between z-20">
        <div className="flex items-center gap-3 min-w-0">
          <BobFace size={46} status={ready ? 'online' : 'offline'} />
          <div className="min-w-0" title={config?.smartChat ? 'BOB, AI booking assistant' : 'BOB, booking assistant'}>
            <h1 className="flex items-center gap-2 leading-none">
              <span className="font-display font-extrabold text-lg text-white tracking-tight">BOB</span>
              <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wide ${ready ? 'bg-emerald-400/15 text-emerald-300' : error ? 'bg-rose-400/15 text-rose-300' : 'bg-slate-600/60 text-slate-300'}`}>
                {ready ? (config?.bookingEnabled ? 'Live schedule' : 'Requests') : error ? 'Not connected yet' : 'Connecting…'}
              </span>
            </h1>
            <p className="mt-1 truncate text-xs font-semibold text-slate-300">{config?.businessName || 'Dryer Vent Squad West Valley'}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button ref={expandRef} type="button" onClick={() => changeMinimized(!minimized)} className="text-xs font-bold text-slate-300 hover:text-white p-2 rounded-xl bg-slate-700/50 hover:bg-slate-700" aria-expanded={!minimized} aria-label={minimized ? 'Expand BOB' : 'Minimize BOB'} title={minimized ? 'Expand BOB' : 'Minimize BOB'}>{minimized ? <Plus size={17} /> : <Minus size={17} />}</button>
          <button onClick={() => setFaqOpen(!faqOpen)} aria-expanded={faqOpen} className={`text-xs font-bold px-3 py-1.5 rounded-xl border flex items-center gap-1.5 ${faqOpen ? 'bg-orange-500 text-white border-orange-500' : 'text-slate-300 hover:text-white bg-slate-700/50 hover:bg-slate-700 border-slate-600'}`}>
            <HelpCircle size={14} className={faqOpen ? 'text-white' : 'text-orange-400'} /><span className="sr-only sm:not-sr-only">FAQs</span>
          </button>
          <button onClick={restart} className="text-xs font-bold text-slate-300 hover:text-white px-3 py-1.5 rounded-xl bg-slate-700/50 hover:bg-slate-700 flex items-center gap-1.5" aria-label="Start over"><RotateCcw size={13} /><span className="hidden sm:inline">Reset</span></button>
        </div>
      </div>

      {config?.preview && <div role="status" className="px-4 py-2 text-xs font-semibold bg-amber-100 text-amber-950">Read-only preview — no bookings, messages, verification codes, or live integrations. Production is unchanged.</div>}

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
            <div className="mb-5"><BobFace size={128} /></div>
            <h2 className="text-2xl sm:text-3xl font-black text-white mb-2 text-center tracking-tight">👋 Hi! Welcome to Dryer Vent Squad West Valley!</h2>
            <p className="text-slate-300 text-center mb-6 text-sm max-w-sm leading-relaxed">I'm your AI Booking &amp; Diagnostic Assistant. How can I help restore your dryer exhaust system today?</p>
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
                  <div className={`flex ${model && msg.card ? 'w-full sm:max-w-[88%]' : 'max-w-[90%] sm:max-w-[80%]'} gap-2.5 ${model ? 'flex-row' : 'flex-row-reverse'}`}>
                    <div className="shrink-0 mt-auto mb-1">
                      {model ? <BobFace size={38} /> : <div className="bg-slate-700 text-slate-300 p-2 rounded-full border border-slate-600"><User size={16} /></div>}
                    </div>
                    <div className={`min-w-0 ${model && msg.card ? 'w-full' : ''}`}>
                      {model && msg.card ? (
                        <RecommendationCard card={msg.card} onChoose={(o) => void send(o)} active={i === messages.length - 1 && ready && !busy} />
                      ) : (
                        <div className="space-y-2">
                          {(model ? msg.text.split(/\n?\|\|\|\n?/) : [msg.text]).filter((part) => part.trim()).map((part, k) => (
                            <div key={k} className={`p-4 rounded-2xl text-sm sm:text-[15px] leading-relaxed whitespace-pre-wrap shadow-xs ${model ? 'bg-white text-slate-800 border border-slate-200/90 rounded-bl-xs' : 'bg-gradient-to-r from-orange-500 to-orange-600 text-white rounded-br-xs font-medium'}`}>
                              <Rich text={part.trim()} />
                            </div>
                          ))}
                        </div>
                      )}
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
                    {options.filter((o) => !(last?.card?.picks || []).some((p: any) => p.option === o)).map((o) => {
                      const star = suggested && o === suggested;
                      const primary = /^(accept|accept & continue|book assessment|include assessment|cleaning \+ assessment|yes, let's schedule)$/i.test(o);
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
              {!receipt && !requestId && contactStep === 'addons' && session?.upsell && !busy && <UpsellOffer upsell={session.upsell} onDone={chooseUpsell} />}
              {!receipt && !requestId && action === 'verify' && verification && <VerifyPhone token={token} verification={verification} onVerified={(s) => { setSession(s); setVerification(null); setAction('slots'); say('model', `Thanks — your ${s.verifiedContact?.channel === 'email' ? 'email' : 'phone'} is confirmed. ${s.afterHours ? "Here's your after-hours request. Send it and I'll check with our on-call technician right away." : 'Here are the soonest openings for the full visit.'}`); }} onEdit={editDetails} onRequest={() => setAction('request')} />}
              {!receipt && !requestId && action === 'slots' && session?.afterHours && <AfterHoursSend token={token} onSent={(a) => { setApproval(a); setAction('approval'); setOptions([]); }} onRegular={() => void send('Keep regular times')} />}
              {!receipt && !requestId && action === 'slots' && !session?.afterHours && <SlotPicker token={token} session={session} config={config} onSooner={() => void send('Do you have anything sooner?')} onBooked={(r, p) => { setReceipt(r); setPending(p); setAction(''); setOptions([]); setAutoClose(!p && !preview); }} onApproval={(a) => { setApproval(a); setAction('approval'); setOptions([]); }} onRequest={() => setAction('request')} onEdit={editDetails} />}
              {!receipt && !requestId && action === 'approval' && approval && <ApprovalWait token={token} initial={approval} onBooked={onApprovalBooked} onEnded={onApprovalEnded} onCancelled={onApprovalCancelled} />}
              {!receipt && !requestId && action === 'call_office' && <CallOffice phone={config?.phone} />}
              {!receipt && !requestId && action === 'request' && <RequestForm token={token} session={session} onDone={(id) => { setRequestId(id); setAction(''); setOptions([]); }} />}
              {requestId && (
                <Card>
                  <h3 className="font-extrabold text-slate-800 text-lg flex items-center gap-2"><Sparkles size={20} className="text-orange-500" />Request sent</h3>
                  <p className="text-sm text-slate-500 mt-1">Reference <b className="text-slate-800">{requestId}</b>. The office has it and will reach out. This isn't a booked visit yet.</p>
                  <button className="mt-4 px-4 py-2.5 bg-slate-100 hover:bg-slate-200 rounded-xl font-extrabold text-sm text-slate-700" onClick={restart}>Start a new conversation</button>
                </Card>
              )}
              {receipt && <Receipt receipt={receipt} pending={pending} business={config} autoClose={autoClose} closeLabel={embedded ? 'This chat will close' : 'Returning to dryerventsquadaz.com'} onStay={() => setAutoClose(false)} onAutoClose={() => { setAutoClose(false); if (embedded) changeMinimized(true); else window.location.assign(SITE_URL); }} />}
            </div>
          </>
        )}
        <div className="h-2" />
      </div>

      <div className="p-3 sm:p-4 bg-slate-800/90 border-t border-slate-700/60 shrink-0">
        <div className="flex items-center gap-2 max-w-3xl mx-auto">
        {canGoBack && (
          <button type="button" onClick={() => void goBack()} disabled={busy} aria-label="Go back and change your last answer" title="Change my last answer"
            className="shrink-0 size-10 rounded-full border border-slate-600 text-slate-300 hover:text-white hover:border-sky-300 flex items-center justify-center transition-colors disabled:opacity-40">
            <ArrowLeft size={17} />
          </button>
        )}
        <form onSubmit={(e) => { e.preventDefault(); void send(); }} className="relative flex-1 min-w-0 flex items-center">
          {suggestOn && (addrItems.length > 0 || addrLoading) && (
            <div className="absolute bottom-full inset-x-0 mb-2 bg-white rounded-2xl shadow-2xl shadow-slate-900/30 border border-slate-200 overflow-hidden animate-in">
              {addrLoading ? (
                <p className="px-4 py-3.5 text-sm font-semibold text-slate-500 flex items-center gap-2"><Loader2 size={16} className="animate-spin text-orange-500" />Getting that address…</p>
              ) : (
                <ul id="bob-address-options" role="listbox" aria-label="Address suggestions" className="py-1.5">
                  {addrItems.map((a, i) => (
                    <li key={a.id} id={`bob-address-${i}`} role="option" aria-selected={i === addrActive}>
                      <button type="button" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={() => void pickAddress(a)} onMouseEnter={() => setAddrActive(i)}
                        className={`w-full text-left px-4 py-2.5 flex items-start gap-3 ${i === addrActive ? 'bg-orange-50' : ''}`}>
                        <MapPin size={17} className="text-orange-500 mt-0.5 shrink-0" />
                        <span className="min-w-0"><span className="block text-sm font-bold text-slate-900 truncate">{a.main}</span>{a.secondary && <span className="block text-xs text-slate-500 truncate">{a.secondary.replace(/, USA$/, '')}</span>}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="px-4 py-1.5 border-t border-slate-100 text-[10px] text-slate-400 text-right">Google Maps</p>
            </div>
          )}
          <PhoneInput
            formatPhone={contactStep === 'phone'}
            ref={inputRef}
            aria-label={suggestOn ? 'Street address' : 'Message BOB'} maxLength={2000} value={text} onValueChange={setText} onKeyDown={onInputKey}
            {...(suggestOn ? { role: 'combobox', 'aria-autocomplete': 'list' as const, 'aria-expanded': addrItems.length > 0, 'aria-controls': 'bob-address-options', 'aria-activedescendant': addrActive >= 0 ? `bob-address-${addrActive}` : undefined } : {})}
            type={inputHints?.type || 'text'} autoComplete={suggestOn ? 'off' : inputHints?.autoComplete || 'off'} inputMode={inputHints?.inputMode} enterKeyHint="send"
            disabled={!ready || busy || addrLoading || !!receipt || !!requestId || contactStep === 'sms' || contactStep === 'addons'}
            placeholder={receipt ? 'Your visit is booked.' : inputHints?.placeholder || 'Type your message or answer…'}
            className="neon-field w-full bg-slate-950 rounded-full pl-5 pr-14 py-3.5 text-sm font-semibold text-white outline-none disabled:opacity-60"
          />
          <button type="submit" aria-label="Send" disabled={!ready || busy || !text.trim() || !!receipt || !!requestId} className="neon-send absolute right-1.5 p-2.5 rounded-full"><Send size={18} strokeWidth={2.5} /></button>
        </form>
        </div>
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
        <a href={SITE_URL} className="font-bold text-slate-600 hover:text-slate-900 flex items-center gap-1.5"><ArrowLeft size={16} />Dryer Vent Squad West Valley</a>
        <span className="text-slate-400 font-semibold hidden sm:inline">Veteran-owned · West Valley, AZ</span>
      </div>
      <BookingBot />
    </div>
  );
}
