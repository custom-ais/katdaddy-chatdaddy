// Server-only Twilio transport. Verify email uses the mailer attached to the
// Verify Service; it does not send booking-confirmation emails.
// Application/session guards and explicit provider selection belong to app.mjs.
const isSid = (value, prefix) => typeof value === "string" && new RegExp(`^${prefix}[a-fA-F0-9]{32}$`).test(value);
const phone = (value) => typeof value === "string" && /^\+[1-9]\d{7,14}$/.test(value);
const email = (value) => typeof value === "string" && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const error = (code, message) => Object.assign(new Error(message), { code });

export function createTwilio({ env = process.env, fetchImpl = fetch } = {}) {
  const account = String(env.TWILIO_ACCOUNT_SID || "").trim();
  const key = String(env.TWILIO_API_KEY_SID || "").trim();
  const secret = String(env.TWILIO_API_KEY_SECRET || "").trim();
  const service = String(env.TWILIO_VERIFY_SERVICE_SID || "").trim();
  const messaging = String(env.TWILIO_MESSAGING_SERVICE_SID || "").trim();
  const credentials = isSid(account, "AC") && isSid(key, "SK") && Boolean(secret);
  const verifyConfigured = credentials && isSid(service, "VA");
  // This is an operator attestation, not a claim that an API key proves sender approval.
  const messagingConfigured = credentials && isSid(messaging, "MG") && env.TWILIO_SMS_SENDER_APPROVED === "true";

  async function post(url, values) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams(values).toString(),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
    } catch {
      // Never retry an uncertain send; never expose raw errors, URLs or credentials.
      throw error("TWILIO_UNAVAILABLE", "The messaging provider could not be reached. Please try again later.");
    }
    if (!response.ok) {
      const code = response.status === 429 ? "TWILIO_RATE_LIMIT" : response.status === 404 ? "TWILIO_NOT_FOUND" : "TWILIO_REJECTED";
      throw error(code, response.status === 429 ? "Too many requests. Please wait before trying again." : "The messaging provider could not complete this request.");
    }
    try { return await response.json(); }
    catch { throw error("TWILIO_BAD_RESPONSE", "The messaging provider returned an invalid response."); }
  }

  async function sendVerification({ to, channel }) {
    if (!verifyConfigured) throw error("TWILIO_NOT_CONFIGURED", "Verification is not configured.");
    if (!(channel === "sms" ? phone(to) : channel === "email" && email(to))) throw error("INVALID_VERIFICATION_DESTINATION", "Choose a valid SMS number or email address.");
    const result = await post(`https://verify.twilio.com/v2/Services/${service}/Verifications`, { To: to, Channel: channel });
    if (!isSid(result.sid, "VE") || result.status !== "pending") throw error("TWILIO_BAD_RESPONSE", "The verification request was not accepted.");
    return { sid: result.sid, status: result.status };
  }

  async function checkVerification({ sid, code }) {
    if (!verifyConfigured) throw error("TWILIO_NOT_CONFIGURED", "Verification is not configured.");
    if (!isSid(sid, "VE") || typeof code !== "string" || !/^\d{4}$/.test(code)) throw error("INVALID_VERIFICATION_CODE", "Enter the verification code you received.");
    const result = await post(`https://verify.twilio.com/v2/Services/${service}/VerificationCheck`, { VerificationSid: sid, Code: code });
    if (result.sid !== sid || !["pending", "approved", "canceled", "expired", "failed", "max_attempts_reached", "deleted"].includes(result.status)) throw error("TWILIO_BAD_RESPONSE", "The messaging provider returned an invalid response.");
    return { sid, status: result.status };
  }

  async function sendSms(to, message) {
    if (!messagingConfigured) throw error("TWILIO_NOT_CONFIGURED", "An approved SMS sender is not configured.");
    if (!phone(to) || typeof message !== "string" || !message.trim() || message.length > 1600) throw error("INVALID_SMS", "A valid recipient and message are required.");
    const result = await post(`https://api.twilio.com/2010-04-01/Accounts/${account}/Messages.json`, { To: to, MessagingServiceSid: messaging, Body: message });
    if (!isSid(result.sid, "SM") || !["accepted", "queued", "sending", "sent", "delivered"].includes(result.status)) throw error("TWILIO_BAD_RESPONSE", "The SMS request was not accepted.");
    return { messageId: result.sid, status: result.status };
  }

  return { verifyConfigured, messagingConfigured, sendVerification, checkVerification, sendSms };
}
