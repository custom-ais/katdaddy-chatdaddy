import { createIntegrationAccounts } from "./integration-accounts.mjs";
import { createSendGrid } from "./sendgrid.mjs";
import { createTwilio } from "./twilio.mjs";
// Wires the real dependencies together. One instance per serverless container.

import { createDb } from "./db.mjs";
import { createStore } from "./store.mjs";
import { createJobber } from "./jobber.mjs";
import { createIntegrationControls, controlProviders } from "./integration-controls.mjs";
import { createGeo } from "./geo.mjs";
import { createScheduler } from "./schedule.mjs";
import { createBobHandler } from "./app.mjs";
import { createAssistant } from "./assistant.mjs";

let instance = null;

export async function bobRuntime(env = process.env) {
  instance ??= (async () => {
    const db = await createDb(env);
    const store = createStore(db);
    const controls = createIntegrationControls({ store });
    const { jobber, geo, twilio, sendgrid } = controlProviders({
      controls,
      sendgrid: createSendGrid({ env, fetchImpl: controls.fetchFor('email') }),
      jobber: createJobber({ store, env, fetchImpl: controls.fetchFor('jobber') }),
      geo: createGeo({ cache: store, googleKey: env.GOOGLE_MAPS_API_KEY || '', fetchImpl: controls.fetchFor('maps') }),
      twilio: createTwilio({ env, fetchImpl: controls.fetchFor(input => String(input).startsWith('https://verify.twilio.com/') ? 'verification' : 'sms') }),
    });
    const scheduler = createScheduler({ store, jobber, geo });
    const assistant = createAssistant({ env, fetchImpl: async (input, init) => {
      const config = await store.config();
      const provider = String(input).startsWith('https://api.openai.com/') ? 'openai' : 'gemini';
      if (config.aiAssistant === false || (config.aiProvider || 'gemini') !== provider) throw new Error('Smart chat is disabled or its selected provider changed.');
      return fetch(input, init);
    } });
    const integrationAccounts = createIntegrationAccounts({ env, store, jobber });
    const handle = createBobHandler({ integrationAccounts, store, jobber, geo, scheduler, assistant, twilio, sendgrid, env });
    return { db, store, jobber, geo, scheduler, assistant, handle };
  })().catch((error) => {
    instance = null;
    throw error;
  });
  return instance;
}
