import test from "node:test";
import assert from "node:assert/strict";
import { isUrgentBooking } from "../shared/booking-urgency.mjs";
import { initialSession, turn, parseSymptoms, applyFacts, detectSafety, QUESTIONS } from "../shared/conversation.mjs";
import { DEFAULT_CONFIG, INITIAL_FAQS } from "../shared/domain.mjs";
import { normalizeResult } from "../server/assistant.mjs";
import { chatTurn } from "../server/chat.mjs";

const config = { ...DEFAULT_CONFIG, serviceZips: ["85326"], pricesAcknowledged: true };
const performance = () => ({
  ...initialSession(), stage: "evaluating", intent: "cleaning", route: "cleaning", pending: "symptoms", zip: "85326",
  property: { hasDryer: "Yes", recentService: "No", stories: "1-story", power: "Electric", mount: "Standard" },
});

test("urgent routing uses the existing current-performance answers", () => {
  for (const property of [
    { dryerWorking: "Not working" },
    { symptoms: ["not_working"] },
    { symptoms: ["overheat"] },
    { symptoms: ["error"] },
    { symptoms: ["normal", "error"] },
    { triage: ["Overheating or shutting off"] },
    { triage: ["Showing an error code (D80 / D90 / D95)"] },
  ]) assert.equal(isUrgentBooking({ property }), true, JSON.stringify(property));
  assert.equal(isUrgentBooking({ heatSign: true }), true);
});

test("routine, slower drying, missing information and package names do not grant urgency", () => {
  for (const session of [
    undefined, null, {}, { property: {} }, { property: { symptoms: ["normal"] } },
    { property: { symptoms: ["two", "three"] } },
    { property: { dryerWorking: "Working normally" } },
    { property: { dryerWorking: "Takes more than 1 cycle" } },
    { property: { dryerWorking: "Not sure" } },
    { property: { triage: ["No error codes", "Taking multiple cycles to dry"] } },
    { property: { symptoms: "error", dryerWorking: "not working normally" } },
    { package: "emergency", intent: "emergency", urgency: "high", notes: ["ASAP, not working"] },
    { property: { hasDryer: "No", symptoms: ["overheat", "error"], dryerWorking: "Not working" }, heatSign: true },
  ]) assert.equal(isUrgentBooking(session), false, JSON.stringify(session));
});

test("performance answers and Other detail retain breakdowns without a new question", () => {
  for (const answer of ["My dryer is not working", "It stopped working", "It doesn't work", "It is showing error codes"]) {
    const result = turn(answer, performance(), config, INITIAL_FAQS);
    assert.equal(isUrgentBooking(result.session), true, answer);
    assert.notEqual(result.session.pending, "symptoms", answer);
  }
  const other = turn("Other / not sure", performance(), config, INITIAL_FAQS);
  assert.equal(other.session.pending, "otherDetail");
  const result = turn("My dryer stopped working", other.session, config, INITIAL_FAQS);
  assert.equal(isUrgentBooking(result.session), true);
  assert.ok(result.session.notes.includes("Dryer performance: My dryer stopped working"));
  assert.equal(QUESTIONS.symptoms.options.includes("Not working"), false, "existing question options stay unchanged");
});

test("negated problems and questions do not become urgent performance facts", () => {
  for (const answer of [
    "Dries in one normal cycle, no error codes",
    "Working normally, it isn't overheating or shutting off",
    "Working normally, not overheating or shutting off",
    "Working normally, it doesn't shut off",
    "It hasn't stopped working, it dries in one normal cycle",
    "It used to show error codes but now it dries normally",
    "It was overheating but it now works normally",
    "It stopped working last month but it works normally now",
  ]) {
    const result = turn(answer, performance(), config, INITIAL_FAQS);
    assert.equal(isUrgentBooking(result.session), false, answer);
  }
  for (const answer of ["What if my dryer stopped working?", "What does an error code mean?"]) {
    const result = turn(answer, performance(), config, INITIAL_FAQS);
    assert.equal(isUrgentBooking(result.session), false, answer);
  }
  assert.ok(!parseSymptoms("not working normally").includes("not_working"));
  assert.equal(detectSafety("The dryer was overheating and now works normally but I smell burning"), "stop");
  assert.deepEqual(parseSymptoms("it was overheating but it works normally now and is showing an error code"), ["normal", "error"]);
  for (const answer of [
    "It is showing an error code but now dries normally",
    "It still overheats but now dries normally",
    "It shuts off but now it dries normally",
    "It was overheating and smells like burning but now dries normally",
    "It was overheating and runs hot but now dries normally",
  ]) {
    const result = turn(answer, performance(), config, INITIAL_FAQS);
    assert.equal(isUrgentBooking(result.session), true, answer);
  }
});

