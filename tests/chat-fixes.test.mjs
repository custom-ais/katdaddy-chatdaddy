// Fixes from reviewing real conversations: answers the rules engine used to miss, the hand-off
// reply for new customers, and logging what BOB couldn't answer so the office can add FAQs.

import test from "node:test";
import assert from "node:assert/strict";
import { createAssistant, voiceSchema } from "../server/assistant.mjs";
import { initialSession, turn } from "../shared/conversation.mjs";
import { DEFAULT_CONFIG, INITIAL_FAQS } from "../shared/domain.mjs";
import { harness } from "./helpers.mjs";

const config = { ...DEFAULT_CONFIG, serviceZips: ["85326"], pricesAcknowledged: true };
const chat = (text, s = initialSession()) => turn(text, s, config, INITIAL_FAQS);
const run = (steps, s = initialSession()) => { let r; for (const t of steps) { r = chat(t, s); s = r.session; } return r; };
const atRecentService = () => run(["Dryer Vent Cleaning", "85326", "Have Dryer"]).session;

test("a tentative answer with a trailing question mark is still an answer", () => {
  const r = chat("umm maybe 3 years ago?", atRecentService());
  assert.equal(r.session.property.recentService, "No");
  assert.equal(r.session.pending, "stories");
  assert.doesNotMatch(r.reply, /verified answer/);
  assert.equal(chat("gas?", run(["Dryer Vent Cleaning", "85326", "Have Dryer", "No", "1-Story"]).session).session.property.power, "Gas");
});

test("real questions and hypotheticals still teach nothing", () => {
  const s = run(["Dryer Vent Cleaning", "85326", "Have Dryer", "No", "1-Story"]).session;
  assert.equal(chat("what if it's gas?", s).session.property.power, undefined);
  assert.equal(chat("is gas more expensive?", s).session.property.power, undefined);
});

test("time answers to 'purchased or serviced in the last 90 days?'", () => {
  for (const [answer, value] of [["about 2 weeks ago", "Yes"], ["last month", "Yes"], ["3 months ago", "Yes"], ["like 6 months ago", "No"], ["a year ago", "No"], ["a couple years", "No"], ["we just bought it", "Yes"], ["not that i know of", "No"]]) {
    assert.equal(chat(answer, atRecentService()).session.property.recentService, value, answer);
  }
});

test("everyday ways of saying where the vent exits are kept, even while another question is pending", () => {
  for (const [text, exit] of [["pretty sure it goes out the roof", "Roof"], ["it vents up through the roof", "Roof"], ["on the roof", "Roof"], ["it goes out the side of the house", "Wall"], ["vents out the wall", "Wall"]]) {
    const r = chat(text, atRecentService());
    assert.equal(r.session.property.exit, exit, text);
    assert.equal(r.session.pending, "recentService", "the pending question is asked again");
  }
});

test("asking for a person gets a follow-up offer; only changes mention an appointment reference", () => {
  const talk = chat("can i talk to someone about my options");
  assert.equal(talk.session.stage, "review");
  assert.match(talk.reply, /have the team reach out/);
  assert.doesNotMatch(talk.reply, /appointment reference/);
  for (const t of ["I need to reschedule my appointment", "please cancel my booking"]) assert.match(chat(t).reply, /appointment reference/, t);
});

test("unanswered questions and blocked AI answers are logged as warnings for the office", async (t) => {
  const assistant = createAssistant({ env: {}, generate: async (req) => (req.schema === voiceSchema ? { response: null } : { command: null, facts: {}, question: true, answer: "Yes, we're fully licensed and insured.", lead: null }) });
  const h = await harness(t, { assistant, config: { pricesAcknowledged: true } });
  const token = await h.fresh();
  const r = await h.chat(token, "are you guys licensed and insured");
  assert.match(r.reply, /verified answer/, "the blocked answer is never shown");
  const { items } = await h.store.activity({ level: "warning" });
  const kinds = items.map((i) => i.kind);
  assert.ok(kinds.includes("conversation.ai_answer_blocked"), JSON.stringify(kinds));
  assert.ok(kinds.includes("conversation.unanswered_question"), JSON.stringify(kinds));
  assert.equal(items.find((i) => i.kind === "conversation.unanswered_question").details.text, "are you guys licensed and insured");
});

