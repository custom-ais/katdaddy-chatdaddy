import React, { useState } from 'react';
import { AlertTriangle, Calendar, DollarSign, ExternalLink, FileText, Gauge, Home, Mail, MapPin, Phone, Send, User } from 'lucide-react';
import { useDashboard, azDay, azTime, dollars, isLinked, attentionReason, type Appointment } from './DashboardContext';
import { ErrorNote, Field, Modal, StatusBadge, inputClass, primaryButton, secondaryButton, subtleButton } from './ui';
import { money } from '../../shared/domain.mjs';

const TZ = 'America/Phoenix';
/** ISO → value for <input type="datetime-local"> in Arizona time (no DST, always UTC−7). */
const toLocalInput = (iso: string) => new Date(Date.parse(iso) - 7 * 3_600_000).toISOString().slice(0, 16);
const fromLocalInput = (v: string) => new Date(`${v}:00-07:00`).toISOString();

export function AppointmentDetailModal({ appointment: a, onClose }: { appointment: Appointment; onClose: () => void }) {
  const { data, mutate } = useDashboard();
  const linked = isLinked(a);
  const [status, setStatus] = useState(a.status);
  const [urgency, setUrgency] = useState(a.urgency || 'normal');
  const [technicianId, setTechnicianId] = useState(a.technicianId);
  const [scheduledAt, setScheduledAt] = useState(toLocalInput(a.scheduledAt));
  const [notes, setNotes] = useState(a.notes || '');
  const [before, setBefore] = useState<string>(a.airflowReadings?.beforeCfm != null ? String(a.airflowReadings.beforeCfm) : '');
  const [after, setAfter] = useState<string>(a.airflowReadings?.afterCfm != null ? String(a.airflowReadings.afterCfm) : '');
  const [jobNumber, setJobNumber] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const reason = attentionReason(a);
  const gain = before && after && Number(before) > 0 ? Math.round(((Number(after) - Number(before)) / Number(before)) * 100) : null;

  const run = async (fn: () => Promise<any>) => {
    setBusy(true); setError('');
    try { await fn(); onClose(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const save = () => run(() => {
    const body: any = { revision: a.revision, notes, urgency };
    if (status !== a.status) body.status = status;
    if (!linked && technicianId !== a.technicianId) body.technicianId = technicianId;
    if (!linked && fromLocalInput(scheduledAt) !== new Date(a.scheduledAt).toISOString()) body.scheduledAt = fromLocalInput(scheduledAt);
    if (before || after) body.airflowReadings = { beforeCfm: before ? Number(before) : null, afterCfm: after ? Number(after) : null };
    return mutate(`/api/admin/appointments/${encodeURIComponent(a.id)}`, body, 'PATCH', 'Appointment updated');
  });
  const resolve = (outcome: 'in_jobber' | 'not_in_jobber') => run(() => mutate(`/api/admin/appointments/${encodeURIComponent(a.id)}/resolve`, { outcome, jobNumber }, 'POST', outcome === 'in_jobber' ? 'Confirmed and customer notified' : 'Released — the time is open again'));
  const resend = () => run(() => mutate(`/api/admin/appointments/${encodeURIComponent(a.id)}/confirmation`, {}, 'POST', 'Confirmation sent'));
  const sms = a.notifications?.sms, email = a.notifications?.email;
  // Twilio reports delivery after the fact; the latest word on this visit's confirmation text.
  const delivered = (data.messages || []).find((m) => m.ref === a.id && m.channel === 'sms' && m.kind === 'confirmation' && m.direction === 'out');
  const smsLabel = sms === 'sent' && delivered && ['delivered', 'undelivered', 'failed'].includes(delivered.status) ? delivered.status : sms;

  return (
    <Modal
      title={a.customerName}
      badge={<span className="text-xs font-mono font-bold bg-orange-100 text-orange-800 px-2.5 py-1 rounded-lg">{a.id}</span>}
      subtitle={<>{a.source === 'ai_bot' ? 'Booked by BOB online' : 'Office booking'} · {new Date(a.createdAt).toLocaleDateString('en-US', { timeZone: TZ })}</>}
      onClose={onClose}
      footer={
        <>
          <div className="flex items-center gap-2">
            {a.jobber?.webUri && <a className={secondaryButton} href={a.jobber.webUri} target="_blank" rel="noreferrer">Open in Jobber<ExternalLink size={14} /></a>}
            {a.status === 'confirmed' && (data.integrations?.messaging?.sms || data.integrations?.messaging?.email) && <button className={subtleButton} onClick={resend} disabled={busy}><Send size={15} />Resend confirmation</button>}
          </div>
          <div className="flex items-center gap-2.5">
            <button className={secondaryButton} onClick={onClose}>Close</button>
            <button className={primaryButton} onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
          </div>
        </>
      }
    >
      {reason && (
        <div className="bg-rose-50 border border-rose-200 rounded-2xl p-4 space-y-3">
          <p className="text-sm font-extrabold text-rose-800 flex items-center gap-2"><AlertTriangle size={16} />{reason}</p>
          {a.jobberError && <p className="text-xs text-rose-700 font-mono">{a.jobberError}</p>}
          <p className="text-xs text-rose-800">The customer was told it isn't confirmed yet. Search Jobber for <b>{a.customerName}</b> or reference <b>{a.id}</b> on {azDay(a.scheduledAt)} {azTime(a.scheduledAt)}. Don't rebook until you've checked.</p>
          {a.jobberState && (
            <div className="flex flex-col sm:flex-row sm:items-end gap-2">
              <Field label="Jobber job number you found" className="flex-1"><input className={inputClass} inputMode="numeric" value={jobNumber || (a.jobber?.jobNumber ? String(a.jobber.jobNumber) : '')} onChange={(e) => setJobNumber(e.target.value.replace(/\D/g, ''))} placeholder="e.g. 4521" /></Field>
              <button className={primaryButton} disabled={busy} onClick={() => resolve('in_jobber')}>It's in Jobber — confirm it</button>
              <button className={secondaryButton} disabled={busy} onClick={() => resolve('not_in_jobber')}>Not in Jobber — release</button>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-slate-50 p-4 rounded-2xl border border-slate-200/80">
        <Field label="Status">
          <select className={inputClass} value={status} onChange={(e) => setStatus(e.target.value as any)}>
            <option value="confirmed">Scheduled</option>
            <option value="in_progress">In progress (tech on site)</option>
            <option value="completed">Completed</option>
            <option value="action_needed">Action needed</option>
            <option value="cancelled" disabled={linked}>Cancelled{linked ? ' — cancel in Jobber' : ''}</option>
          </select>
        </Field>
        <Field label="Urgency">
          <select className={inputClass} value={urgency} onChange={(e) => setUrgency(e.target.value as any)}>
            <option value="normal">Normal</option>
            <option value="elevated">Elevated</option>
            <option value="high">High (emergency, clog)</option>
          </select>
        </Field>
      </div>

      <div className="space-y-3">
        <h4 className="text-xs font-extrabold text-slate-400 flex items-center gap-1.5"><User size={14} className="text-orange-500" />Customer</h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <p className="flex items-center gap-2 text-slate-700"><Phone size={15} className="text-slate-400" /><a className="font-semibold hover:text-orange-600" href={`tel:${a.phone}`}>{a.phone}</a>{a.phoneVerified && <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 px-1.5 rounded">verified</span>}</p>
          <p className="flex items-center gap-2 text-slate-700"><Mail size={15} className="text-slate-400" />{a.email || <span className="text-slate-400">No email</span>}</p>
          <p className="flex items-start gap-2 text-slate-700 sm:col-span-2"><MapPin size={15} className="text-slate-400 mt-0.5" /><span>{a.address}, {a.city}, AZ {a.zip}{a.territory && <span className="block text-xs text-slate-500">Zone {a.territory.zone} · {a.territory.micro || a.territory.city} · {a.territory.corridor}</span>}</span></p>
        </div>
        <p className="text-[11px] text-slate-400">Customer details come from the booking. Changes to the visit itself happen in Jobber.</p>
      </div>

      <div className="space-y-3 pt-2 border-t border-slate-100">
        <h4 className="text-xs font-extrabold text-slate-400 flex items-center gap-1.5"><Calendar size={14} className="text-orange-500" />Schedule</h4>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Arrival time (Arizona)" hint={linked ? 'Reschedule in Jobber — BOB follows the Jobber calendar.' : 'BOB checks the new time against the schedule rules.'}>
            <input type="datetime-local" className={inputClass} value={scheduledAt} disabled={linked} onChange={(e) => setScheduledAt(e.target.value)} />
          </Field>
          <Field label="Technician" hint={linked ? 'Reassign in Jobber.' : undefined}>
            <select className={inputClass} value={technicianId} disabled={linked} onChange={(e) => setTechnicianId(e.target.value)}>
              {data.technicians.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
        </div>
        {a.approval && <p className="text-xs text-sky-800 bg-sky-50 border border-sky-200 rounded-lg px-3 py-2">Approved by {a.approval.by} ({a.approval.id}).</p>}
      </div>

      <div className="space-y-3 pt-2 border-t border-slate-100">
        <h4 className="text-xs font-extrabold text-slate-400 flex items-center gap-1.5"><DollarSign size={14} className="text-orange-500" />Service and price</h4>
        <div className="rounded-2xl border border-slate-200 divide-y divide-slate-100 text-sm">
          {(a.lineItems?.length ? a.lineItems : [{ name: a.package, cents: Math.round(a.price * 100) }]).map((l, i) => <div key={i} className="flex justify-between px-4 py-2"><span className="text-slate-600">{l.name}</span><span className="font-bold">{money(l.cents)}</span></div>)}
          <div className="flex justify-between px-4 py-2 font-black"><span>Total</span><span>{dollars(a.price)}</span></div>
        </div>
        {a.route && a.route !== 'cleaning' && <p className="text-xs font-bold text-amber-800">Repairs and parts are quoted separately.</p>}
        {(a.property && Object.keys(a.property).length > 0) && (
          <p className="text-xs text-slate-600 flex items-start gap-2"><Home size={14} className="text-slate-400 mt-0.5" />{Object.entries(a.property).map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' · ')}</p>
        )}
        {a.concerns && a.concerns.length > 0 && <p className="text-xs text-slate-600"><b>Customer said:</b> {a.concerns.join(' · ')}</p>}
      </div>

      <div className="bg-orange-50/60 border border-orange-200/70 p-4 rounded-2xl space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-extrabold text-orange-900 flex items-center gap-1.5"><Gauge size={16} className="text-orange-500" />Measured airflow (CFM)</span>
          {gain !== null && <span className="text-xs font-extrabold bg-emerald-100 text-emerald-800 px-2.5 py-0.5 rounded-full">{gain >= 0 ? '+' : ''}{gain}% after cleaning</span>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Before"><input type="number" min={0} max={2000} className={inputClass} value={before} onChange={(e) => setBefore(e.target.value)} placeholder="Reading" /></Field>
          <Field label="After"><input type="number" min={0} max={2000} className={inputClass} value={after} onChange={(e) => setAfter(e.target.value)} placeholder="Reading" /></Field>
        </div>
        <p className="text-[11px] text-orange-900/70">Enter what the technician measured. Leave blank if it wasn't measured.</p>
      </div>

      <Field label="Notes and property access">
        <textarea rows={3} className={inputClass} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Gate codes, pets, dryer details…" />
      </Field>
      <p className="text-xs text-slate-500 flex items-center gap-2"><FileText size={14} />Confirmation: text {smsLabel || 'not sent'} · email {email || 'not sent'}{a.reminder ? ` · reminder ${a.reminder.sms === 'sent' || a.reminder.email === 'sent' ? 'sent' : 'not sent'}` : ''}</p>
      {error && <ErrorNote>{error}</ErrorNote>}
    </Modal>
  );
}
