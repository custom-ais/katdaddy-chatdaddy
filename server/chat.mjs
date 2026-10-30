// One chat turn: rules engine first for anything exact, Gemini for free-typed messages.

import { turn, detectSafety, applyFacts, WELCOME, START_LABELS } from "../shared/conversation.mjs";

const DIRECT = /^(?:continue(?: booking)?|start over|restart|reset|accept(?: & continue)?|compare packages|more services|back to (?:packages|options)|book this service|book assessment|include assessment|cleaning only|skip|not sure|i don't know|yes|no|ask a question(?: \(faqs\))?|request a callback|\d{5})$/i;
const PICK_LABEL = /^(?:select )?(?:premium 1-2-3|ultimate protection|safety inspection|essential|performance|total system|express|post-service|nest removal \+ cleaning|full system restoration|emergency same-day)(?: ⭐)?(?: · \$[\d,.]+\+?| \(\$[\d,.]+\+?\))?$/i;

const isDirect = (message, session) => {
  const m = message.trim();
  const lower = m.toLowerCase();
  return (
    (session.options || []).some((o) => o.toLowerCase() === lower) ||
    WELCOME.some((o) => o.toLowerCase() === lower) ||
    START_LABELS.includes(lower) ||
    /^select\s+/i.test(m) ||
    /^(?:yes,? let'?s schedule|ask another question)$/i.test(m) ||
    DIRECT.test(m) ||
    PICK_LABEL.test(m) ||
    // multi-select symptom answers arrive as comma-joined option labels
    m.split(/,\s*/).every((part) => (session.options || []).some((o) => o.toLowerCase() === part.toLowerCase()))
  );
};

/** Put the customer's own words back into the record wherever a command stood in for them. */
function restoreWords(result, message, stand) {
  const s = result.session;
  for (let i = s.history.length - 1; i >= 0; i--) {
    if (s.history[i].role === "user") {
      s.history[i] = { role: "user", text: message.slice(0, 2000) };
      break;
    }
  }
  if (stand) s.concerns = s.concerns.map((c) => (c === stand ? message.slice(0, 500) : c));
  return result;
}

function prepend(result, text) {
  if (!text) return result;
  const s = result.session;
  const reply = `${text}\n\n${result.reply}`;
  const last = s.history.at(-1);
  if (last?.role === "assistant") last.text = reply;
  return { ...result, reply };
}

/**
 * @returns {{ session, reply, options, ..., via: 'rules' | 'ai' }}
 */
export async function chatTurn({ message, session, config, faqs, assistant, place = null }) {
  const rules = () => ({ ...turn(message, session, config, faqs, place ? { place } : {}), via: "rules" });
  const aiOn = assistant?.configured && config.aiAssistant !== false;
  if (!aiOn) return rules();
  if (place) return rules(); // an address the server already looked up
  if (isDirect(message, session)) return rules();
  if (detectSafety(message)) return rules();
  if (["emergency", "confirmed", "review"].includes(session.stage)) return rules();
  // Verification codes belong in the code box, never in chat (and never sent to Gemini).
  if (/^\s*\d{4,8}\s*$/.test(message) && ["contact", "verify", "slots"].includes(session.stage)) {
    return { ...turn("continue", session, config, faqs), reply: "Please enter the verification code in the code box below, not in the chat.", via: "rules" };
  }

  let ai;
  try {
    ai = await assistant.interpret({ text: message, session, config, faqs });
  } catch (error) {
    console.error("[assistant]", error.message);
    return { ...rules(), aiError: true };
  }

  // Safety from Gemini can only escalate; BOB's own wording is used.
  if (/^SAFETY_/.test(ai.command || "")) return { ...restoreWords(turn(ai.commandText, session, config, faqs), message), via: "ai" };

  const working = structuredClone(session);
  const canChangeFacts = !working.serviceAccepted && ["welcome", "evaluating", "offer", "details", "bundle_offer"].includes(working.stage);
  const before = JSON.stringify([working.property, working.zip, working.concerns]);
  if (canChangeFacts) {
    const facts = { ...ai.facts };
    // The concern is recorded by the command that needs it (bundle offer / repair start).
    delete facts.concern;
    applyFacts(working, facts);
  }
  const factsChanged = JSON.stringify([working.property, working.zip, working.concerns]) !== before;

  let result;
  if (ai.command) {
    let text = ai.commandText;
    if (ai.command === "ACCEPT" && working.stage === "bundle_offer") text = "Include assessment";
    if (ai.command === "DECLINE" && working.stage === "bundle_offer") text = "Cleaning only";
    if (ai.command === "START_REPAIR" && ai.facts.concern && !working.concerns.length) {
      working.concerns.push(ai.facts.concern);
      working.concernDescribed = true; // their own words describe the issue, so BOB skips the issue list
    }
    const stand = ai.command === "CLEANING_WITH_CONCERN" ? COMMAND_CONCERN : null;
    result = restoreWords(turn(text, working, config, faqs), message, stand);
    if (stand && ai.facts.concern) result.session.concerns = result.session.concerns.map((c) => (c === message.slice(0, 500) ? ai.facts.concern : c));
    if (ai.answer) result = prepend(result, ai.answer);
  } else if (ai.question && ai.answer) {
    result = restoreWords(turn(message, working, config, faqs, { answer: ai.answer }), message);
  } else if (factsChanged) {
    result = restoreWords(turn("continue", working, config, faqs), message);
  } else {
    // Gemini added nothing usable: the rules engine handles the raw text.
    return { ...turn(message, working, config, faqs), via: "rules" };
  }
  if (ai.lead && !ai.answer && !["emergency", "review"].includes(result.session.stage)) result = prepend(result, ai.lead);
  return { ...result, via: "ai" };
}

const COMMAND_CONCERN = "I want a cleaning and I also have a vent repair concern";
