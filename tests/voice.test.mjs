// BOB's voice: the AI writes the opening of the reply to a typed message, while the rules engine's
// required message (next question, offer, summary, safety steps) always follows unchanged.

import test from "node:test";
import assert from "node:assert/strict";
import { createAssistant, voiceSchema, normalizeVoice } from "../server/assistant.mjs";
import { chatTurn } from "../server/chat.mjs";
import { initialSession, turn, classify, UNANSWERED } from "../shared/conversation.mjs";
import { DEFAULT_CONFIG, INITIAL_FAQS } from "../shared/domain.mjs";

const config = { ...DEFAULT_CONFIG, serviceZips: ["85326"], pricesAcknowledged: true, scheduleAcknowledged: true, bookingEnabled: true };
const base = { command: null, facts: {}, question: false, answer: null, lead: null };

/** A stand-in model: interpretation requests get `interp`, voice requests get `voice`. */
function model(interp, voice) {
  const calls = [];
  const assistant = createAssistant({
    env: {},
    generate: async (req) => {
      calls.push(req);
      if (req.schema === voiceSchema) {
        if (voice instanceof Error) throw voice;
        return typeof voice === "function" ? voice(req) : { response: voice };
      }
      return { ...base, ...interp };
    },
  });
  return { assistant, calls, voiceCalls: () => calls.filter((c) => c.schema === voiceSchema) };
}
const step = (message, session, assistant) => chatTurn({ message, session, config, faqs: INITIAL_FAQS, assistant });
/** A conversation waiting on "Is your home a 1-story or 2-story residence?". */
function atStories() {
  let s = initialSession();
  for (const m of ["Dryer Vent Cleaning", "85326", "Have Dryer", "No"]) s = turn(m, s, config, INITIAL_FAQS).session;
  assert.equal(s.pending, "stories");
  return s;
}