test("the existing repair answer and AI fact allowlist preserve not-working urgency", () => {
  const repair = { ...performance(), intent: "repair", route: "assessment", pending: "repairPerf", repairScope: "Broken Vent Cap / Exterior Damage" };
  const result = turn("Not working", repair, config, INITIAL_FAQS);
  assert.equal(result.session.property.dryerWorking, "Not working");
  assert.equal(isUrgentBooking(result.session), true);
  const facts = normalizeResult({ facts: { symptoms: ["not_working", "invented"] } }, { config, faqs: INITIAL_FAQS }).facts;
  const session = applyFacts(initialSession(), facts);
  assert.deepEqual(session.property.symptoms, ["not_working"]);
  assert.equal(isUrgentBooking(session), true);
});

test("appliance-only breakdowns still use the existing team handoff", () => {
  const result = turn("My dryer won't turn on", initialSession(), config, INITIAL_FAQS);
  assert.equal(result.action, "request");
  assert.equal(result.session.stage, "review");
  assert.match(result.reply, /appliance/);
});

test("the production emergency path remains safety checks followed by calling the office", () => {
  let session = initialSession();
  let result;
  for (const answer of ["Emergency", "Yes, everyone is safe", "No, it's turned off now"]) {
    result = turn(answer, session, config, INITIAL_FAQS);
    session = result.session;
  }
  assert.equal(result.action, "call_office");
  assert.equal(session.stage, "call_office");
  assert.deepEqual(result.options, ["Book a Cleaning"]);
  assert.doesNotMatch(result.reply, /same-day|after-hours|on-call|\$199/i);
  assert.equal(session.serviceAccepted, false);
});

