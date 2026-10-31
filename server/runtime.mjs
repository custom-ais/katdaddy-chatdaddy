// Wires the real dependencies together. One instance per serverless container.

import { createDb } from "./db.mjs";
import { createStore } from "./store.mjs";
import { createJobber } from "./jobber.mjs";
import { createLeadConnector } from "./leadconnector.mjs";
import { createGeo } from "./geo.mjs";
import { createScheduler } from "./schedule.mjs";
import { createBobHandler } from "./app.mjs";
import { createAssistant } from "./assistant.mjs";
import { createEmail } from "./email.mjs";
import { createIntegrationSettings } from "./integration-settings.mjs";

let base = null, instance = null;

export async function bobRuntime(env = process.env) {
  base ??= (async () => {
    const db = await createDb(env);
    const store = createStore(db);
    return { db, store, integrationSettings: createIntegrationSettings({ store, env }) };
  })().catch((error) => { base = null; throw error; });
  const { db, store, integrationSettings } = await base;
  // Only metadata is exposed by the admin API. Decrypted values stay in server memory.
  const saved = await integrationSettings.resolve().catch(() => ({ revision: 'unavailable', values: {} }));
  if (!instance || instance.revision !== saved.revision) {
    const effectiveEnv = { ...env, ...saved.values };
    const jobber = createJobber({ store, env: effectiveEnv });
    const lc = createLeadConnector({ env: effectiveEnv });
    const geo = createGeo({ cache: store, googleKey: effectiveEnv.GOOGLE_MAPS_API_KEY || "" });
    const scheduler = createScheduler({ store, jobber, geo });
    const assistant = createAssistant({ env: effectiveEnv });
    const email = createEmail({ env: effectiveEnv });
    const handle = createBobHandler({ store, jobber, lc, geo, scheduler, assistant, email, integrationSettings, env: effectiveEnv });
    instance = { db, store, jobber, lc, geo, scheduler, assistant, email, handle, revision: saved.revision };
  }
  return instance;
}
