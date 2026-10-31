import React, { useMemo, useState } from 'react';
import { Calendar, Shield, User } from 'lucide-react';
import { useDashboard } from './DashboardContext';
import { ErrorNote, Field, Modal, Toggle, inputClass, primaryButton, secondaryButton } from './ui';
import { bookingQuote, money } from '../../shared/domain.mjs';
import { PACKAGES, TIERS, MORE } from '../../shared/catalog.mjs';

const tomorrow10 = () => {
  const d = new Date(Date.now() + 86_400_000 - 7 * 3_600_000);
  return `${d.toISOString().slice(0, 10)}T10:00`;
};

export function NewAppointmentModal({ onClose }: { onClose: () => void }) {
  const { data, mutate } = useDashboard();
  const c = data.config;
  const [f, setF] = useState({
    name: '', phone: '', email: '', address: '', city: '', zip: c.serviceZips[0] || '', service: 'cleaning:premium',
    stories: '1-story', upstairs: false, gas: false, noDryer: false, fogging: false, toolRetrieval: false,
    scheduledAt: tomorrow10(), technicianId: '', urgency: 'normal', notes: '', smsConsent: false, sendConfirmation: true,
  });
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }));
  const [route, pkg] = f.service.split(':');

  const quote = useMemo(() => {
    try {
      return bookingQuote(route, c, {
        package: pkg,
        property: { stories: f.stories, laundryFloor: f.upstairs ? '2nd floor' : '1st floor', hasDryer: f.noDryer ? 'No' : 'Yes', power: f.gas ? 'Gas' : 'Electric' },
        addOns: { fogging: f.fogging, toolRetrieval: f.toolRetrieval },
      });
    } catch {
      return null;
    }
  }, [route, pkg, f.stories, f.upstairs, f.gas, f.noDryer, f.fogging, f.toolRetrieval, c]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await mutate('/api/admin/appointments', {
        name: f.name, phone: f.phone, email: f.email, address: f.address, city: f.city, zip: f.zip,
        route, package: pkg, stories: f.stories, upstairs: f.stories === '2-story' && f.upstairs, gas: f.gas, noDryer: f.noDryer,
        fogging: f.fogging, toolRetrieval: f.toolRetrieval, scheduledAt: new Date(`${f.scheduledAt}:00-07:00`).toISOString(),
        technicianId: f.technicianId || undefined, urgency: f.urgency, notes: f.notes, smsConsent: f.smsConsent, sendConfirmation: f.sendConfirmation,
      }, 'POST', c.scheduleSource === 'Jobber' ? 'Booked and added to Jobber' : 'Booked');
      onClose();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const families = [...TIERS, ...MORE].filter((fam) => (c.services || []).some((s: any) => s.family === fam && s.active !== false));

  return (
    <Modal title="Office booking" subtitle="Phone or walk-in booking — checked against the same schedule and drive-time rules" onClose={onClose}
      badge={<div className="bg-orange-500 text-white p-2 rounded-xl"><Calendar size={20} /></div>}>
      <form id="office-booking" onSubmit={submit} className="space-y-5">
        <div className="space-y-3">
          <h4 className="text-xs font-extrabold text-slate-400 flex items-center gap-1.5"><User size={14} className="text-orange-500" />Customer</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Full name *"><input className={inputClass} required value={f.name} onChange={(e) => set({ name: e.target.value })} /></Field>
            <Field label="Phone *"><input className={inputClass} required type="tel" value={f.phone} onChange={(e) => set({ phone: e.target.value })} /></Field>
            <Field label="Email" className="sm:col-span-2"><input className={inputClass} type="email" value={f.email} onChange={(e) => set({ email: e.target.value })} /></Field>
            <Field label="Street address *" className="sm:col-span-2"><input className={inputClass} required value={f.address} onChange={(e) => set({ address: e.target.value })} placeholder="15420 W Bell Rd" /></Field>
            <Field label="City *"><input className={inputClass} required value={f.city} onChange={(e) => set({ city: e.target.value })} /></Field>
            <Field label="ZIP *" hint={c.serviceZips.includes(f.zip) ? undefined : 'Add this ZIP to the service area in Settings first.'}><input className={inputClass} required inputMode="numeric" maxLength={5} value={f.zip} onChange={(e) => set({ zip: e.target.value.replace(/\D/g, '') })} /></Field>
          </div>
        </div>

        <div className="space-y-3 pt-3 border-t border-slate-100">
          <h4 className="text-xs font-extrabold text-slate-400 flex items-center gap-1.5"><Shield size={14} className="text-orange-500" />Service</h4>
          <Field label="Service">
            <select className={inputClass} value={f.service} onChange={(e) => set({ service: e.target.value })}>
              <optgroup label="Cleaning">{families.map((fam) => <option key={fam} value={`cleaning:${fam}`}>{(PACKAGES as any)[fam].short}</option>)}</optgroup>
              <optgroup label="Repairs"><option value="assessment:">Dryer-vent assessment ({money(c.assessmentPriceCents)})</option><option value="bundle:premium">Premium 1-2-3 + assessment (50% off)</option><option value="bundle:ultimate">Ultimate Protection + assessment (50% off)</option></optgroup>
            </select>
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4">
            <Field label="Home"><select className={inputClass} value={f.stories} onChange={(e) => set({ stories: e.target.value })}><option value="1-story">1-story</option><option value="2-story">2-story</option></select></Field>
            <div className="pt-4">
              {f.stories === '2-story' && <Toggle checked={f.upstairs} onChange={(v) => set({ upstairs: v })} label="Laundry is upstairs" />}
              <Toggle checked={f.gas} onChange={(v) => set({ gas: v })} label="Gas dryer" detail={route === 'cleaning' ? 'Adds the Gas Appliance Safety Procedure.' : 'No add-on for this service.'} />
              <Toggle checked={f.noDryer} onChange={(v) => set({ noDryer: v })} label="No dryer installed" detail="Cleaning becomes Express (vent only)." />
            </div>
          </div>
          {route === 'cleaning' && (
            <div className="flex flex-wrap gap-x-6">
              <Toggle checked={f.fogging} onChange={(v) => set({ fogging: v })} label="Sanitation fogging add-on" />
              <Toggle checked={f.toolRetrieval} onChange={(v) => set({ toolRetrieval: v })} label="Tool retrieval add-on" />
            </div>
          )}
        </div>

        <div className="space-y-3 pt-3 border-t border-slate-100">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Arrival time (Arizona) *"><input type="datetime-local" required className={inputClass} value={f.scheduledAt} onChange={(e) => set({ scheduledAt: e.target.value })} /></Field>
            <Field label="Technician" hint="Any free tech if left on Best fit."><select className={inputClass} value={f.technicianId} onChange={(e) => set({ technicianId: e.target.value })}><option value="">Best fit</option>{data.technicians.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
            <Field label="Urgency"><select className={inputClass} value={f.urgency} onChange={(e) => set({ urgency: e.target.value })}><option value="normal">Normal</option><option value="elevated">Elevated</option><option value="high">High</option></select></Field>
          </div>
          <Field label="Gate codes and notes"><textarea rows={2} className={inputClass} value={f.notes} onChange={(e) => set({ notes: e.target.value })} /></Field>
          <Toggle checked={f.smsConsent} onChange={(v) => set({ smsConsent: v })} label="Customer agreed to appointment texts" />
          <Toggle checked={f.sendConfirmation} onChange={(v) => set({ sendConfirmation: v })} label="Send the confirmation text and email" detail={data.integrations?.messaging?.sms || data.integrations?.messaging?.email ? 'Text only with consent; email when given.' : 'Neither Twilio nor LeadConnector is set up, so nothing will be sent.'} />
        </div>

        <div className="bg-orange-50 p-4 rounded-2xl flex items-center justify-between border border-orange-200">
          <div><span className="text-xs font-extrabold text-orange-900">Total</span><p className="text-xl font-black text-orange-600">{quote ? money(quote.totalCents) : '—'}</p>{quote && quote.lineItems.length > 1 && <p className="text-[11px] text-orange-900/70">{quote.lineItems.map((l: any) => l.name).join(' + ')}</p>}</div>
          <div className="text-right text-xs text-orange-800 font-medium">{quote ? `${quote.durationMins} minutes` : ''}</div>
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
        <div className="flex items-center justify-end gap-3">
          <button type="button" className={secondaryButton} onClick={onClose}>Cancel</button>
          <button className={primaryButton} disabled={busy}>{busy ? 'Booking…' : 'Book visit'}</button>
        </div>
      </form>
    </Modal>
  );
}
