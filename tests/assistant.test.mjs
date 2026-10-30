// The AI layer: Gemini's JSON is mapped onto BOB's commands, checked, and never trusted
// with prices, bookings, or safety de-escalation.

import test from "node:test";
import assert from "node:assert/strict";
import { createAssistant, guard, allowedMoney, normalizeResult } from "../server/assistant.mjs";
import { chatTurn } from "../server/chat.mjs";
import { initialSession, turn } from "../shared/conversation.mjs";
import { DEFAULT_CONFIG, INITIAL_FAQS } from "../shared/domain.mjs";
import { harness } from "./helpers.mjs";

const config = { ...DEFAULT_CONFIG, serviceZips: ["85326"], pricesAcknowledged: true, scheduleAcknowledged: true, bookingEnabled: true };
const reply = (out) => {
  const calls = [];
  const assistant = createAssistant({ env: {}, generate: async (req) => (calls.push(req), typeof out === "function" ? out(req) : out) });
  return { assistant, calls };
};
const base = { command: null, facts: {}, question: false, answer: null, lead: null };
const step = (message, session, assistant) => chatTurn({ message, session, config, faqs: INITIAL_FAQS, assistant });

test("free text with several home details fills them in and skips those questions", async () => {
  const { assistant } = reply({ ...base, command: "START_CLEANING", facts: { stories: "2-story", laundryFloor: "2nd floor", power: "Gas", hasDryer: "Yes", symptoms: ["three"] }, lead: "Sorry the dryer is taking so long." });
  const r = await step("Need my vent cleaned — 2 story house, gas dryer upstairs, takes 3 loads to dry", initialSession(), assistant);
  assert.equal(r.via, "ai");
  assert.equal(r.session.intent, "cleaning");
  assert.deepEqual(r.session.property, { stories: "2-story", laundryFloor: "2nd floor", power: "Gas", hasDryer: "Yes", symptoms: ["three"] });
  assert.equal(r.session.pending, "zip");
  assert.match(r.reply, /^Sorry the dryer is taking so long\.\n\nWhat's the five-digit ZIP/);
  assert.equal(r.session.history.at(-2).text, "Need my vent cleaned — 2 story house, gas dryer upstairs, takes 3 loads to dry", "customer's own words are kept");
});

test("a question is answered from the FAQ knowledge, then the pending question returns", async () => {
  let s = turn("Dryer Vent Cleaning", initialSession(), config, INITIAL_FAQS).session;
  s = turn("85326", s, config, INITIAL_FAQS).session;
  const { assistant, calls } = reply({ ...base, question: true, answer: "Yes. Your technician pulls the dryer out to reach the vent." });
  const r = await step("will your guy be able to slide my dryer out? it's heavy", s, assistant);
  assert.match(r.reply, /^Yes\. Your technician pulls the dryer out to reach the vent\.\n\nDo you currently have a dryer installed/);
  assert.equal(r.session.pending, "hasDryer");
  assert.deepEqual(r.options, ["Have Dryer", "No Dryer", "Not sure"]);
  assert.match(calls[0].system, /APPROVED FAQ ANSWERS/);
  assert.doesNotMatch(calls[0].system, /\$20 off for active military/, "draft FAQs are not given to the model");
});

test("an answer with an invented price is thrown away; the rules engine answers instead", async () => {
  const { assistant } = reply({ ...base, question: true, answer: "That's $99 today only!" });
  const r = await step("how much for a cleaning?", initialSession(), assistant);
  assert.equal(r.via, "rules");
  assert.doesNotMatch(r.reply, /\$99/);
  assert.match(r.reply, /\$189/);
});

test("Gemini can't claim a booking, promise a warranty, or ask for card numbers", () => {
  const limits = { money: allowedMoney(config, INITIAL_FAQS), phone: "", kb: "" };
  assert.equal(guard("You're all booked for Tuesday!", limits), null);
  assert.equal(guard("Every cleaning has a 3-year warranty.", limits), null);
  assert.equal(guard("Please share your credit card number.", limits), null);
  assert.equal(guard("Call us at (602) 555-0000.", limits), null);
  assert.equal(guard("Essential is $189 and Performance is $249.", limits), "Essential is $189 and Performance is $249.");
  assert.equal(guard("Gas dryers come to $318 for Performance upstairs.", limits), "Gas dryers come to $318 for Performance upstairs.");
});

test("option commands must match a real button", () => {
  const r = normalizeResult({ ...base, command: "OPTION:Include assessment" }, { config, faqs: INITIAL_FAQS, options: ["Include assessment", "Cleaning only"] });
  assert.equal(r.commandText, "Include assessment");
  const bad = normalizeResult({ ...base, command: "OPTION:Free cleaning" }, { config, faqs: INITIAL_FAQS, options: ["Include assessment"] });
  assert.equal(bad.command, null);
  const unknown = normalizeResult({ ...base, command: "BOOK_NOW_FREE", facts: { power: "Plasma", stories: "2-story" } }, { config, faqs: INITIAL_FAQS });
  assert.equal(unknown.command, null);
  assert.deepEqual(unknown.facts, { stories: "2-story" }, "only allowed values survive");
});

test("cleaning plus a vent problem gets the $248 offer with the customer's concern recorded", async () => {
  const { assistant } = reply({ ...base, command: "CLEANING_WITH_CONCERN", facts: { concern: "hose behind the dryer is squished" } });
  const r = await step("want it cleaned, also the hose behind the dryer is all squished", initialSession(), assistant);
  assert.equal(r.session.stage, "bundle_offer");
  assert.match(r.reply, /\$248 total/);
  assert.deepEqual(r.session.concerns, ["hose behind the dryer is squished"]);
  assert.equal(r.session.bundleAccepted, false, "an offer is not acceptance");
});

test("yes to the bundle offer becomes Include assessment", async () => {
  const offered = turn("I need cleaning and the hose may need replacing.", initialSession(), config, INITIAL_FAQS).session;
  const { assistant } = reply({ ...base, command: "ACCEPT" });
  const r = await step("ya lets add that", offered, assistant);
  assert.equal(r.session.route, "bundle");
  assert.equal(r.session.bundleAccepted, true);
});

test("Gemini can escalate safety but never talks a safety report down", async () => {
  const up = reply({ ...base, command: "SAFETY_GAS" });
  const r = await step("theres a weird rotten smell by the laundry", initialSession(), up.assistant);
  assert.equal(r.action, "emergency");
  assert.match(r.reply, /gas utility/);
  const down = reply({ ...base, command: "START_CLEANING" });
  const s = await step("I smell gas near the dryer", initialSession(), down.assistant);
  assert.equal(s.action, "emergency");
  assert.equal(s.via, "rules", "safety text never goes to Gemini");
});

test("buttons, verification codes and an assistant outage all stay on the rules engine", async () => {
  let n = 0;
  const assistant = createAssistant({ env: {}, generate: async () => { n++; throw new Error("down"); } });
  const a = await step("Dryer Vent Cleaning", initialSession(), assistant);
  assert.equal(a.via, "rules");
  assert.equal(n, 0, "exact buttons skip the model");
  const contactStage = { ...initialSession(), stage: "verify", intent: "cleaning", serviceAccepted: true };
  const code = await step("482913", contactStage, assistant);
  assert.match(code.reply, /code box/);
  assert.equal(n, 0, "codes never go to the model");
  const b = await step("i dunno where to start honestly", initialSession(), assistant);
  assert.equal(b.via, "rules");
  assert.equal(b.aiError, true);
  assert.equal(n, 1);
});

test("the smart chat is used through the API when configured, and can be switched off in settings", async (t) => {
  const { assistant, calls } = reply({ ...base, command: "START_REPAIR", facts: { concern: "vent came apart in the attic" } });
  const h = await harness(t, { assistant });
  const token = await h.fresh();
  const r = await h.chat(token, "my vent pipe in the attic fell apart, can someone come fix it");
  assert.equal(r.via, "ai");
  assert.match(r.reply, /we start with an assessment/);
  assert.equal(calls.length, 1);
  assert.equal((await h.call("/api/public/config")).data.smartChat, true);
  await h.store.set("config", { ...(await h.store.config()), aiAssistant: false });
  const off = await h.chat(await h.fresh(), "my vent pipe in the attic fell apart, can someone come fix it");
  assert.equal(off.via, "rules");
  assert.equal(calls.length, 1);
});

test("Gemini requests use the configured model, JSON output, and the API key header", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ ...base, command: "START_CLEANING" }) }] } }] }), { status: 200 });
  };
  const assistant = createAssistant({ env: { GEMINI_API_KEY: "test-key", GEMINI_MODEL: "gemini-test" }, fetchImpl });
  const out = await assistant.interpret({ text: "clean my vent pls", session: initialSession(), config, faqs: INITIAL_FAQS });
  assert.equal(out.command, "START_CLEANING");
  assert.match(seen[0].url, /models\/gemini-test:generateContent$/);
  assert.equal(seen[0].init.headers["x-goog-api-key"], "test-key");
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.generationConfig.responseMimeType, "application/json");
});

test("a model that rejects the schema option is retried once without it", async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.generationConfig.responseJsonSchema) return new Response(JSON.stringify({ error: { message: "Invalid JSON payload: unknown field responseJsonSchema" } }), { status: 400 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "```json\n" + JSON.stringify(base) + "\n```" }] } }] }), { status: 200 });
  };
  const assistant = createAssistant({ env: { GEMINI_API_KEY: "k" }, fetchImpl });
  await assistant.interpret({ text: "hello", session: initialSession(), config, faqs: INITIAL_FAQS });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].generationConfig.responseJsonSchema, undefined);
});
