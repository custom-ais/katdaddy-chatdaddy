// LeadConnector (HighLevel) — contacts, tags, notes, and SMS/email confirmations.
// Messages go straight through the Conversations API, so this works even though
// Workflows are locked at the franchisor level.
// Needs a sub-account Private Integration token with these scopes:
//   contacts.write, contacts.readonly, conversations/message.write

const BASE = "https://services.leadconnectorhq.com";

export function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/);
  return { firstName: parts[0] || "", lastName: parts.slice(1).join(" ") };
}

/** A pasted value can carry spaces, quotes or a "Bearer " prefix; LeadConnector rejects all of them. */
export const cleanSecret = (value) => String(value || "").trim().replace(/^["']+|["']+$/g, "").replace(/^Bearer\s+/i, "").trim();

/** What kind of value is in LC_PRIVATE_TOKEN, without revealing it. */
export function tokenKind(token) {
  if (!token) return "missing";
  if (/^pit-[A-Za-z0-9-]{8,}$/.test(token)) return "private-integration";
  if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) return "jwt"; // an old location API key or an OAuth token
  return "other";
}

export function createLeadConnector({ env = process.env, fetchImpl = fetch } = {}) {
  const cfg = {
    token: cleanSecret(env.LC_PRIVATE_TOKEN),
    locationId: cleanSecret(env.LC_LOCATION_ID),
    contactsVersion: env.LC_CONTACTS_VERSION || "2021-07-28",
    conversationsVersion: env.LC_CONVERSATIONS_VERSION || "2021-04-15",
    emailFrom: env.LC_EMAIL_FROM || "",
    fromNumber: env.LC_FROM_NUMBER || "",
    smsConsentField: env.LC_SMS_CONSENT_FIELD || "",
    bookedTags: (env.LC_BOOKED_TAGS || "bob-booked,website-booking").split(",").map((t) => t.trim()).filter(Boolean),
    requestTags: (env.LC_REQUEST_TAGS || "bob-request").split(",").map((t) => t.trim()).filter(Boolean),
  };
  const configured = Boolean(cfg.token && cfg.locationId);

  async function call(path, body, version) {
    const send = (v) =>
      fetchImpl(`${BASE}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${cfg.token}`, Version: v, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    let response = await send(version);
    // HighLevel is moving the Version header to "v3"; retry once if the dated value is refused.
    if ((response.status === 400 || response.status === 422) && version !== "v3") {
      const text = await response.clone().text();
      if (/version/i.test(text)) response = await send("v3");
    }
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = Array.isArray(json.message) ? json.message.join("; ") : json.message;
      throw new Error(`LeadConnector ${path} ${response.status}: ${message || "request failed"}`);
    }
    return json;
  }

  /** Upsert by phone/email; tags are added separately because upsert replaces all tags. */
  async function upsertContact({ name, phone, email, address, city, zip, smsConsent, tags = [] }) {
    const { firstName, lastName } = splitName(name);
    // Empty fields are left out so an upsert never blanks details already on the contact.
    const body = {
      locationId: cfg.locationId,
      firstName: firstName || undefined,
      lastName: lastName || undefined,
      phone: phone || undefined,
      email: email || undefined,
      address1: address || undefined,
      city: city || undefined,
      state: address ? "AZ" : undefined,
      postalCode: zip || undefined,
      country: address ? "US" : undefined,
      source: "BOB Booking Bot",
    };
    if (cfg.smsConsentField && typeof smsConsent === "boolean") {
      const idLike = /^[A-Za-z0-9]{15,}$/.test(cfg.smsConsentField);
      body.customFields = [{ [idLike ? "id" : "key"]: cfg.smsConsentField, fieldValue: smsConsent ? "Yes" : "No" }];
    }
    const json = await call("/contacts/upsert", body, cfg.contactsVersion);
    const contactId = json.contact?.id;
    if (!contactId) throw new Error("LeadConnector upsert returned no contact id");
    if (tags.length) await call(`/contacts/${contactId}/tags`, { tags }, cfg.contactsVersion).catch((e) => console.warn("[lc] tags:", e.message));
    return contactId;
  }

  const sendSms = (contactId, message) =>
    call("/conversations/messages", { type: "SMS", contactId, message, ...(cfg.fromNumber ? { fromNumber: cfg.fromNumber } : {}) }, cfg.conversationsVersion);

  const sendEmail = (contactId, { subject, html, text }) =>
    call("/conversations/messages", { type: "Email", contactId, subject, html, message: text, ...(cfg.emailFrom ? { emailFrom: cfg.emailFrom } : {}) }, cfg.conversationsVersion);

  const addNote = (contactId, text) =>
    call(`/contacts/${contactId}/notes`, { body: text }, cfg.contactsVersion).catch((e) => console.warn("[lc] note:", e.message));

  return { configured, cfg, tokenKind: tokenKind(cfg.token), upsertContact, sendSms, sendEmail, addNote };
}
