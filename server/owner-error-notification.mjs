import { normalizePhone } from '../shared/domain.mjs';
import { ownerErrorSms } from './messages.mjs';
import { isReadOnlyPreview } from './preview.mjs';

const BOOKING_KINDS = new Set(['booking_action_needed', 'booking_jobber_failed']);
const CONNECTIONS = new Set(['jobber', 'verification', 'assistant', 'email']);
const CLAIM_SQL = 'insert into bob.kv(key,value,expires) values($1,$2::jsonb,null) on conflict (key) do nothing returning key';
const SIX_HOURS = 21_600_000;
const arizonaDay = at => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at)).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

/** Durable at-most-once error alerts. Claims and daily slots survive failed or
 * uncertain sends. No provider failure, database failure or logging failure may
 * change the booking or the provider operation that prompted this notification. */
export async function notifyOwnerError({ store, kind, details = {}, ownerConsent, smsReady, sendSms, provider = 'Twilio', env = {}, clock = Date.now } = {}) {
  const readOnly = () => isReadOnlyPreview(env);
  // Preview is inert, including observability: recording a skip would write to
  // the live activity store. Do not inspect settings, consent or claims either.
  if (readOnly()) return { status: 'skipped', reason: 'read_only_preview' };
  const booking = BOOKING_KINDS.has(kind), connection = CONNECTIONS.has(kind);
  const metadata = { kind: booking || connection ? kind : 'unsupported', ...(connection ? { name: kind } : {}) };
  const previewResult = () => ({ ...metadata, status: 'skipped', reason: 'read_only_preview' });
  const log = async result => {
    if (readOnly()) return result;
    try { await store.log(`owner_error_alert.${result.status}`, result, { level: result.status === 'failed_or_uncertain' ? 'warning' : 'info' }); } catch {}
    return result;
  };
  const skip = reason => log({ ...metadata, status: 'skipped', reason });
  let key, record;
  const persist = async result => {
    if (readOnly()) return result;
    try { await store.kvSet(key, result); } catch {}
    return log(result);
  };
  const gate = async expectedPhone => {
    if (readOnly()) return { reason: 'read_only_preview' };
    const config = await store.config();
    if (readOnly()) return { reason: 'read_only_preview' };
    if (config.ownerErrorSmsEnabled !== true) return { reason: 'disabled' };
    const phone = normalizePhone(config.bookingOwnerSmsPhone);
    if (!phone) return { reason: 'not_configured' };
    if (expectedPhone && phone !== expectedPhone) return { reason: 'recipient_changed' };
    const allowed = await ownerConsent.allows(phone);
    if (readOnly()) return { reason: 'read_only_preview' };
    if (allowed !== true) return { reason: 'owner_consent_required' };
    const ready = await smsReady(config);
    if (readOnly()) return { reason: 'read_only_preview' };
    if (ready !== true) return { reason: 'sms_unavailable' };
    return { phone };
  };
  try {
    if (!booking && !connection) return skip('unsupported_kind');
    if (booking) {
      if (typeof details.appointmentId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(details.appointmentId)) return skip('invalid_reference');
      metadata.appointmentId = details.appointmentId;
    }
    const at = details.at ?? clock();
    if (!Number.isFinite(at) || !Number.isFinite(new Date(at).getTime())) return skip('invalid_time');
    const initial = await gate();
    if (initial.reason) return skip(initial.reason);
    const text = ownerErrorSms(kind, { appointmentId: metadata.appointmentId, at });
    key = booking ? `owner-error-sms:booking:${kind}:${metadata.appointmentId}` : `owner-error-sms:connection:${kind}:${Math.floor(at / SIX_HOURS)}`;
    record = { ...metadata, provider, at, status: 'attempting' };
    let claimed;
    if (readOnly()) return previewResult();
    try { claimed = await store.db.query(CLAIM_SQL, [key, JSON.stringify(record)]); }
    catch { return skip('claim_failed'); }
    if (readOnly()) return previewResult();
    if (!claimed.length) return skip('already_attempted');

    if (booking) {
      // Preserve the kind-specific evidence while enforcing one attempt per
      // booking across both failure types, including concurrent callers.
      let bookingClaim;
      if (readOnly()) return previewResult();
      try { bookingClaim = await store.db.query(CLAIM_SQL, [`owner-error-sms:booking-any:${metadata.appointmentId}`, JSON.stringify(record)]); }
      catch { return persist({ ...record, status: 'skipped', reason: 'claim_failed' }); }
      if (readOnly()) return previewResult();
      if (!bookingClaim.length) return persist({ ...record, status: 'skipped', reason: 'booking_already_attempted' });
    }

    // Unique numbered slots enforce the shared daily cap across processes and
    // both database adapters. Reservations are never released for a retry.
    let reservedDay;
    for (let dayChecks = 0; dayChecks < 3; dayChecks++) {
      const day = arizonaDay(clock());
      if (reservedDay !== day) {
        let slot = false;
        for (let number = 1; number <= 10; number++) {
          if (readOnly()) return previewResult();
          const rows = await store.db.query(CLAIM_SQL, [`owner-error-sms:daily:${day}:${number}`, JSON.stringify({ key, at, status: 'reserved' })]);
          if (readOnly()) return previewResult();
          if (rows.length) { slot = true; break; }
        }
        if (!slot) return persist({ ...record, status: 'skipped', reason: 'daily_cap' });
        reservedDay = day;
      }
      const latest = await gate(initial.phone);
      if (latest.reason) return persist({ ...record, status: 'skipped', reason: latest.reason });
      // If an awaited check crossed Arizona midnight, reserve in the new day
      // before sending too. This may under-use a day, never exceed its cap.
      if (arizonaDay(clock()) !== reservedDay) continue;
      let result;
      try {
        const response = await sendSms(latest.phone, text, { beforeSend: async () => {
          // The transport invokes this after its own awaited configuration reads,
          // immediately before dispatch. A late withdrawal cannot slip through.
          const dispatch = await gate(initial.phone);
          if (dispatch.reason || arizonaDay(clock()) !== reservedDay) throw new Error('Owner error alert is no longer eligible.');
        } });
        const messageId = response?.messageId || response?.id;
        if (typeof messageId !== 'string' || !messageId.trim() || !['accepted', 'queued', 'sending', 'sent', 'delivered'].includes(response?.status)) throw new Error('Unconfirmed SMS acceptance.');
        result = { ...record, status: 'accepted', reason: 'provider_accepted', delivery: 'not_confirmed' };
      } catch {
        result = { ...record, status: 'failed_or_uncertain', reason: 'provider_request_failed', delivery: 'not_confirmed' };
      }
      return persist(result);
    }
    return persist({ ...record, status: 'skipped', reason: 'clock_changed' });
  } catch {
    return key && record ? persist({ ...record, status: 'skipped', reason: 'unavailable' }) : skip('unavailable');
  }
}
