import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle, Clock, Inbox, Mail, MessageSquare, Phone, ShieldCheck, XCircle } from 'lucide-react';
import { useDashboard, azDay, azTime } from './DashboardContext';
import { Banner, ErrorNote, Field, Modal, inputClass, primaryButton, secondaryButton } from './ui';
import { money } from '../../shared/domain.mjs';

const APPROVAL_STATUS: Record<string, [string, string]> = {
  pending: ['Waiting for a decision', 'bg-amber-50 text-amber-900 border-amber-300'],
  booked: ['Approved and booked', 'bg-emerald-50 text-emerald-800 border-emerald-300'],
  action_needed: ['Approved — check Jobber', 'bg-rose-50 text-rose-800 border-rose-300'],
  declined: ['Declined', 'bg-slate-100 text-slate-600 border-slate-300'],
  cancelled: ['Cancelled by customer', 'bg-slate-100 text-slate-600 border-slate-300'],
  expired: ['Expired', 'bg-slate-100 text-slate-500 border-slate-200'],
  failed: ["Approved, couldn't book", 'bg-rose-50 text-rose-800 border-rose-300'],
};
const REQUEST_STATUS: Record<string, string> = { new: 'New', in_progress: 'In progress', resolved: 'Resolved' };

function minutesLeft(expiresAt: number) {
  const m = Math.round((expiresAt - Date.now()) / 60_000);
  return m <= 0 ? 'expiring now' : `${m} min left`;
}

const TZ = 'America/Phoenix';
/** A time of day ("19:30") as the next such moment in Arizona time (Arizona has no daylight saving). */
function nextArizonaTime(hhmm: string, now = Date.now()) {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const at = Date.parse(`${ymd}T${hhmm}:00-07:00`);
  return Number.isFinite(at) && at < now - 10 * 60_000 ? at + 24 * 3600_000 : at;
}
/** About an hour from now, on the quarter hour, as "HH:MM" in Arizona time. */
function defaultArrival(now = Date.now()) {
  const t = Math.ceil((now + 60 * 60_000) / (15 * 60_000)) * 15 * 60_000;
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t);
}
const SMS_REASON: Record<string, string> = {
  emergency_texts_off: 'after-hours texts are not turned on yet',
  owner_alerts_off: 'turn on Owner booking alerts in Settings',
  sms_not_configured: 'texting is not configured',
  owner_consent_required: 'the owner alert number needs to agree to the current text terms in Settings',
};

