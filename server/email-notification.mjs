import { createHash } from 'node:crypto';
const KINDS = new Set(['appointment_confirmed', 'approval_pending', 'booking_report']);
const normalizeRecipient = value => {
  const address = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return address.length <= 254 && /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(address) ? address : null;
};

/** Durable at-most-once attempt, NOT guaranteed delivery. A permanent unique claim
 * precedes the provider call. Neither changed recipients nor ambiguous timeouts
 * allow automatic resend. Missing capability does not consume an attempt.
 * Caller supplies only a confirmed appointment or pending approval's stable ID.
 */
export async function deliverEmailOnce({ store, kind, id, to, enabled, configured, sendEmail, message = {}, clock = Date.now }) {
  if (!enabled || !configured || typeof sendEmail !== 'function') return { status: 'skipped', reason: 'disabled_or_not_configured' };
  const recipient = normalizeRecipient(to);
  if (!KINDS.has(kind) || typeof id !== 'string' || !id.trim() || id.length > 200 || !recipient) return { status: 'rejected', reason: 'invalid_notification' };
  const key = `email-notification:${kind}:${id}`;
  const record = { status: 'attempting', kind, recordId: id, recipientHash: createHash('sha256').update(recipient).digest('hex'), provider: 'SendGrid', at: clock(), delivery: 'not_confirmed' };
  try {
    const rows = await store.db.query('insert into bob.kv(key,value,expires) values($1,$2::jsonb,null) on conflict (key) do nothing returning key', [key, JSON.stringify(record)]);
    if (!rows.length) {
      let prior = null;
      try { prior = await store.kvGet(key); } catch {}
      return { status: 'already_attempted', prior };
    }
  } catch { return { status: 'failed_or_uncertain', reason: 'claim_failed', delivery: 'not_confirmed' }; }
  let result;
  try {
    const response = await sendEmail({ ...message, to: recipient });
    result = response?.rejected === true
      ? { ...record, status: 'rejected', reason: 'provider_rejected' }
      : response?.status === 'accepted'
        ? { ...record, status: 'accepted', messageId: response?.messageId || response?.id || null }
        : { ...record, status: 'failed_or_uncertain', reason: 'invalid_provider_response' };
  } catch (error) {
    result = { ...record, status: (error?.rejected === true || error?.code === 'SENDGRID_REJECTED' && error?.uncertain === false) ? 'rejected' : 'failed_or_uncertain', reason: (error?.rejected === true || error?.code === 'SENDGRID_REJECTED' && error?.uncertain === false) ? 'provider_rejected' : 'provider_request_failed' };
  }
  // Never clear the permanent claim, propagate provider detail, or roll back booking.
  try { await store.kvSet(key, result); } catch {}
  try { await store.log(`email_notification.${result.status}`, { kind, recordId: id, provider: 'SendGrid', status: result.status, delivery: result.delivery }, { level: result.status === 'accepted' ? 'info' : 'warning' }); } catch {}
  return result;
}