test("the office's assessment description is used, its price is said once, and older saved wording switches over once", async () => {
  const { withConfigDefaults } = await import("../shared/domain.mjs");
  const migrated = withConfigDefaults({ assessmentProcess: "Older office wording. $119 for a 1-story home.", version: 3 });
  assert.match(migrated.assessmentProcess, /^We'll start by asking what you've noticed/);
  assert.equal(migrated.assessmentProcessVersion, 2);
  assert.equal(withConfigDefaults({ assessmentProcess: "Office edit", assessmentProcessVersion: 2 }).assessmentProcess, "Office edit", "later edits stand");
  const offer = run(["Repair / Reroute / Assessment", "85326", "Disconnected Duct in Wall/Attic", "1-Story Home", "Electric Dryer", "Standard Floor Setup", "Working Normal", "The vent is disconnected behind the dryer"]);
  assert.equal(offer.session.stage, "offer");
  assert.match(offer.reply, /Your technician will use a camera to look inside the duct and measure airflow at both ends/);
  assert.equal(offer.reply.match(/\$119/g).length, 1);
  assert.doesNotMatch(offer.reply, /\*\*Comprehensive Repair Assessment: \$119\.\*\*/);
  const unpriced = turn("Repair / Reroute / Assessment", initialSession(), { ...config, pricesAcknowledged: false, serviceZips: ["85326"] }, INITIAL_FAQS);
  let s = unpriced.session, r;
  for (const m of ["85326", "Disconnected Duct in Wall/Attic", "1-Story Home", "Electric Dryer", "Standard Floor Setup", "Working Normal", "The vent is disconnected behind the dryer"]) { r = turn(m, s, { ...config, pricesAcknowledged: false, serviceZips: ["85326"] }, INITIAL_FAQS); s = r.session; }
  assert.doesNotMatch(r.reply, /\$\d/, "unapproved prices are left out of the description too");
});

test("after three unresolved turns in a row the team is offered, then it resets", () => {
  let s = run(["Dryer Vent Cleaning", "85326", "Have Dryer", "No"]).session, r;
  for (const m of ["purple", "banana"]) { r = chat(m, s); s = r.session; assert.ok(!r.options.includes("Request a callback")); }
  r = chat("whatever", s); s = r.session;
  assert.match(r.reply, /If it's easier, the team can call you instead\./);
  assert.ok(r.options.includes("Request a callback"));
  r = chat("1-Story Home", s);
  assert.equal(r.session.unresolved, 0);
  assert.ok(!r.options.includes("Request a callback"));
  const callback = chat("Request a callback", chat("whatever", chat("banana", chat("purple", run(["Dryer Vent Cleaning", "85326", "Have Dryer", "No"]).session).session).session).session);
  assert.equal(callback.session.stage, "review", "the button reaches the team");
});

test("three unusable answers to the address (or a saved session's ZIP) question also offer the team", () => {
  const atAddress = chat("Dryer Vent Cleaning").session;
  assert.equal(atAddress.pending, "serviceAddress");
  const atZip = { ...structuredClone(atAddress), pending: "zip" };
  for (const start of [atAddress, atZip]) {
    let s = structuredClone(start), r;
    for (const m of ["purple", "banana"]) { r = chat(m, s); s = r.session; assert.ok(!r.options.includes("Request a callback"), start.pending); }
    r = chat("whatever", s); s = r.session;
    assert.equal(s.pending, start.pending, "the question is still pending");
    assert.match(r.reply, /If it's easier, the team can call you instead\./, start.pending);
    assert.ok(r.options.includes("Request a callback"), start.pending);
    assert.equal(chat("Request a callback", s).session.stage, "review", `${start.pending}: the button reaches the team`);
  }
});

test("the voice doesn't pretend to understand a message that made no sense", async () => {
  let system = "";
  const assistant = createAssistant({ env: {}, generate: async (req) => { system = req.system; return { response: null }; } });
  await assistant.speak({ text: "purple", session: initialSession(), config, faqs: INITIAL_FAQS, next: "Please enter the street address." });
  assert.match(system, /don't pretend it did: no "Got it" or "Thanks"/);
});
