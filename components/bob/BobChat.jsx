'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CalendarCheck, Check, ChevronDown, Flame, Phone, Send, X, Zap } from 'lucide-react';
import { PHASES, STEPS, phaseOf } from '@/lib/bob/flow';
import { addonsFor, money, quote, recommend } from '@/lib/bob/pricing';
import { ADDONS, BUSINESS, HOURS_TEXT, PACKAGES, PRICING_NOTE, REPAIR_STEPS, SEVERITY_CREDIT } from '@/lib/bob/catalog';
import { inServiceArea } from '@/lib/bob/serviceArea';
import { formatDay, formatTime } from '@/lib/bob/schedule';
import './bob.css';

const STORE = 'dvs-bob-v1';
let counter = 0;
const nid = () => `m${Date.now().toString(36)}${(counter++).toString(36)}`;

const ENTRY_LINES = {
  promise: "Good choice. Here's exactly what you're getting.",
  contact: "Where should we come? I'll check that you're in our service area.",
  slots: 'These times are open on our schedule right now. Pick the one that works for you.',
};

// What BOB says when the conversation arrives at a step.
function enter(stepId, answers) {
  const step = STEPS[stepId];
  if (step?.say) return [{ id: nid(), from: 'bob', text: step.say(answers) }];
  if (stepId === 'recommend') return [{ id: nid(), from: 'bob', kind: 'diagnosis', answers }];
  if (stepId === 'assessment') return [{ id: nid(), from: 'bob', kind: 'assessment' }];
  if (ENTRY_LINES[stepId]) return [{ id: nid(), from: 'bob', text: ENTRY_LINES[stepId] }];
  return [];
}

function initialState() {
  return {
    step: 'start',
    answers: {},
    messages: enter('start', {}),
    history: [],
    packageId: null,
    addons: [],
    contact: null,
    result: null,
  };
}