test("negation of one problem never suppresses a joined positive heat report", () => {
  for (const text of [
    "No error codes and overheating",
    "No error code and shutting off",
    "I have no error codes and overheating",
    "No error codes but shutting off",
  ]) {
    assert.deepEqual(parseSymptoms(text.toLowerCase()), ["overheat"], text);
    assert.equal(detectSafety(text), "stop", text);
    const result = turn(text, performance(), config, INITIAL_FAQS);
    assert.equal(isUrgentBooking(result.session), true, text);
    assert.match(result.reply, /don't use|do not use/i, text);
  }
  assert.deepEqual(parseSymptoms("not overheating or shutting off"), []);
  assert.equal(detectSafety("not overheating or shutting off"), null);
});

test("explicit intake corrections clear matching stored symptoms and legacy urgency mirrors", () => {
  const heat = performance();
  heat.heatSign = true;
  heat.property.symptoms = ["overheat"];
  heat.property.triage = ["Overheating or shutting off"];
  const cooled = turn("It isn't overheating or shutting off; it dries in one normal cycle", heat, config, INITIAL_FAQS).session;
  assert.equal(cooled.heatSign, false);
  assert.deepEqual(cooled.property.symptoms, ["normal"]);
  assert.deepEqual(cooled.property.triage, []);
  assert.equal(isUrgentBooking(cooled), false);

  const error = performance();
  error.pending = "animals";
  error.property.symptoms = ["error"];
  error.property.triage = ["Showing an error code (D80 / D90 / D95)"];
  const corrected = turn("Correction: there are no error codes; it dries in one normal cycle", error, config, INITIAL_FAQS).session;
  assert.deepEqual(corrected.property.symptoms, []);
  assert.deepEqual(corrected.property.triage, []);
  assert.equal(isUrgentBooking(corrected), false);

  const legacy = performance();
  legacy.property.triage = ["Showing an error code (D80 / D90 / D95)"];
  const resolved = turn("It used to show error codes but now it dries normally", legacy, config, INITIAL_FAQS).session;
  assert.deepEqual(resolved.property.triage, []);
  assert.equal(isUrgentBooking(resolved), false);

  const repair = { ...performance(), intent: "repair", route: "assessment", pending: "repairPerf", repairScope: "Broken Vent Cap / Exterior Damage" };
  repair.property.dryerWorking = "Not working";
  repair.property.symptoms = ["not_working"];
  const working = turn("Working Normal", repair, config, INITIAL_FAQS).session;
  assert.equal(working.property.dryerWorking, "Working normally");
  assert.deepEqual(working.property.symptoms, []);
  assert.equal(isUrgentBooking(working), false);
});

test("corrections change only the named problem and preserve concurrent severe symptoms", () => {
  const both = () => {
    const session = performance();
    session.heatSign = true;
    session.property.symptoms = ["overheat", "error"];
    session.property.triage = ["Overheating or shutting off", "Showing an error code (D80 / D90 / D95)"];
    return session;
  };
  const heatOnly = turn("It used to show error codes but now it dries normally", both(), config, INITIAL_FAQS).session;
  assert.equal(heatOnly.heatSign, true, "resolving an error code does not resolve reported heat");
  assert.deepEqual(heatOnly.property.symptoms, ["normal", "overheat"]);
  assert.deepEqual(heatOnly.property.triage, ["Overheating or shutting off"]);
  assert.equal(isUrgentBooking(heatOnly), true);

  const errorOnly = turn("It isn't overheating or shutting off; it dries in one normal cycle", both(), config, INITIAL_FAQS).session;
  assert.equal(errorOnly.heatSign, false);
  assert.deepEqual(errorOnly.property.symptoms, ["normal", "error"]);
  assert.deepEqual(errorOnly.property.triage, ["Showing an error code (D80 / D90 / D95)"]);
  assert.equal(isUrgentBooking(errorOnly), true);

  for (const text of ["Dries in one normal cycle", "Working normally"]) {
    const unchanged = turn(text, both(), config, INITIAL_FAQS).session;
    assert.ok(unchanged.property.symptoms.includes("error"), text);
    assert.ok(unchanged.property.symptoms.includes("overheat"), text);
    assert.equal(unchanged.heatSign, true, text);
    assert.equal(isUrgentBooking(unchanged), true, text);
  }
  const facts = applyFacts(both(), { symptoms: ["normal"] });
  assert.deepEqual(facts.property.symptoms, ["normal", "overheat", "error"], "AI normal-cycle facts alone cannot retract prior problems");

  const active = turn("No error codes and overheating", both(), config, INITIAL_FAQS);
  assert.equal(active.session.heatSign, true);
  assert.deepEqual(active.session.property.symptoms, ["overheat"]);
  assert.equal(isUrgentBooking(active.session), true);
  assert.match(active.reply, /don't use|do not use/i);
});

test("questions and hypotheticals cannot retract recorded severe symptoms", () => {
  for (const text of [
    "What if there are no error codes and it is not overheating or shutting off?",
    "Does working normally mean there are no error codes?",
  ]) {
    const session = performance();
    session.heatSign = true;
    session.property.symptoms = ["overheat", "error", "not_working"];
    session.property.dryerWorking = "Not working";
    session.property.triage = ["Showing an error code (D80 / D90 / D95)"];
    const result = turn(text, session, config, INITIAL_FAQS).session;
    assert.deepEqual(result.property, session.property, text);
    assert.equal(result.heatSign, true, text);
    assert.equal(isUrgentBooking(result), true, text);
  }
});

test("explicit corrections remain effective through the unconfirmed booking stages", () => {
  for (const stage of ["contact", "verify", "slots", "approval"]) {
    const session = { ...performance(), stage, pending: null, serviceAccepted: true, package: "premium" };
    session.property.symptoms = ["error"];
    session.property.triage = ["Showing an error code (D80 / D90 / D95)"];
    const result = turn("Correction: there are no error codes", session, config, INITIAL_FAQS).session;
    assert.deepEqual(result.property.symptoms, [], stage);
    assert.deepEqual(result.property.triage, [], stage);
    assert.equal(isUrgentBooking(result), false, stage);
  }
  const session = { ...performance(), stage: "slots", pending: null, serviceAccepted: true, package: "premium", heatSign: true };
  session.property.symptoms = ["overheat", "error"];
  const result = turn("There are no error codes; it is still overheating", session, config, INITIAL_FAQS).session;
  assert.deepEqual(result.property.symptoms, ["overheat"]);
  assert.equal(result.heatSign, true);
  assert.equal(isUrgentBooking(result), true);

  for (const text of ["It isn't working normally", "It is not working normally", "It never works normally", "It rarely works normally", "It used to work normally"]) {
    const notWorking = performance();
    notWorking.property.dryerWorking = "Not working";
    notWorking.property.symptoms = ["not_working"];
    const unclear = turn(text, notWorking, config, INITIAL_FAQS).session;
    assert.equal(unclear.property.dryerWorking, "Not working", text);
    assert.ok(unclear.property.symptoms.includes("not_working"), text);
    assert.equal(isUrgentBooking(unclear), true, text);
  }
});

test("AI fact updates and commands preserve the original explicit correction", async () => {
  for (const ai of [
    { facts: { symptoms: ["normal"] }, command: null, question: false },
    { facts: {}, command: "CONTINUE", commandText: "Continue booking", question: false },
  ]) {
    for (const stage of ["evaluating", "slots"]) {
      const session = { ...performance(), stage, heatSign: true };
      session.property.symptoms = ["overheat"];
      session.property.triage = ["Overheating or shutting off"];
      if (stage === "slots") Object.assign(session, { pending: null, serviceAccepted: true, package: "premium" });
      const assistant = { configured: true, interpret: async () => ai };
      const result = await chatTurn({ message: "It isn't overheating or shutting off; it works normally", session, config, faqs: INITIAL_FAQS, assistant });
      assert.equal(result.session.heatSign, false, `${stage}: ${ai.command}`);
      assert.ok(!result.session.property.symptoms.includes("overheat"), `${stage}: ${ai.command}`);
      assert.deepEqual(result.session.property.triage, [], `${stage}: ${ai.command}`);
      assert.equal(isUrgentBooking(result.session), false, `${stage}: ${ai.command}`);
    }
  }
  const session = performance();
  session.heatSign = true;
  session.property.symptoms = ["overheat", "error"];
  const assistant = { configured: true, interpret: async () => ({ facts: { symptoms: ["normal"] }, command: null, question: true, answer: "The technician can check that." }) };
  const result = await chatTurn({ message: "What if it isn't overheating or showing error codes?", session, config, faqs: INITIAL_FAQS, assistant });
  assert.equal(result.session.heatSign, true);
  assert.ok(result.session.property.symptoms.includes("overheat"));
  assert.ok(result.session.property.symptoms.includes("error"));
  assert.equal(isUrgentBooking(result.session), true);

  const legacy = { ...performance(), heatSign: true };
  const noFacts = { configured: true, interpret: async () => ({ facts: {}, command: null, question: false }) };
  const cleared = await chatTurn({ message: "Correction: it is not overheating or shutting off", session: legacy, config, faqs: INITIAL_FAQS, assistant: noFacts });
  assert.equal(cleared.session.heatSign, true, "a legacy source might have been burning; a partial denial cannot retract it");
  assert.equal(isUrgentBooking(cleared.session), true);
  const allCleared = await chatTurn({ message: "Correction: it is not overheating or shutting off and there is no burning smell", session: legacy, config, faqs: INITIAL_FAQS, assistant: noFacts });
  assert.equal(allCleared.session.heatSign, false);
  assert.equal(isUrgentBooking(allCleared.session), false);
});

test("a correction cannot retract a different previously reported heat hazard", () => {
  for (const report of ["It smells like burning", "It shuts off mid-cycle"]) {
    const first = turn(report, performance(), config, INITIAL_FAQS).session;
    assert.equal(isUrgentBooking(first), true, report);
    assert.deepEqual(first.heatSources, report.includes("burning") ? ["burning"] : ["shutoff"]);
    const corrected = turn("There are no error codes and it is not overheating; it works normally", first, config, INITIAL_FAQS).session;
    assert.equal(isUrgentBooking(corrected), true, report);
    assert.equal(corrected.heatSign, true, report);
    assert.ok(corrected.property.symptoms.includes("overheat"), report);
    const denial = report.includes("burning") ? "There is no burning smell" : "It is not shutting off";
    const resolved = turn(denial, corrected, config, INITIAL_FAQS).session;
    assert.equal(resolved.heatSign, false, report);
    assert.equal(isUrgentBooking(resolved), false, report);
  }
});