test("a hesitant customer gets a real answer, then the required question and its buttons", async () => {
  const s = atStories();
  const { assistant, voiceCalls } = model({}, "No pressure at all. Nothing is booked until you approve the final summary, and I can show you the exact price first.");
  const r = await step("i dont know if i want to book yet", s, assistant);
  assert.equal(r.voiced, true);
  assert.match(r.reply, /^No pressure at all\. Nothing is booked until you approve the final summary, and I can show you the exact price first\.\n\nIs your home a 1-story or 2-story residence\?$/);
  assert.doesNotMatch(r.reply, /didn't catch that/);
  assert.equal(r.session.pending, "stories", "the required question is still pending");
  assert.deepEqual(r.options, ["1-Story Home", "2-Story (1st Floor Laundry)", "2-Story (2nd Floor Laundry)", "Not sure"]);
  assert.equal(r.session.history.at(-1).text, r.reply, "the conversation record shows what the customer saw");
  assert.equal(r.session.history.at(-2).text, "i dont know if i want to book yet");
  const req = voiceCalls()[0];
  assert.match(req.prompt, /NEXT MESSAGE \(shown right after your response, unchanged\):\n"""Is your home a 1-story or 2-story residence\?"""/);
  assert.match(req.prompt, /CUSTOMER'S LATEST MESSAGE:\n"""i dont know if i want to book yet"""/);
  assert.match(req.prompt, /Customer: Dryer Vent Cleaning/, "the model sees the conversation so far");
  assert.match(req.system, /APPROVED FAQ ANSWERS/, "the model sees the approved knowledge");
});

test("the voice can't ask its own question when the engine already asks one", async () => {
  const { assistant } = model({}, "No problem! Want the price first?");
  const r = await step("i dont know if i want to book yet", atStories(), assistant);
  assert.equal(r.voiced, undefined);
  assert.match(r.reply, /Is your home a 1-story or 2-story residence\?$/);
});

test("the voice can't invent a price, but may repeat one the engine shows", async () => {
  const limits = { config, faqs: INITIAL_FAQS, kb: "" };
  assert.equal(normalizeVoice({ response: "It's usually about $150." }, { ...limits, next: "Is your home a 1-story or 2-story residence?" }), null);
  assert.equal(normalizeVoice({ response: "That comes to $228 with the gas procedure." }, { ...limits, next: "**Total: $228**\n\nReady to continue?" }), "That comes to $228 with the gas procedure.");
  assert.equal(normalizeVoice({ response: "You're all booked for Tuesday." }, { ...limits, next: "" }), null);
  assert.equal(normalizeVoice({ response: "Please send your card number." }, { ...limits, next: "" }), null);
  assert.equal(normalizeVoice({ response: "- first\n- second" }, { ...limits, next: "" }), null, "no lists");
  assert.equal(normalizeVoice({ response: "x".repeat(501) }, { ...limits, next: "" }), null, "short replies only");
  assert.equal(normalizeVoice({ response: null }, { ...limits, next: "" }), null);
});

test("the voice replaces the engine's unanswered fallback but keeps the next step", async () => {
  const { assistant } = model({ question: true }, "Good question. I'll make sure the team can answer that for you.");
  const r = await step("do you guys do gutter cleaning too", initialSession(), assistant);
  assert.equal(r.voiced, true);
  assert.ok(!r.reply.includes(UNANSWERED));
  assert.match(r.reply, /^Good question\. I'll make sure the team can answer that for you\./);
});

test("a typed problem gets acknowledged before the engine's offer", async () => {
  const { assistant } = model({ command: "CLEANING_WITH_CONCERN", facts: { concern: "vent behind the dryer got crushed" } }, "Sorry about that. A crushed vent right behind the dryer would explain the long drying times.");
  const r = await step("the vent behind my dryer got crushed when we moved it and now it takes forever to dry", initialSession(), assistant);
  assert.equal(r.via, "ai");
  assert.equal(r.session.stage, "bundle_offer");
  assert.match(r.reply, /^Sorry about that\. A crushed vent right behind the dryer would explain the long drying times\.\n\n.*Cleaning \+ Assessment: \$239/s);
  assert.deepEqual(r.options, ["Cleaning + Assessment", "Just the cleaning", "Ask a question"]);
});

test("buttons, exact commands, safety reports and FAQ answers never call the voice", async () => {
  const s = atStories();
  for (const [message, session] of [["1-Story Home", s], ["start over", s], ["There is smoke coming from my dryer", initialSession()]]) {
    const { assistant, voiceCalls } = model({}, "SHOULD NOT APPEAR");
    const r = await step(message, session, assistant);
    assert.equal(voiceCalls().length, 0, message);
    assert.doesNotMatch(r.reply, /SHOULD NOT APPEAR/);
  }
  const { assistant, voiceCalls } = model({ question: true, answer: "Yes. Your technician pulls the dryer out to reach the vent." }, "SHOULD NOT APPEAR");
  const r = await step("will your guy slide my dryer out? it's heavy", s, assistant);
  assert.equal(voiceCalls().length, 0, "an approved FAQ answer is already conversational");
  assert.match(r.reply, /Your technician pulls the dryer out/);
});

test("a voice failure keeps the engine's own reply", async () => {
  const { assistant } = model({}, new Error("provider timeout"));
  const r = await step("i dont know if i want to book yet", atStories(), assistant);
  assert.equal(r.voiced, undefined);
  assert.match(r.reply, /Is your home a 1-story or 2-story residence\?$/);
});

test("the voice is off when the AI assistant is switched off", async () => {
  const { assistant, calls } = model({}, "SHOULD NOT APPEAR");
  const r = await chatTurn({ message: "i dont know if i want to book yet", session: atStories(), config: { ...config, aiAssistant: false }, faqs: INITIAL_FAQS, assistant });
  assert.equal(calls.length, 0);
  assert.equal(r.via, "rules");
});

test("'can someone come look at it' is a service request; asking for a person still goes to the team", () => {
  assert.notEqual(classify("my dryer takes 2 or 3 loads to dry, can someone come look at it").route, "review");
  for (const t of ["can i talk to someone", "have someone call me", "can someone call me back", "i want to speak with a person"]) assert.equal(classify(t).route, "review", t);
});