export default function BobChat({ mode = 'page' }) {
  const [state, setState] = useState(initialState);
  const [asking, setAsking] = useState(false);
  const [draft, setDraft] = useState('');
  const [inFrame, setInFrame] = useState(false);
  const logRef = useRef(null);
  const loaded = useRef(false);

  // Inside the website's pop-up, Escape closes the pop-up.
  useEffect(() => {
    if (window.parent === window) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') window.parent.postMessage({ type: 'dvs-bob:close' }, '*');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Pick up where the customer left off if they reload the page.
  useEffect(() => {
    setInFrame(window.parent !== window);
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORE) || 'null');
      if (saved?.step && STEPS[saved.step] && saved.step !== 'done') setState(saved);
    } catch {
      // storage unavailable; start fresh
    }
    loaded.current = true;
  }, []);

  useEffect(() => {
    if (!loaded.current) return;
    try {
      if (state.step === 'done') sessionStorage.removeItem(STORE);
      else sessionStorage.setItem(STORE, JSON.stringify(state));
    } catch {
      // ignore
    }
  }, [state]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [state.messages.length, state.step, asking]);

  const step = STEPS[state.step];

  function snapshot(s) {
    return { step: s.step, answers: s.answers, count: s.messages.length, packageId: s.packageId, addons: s.addons, contact: s.contact };
  }

  // Moves to another step, adding the customer's answer as a chat bubble.
  function go(nextStep, myText, patch = {}, extraBob = []) {
    setState((s) => {
      const answers = patch.answers || s.answers;
      const messages = [...s.messages];
      if (myText) messages.push({ id: nid(), from: 'me', text: myText });
      for (const line of extraBob) messages.push({ id: nid(), from: 'bob', text: line });
      messages.push(...enter(nextStep, answers));
      return { ...s, ...patch, answers, step: nextStep, messages, history: [...s.history, snapshot(s)] };
    });
  }

  function answer(value, label) {
    const apply = step.apply || ((a, v) => (step.key ? { ...a, [step.key]: v } : a));
    const answers = apply(state.answers, value);
    const ack = step.ack?.[Array.isArray(value) ? '' : value];
    go(step.next(answers, value), label, { answers }, ack ? [ack] : []);
  }

  function back() {
    setState((s) => {
      const prev = s.history[s.history.length - 1];
      if (!prev) return s;
      return {
        ...s,
        step: prev.step,
        answers: prev.answers,
        packageId: prev.packageId,
        addons: prev.addons,
        contact: prev.contact,
        messages: s.messages.slice(0, prev.count),
        history: s.history.slice(0, -1),
      };
    });
  }

  function restart() {
    try {
      sessionStorage.removeItem(STORE);
    } catch {
      // ignore
    }
    setState(initialState());
  }

  async function send(e) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || asking) return;
    setDraft('');
    if (step.type === 'text') {
      answer(text, text);
      return;
    }
    setState((s) => ({ ...s, messages: [...s.messages, { id: nid(), from: 'me', text }] }));
    setAsking(true);
    let reply = `I couldn't get an answer just now. Call ${BUSINESS.phone} and the team will help.`;
    try {
      const res = await fetch('/api/bob/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: text }),
      });
      const data = await res.json();
      if (data.answer) reply = data.answer;
    } catch {
      // keep fallback
    }
    setAsking(false);
    setState((s) => ({ ...s, messages: [...s.messages, { id: nid(), from: 'bob', text: reply }] }));
  }

  const phase = phaseOf(state.step);
  const canGoBack = state.history.length > 0 && state.step !== 'done';

  return (
    <section className={`bob bob--${mode}`} aria-label="Book with BOB">
      <header className="bob-head">
        <img className="bob-avatar" src="/bob-avatar.svg" alt="" width="40" height="40" />
        <div className="bob-id">
          <p className="bob-name">BOB</p>
          <p className="bob-sub">Dryer Vent Squad West Valley</p>
        </div>
        <a className="bob-iconbtn" href={`tel:${BUSINESS.tel}`} aria-label={`Call ${BUSINESS.phone}`}>
          <Phone size={18} />
        </a>
        {inFrame && (
          <button
            className="bob-iconbtn"
            type="button"
            aria-label="Close chat"
            onClick={() => window.parent.postMessage({ type: 'dvs-bob:close' }, '*')}
          >
            <X size={18} />
          </button>
        )}
      </header>

      <ol className="bob-phases" aria-label="Booking progress">
        {PHASES.map((p, i) => (
          <li key={p} className={i < phase ? 'is-done' : i === phase ? 'is-now' : ''} aria-current={i === phase ? 'step' : undefined}>
            {p}
          </li>
        ))}
      </ol>

      <div className="bob-log" ref={logRef} aria-live="polite">
        {state.messages.map((m) => (
          <Message key={m.id} m={m} />
        ))}
        {asking && (
          <div className="bob-msg bob-msg--bob">
            <p className="bob-bubble bob-typing" aria-label="BOB is typing">
              <span />
              <span />
              <span />
            </p>
          </div>
        )}

        <div className="bob-panel">
          {step.info && <Info which={step.info} />}
          {step.type === 'single' && <Single step={step} onPick={answer} />}
          {step.type === 'multi' && <Multi step={step} onDone={answer} key={state.step} />}
          {state.step === 'recommend' && (
            <Packages
              answers={state.answers}
              onPick={(id) => {
                const q = quote(id, state.answers);
                go('promise', `${q.name}, ${money(q.total)}`, { packageId: id, addons: [] });
              }}
            />
          )}
          {state.step === 'promise' && (
            <PriceSummary
              answers={state.answers}
              packageId={state.packageId}
              onAccept={(addons) => {
                const q = quote(state.packageId, state.answers, addons);
                const extra = addons.length ? ` with ${addons.map((a) => ADDONS[a].name.toLowerCase()).join(', ')}` : '';
                go('contact', `Accepted: ${money(q.total)}${extra}`, { addons });
              }}
            />
          )}
          {state.step === 'assessment' && (
            <button className="bob-cta" type="button" onClick={() => go('contact', `Book the ${money(PACKAGES.repair.price)} assessment`, { packageId: 'repair', addons: [] })}>
              Book the {money(PACKAGES.repair.price)} assessment
            </button>
          )}
          {state.step === 'contact' && (
            <Contact
              initial={state.contact}
              onNext={(contact, inArea) => {
                if (inArea) go('slots', `${contact.street}, ${contact.city} ${contact.zip}`, { contact });
                else go('done', `${contact.street}, ${contact.city} ${contact.zip}`, { contact, result: { pending: true, outOfArea: true } });
              }}
            />
          )}
          {state.step === 'slots' && (
            <Slots
              answers={state.answers}
              packageId={state.packageId}
              addons={state.addons}
              contact={state.contact}
              onBooked={(result) => go('done', result.when, { result })}
            />
          )}
          {state.step === 'done' && (
            <Done state={state} onUpdate={(result) => setState((s) => ({ ...s, result }))} onRestart={restart} />
          )}
        </div>
      </div>

      <form className="bob-compose" onSubmit={send}>
        {canGoBack && (
          <button className="bob-back" type="button" onClick={back} aria-label="Change my last answer" title="Change my last answer">
            <ArrowLeft size={18} />
          </button>
        )}
        <label className="bob-visually-hidden" htmlFor={`bob-input-${mode}`}>
          {step.type === 'text' ? 'Your answer' : 'Ask BOB a question'}
        </label>
        <input
          id={`bob-input-${mode}`}
          className="bob-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={step.type === 'text' ? step.placeholder : 'Ask BOB a question'}
          maxLength={500}
          autoComplete="off"
        />
        <button className="bob-send" type="submit" aria-label={step.type === 'text' ? 'Send answer' : 'Ask'} disabled={!draft.trim() || asking}>
          <Send size={18} />
        </button>
      </form>
    </section>
  );
}

