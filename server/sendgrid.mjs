// Server-only ordinary appointment email. Twilio Verify's OTP template is separate.
// Provider selection and current tenant switches belong to app/runtime.
const mailbox = value => typeof value === 'string' && value.length <= 254 && /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}$/.test(value);
const failure = (code, message, uncertain = false) => Object.assign(new Error(message), { code, uncertain });

export function createSendGrid({ env = process.env, fetchImpl = fetch } = {}) {
  const key = String(env.SENDGRID_API_KEY || '').trim();
  const from = String(env.SENDGRID_FROM_EMAIL || '').trim();
  const name = String(env.SENDGRID_FROM_NAME || '').trim();
  // This flag is operator attestation, not proof obtained from SendGrid.
  const configured = Boolean(key && !/[\r\n]/.test(key) && mailbox(from) && name.length <= 200 && !/[\x00-\x1f\x7f]/.test(name) && env.SENDGRID_SENDER_VERIFIED === 'true');

  async function sendEmail(to, { subject, html, text } = {}) {
    if (!configured) throw failure('SENDGRID_NOT_CONFIGURED', 'A verified email sender is not configured.');
    const content = [];
    if (typeof text === 'string' && text.trim()) content.push({ type: 'text/plain', value: text });
    if (typeof html === 'string' && html.trim()) content.push({ type: 'text/html', value: html });
    if (!mailbox(to) || typeof subject !== 'string' || !subject.trim() || subject.length > 998 || /[\x00-\x1f\x7f]/.test(subject) || !content.length || content.some(c => c.value.length > 200_000) || (html != null && typeof html !== 'string') || (text != null && typeof text !== 'string')) {
      throw failure('INVALID_EMAIL', 'A valid recipient, subject and email body are required.');
    }
    let response;
    try {
      response = await fetchImpl('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ personalizations: [{ to: [{ email: to }] }], from: { email: from, ...(name ? { name } : {}) }, subject, content }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // A timeout or interrupted response may have occurred after acceptance.
      throw failure('SENDGRID_UNCERTAIN', 'Email acceptance could not be confirmed. Do not automatically retry.', true);
    }
    if (response?.status !== 202) {
      if (response?.status >= 400 && response.status < 500) throw failure('SENDGRID_REJECTED', 'The email provider rejected this request.');
      throw failure('SENDGRID_UNCERTAIN', 'Email acceptance could not be confirmed. Do not automatically retry.', true);
    }
    // Do not parse error bodies or expose provider-echoed credentials/payload.
    let messageId = null;
    try {
      const candidate = response.headers?.get('x-message-id');
      if (typeof candidate === 'string' && /^[A-Za-z0-9._-]{1,256}$/.test(candidate) && !candidate.includes(key)) messageId = candidate;
    } catch { /* Accepted delivery is not undone by missing tracking metadata. */ }
    return { messageId, status: 'accepted' };
  }
  return { configured, sendEmail };
}