function ApprovalModal({ approval: a, onClose }: { approval: any; onClose: () => void }) {
  const { data, mutate, can } = useDashboard();
  const canManage = can('inbox.view') && can('inbox.manage'), canViewFinance = can('finance.view');
  const namedUser = data.access?.role === 'master' || data.access?.role === 'member';
  const [name, setName] = useState(namedUser ? data.access?.name || '' : data.config.approver?.name || '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = a.status === 'pending';
  const afterHours = a.kind === 'after_hours';
  const technicians = data.technicians || [];
  const [arrival, setArrival] = useState(() => defaultArrival());
  const [techId, setTechId] = useState(() => technicians[0]?.id || '');
  const arrivalAt = afterHours ? nextArizonaTime(arrival) : null;
  const decide = async (decision: 'approve' | 'decline') => {
    if (!can('inbox.view') || !can('inbox.manage')) return;
    setBusy(true); setError('');
    try {
      const extra = afterHours && decision === 'approve' ? { arrivalAt, technicianId: techId } : {};
      const r = await mutate(`/api/admin/approvals/${encodeURIComponent(a.id)}`, { decision, approverName: name, note, ...extra }, 'POST', '');
      const status = r?.result?.status;
      if (decision === 'decline') onClose();
      else if (status === 'booked' || status === 'action_needed') onClose();
      else setError(r?.result?.failure || 'The visit could not be booked.');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal title={a.service} subtitle={<>{a.customer?.name} · requested {azDay(a.requestedAt)} {azTime(a.requestedAt)}</>} onClose={onClose}
      badge={<div className="bg-amber-500 text-white p-2 rounded-xl"><ShieldCheck size={20} /></div>}
      footer={pending && canManage ? (
        <>
          <span className="text-xs font-bold text-amber-800 flex items-center gap-1.5"><Clock size={14} />{minutesLeft(a.expiresAt)} — {afterHours ? 'the customer is waiting in the chat' : 'the time is held until then'}</span>
          <div className="space-y-2">
            <p className="text-xs text-slate-600 max-w-md">Completing this booking may send configured automatic customer and owner notifications. Existing consent and sending holds still apply.</p>
            <div className="flex gap-2.5">
              <button className={secondaryButton} disabled={busy} onClick={() => decide('decline')}>{afterHours ? "Can't make it" : 'Decline'}</button>
              <button className={primaryButton} disabled={busy || name.trim().length < 2 || (afterHours && (!arrival || !Number.isFinite(arrivalAt) || (!techId && technicians.length > 0)))} onClick={() => decide('approve')}>{busy ? 'Booking…' : afterHours ? 'Accept and book' : 'Approve and book'}</button>
            </div>
          </div>
        </>
      ) : <button className={secondaryButton} onClick={onClose}>Close</button>}>
      <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-sm text-amber-900 font-semibold flex gap-2"><AlertTriangle size={18} className="shrink-0" />{a.reason}</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
        <div className="space-y-1">
          <p className="text-xs font-extrabold text-slate-400">Arrival</p>
          {a.scheduledAt ? <>
            <p className="font-bold text-slate-900">{azDay(a.scheduledAt)}, {azTime(a.scheduledAt)}</p>
            <p className="text-slate-600">{a.durationMins} minutes · {a.technicianName}</p>
          </> : <>
            <p className="font-bold text-slate-900">After hours · you set the time</p>
            <p className="text-slate-600">{a.durationMins} minutes · on-call technician</p>
          </>}
        </div>
        <div className="space-y-1">
          <p className="text-xs font-extrabold text-slate-400">Customer</p>
          <p className="font-bold text-slate-900">{a.customer?.name}</p>
          <p className="text-slate-600"><a className="hover:text-orange-600" href={`tel:${a.customer?.phone}`}>{a.customer?.phone}</a>{a.customer?.email ? ` · ${a.customer.email}` : ''}</p>
          <p className="text-slate-600">{a.customer?.address}, {a.customer?.city} {a.customer?.zip}</p>
        </div>
      </div>
      <div className="rounded-2xl border border-slate-200 divide-y divide-slate-100 text-sm">
        {canViewFinance && (a.lineItems || []).map((l: any, i: number) => <div key={i} className="flex justify-between px-4 py-2"><span className="text-slate-600">{l.name}</span><span className="font-bold">{Number.isFinite(l.cents) ? money(l.cents) : '—'}</span></div>)}
        <div className="flex justify-between px-4 py-2 font-black"><span>Total</span><span>{canViewFinance ? Number.isFinite(a.totalCents) ? money(a.totalCents) : '—' : 'Restricted'}</span></div>
      </div>
      {a.concerns?.length > 0 && <p className="text-xs text-slate-600"><b>Customer said:</b> {a.concerns.join(' · ')}</p>}
      {a.notes && <p className="text-xs text-slate-600"><b>Notes:</b> {a.notes}</p>}
      {a.notified && (afterHours
        ? <p className="text-[11px] text-slate-400">Account admin text {a.notified.sms}{a.notified.smsReason && SMS_REASON[a.notified.smsReason] ? ` (${SMS_REASON[a.notified.smsReason]})` : ''} · email {a.notified.email}</p>
        : <p className="text-[11px] text-slate-400">Approver text {a.notified.sms} · email {a.notified.email}{a.notified.reason === 'not_configured' ? ' (add the approver phone and configure Twilio in Settings)' : ''}</p>)}
      {!canManage && <p className="text-sm text-slate-600">You have view-only access to the inbox.</p>}
      {pending && canManage ? (
        <div className="space-y-3 pt-2 border-t border-slate-100">
          <Field label="Your name" hint={data.config.approver?.name ? `The named approver is ${data.config.approver.name}. Your name is saved with the decision.` : 'Saved with the decision.'}>
            <input className={inputClass} value={name} disabled={namedUser || busy} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </Field>
          {afterHours && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Arrival time (Arizona)" hint={Number.isFinite(arrivalAt) ? `${azDay(arrivalAt as number)}, ${azTime(arrivalAt as number)}` : 'Choose a time.'}>
                <input type="time" step={900} className={inputClass} value={arrival} disabled={busy} onChange={(e) => setArrival(e.target.value)} />
              </Field>
              <Field label="Technician" hint={technicians.length ? 'Who is going.' : 'The on-call technician on file is used.'}>
                <select className={inputClass} value={techId} disabled={busy || !technicians.length} onChange={(e) => setTechId(e.target.value)}>
                  {technicians.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </Field>
            </div>
          )}
          <Field label="Note (optional)"><textarea rows={2} className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <p className="text-[11px] text-slate-500">{afterHours ? "Accepting books the visit at that time with the after-hours premium — into Jobber when it's connected — and the customer sees the confirmation in the chat. If you can't make it, they're offered our regular openings." : "Approving books the held time right away — into Jobber when it's connected."}</p>
        </div>
      ) : a.decision && (
        <p className="text-sm text-slate-700 pt-2 border-t border-slate-100">{a.decision.decision === 'approve' ? 'Approved' : 'Declined'} by <b>{a.decision.by}</b> on {azDay(a.decision.at)} {azTime(a.decision.at)}{a.decision.note ? ` — ${a.decision.note}` : ''}.{a.failure ? ` ${a.failure}` : ''}{a.appointmentId ? ` Appointment ${a.appointmentId}.` : ''}</p>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </Modal>
  );
}

function RequestModal({ request: r, onClose }: { request: any; onClose: () => void }) {
  const { mutate, can } = useDashboard();
  const canManage = can('inbox.view') && can('inbox.manage');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const set = async (status: string) => {
    if (!can('inbox.view') || !can('inbox.manage')) return;
    setBusy(true); setError('');
    try { await mutate(`/api/admin/requests/${encodeURIComponent(r.id)}`, { status }, 'PATCH', status === 'resolved' ? 'Marked resolved' : 'Updated'); onClose(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const transcript = (r.transcript || []).slice(-16);
  return (
    <Modal title={r.name} subtitle={<>{r.id} · {azDay(r.createdAt)} {azTime(r.createdAt)} · prefers {r.preference === 'email' ? 'email' : 'a call'}</>} onClose={onClose}
      badge={<div className="bg-orange-500 text-white p-2 rounded-xl"><MessageSquare size={20} /></div>}
      footer={<>
        <div className="flex gap-2"><a className={secondaryButton} href={`tel:${r.phone}`}><Phone size={15} />Call</a>{r.email && <a className={secondaryButton} href={`mailto:${r.email}`}><Mail size={15} />Email</a>}</div>
        {canManage && <div className="flex gap-2">
          {r.status === 'new' && <button className={secondaryButton} disabled={busy} onClick={() => set('in_progress')}>Mark in progress</button>}
          {r.status !== 'resolved' ? <button className={primaryButton} disabled={busy} onClick={() => set('resolved')}>Mark resolved</button> : <button className={secondaryButton} disabled={busy} onClick={() => set('new')}>Reopen</button>}
        </div>}
      </>}>
      {!canManage && <p className="text-sm text-slate-600">You have view-only access to the inbox.</p>}
      {r.safety && <div className="bg-rose-50 border border-rose-200 rounded-2xl p-3 text-sm font-bold text-rose-800 flex gap-2"><AlertTriangle size={18} />Safety flag: {r.safety}</div>}
      <div className="text-sm text-slate-700 space-y-1">
        <p><a className="font-bold hover:text-orange-600" href={`tel:${r.phone}`}>{r.phone}</a>{r.email ? ` · ${r.email}` : ''}{r.zip ? ` · ZIP ${r.zip}` : ''}</p>
        <p className="text-xs text-slate-500">{r.smsConsent ? 'OK to text' : 'No texting consent'}{r.route ? ` · asked about ${r.route}` : ''}</p>
      </div>
      <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4 text-sm text-slate-800 whitespace-pre-wrap">{r.message}</div>
      {(r.kind === 'availability' || r.kind === 'emergency') && <div className={`rounded-2xl p-4 border text-sm ${r.notification?.status === 'failed' ? 'bg-rose-50 border-rose-200 text-rose-800' : 'bg-blue-50 border-blue-200 text-blue-900'}`}><strong>{r.kind === 'emergency' ? 'Staff emergency alert' : 'Staff availability inquiry'} · {r.notification?.status === 'accepted' ? 'Text accepted by messaging provider' : r.notification?.status === 'failed' ? 'Staff text failed' : 'Text pending'}</strong><p className="mt-1">{r.notification?.recipient && `Recipient: ${r.notification.recipient}. `}{r.notification?.error || (r.kind === 'emergency' ? 'Sent when the customer gave their details, before any booking. Call them to follow up.' : 'Technician availability and appointment confirmation still need to be completed.')}</p>{r.notification?.messageId && <p className="text-xs font-mono mt-2">Message ID: {r.notification.messageId}</p>}</div>}
      {r.concerns?.length > 0 && <p className="text-xs text-slate-600"><b>Customer said:</b> {r.concerns.join(' · ')}</p>}
      {transcript.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-extrabold text-slate-400">Chat with BOB (latest)</p>
          <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
            {transcript.map((m: any, i: number) => (
              <p key={i} className={`text-xs leading-relaxed rounded-xl px-3 py-2 ${m.role === 'user' ? 'bg-orange-50 text-orange-950 ml-8' : 'bg-slate-100 text-slate-700 mr-8'}`}>{m.text}</p>
            ))}
          </div>
        </div>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
    </Modal>
  );
}

export function InboxPage({ focusApproval }: { focusApproval?: string | null }) {
  const { data, can } = useDashboard();
  const canViewFinance = can('finance.view');
  const [approvalId, setApprovalId] = useState<string | null>(focusApproval || null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  useEffect(() => { if (focusApproval) setApprovalId(focusApproval); }, [focusApproval]);

  const approvals = useMemo(() => [...data.approvals].sort((x, y) => (x.status === 'pending' ? 0 : 1) - (y.status === 'pending' ? 0 : 1) || y.requestedAt - x.requestedAt), [data.approvals]);
  const pendingApprovals = approvals.filter((a) => a.status === 'pending');
  const requests = useMemo(() => [...data.requests].sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt)), [data.requests]);
  const openRequests = requests.filter((r) => r.status !== 'resolved');
  const shownRequests = showDone ? requests : openRequests;
  const approval = approvals.find((a) => a.id === approvalId);
  const request = requests.find((r) => r.id === requestId);

  return (
    <div className="space-y-6 animate-in">
      <Banner eyebrow={<><Inbox size={14} />Needs a person</>} title="Approvals and customer requests">
        Visits that need a yes before booking (after-hours and same-day emergency service, and 5 PM overflow), and customers who asked the team to follow up.
      </Banner>

      <section className="bg-white rounded-3xl border border-slate-200/90 shadow-sm p-5 sm:p-6 space-y-4">
        <div className="flex items-center justify-between gap-3 pb-3 border-b border-slate-100">
          <div>
            <h3 className="font-extrabold text-slate-900 text-base flex items-center gap-2"><ShieldCheck size={18} className="text-amber-500" />Approvals {pendingApprovals.length > 0 && <span className="px-2 py-0.5 text-[11px] font-bold rounded-full bg-rose-500 text-white">{pendingApprovals.length}</span>}</h3>
            <p className="text-xs text-slate-500 font-medium">The customer is waiting in the chat while the time is held.{data.config.approver?.name ? ` Approver: ${data.config.approver.name}.` : ' Add the approver in Settings so they get a text.'}</p>
          </div>
        </div>
        {!approvals.length && <p className="text-sm text-slate-500 py-4 text-center">No approval requests yet.</p>}
        <div className="divide-y divide-slate-100">
          {approvals.slice(0, 30).map((a) => {
            const [label, cls] = APPROVAL_STATUS[a.status] || [a.status, 'bg-slate-100 text-slate-600 border-slate-200'];
            return (
              <button key={a.id} onClick={() => setApprovalId(a.id)} className="w-full text-left py-3.5 px-2 flex flex-col sm:flex-row sm:items-center justify-between gap-2 hover:bg-slate-50 rounded-xl">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap"><span className="font-extrabold text-sm text-slate-900">{a.customer?.name}</span><span className="text-xs font-bold text-slate-700 bg-slate-100 px-2 py-0.5 rounded-md">{a.service}</span><span className="text-xs font-extrabold text-orange-600">{canViewFinance ? Number.isFinite(a.totalCents) ? money(a.totalCents) : '—' : 'Restricted'}</span></div>
                  <p className="text-xs text-slate-500 mt-0.5">{a.scheduledAt ? `${azDay(a.scheduledAt)} ${azTime(a.scheduledAt)}` : 'After hours · time not set'} · {a.customer?.city} · {a.reason}</p>
                </div>
                <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-black rounded-full border shrink-0 self-start sm:self-auto ${cls}`}>
                  {a.status === 'pending' ? <Clock size={12} /> : a.status === 'booked' ? <CheckCircle size={12} /> : <XCircle size={12} />}{label}{a.status === 'pending' ? ` · ${minutesLeft(a.expiresAt)}` : ''}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="bg-white rounded-3xl border border-slate-200/90 shadow-sm p-5 sm:p-6 space-y-4">
        <div className="flex items-center justify-between gap-3 pb-3 border-b border-slate-100">
          <div>
            <h3 className="font-extrabold text-slate-900 text-base flex items-center gap-2"><MessageSquare size={18} className="text-orange-500" />Customer requests {openRequests.length > 0 && <span className="px-2 py-0.5 text-[11px] font-bold rounded-full bg-rose-500 text-white">{openRequests.length}</span>}</h3>
            <p className="text-xs text-slate-500 font-medium">Callback and question requests from the chat are saved here for the team.</p>
          </div>
          <label className="text-xs font-bold text-slate-600 flex items-center gap-2 cursor-pointer shrink-0"><input type="checkbox" className="accent-orange-500" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />Show resolved</label>
        </div>
        {!shownRequests.length && <p className="text-sm text-slate-500 py-4 text-center">{requests.length ? 'Everything is resolved.' : 'No requests yet. When a customer asks for a callback, it lands here.'}</p>}
        <div className="divide-y divide-slate-100">
          {shownRequests.slice(0, 60).map((r) => (
            <button key={r.id} onClick={() => setRequestId(r.id)} className="w-full text-left py-3.5 px-2 flex flex-col sm:flex-row sm:items-center justify-between gap-2 hover:bg-slate-50 rounded-xl">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap"><span className="font-extrabold text-sm text-slate-900">{r.name}</span>{r.safety && <span className="text-[10px] font-black text-rose-700 bg-rose-50 border border-rose-200 px-1.5 rounded">Safety</span>}<span className="text-xs text-slate-500">{azDay(r.createdAt)} {azTime(r.createdAt)}</span></div>
                <p className="text-xs text-slate-600 mt-0.5 line-clamp-1">{r.message}</p>
              </div>
              <span className={`text-[11px] font-black px-2.5 py-1 rounded-full border shrink-0 self-start sm:self-auto ${r.status === 'new' ? 'bg-orange-50 text-orange-800 border-orange-300' : r.status === 'in_progress' ? 'bg-sky-50 text-sky-800 border-sky-300' : 'bg-slate-100 text-slate-500 border-slate-200'}`}>{REQUEST_STATUS[r.status] || r.status}</span>
            </button>
          ))}
        </div>
      </section>

      {approval && <ApprovalModal approval={approval} onClose={() => setApprovalId(null)} />}
      {request && <RequestModal request={request} onClose={() => setRequestId(null)} />}
    </div>
  );
}