function Message({ m }) {
  if (m.kind === 'diagnosis') return <Diagnosis answers={m.answers} />;
  if (m.kind === 'assessment') return <Assessment />;
  return (
    <div className={`bob-msg bob-msg--${m.from}`}>
      <p className="bob-bubble">{m.text}</p>
    </div>
  );
}

function Single({ step, onPick }) {
  return (
    <div className="bob-options" role="group" aria-label="Choose an answer">
      {step.options.map((o) => (
        <button key={o.value} type="button" className={`bob-option${o.urgent ? ' is-urgent' : ''}`} onClick={() => onPick(o.value, o.label)}>
          {o.urgent && <Flame size={18} aria-hidden="true" />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Multi({ step, onDone }) {
  const [picked, setPicked] = useState([]);
  const toggle = (v) => setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));
  return (
    <div>
      <div className="bob-chips" role="group" aria-label="Pick all that apply">
        {step.options.map((o) => {
          const on = picked.includes(o.value);
          return (
            <button key={o.value} type="button" className={`bob-chip${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => toggle(o.value)}>
              {on && <Check size={16} aria-hidden="true" />}
              {o.label}
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="bob-cta"
        disabled={!picked.length}
        onClick={() =>
          onDone(
            picked,
            step.options.filter((o) => picked.includes(o.value)).map((o) => o.label).join(', ')
          )
        }
      >
        Continue
      </button>
    </div>
  );
}

function Expand({ title, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`bob-expand${open ? ' is-open' : ''}`}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        {title}
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && <div className="bob-expand-body">{children}</div>}
    </div>
  );
}

function Info({ which }) {
  return (
    <div className="bob-info">
      {which.includes('gasElectric') && (
        <Expand title="How to tell gas from electric">
          <div className="bob-compare">
            <div>
              <p className="bob-compare-head">
                <Zap size={16} aria-hidden="true" /> Electric
              </p>
              <p>A very thick power cord that plugs into a large 220V outlet, like a stove outlet. No metal tube to the wall.</p>
            </div>
            <div>
              <p className="bob-compare-head">
                <Flame size={16} aria-hidden="true" /> Gas
              </p>
              <p>A regular power cord plus a flexible metal or yellow-coated line running to a gas valve on the wall.</p>
            </div>
          </div>
        </Expand>
      )}
      {which.includes('whyAsk') && (
        <Expand title="Why BOB asks this">
          <p>
            Gas dryers need a safety procedure to disconnect and reconnect, and pedestal or stacked setups take extra time to move. Knowing ahead
            means the right tech, the right parts and an accurate price.
          </p>
        </Expand>
      )}
    </div>
  );
}

const GAUGE = {
  severe: { at: 86, label: 'Severe restriction' },
  moderate: { at: 52, label: 'Moderate restriction' },
  good: { at: 14, label: 'Airflow looks clear' },
};

const DIAGNOSIS = {
  severe: `From what you described, your airflow is likely down 80% or more. That's a real fire risk and hard on the dryer. I suggest the Total System See-It-Clean, and I've taken a $${SEVERITY_CREDIT} severity credit off it.`,
  moderate:
    "Your dryer is showing a moderate restriction, so it's working harder than it should. I suggest the Performance See-It-Clean: it clears the line and upgrades the transition hose to DryerFlex.",
  good: 'Good news: no warning signs. The Essential See-It-Clean is the right fit to keep it that way.',
};

function Diagnosis({ answers }) {
  const rec = recommend(answers);
  if (rec.kind === 'express') {
    return (
      <div className="bob-msg bob-msg--bob">
        <p className="bob-bubble">
          Since there's no dryer hooked up, or it was just serviced, the Express Vent Cleaning is the right fit. It cleans the vent line and
          includes a live camera inspection.
        </p>
      </div>
    );
  }
  const g = GAUGE[rec.severity];
  return (
    <div className="bob-msg bob-msg--bob">
      <div className="bob-bubble bob-diagnosis">
        <div className="bob-gauge" role="img" aria-label={`Estimated airflow: ${g.label}`}>
          <div className="bob-gauge-track">
            <span className="bob-gauge-marker" style={{ left: `${g.at}%` }} />
          </div>
          <div className="bob-gauge-scale" aria-hidden="true">
            <span>Clear</span>
            <span>Restricted</span>
            <span>Severe</span>
          </div>
          <p className="bob-gauge-label">{g.label}</p>
          <p className="bob-gauge-note">Estimated from your answers. The tech measures real airflow before and after.</p>
        </div>
        <p>{DIAGNOSIS[rec.severity]}</p>
        {answers.path === 'emergency' && <p>If you need us today, Emergency Same-Day Clog Relief is also an option.</p>}
        <p>Keeping the vent clear lets the dryer finish in one cycle, which typically saves $150 to $300 a year in energy.</p>
      </div>
    </div>
  );
}

function Assessment() {
  return (
    <div className="bob-msg bob-msg--bob">
      <div className="bob-bubble">
        <p>
          Repairs start with a <strong>{money(PACKAGES.repair.price)} comprehensive assessment</strong>, fully credited toward the repair if you
          hire us. It includes:
        </p>
        <ul className="bob-list">
          {PACKAGES.repair.features.slice(0, 4).map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
        <p>Then our repair process:</p>
        <ol className="bob-list bob-list--steps">
          {REPAIR_STEPS.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function Packages({ answers, onPick }) {
  const rec = recommend(answers);
  return (
    <div className="bob-packages">
      {rec.options.map((id) => {
        const q = quote(id, answers);
        const pkg = PACKAGES[id];
        const pick = id === rec.suggested;
        return (
          <article key={id} className={`bob-pkg${pick ? ' is-pick' : ''}`}>
            {pick && <p className="bob-pkg-flag">BOB's pick for you</p>}
            <div className="bob-pkg-top">
              <h3>{pkg.name}</h3>
              <p className="bob-price">{money(q.total)}</p>
            </div>
            <p className="bob-pkg-time">About {q.minutes} minutes</p>
            <ul className="bob-list">
              {pkg.features.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            <button type="button" className={pick ? 'bob-cta' : 'bob-cta bob-cta--quiet'} onClick={() => onPick(id)}>
              Choose {pkg.short}
            </button>
          </article>
        );
      })}
    </div>
  );
}

function PriceSummary({ answers, packageId, onAccept }) {
  const [addons, setAddons] = useState([]);
  const q = quote(packageId, answers, addons);
  const available = addonsFor(packageId);
  return (
    <div className="bob-card">
      <h3 className="bob-card-title">Your price</h3>
      <dl className="bob-lines">
        {q.lines.map((l) => (
          <div key={l.label}>
            <dt>
              {l.label}
              {l.note && <span>{l.note}</span>}
            </dt>
            <dd>{money(l.amount)}</dd>
          </div>
        ))}
        <div className="bob-total">
          <dt>Total</dt>
          <dd>{money(q.total)}</dd>
        </div>
      </dl>
      {available.map((id) => {
        const on = addons.includes(id);
        return (
          <label key={id} className="bob-addon">
            <input type="checkbox" checked={on} onChange={() => setAddons(on ? addons.filter((a) => a !== id) : [...addons, id])} />
            <span>
              Add {ADDONS[id].name.toLowerCase()} for {money(ADDONS[id].price)}
              <small>{ADDONS[id].description}</small>
            </span>
          </label>
        );
      })}
      <div className="bob-promise">
        <p className="bob-promise-title">Transparent pricing promise</p>
        <p>{PRICING_NOTE}</p>
      </div>
      <button type="button" className="bob-cta" onClick={() => onAccept(addons)}>
        Accept and continue
      </button>
    </div>
  );
}

const EMPTY_CONTACT = { firstName: '', lastName: '', phone: '', email: '', street: '', city: '', zip: '', notes: '' };

function Contact({ initial, onNext }) {
  const [c, setC] = useState(initial || EMPTY_CONTACT);
  const [error, setError] = useState('');
  const set = (k) => (e) => setC({ ...c, [k]: e.target.value });

  function submit(e) {
    e.preventDefault();
    const phone = c.phone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    const problems = [];
    if (!c.firstName.trim() || !c.lastName.trim()) problems.push('your full name');
    if (phone.length !== 10) problems.push('a 10-digit phone number');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email.trim())) problems.push('a valid email');
    if (!c.street.trim() || !c.city.trim()) problems.push('your street and city');
    if (!/^\d{5}$/.test(c.zip.trim())) problems.push('a 5-digit ZIP');
    if (problems.length) {
      setError(`Please add ${problems.join(', ')}.`);
      return;
    }
    const clean = { ...c, phone, zip: c.zip.trim(), email: c.email.trim() };
    onNext(clean, inServiceArea(clean));
  }

  return (
    <form className="bob-card bob-form" onSubmit={submit} noValidate>
      <div className="bob-row">
        <Field label="First name" value={c.firstName} onChange={set('firstName')} autoComplete="given-name" />
        <Field label="Last name" value={c.lastName} onChange={set('lastName')} autoComplete="family-name" />
      </div>
      <Field label="Mobile phone" value={c.phone} onChange={set('phone')} autoComplete="tel" inputMode="tel" />
      <Field label="Email" value={c.email} onChange={set('email')} autoComplete="email" inputMode="email" type="email" />
      <Field label="Street address" value={c.street} onChange={set('street')} autoComplete="address-line1" />
      <div className="bob-row">
        <Field label="City" value={c.city} onChange={set('city')} autoComplete="address-level2" />
        <Field label="ZIP" value={c.zip} onChange={set('zip')} autoComplete="postal-code" inputMode="numeric" small />
      </div>
      <Field label="Gate code or notes for the tech (optional)" value={c.notes} onChange={set('notes')} />
      {error && (
        <p className="bob-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="bob-cta">
        See open times
      </button>
    </form>
  );
}

function Field({ label, small, ...props }) {
  return (
    <label className={`bob-field${small ? ' bob-field--small' : ''}`}>
      <span>{label}</span>
      <input {...props} />
    </label>
  );
}

function Slots({ answers, packageId, addons, contact, onBooked }) {
  const [slots, setSlots] = useState(null);
  const [error, setError] = useState('');
  const [day, setDay] = useState(null);
  const [chosen, setChosen] = useState(null);
  const [booking, setBooking] = useState(false);
  const [reload, setReload] = useState(0);
  const honeypot = useRef(null);

  useEffect(() => {
    let live = true;
    setSlots(null);
    fetch('/api/bob/slots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers, packageId, addons }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (!live) return;
        if (data.error && !data.slots?.length) setError(data.error);
        setSlots(data.slots || []);
      })
      .catch(() => live && (setError('The schedule could not be loaded.'), setSlots([])));
    return () => {
      live = false;
    };
  }, [answers, packageId, addons, reload]);

  const days = useMemo(() => {
    const map = new Map();
    for (const s of slots || []) {
      if (!map.has(s.day)) map.set(s.day, []);
      map.get(s.day).push(s);
    }
    return [...map.entries()].slice(0, 10);
  }, [slots]);

  useEffect(() => {
    if (days.length && (!day || !days.some(([d]) => d === day))) setDay(days[0][0]);
  }, [days, day]);

  async function book() {
    if (!chosen) return;
    setBooking(true);
    setError('');
    try {
      const res = await fetch('/api/bob/book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers, packageId, addons, contact, slot: { start: chosen.start }, website: honeypot.current?.value || '' }),
      });
      const data = await res.json();
      if (res.status === 409) {
        setError(data.error);
        setChosen(null);
        setReload((n) => n + 1);
      } else if (!res.ok) {
        setError(data.error || 'Booking failed. Please call us.');
      } else {
        onBooked(data);
      }
    } catch {
      setError(`Booking failed. Please call ${BUSINESS.phone}.`);
    }
    setBooking(false);
  }

  if (slots === null) {
    return <p className="bob-loading">Checking the schedule…</p>;
  }

  if (!days.length) {
    return (
      <div className="bob-card">
        <p>{error || 'No open times showed up in the next two weeks.'}</p>
        <p>
          Call <a href={`tel:${BUSINESS.tel}`}>{BUSINESS.phone}</a> and we'll fit you in. Hours: {HOURS_TEXT}.
        </p>
      </div>
    );
  }

  const times = days.find(([d]) => d === day)?.[1] || [];

  return (
    <div className="bob-card bob-slots">
      <div className="bob-days" role="tablist" aria-label="Day">
        {days.map(([d, list]) => (
          <button
            key={d}
            type="button"
            role="tab"
            aria-selected={d === day}
            className={`bob-day${d === day ? ' is-on' : ''}`}
            onClick={() => {
              setDay(d);
              setChosen(null);
            }}
          >
            {formatDay(new Date(list[0].start))}
          </button>
        ))}
      </div>
      <div className="bob-times" role="group" aria-label="Start time">
        {times.map((s) => (
          <button
            key={s.start}
            type="button"
            className={`bob-time${chosen?.start === s.start ? ' is-on' : ''}`}
            aria-pressed={chosen?.start === s.start}
            onClick={() => setChosen(s)}
          >
            {formatTime(new Date(s.start))}
          </button>
        ))}
      </div>
      <input ref={honeypot} className="bob-visually-hidden" tabIndex={-1} autoComplete="off" aria-hidden="true" name="website" />
      {error && (
        <p className="bob-error" role="alert">
          {error}
        </p>
      )}
      <button type="button" className="bob-cta" disabled={!chosen || booking} onClick={book}>
        <CalendarCheck size={18} aria-hidden="true" />
        {booking ? 'Booking…' : chosen ? `Book ${formatDay(new Date(chosen.start))} at ${formatTime(new Date(chosen.start))}` : 'Pick a time'}
      </button>
    </div>
  );
}

function Done({ state, onUpdate, onRestart }) {
  const { result, answers, packageId, addons, contact } = state;
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  // Out-of-area customers: save the request in Jobber so the office can call them.
  useEffect(() => {
    if (!result?.pending || sending) return;
    setSending(true);
    fetch('/api/bob/book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answers, packageId, addons, contact }),
    })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) setError(d.error || 'Saving your request failed.');
        else onUpdate({ ...d, outOfArea: true });
      })
      .catch(() => setError('Saving your request failed.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (result?.pending) {
    return (
      <div className="bob-card">
        <p>{error ? `${error} Call ${BUSINESS.phone} and we'll help.` : 'Saving your request…'}</p>
      </div>
    );
  }

  const booked = result?.scheduled;
  return (
    <div className={`bob-card bob-done${booked ? ' is-booked' : ''}`}>
      <p className="bob-done-mark" aria-hidden="true">
        <Check size={26} />
      </p>
      {booked ? (
        <>
          <h3 className="bob-card-title">You're booked, {contact?.firstName}</h3>
          <p className="bob-done-when">{result.when}</p>
          <p>
            {result.name}, {money(result.total)}. Job #{result.jobNumber}.
          </p>
          <p>
            We'll reach out to confirm before the visit. Need to change anything? Call{' '}
            <a className="bob-nowrap" href={`tel:${BUSINESS.tel}`}>
              {BUSINESS.phone}
            </a>
            .
          </p>
        </>
      ) : (
        <>
          <h3 className="bob-card-title">Request received</h3>
          <p>
            {result?.outOfArea
              ? "Your address is just outside our usual area, so the office will call you to confirm we can make it."
              : result?.message || "We'll call you to confirm a time."}
          </p>
          <p>
            Questions in the meantime? Call{' '}
            <a className="bob-nowrap" href={`tel:${BUSINESS.tel}`}>
              {BUSINESS.phone}
            </a>
            .
          </p>
        </>
      )}
      <button type="button" className="bob-link" onClick={onRestart}>
        Start a new booking
      </button>
    </div>
  );
}
