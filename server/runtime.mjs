// Wires the real dependencies together. One instance per serverless container.

import { createDb } from "./db.mjs";
import { createStore } from "./store.mjs";
import { createJobber } from "./jobber.mjs";
import { createLeadConnector } from "./leadconnector.mjs";
import { createGeo } from "./geo.mjs";
import { createScheduler } from "./schedule.mjs";
import { createBobHandler } from "./app.mjs";
import { createAssistant } from "./assistant.mjs";

let instance = null;

export async function bobRuntime(env = process.env) {
  instance ??= (async () => {
    const db = await createDb(env);
    const store = createStore(db);
    const jobber = createJobber({ store, env });
    const lc = createLeadConnector({ env });
    const geo = createGeo({ cache: store, googleKey: env.GOOGLE_MAPS_API_KEY || "" });
    const scheduler = createScheduler({ store, jobber, geo });
    const assistant = createAssistant({ env });
    const handle = createBobHandler({ store, jobber, lc, geo, scheduler, assistant, env });
    return { db, store, jobber, lc, geo, scheduler, assistant, handle };
  })().catch((error) => {
    instance = null;
    throw error;
  });
  return instance;
}
