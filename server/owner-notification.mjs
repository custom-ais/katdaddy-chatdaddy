import { normalizePhone } from '../shared/domain.mjs';

/** At-most-once owner alert. The durable claim precedes the external request, so
 * a crash/timeout cannot cause an automatic duplicate. This deliberately favors
 * no duplicates over guaranteed delivery; uncertain attempts need office review.
 * The caller supplies the explicitly selected SMS provider, never Verify.
 */
export async function notifyBookingOwner({ store, appointment, config, sendSms, provider, clock = Date.now }) {
  if (!config.bookingOwnerSmsEnabled || appointment.status !== 'confirmed' || appointment.source !== 'ai_bot') return { status: 'skipped' };
  const phone = normalizePhone(config.bookingOwnerSmsPhone);
  if (!phone || !appointment.id || !Number.isFinite(Date.parse(appointment.scheduledAt))) return { status: 'skipped', reason: 'not_configured' };
  const key = `owner-booking-sms:${appointment.id}`;
  const record = { status: 'attempting', appointmentId: appointment.id, provider, at: clock() };
  try {
    // Atomic unique-key claim: unlike a TTL lock, a delayed worker cannot reacquire
    // this claim after expiry. NULL expiry keeps it through normal cleanup.
    const rows = await store.db.query('insert into bob.kv(key,value,expires) values($1,$2::jsonb,null) on conflict (key) do nothing returning key', [key, JSON.stringify(record)]);
    if (!rows.length) return { status: 'already_attempted' };
  } catch {
    return { status: 'failed', reason: 'claim_failed' }; // Never send without durable deduplication.
  }
  const when = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Phoenix', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(appointment.scheduledAt));
  const clean = value => String(value || '').replace(/[\r\n\t]+/g, ' ').slice(0, 180);
  const text = `ChatDaddy booked an appointment: ${clean(appointment.customerName)} — ${clean(appointment.package)}. ${when} Arizona time. Ref ${clean(appointment.id)}. This booking is confirmed; no approval is needed.`;
  let result;
  try {
    const response = await sendSms(phone, text);
    result = { ...record, status: 'accepted', messageId: response?.messageId || response?.id || null, delivery: 'not_confirmed' };
  } catch {
    result = { ...record, status: 'failed_or_uncertain', delivery: 'not_confirmed', reason: 'provider_request_failed' };
  }
  // A persistence/logging failure must never undo a real booking or clear its claim.
  try { await store.kvSet(key, result); } catch {}
  try { await store.log(`owner_notification.${result.status}`, result, { level: result.status === 'accepted' ? 'info' : 'warning' }); } catch {}
  return result;
}
