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

test("'I don't know' gets reassurance, in the ways people type it", async () => {
  const { NOTED } = await import("../shared/conversation.mjs");
  const base = ["Dryer Vent Cleaning", "85326", "Have Dryer"];
  for (const [steps, field] of [
    [[...base, "Not sure"], "recentService"],
    [[...base, "idk"], "recentService"],
    [[...base, "No", "i dont know"], "stories"],
    [[...base, "No", "1-Story Home", "no clue lol"], "power"],
    [[...base, "No", "1-Story Home", "Electric Dryer", "I don't know"], "mount"],
    [[...base, "No", "1-Story Home", "Electric Dryer", "Standard Floor Setup", "Dries in one normal cycle", "honestly not sure"], "animals"],
  ]) {
    const r = run(steps);
    assert.equal(r.session.property[field], "Not sure", steps.at(-1));
    assert.ok(r.reply.startsWith(`${NOTED}\n\n`), `${steps.at(-1)}: ${r.reply}`);
  }
  const symptoms = run([...base, "No", "1-Story Home", "Electric Dryer", "Standard Floor Setup", "not really sure"]);
  assert.ok(symptoms.reply.startsWith(NOTED), symptoms.reply);
  assert.equal(symptoms.session.pending, "animals");
  assert.ok(!run([...base, "No", "1-Story Home", "Electric Dryer", "Standard Floor Setup"]).reply.includes(NOTED), "a real answer isn't treated as unsure");
});

test("with the AI on, the 'I don't know' reassurance is kept word for word", async () => {
  const { chatTurn } = await import("../server/chat.mjs");
  const { NOTED } = await import("../shared/conversation.mjs");
  const calls = [];
  const assistant = createAssistant({ env: {}, generate: async (req) => { calls.push(req); return req.schema === voiceSchema ? { response: "Got it." } : { command: null, facts: { mount: "Not sure" }, question: false, answer: null, lead: null }; } });
  const s = run(["Dryer Vent Cleaning", "85326", "Have Dryer", "No", "1-Story Home", "Electric Dryer"]).session;
  const r = await chatTurn({ message: "honestly i have no idea what that means", session: s, config: { ...config, scheduleAcknowledged: true, bookingEnabled: true }, faqs: INITIAL_FAQS, assistant });
  assert.equal(r.session.property.mount, "Not sure");
  assert.ok(r.reply.startsWith(NOTED), r.reply);
  assert.doesNotMatch(r.reply, /^Got it/);
  assert.equal(calls.filter((c) => c.schema === voiceSchema).length, 0);
});

test("answers the customer didn't know reach the technician as one clear line in Jobber", async (t) => {
  const h = await harness(t, { config: { pricesAcknowledged: true } });
  await h.store.set("technicians", [{ id: "tech-ryan", name: "Ryan Boucher", status: "available", jobberUserId: "J-RYAN" }]);
  const token = await h.fresh();
  let r;
  for (const m of ["Dryer Vent Cleaning", "85326", "Have Dryer", "Not sure", "1-Story", "I don't know", "I don't know", "Dries in one normal cycle", "No signs", "Premium 1-2-3 · $179", "Accept & Continue"]) r = await h.chat(token, m);
  assert.equal(r.action, "contact", r.reply);
  await h.contactAndVerify(token);
  const held = await h.hold(token, (await h.slots(token))[0].scheduledAt);
  assert.equal((await h.confirm(token, held.data.hold)).status, 201);
  assert.match(h.jobber.jobs[0].instructions, /Tech to double-check on site \(customer wasn't sure\): recent dryer purchase or service; gas or electric; dryer setup \(standard, pedestal or stacked\)\./);
});

test("the savings estimate follows the customer's drying cycles and published averages", async () => {
  const { savingsEstimate, SAVINGS_AVERAGES } = await import("../shared/conversation.mjs");
  assert.deepEqual(SAVINGS_AVERAGES, { loadsPerWeek: 5, minutesPerCycle: 45, kwhPerCycle: 2.5, centsPerKwh: 15 });
  const two = savingsEstimate({ symptoms: ["two"], power: "Electric" });
  assert.deepEqual([two.hoursPerWeek, two.hoursPerYear, two.dollarsPerYear], [4, 195, 100], "5 extra 45-minute cycles a week at 2.5 kWh and 15¢");
  const three = savingsEstimate({ symptoms: ["three"], power: "Electric" });
  assert.deepEqual([three.hoursPerWeek, three.hoursPerYear, three.dollarsPerYear], [7.5, 390, 195]);
  const gas = savingsEstimate({ symptoms: ["two"], power: "Gas" });
  assert.equal(gas.dollarsPerYear, null, "no dollar figure for gas");
  assert.match(gas.sentence, /4 hours less drying time a week/);
  assert.doesNotMatch(gas.sentence + gas.basis, /\$/);
  assert.match(savingsEstimate({ symptoms: ["two"], power: "Not sure" }).basis, /for an electric dryer/);
  for (const p of [{ symptoms: ["normal"] }, { symptoms: ["overheat"] }, { symptoms: [] }, {}, { symptoms: ["three"], hasDryer: "No" }]) assert.equal(savingsEstimate(p), null, JSON.stringify(p));
});

test("the package offer shows the savings estimate when loads take extra cycles", () => {
  const offer = (cycles) => run(["Dryer Vent Cleaning", "85326", "Have Dryer", "No", "1-Story Home", "Electric Dryer", "Standard Floor Setup", cycles, "No signs"]);
  const slow = offer("Takes about 2 cycles");
  assert.equal(slow.session.stage, "offer");
  assert.deepEqual([slow.card.savings.hoursPerWeek, slow.card.savings.dollarsPerYear], [4, 100]);
  assert.match(slow.reply, /that's an estimated \$100 a year in electricity and 4 hours less drying time a week\./);
  const fine = offer("Dries in one normal cycle");
  assert.equal(fine.card.savings, undefined, "no savings claim when the dryer already dries in one cycle");
  assert.doesNotMatch(fine.reply, /estimated \$/);
});

test("BOB's AI knows the savings estimate and may repeat its numbers", async () => {
  const { allowedMoney } = await import("../server/assistant.mjs");
  for (const priced of [true, false]) {
    const money = allowedMoney({ ...config, pricesAcknowledged: priced }, INITIAL_FAQS);
    assert.ok(money.has(10000) && money.has(19500), `priced=${priced}`);
  }
  let system = "";
  const assistant = createAssistant({ env: {}, generate: async (req) => { system = req.system; return { response: null }; } });
  await assistant.speak({ text: "how much would this save me", session: initialSession(), config, faqs: INITIAL_FAQS, next: "" });
  assert.match(system, /SAVINGS ESTIMATE .*about 2 cycles saves about 4 hours of drying a week and about \$100 a year in electricity; 3 or more cycles saves about 7\.5 hours a week and about \$195 a year\. .*give no dollar figure for gas/);
});
