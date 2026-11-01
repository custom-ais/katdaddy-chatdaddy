// Twilio Verify state is scoped to this booking conversation and exact destination.
import { createHash } from 'node:crypto';
const hash = (s) => createHash('sha256').update(s).digest('hex');
const TTL = 10 * 60_000, VERIFIED_FOR = 6 * 3_600_000;
export function createVerification({ store, twilio, clock, fail }) {
  const destination = (data, channel) => channel === 'email' ? String(data.contact?.email || '').trim().toLowerCase() : data.contact?.phone || '';
  const channels = (data) => ['sms', ...(data.contact?.email ? ['email'] : [])];
  const verified = (data) => {
    const v = data.verifiedContact;
    return Boolean(v && ['sms', 'email'].includes(v.channel) && v.to === destination(data, v.channel) && clock() - v.at < VERIFIED_FOR);
  };
  const info = (data, extra = {}) => ({ required: true, codeLength: 4, available: Boolean(twilio?.verifyConfigured), channels: channels(data), sent: false, chooseChannel: true, ...extra });
  const pendingInfo = data => {
    const v = data.verification;
    if (!v || v.provider !== 'twilio' || v.to !== destination(data, v.channel) || v.expires <= clock()) return null;
    const to = v.channel === 'sms' ? `•••${v.to.slice(-4)}` : `${v.to[0]}•••@${v.to.split('@')[1]}`;
    return { sent: true, reused: true, chooseChannel: false, channel: v.channel, to, expiresAt: v.expires };
  };
  async function locked(token, fn) {
    if (!await store.lock(`verification:${token}`, 30)) fail(409, 'A verification request is in progress. Please wait.');
    try {
      const data = await store.loadSession(token);
      if (!data) fail(401, 'This conversation expired. Start again.');
      if (!['verify','slots'].includes(data.stage)) fail(409, 'Enter your contact details first.');
      return await fn(data);
    } finally { await store.unlock(`verification:${token}`); }
  }
  async function send(token, channel) {
    return locked(token, async data => {
      if (!twilio?.verifyConfigured) fail(503, 'Verification is not configured. Please contact the office.');
      if (!channels(data).includes(channel)) fail(400, 'Choose text message or enter an email address first.');
      const to = destination(data, channel);
      if (!to) fail(400, 'Enter your contact details first.');
      const now = clock(), last = data.verifyLastAttempt;
      if (last != null && now - last < 30_000) return info(data, { channel, ...pendingInfo(data), retryInSeconds: Math.ceil((30_000 - (now - last)) / 1000) });
      // Destination counter also spans new conversations; count failed/uncertain sends.
      if (!await store.rateHit(`verify-destination:${hash(`${channel}:${to}`)}`, 4, 3_600_000) || !await store.rateHit(`verify-session:${token}`, 6, 3_600_000)) fail(429, 'Too many codes requested. Please wait an hour or contact the office.');
      data.verifyLastAttempt = now;
      delete data.verification; delete data.verifiedContact; delete data.phoneVerified;
      data.stage = 'verify';
      await store.releaseHolds(token);
      await store.saveSession(token, data);
      let result;
      try { result = await twilio.sendVerification({ to, channel }); }
      catch { fail(502, 'The code could not be sent. Please wait before retrying or contact the office.'); }
      if (!result?.sid || result.status !== 'pending') fail(502, 'The verification service did not accept the request.');
      data.verification = { provider: 'twilio', codeLength: 4, sid: result.sid, channel, to, expires: now + TTL, attempts: 0 };
      await store.saveSession(token, data);
      const masked = channel === 'sms' ? `•••${to.slice(-4)}` : `${to[0]}•••@${to.split('@')[1]}`;
      return info(data, { sent: true, chooseChannel: false, channel, to: masked, expiresAt: now + TTL });
    });
  }
  async function check(token, code) {
    return locked(token, async data => {
      const v = data.verification;
      if (!v || v.provider !== 'twilio' || v.to !== destination(data, v.channel)) fail(409, 'Send a new code first.');
      if (clock() >= v.expires) fail(410, 'That code expired. Send a new one.');
      if (v.attempts >= 5) fail(429, 'Too many tries. Send a new code.');
      v.attempts++;
      await store.saveSession(token, data); // Failed provider calls count too.
      if (!/^\d{4}$/.test(String(code || ''))) fail(400, 'Enter the four-digit code.');
      let result;
      try { result = await twilio.checkVerification({ sid: v.sid, code: String(code) }); }
      catch { fail(502, 'Verification could not be checked. Please try again or contact the office.'); }
      if (result?.status !== 'approved') fail(400, 'That code does not match. Please try again.');
      data.verifiedContact = { channel: v.channel, to: v.to, at: clock() };
      if (v.channel === 'sms') data.phoneVerified = { phone: v.to, at: clock() };
      else delete data.phoneVerified;
      delete data.verification;
      data.stage = 'slots';
      await store.saveSession(token, data);
      return data;
    });
  }
  return { info, verified, send, check };
}
