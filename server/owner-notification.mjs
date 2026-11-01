import { ownerBookingSms } from './messages.mjs';
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
  let result;
  try {
    const text = ownerBookingSms(appointment, config);
    const response = await sendSms(phone, text);
    const messageId = response?.messageId || response?.id;
    if (typeof messageId !== 'string' || !messageId.trim() || !['accepted', 'queued', 'sending', 'sent', 'delivered'].includes(response?.status)) throw new Error('SMS acceptance could not be confirmed.');
    result = { ...record, status: 'accepted', messageId, delivery: 'not_confirmed' };
  } catch {
    result = { ...record, status: 'failed_or_uncertain', delivery: 'not_confirmed', reason: 'provider_request_failed' };
  }
  // A persistence/logging failure must never undo a real booking or clear its claim.
  try { await store.kvSet(key, result); } catch {}
  try { await store.log(`owner_notification.${result.status}`, result, { level: result.status === 'accepted' ? 'info' : 'warning' }); } catch {}
  return result;
}
