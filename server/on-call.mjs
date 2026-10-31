import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { normalizePhone } from '../shared/domain.mjs';
import { emailLayout, escapeHtml as esc } from './email-layout.mjs';

const WINDOW = 5 * 60_000, KEEP = 60 * 86400;
const fingerprint = (data) => createHash('sha256').update(JSON.stringify({ route: data.route, package: data.package, property: data.property, addOns: data.addOns, name: data.contact?.name, phone: data.contact?.phone, address: data.contact?.address, city: data.contact?.city, zip: data.contact?.zip })).digest('hex');
const publicState = (r) => ({ id: r.id, status: r.status, expiresAt: r.expiresAt, acceptedBy: r.acceptedBy?.name || '', ticketId: r.ticketId || null, reason: r.reason || '' });
export function createOnCall({ store, lc, email, env = {}, clock = Date.now }) {
  const signingKey = env.BOB_SECRET_KEY || env.CRON_SECRET;
  const key = (id) => `oncall:request:${id}`;
  const save = (r) => store.kvSet(key(r.id), r, KEEP);
  const get = (id) => store.kvGet(key(id));
  const sign = (payload) => createHmac('sha256', signingKey).update(payload).digest('base64url');
  const tokenFor = (r, t) => {
    const payload = Buffer.from(JSON.stringify({ id: r.id, tech: t.id, expires: r.expiresAt })).toString('base64url');
    return `${payload}.${sign(payload)}`;
  };
  function readToken(token) {
    if (!signingKey || typeof token !== 'string' || token.length > 1000) return null;
    const [payload, mac, extra] = token.split('.');
    if (extra || !payload || !mac) return null;
    const expected = Buffer.from(sign(payload)), actual = Buffer.from(mac);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    try { const p = JSON.parse(Buffer.from(payload, 'base64url')); return p.expires > clock() ? p : null; } catch { return null; }
  }
  async function record(r, summary) {
    await store.audit(`oncall.${r.status}`, r.id);
    await store.observer.record(r.session, 'operation', { operation: 'On-call availability', summary, reference: r.ticketId || r.id }).catch(() => {});
  }
  async function emailTicket(r, ticket) {
    if (r.emailStatus && r.emailStatus !== 'queued') return;
    if (!email?.configured) { r.emailStatus = 'queued'; await save(r); return; }
    const subject = `BOB urgent request: ${ticket.name} · ${ticket.city || ticket.zip} · ${ticket.id}`;
    const text = `Emergency / same-day request needs follow-up\n\nTicket: ${ticket.id}\nCustomer: ${ticket.name}\nPhone: ${ticket.phone}\nEmail: ${ticket.email || 'Not supplied'}\nAddress: ${ticket.address}, ${ticket.city}, AZ ${ticket.zip}\nService: ${r.service}\nOutcome: ${r.reason}\n${r.acceptedBy ? `Accepted by: ${r.acceptedBy.name}\n` : ''}Request: ${ticket.message}\n\nNo appointment has been confirmed. Review this support ticket in BOB's admin dashboard.`;
    const html = emailLayout({ preheader: 'Urgent availability request needs office follow-up', eyebrow: 'BOB SUPPORT TICKET', title: 'A customer needs follow-up', subtitle: ticket.id, body: `<p style="line-height:1.7;color:#34465b">${esc(text).replace(/\n/g, '<br>')}</p>`, footer: 'Dryer Vent Squad · West Valley' });
    // Persist before SMTP: an ambiguous send is reviewed, never blindly repeated.
    r.emailStatus = 'sending'; await save(r);
    try {
      await email.send({ to: 'westvalley@dryerventsquad.com', subject, html, text, messageId: `<bob-${r.id}@dryerventsquad.com>` });
      r.emailStatus = 'sent'; await save(r);
    } catch {
      r.emailStatus = 'uncertain'; await save(r);
      await store.kvSet('diag:oncall-email', { at: clock(), message: `Check the Sent folder for support ticket ${ticket.id}; its email result is uncertain.` });
    }
    ticket.emailNotification = r.emailStatus; await store.updateRequest(ticket);
  }
  async function ticket(r, reason) {
    r.status = 'follow_up'; r.reason = reason;
    const idem = `oncall-ticket-${r.id}`;
    let request = (await store.requestByIdem(idem))?.data;
    if (!request) {
      request = { id: `REQ-${r.id}`, ...r.customer, message: `${r.service}: ${r.notes || 'Emergency / same-day availability requested.'}\n${reason}`, preference: r.customer.email ? 'email' : 'phone', status: 'new', urgent: true, source: 'on_call', onCallId: r.id, assignedTo: r.acceptedBy?.id || null, createdAt: new Date(clock()).toISOString() };
      await store.insertRequest(request, r.session, idem);
    }
    r.ticketId = request.id; await save(r);
    await emailTicket(r, request);
    await record(r, `Support ticket ${request.id} created: ${reason}`);
    return r;
  }
  async function expire(r) {
    if (['pending', 'accepted'].includes(r.status)) {
      const saved = await store.loadSession(r.session);
      if (saved?.bookingId) {
        r.status = 'booked'; r.appointmentId = saved.bookingId; await save(r);
        return r;
      }
    }
    if (r.status === 'pending' && clock() >= r.expiresAt) return ticket(r, 'Our team members are taking care of other customers at the moment. No technician accepted within five minutes.');
    if (r.status === 'accepted' && clock() >= r.grantExpiresAt) return ticket(r, 'A technician accepted, but an appointment was not completed within the availability window.');
    return r;
  }
  async function locked(id, fn) {
    if (!(await store.lock(`oncall:${id}`, 90))) throw new Error('This request is being updated. Please try again shortly.');
    try { return await fn(); } finally { await store.unlock(`oncall:${id}`); }
  }
  async function start({ session, data, config, service, origin }) {
    return locked(`session:${session}`, async () => {
      const oldId = await store.kvGet(`oncall:session:${session}`);
      if (oldId) { const old = await current(oldId, session, data); if (old) return old; }
      const technicians = (await store.technicians()).filter((t) => t.onCall === true && t.status !== 'off_duty' && normalizePhone(t.phone) && config.activeTechnicianIds.includes(t.id) && (config.scheduleSource !== 'Jobber' || t.jobberUserId));
      const r = { id: `URG-${randomBytes(6).toString('hex').toUpperCase()}`, session, fingerprint: fingerprint(data), status: 'pending', createdAt: clock(), expiresAt: clock() + WINDOW, service, customer: { ...data.contact }, notes: [...(data.concerns || []), data.contact.notes || ''].filter(Boolean).join('\n'), targets: technicians.map((t) => ({ id: t.id, name: t.name, phone: normalizePhone(t.phone), outcome: 'waiting' })) };
      return locked(r.id, async () => {
      await save(r); await store.kvSet(`oncall:session:${session}`, r.id, KEEP);
      if (!config.phoneServiceReady || !lc.configured || !signingKey || !/^https:\/\//.test(origin || '')) return publicState(await ticket(r, 'On-call texting is not connected yet. The office will follow up about a future visit.'));
      if (!technicians.length) return publicState(await ticket(r, 'No on-call technician is currently available to receive this request.'));
      await Promise.all(r.targets.map(async (t) => {
        try {
          const contactId = await lc.upsertContact({ name: t.name, phone: t.phone, tags: ['bob-on-call'] });
          await lc.sendSms(contactId, `BOB: Can you take ${service} today in ${r.customer.city || r.customer.zip}? Respond within 5 minutes: ${origin}/api/on-call/respond?token=${tokenFor(r, t)}\nAccepting checks availability; it does not book the appointment.`);
          t.delivery = 'sent';
        } catch { t.delivery = 'failed'; t.outcome = 'unreachable'; }
      }));
      await save(r);
      if (!r.targets.some((t) => t.delivery === 'sent')) return publicState(await ticket(r, 'We could not reach an on-call technician by text. The office will follow up.'));
      await record(r, `Texted ${r.targets.filter((t) => t.delivery === 'sent').length} on-call technician(s); waiting up to five minutes.`);
      return publicState(r);
      });
    });
  }
  async function current(id, session, data) {
    return locked(id, async () => {
      const r = await get(id); if (!r || r.session !== session) return null;
      if (data && ['pending', 'accepted'].includes(r.status) && r.fingerprint !== fingerprint(data)) await ticket(r, 'The customer changed the service or contact details after requesting availability. The office will follow up to verify the request.');
      await expire(r); return publicState(r);
    });
  }
  async function grant(id, session, data) {
    if (!id) return null;
    const r = await get(id);
    return r?.session === session && r.status === 'accepted' && r.grantExpiresAt > clock() && (!data || r.fingerprint === fingerprint(data)) ? { id: r.id, technicianId: r.acceptedBy.id, name: r.acceptedBy.name, at: r.acceptedAt, expiresAt: r.grantExpiresAt } : null;
  }
  async function respond(token, decision) {
    const p = readToken(token); if (!p) throw new Error('This response link has expired or is invalid.');
    return locked(p.id, async () => {
      const r = await get(p.id);
      const t = r?.targets.find((x) => x.id === p.tech);
      if (!r || !t || r.expiresAt !== p.expires) throw new Error('Request not found.');
      await expire(r);
      if (r.status !== 'pending') return { message: r.status === 'accepted' ? 'Another response has already been recorded. This request is no longer open.' : 'This request is no longer open.' };
      if (!['accept', 'decline'].includes(decision)) throw new Error('Choose accept or decline.');
      if (t.outcome !== 'waiting') return { message: 'Your response was already recorded.' };
      t.outcome = decision;
      if (decision === 'accept') {
        const config = await store.config();
        const tech = (await store.technicians()).find((x) => x.id === t.id);
        if (!config.phoneServiceReady || !tech?.onCall || tech.status === 'off_duty' || !config.activeTechnicianIds.includes(t.id)) throw new Error('On-call availability has changed. Please contact the office.');
        r.status = 'accepted'; r.acceptedBy = { id: t.id, name: t.name }; r.acceptedAt = clock(); r.grantExpiresAt = clock() + 30 * 60_000;
      }
      await save(r);
      if (r.status === 'pending' && r.targets.every((x) => x.outcome !== 'waiting')) await ticket(r, 'Our team members are taking care of other customers at the moment. No on-call technician could take the appointment.');
      await record(r, `${t.name} ${decision === 'accept' ? 'accepted the availability request; a fresh calendar check and customer confirmation are still required.' : 'could not take this request.'}`);
      return { message: decision === 'accept' ? 'Availability accepted. BOB will check your calendar and let the customer choose a time. No appointment is booked until they confirm.' : 'Your response was recorded. Thank you.' };
    });
  }
  async function page(token) {
    const p = readToken(token); if (!p) return '<h1>This response link has expired or is invalid.</h1>';
    const r = await get(p.id);
    if (!r || r.status !== 'pending') return '<h1>This request is no longer open.</h1>';
    return `<h1>Can you take this visit today?</h1><p>${esc(r.service)}</p><p>${esc(r.customer.address)}, ${esc(r.customer.city)}, AZ ${esc(r.customer.zip)}</p><p>Reply by ${esc(new Date(r.expiresAt).toLocaleTimeString('en-US', { timeZone: 'America/Phoenix', hour: 'numeric', minute: '2-digit' }))} Arizona time. BOB will check your calendar before offering a time. Accepting does not create a booking.</p><form method="post"><input type="hidden" name="token" value="${esc(token)}"><button name="decision" value="accept">I can take it</button> <button name="decision" value="decline">I’m unavailable</button></form>`;
  }
  async function sweep() {
    const rows = await store.db.query("select value from bob.kv where key like 'oncall:request:%' and ((value->>'status'='pending' and (value->>'expiresAt')::bigint<=$1) or (value->>'status'='accepted' and (value->>'grantExpiresAt')::bigint<=$1) or value->>'emailStatus'='queued') order by (value->>'createdAt')::bigint limit 10", [clock()]);
    let processed = 0;
    await Promise.all(rows.map(async (row) => {
      await locked(row.value.id, async () => {
        const r = await get(row.value.id); if (!r) return;
        await expire(r);
        if (r.emailStatus === 'queued' && r.ticketId) { const t = (await store.requestByIdem(`oncall-ticket-${r.id}`))?.data; if (t) await emailTicket(r, t); }
        processed++;
      }).catch(() => {});
    }));
    return { processed };
  }
  async function duringBooking(id, session, work) {
    if (!id) return work();
    return locked(id, async () => {
      const result = await work(), r = await get(id);
      if (r?.session === session && result.appt) {
        r.status = 'booked'; r.appointmentId = result.appt.id; await save(r);
        if (r.ticketId) { const request = (await store.requestByIdem(`oncall-ticket-${r.id}`))?.data; if (request) { request.status = result.pending ? 'in_progress' : 'resolved'; request.appointmentId = result.appt.id; await store.updateRequest(request); } }
        await record(r, `Appointment ${result.appt.id} recorded; status ${result.appt.status}.`);
      }
      return result;
    });
  }
  async function noOpening(id, session) {
    return locked(id, async () => { const r = await get(id); if (r?.session !== session || r.status !== 'accepted') return; await ticket(r, 'The technician responded, but no same-day opening fits the live schedule and travel rules. The office will help arrange another option.'); });
  }
  return { start, current, grant, respond, page, sweep, duringBooking, noOpening };
}
