import { createConnectionHealth, observeMessaging } from "./connection-health.mjs";
import { createOwnerConsent } from "./owner-consent.mjs";
import { notifyOwnerError } from "./owner-error-notification.mjs";
import { createIntegrationAccounts } from "./integration-accounts.mjs";
import { createSendGrid } from "./sendgrid.mjs";
import { createTwilio } from "./twilio.mjs";
// Wires the real dependencies together. One instance per serverless container.

import { createDb } from "./db.mjs";
import { createStore } from "./store.mjs";
import { measure } from "./timing.mjs";

/** The database with every query (and transaction query) timed per request. */
export function timedDb(db) {
  const query = (text, params) => measure("db", () => db.query(text, params));
  const tx = db.tx ? (fn) => db.tx((inner) => fn({ ...inner, query: (text, params) => measure("db", () => inner.query(text, params)) })) : undefined;
  return { ...db, query, ...(tx ? { tx } : {}) };
}
import { createJobber } from "./jobber.mjs";
import { createIntegrationControls, controlProviders } from "./integration-controls.mjs";
import { createGeo } from "./geo.mjs";
import { createScheduler } from "./schedule.mjs";
import { createBobHandler } from "./app.mjs";
import { createAssistant } from "./assistant.mjs";

let instance = null;

export async function bobRuntime(env = process.env) {
  instance ??= (async () => {
    const db = timedDb(await createDb(env));
    const store = createStore(db);
    const controls = createIntegrationControls({ store });
    // Every provider call is timed per request (see timing.mjs).
    const timedFetch = (kind, fetchImpl) => (input, init) => measure(kind, () => fetchImpl(input, init));
    const { jobber, geo, twilio: gatedTwilio, sendgrid: gatedSendgrid } = controlProviders({
      controls,
      sendgrid: createSendGrid({ env, fetchImpl: timedFetch('email', controls.fetchFor('email')) }),
      jobber: createJobber({ store, env, fetchImpl: timedFetch('jobber', controls.fetchFor('jobber')) }),
      geo: createGeo({ cache: store, googleKey: env.GOOGLE_MAPS_API_KEY || '', fetchImpl: timedFetch('google', controls.fetchFor('maps')) }),
      twilio: createTwilio({ env, fetchImpl: timedFetch('twilio', controls.fetchFor(input => String(input).startsWith('https://verify.twilio.com/') ? 'verification' : 'sms')) }),
    });
    const scheduler = createScheduler({ store, jobber, geo });
    const rawAssistant = createAssistant({ env, fetchImpl: async (input, init) => {
      const config = await store.config();
      const provider = String(input).startsWith('https://api.openai.com/') ? 'openai' : 'gemini';
      if (config.aiAssistant === false || (config.aiProvider || 'gemini') !== provider) throw new Error('Smart chat is disabled or its selected provider changed.');
      return fetch(input, init);
    } });
    const ownerConsent = createOwnerConsent({ store });
    const connectionHealth = createConnectionHealth({ store, env, jobber, onError: ({ name, at }) => {
      if (!['jobber', 'verification', 'assistant', 'email'].includes(name)) return;
      return notifyOwnerError({ store, kind: name, details: { at }, ownerConsent, env,
        smsReady: c => c.integrations?.sms !== false && env.BOOKING_SMS_PROVIDER === 'twilio' && Boolean(twilio?.messagingConfigured),
        sendSms: (phone, text, options) => twilio.sendSms(phone, text, options), provider: 'Twilio' });
    } });
    const { twilio, sendgrid, assistant } = observeMessaging({ health: connectionHealth, twilio: gatedTwilio, sendgrid: gatedSendgrid, assistant: rawAssistant });
    const integrationAccounts = createIntegrationAccounts({ env, store, jobber });
    const handle = createBobHandler({ connectionHealth: { ...connectionHealth, refresh: () => connectionHealth.refresh({ integrationAccounts }) }, integrationAccounts, store, jobber, geo, scheduler, assistant, twilio, sendgrid, env });
    return { db, store, jobber, geo, scheduler, assistant, handle };
  })().catch((error) => {
    instance = null;
    throw error;
  });
  return instance;
}
