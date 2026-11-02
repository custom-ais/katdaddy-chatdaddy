// One chat turn: rules engine first for anything exact, Gemini for free-typed messages.

import { turn, detectSafety, applyFacts, answeredUnsure, asksForSooner, WELCOME, START_LABELS, UNANSWERED, NOTED } from "../shared/conversation.mjs";

const DIRECT = /^(?:continue(?: booking)?|start over|restart|reset|accept(?: & continue)?|compare packages|more services|back to (?:packages|options)|book this service|book assessment|include assessment|cleaning (?:\+|and) assessment|cleaning only|just (?:the )?cleaning|cancel package|check after-hours availability|keep regular times|skip|not sure|i don't know|yes|no|ask a question(?: \(faqs\))?|request a callback|\d{5})$/i;
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

// Stages whose message must stay exactly as the rules engine wrote it.
const FIXED_STAGES = new Set(["emergency", "confirmed", "contact", "verify", "slots", "approval"]);

/**
 * BOB's voice: for a typed message, the AI writes the opening of the reply (answering what the
 * customer actually said) and the engine's required message follows unchanged. Its short
 * acknowledgement is replaced; safety warnings and the body (question, offer, summary) stay. Any
 * failure, timeout or rejected text keeps the engine's own reply.
 */
async function withVoice(result, { message, session, config, faqs, assistant }) {
  if (typeof assistant?.speak !== "function" || !result?.parts) return result;
  const s = result.session;
  if (FIXED_STAGES.has(s.stage) || FIXED_STAGES.has(session.stage) || s.safety || result.action === "emergency") return result;
  // "I don't know" gets the same reassurance every time: it's fine, and the technician checks on site.
  if (result.parts.ack === NOTED) return result;
  const body = result.unanswered ? String(result.parts.body).replace(UNANSWERED, "").replace(/^\s+/, "") : result.parts.body;
  const next = [result.parts.warn, body].filter(Boolean).join("\n\n");
  let response;
  try {
    // Context is the conversation before this message, with the state after it.
    response = await assistant.speak({ text: message, session: { ...s, history: session.history || [] }, config, faqs, next });
  } catch (error) {
    console.error("[assistant] voice", error.message);
    return result;
  }
  if (!response) return result;
  const reply = [response, next].filter(Boolean).join("\n\n");
  const last = s.history.at(-1);
  if (last?.role === "assistant") last.text = reply;
  return { ...result, reply, voiced: true };
}

/**
 * @returns {{ session, reply, options, ..., via: 'rules' | 'ai' }}
 */
export async function chatTurn(args) {
  const result = await decide(args);
  // Only typed messages get the voice: buttons and exact commands keep their fast, fixed replies.
  if (!result.voiceable) return result;
  const { voiceable, ...rest } = result;
  return withVoice(rest, args);
}

async function decide({ message, session, config, faqs, assistant, place = null }) {
  const rules = () => ({ ...turn(message, session, config, faqs, place ? { place } : {}), via: "rules" });
  const aiOn = assistant?.configured && config.aiAssistant !== false;
  if (!aiOn) return rules();
  if (place) return rules(); // an address the server already looked up
  if (isDirect(message, session)) return rules();
  if (detectSafety(message)) return rules();
  if (asksForSooner(message, session)) return rules(); // the after-hours offer has fixed wording and price
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
    if (ai.command === "ACCEPT" && working.stage === "bundle_offer") text = "Cleaning + Assessment";
    if (ai.command === "DECLINE" && working.stage === "bundle_offer") text = "Just the cleaning";
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
    // The AI recorded "I don't know" for the question BOB asked: same reassurance as the button.
    if (answeredUnsure(session, result.session) && !result.parts?.ack) result = { ...prepend(result, NOTED), parts: { ...result.parts, ack: NOTED } };
  } else {
    // Gemini added nothing usable: the rules engine handles the raw text, and the voice answers it.
    return { ...turn(message, working, config, faqs), via: "rules", voiceable: true, aiRejected: ai.rejected };
  }
  // An approved FAQ answer is already conversational; anything else gets the voice, with the
  // interpreter's short lead kept only as the fallback when the voice can't be used.
  if (ai.answer) return { ...result, via: "ai", aiRejected: ai.rejected };
  const fallback = ai.lead && !["emergency", "review"].includes(result.session.stage) ? prepend(result, ai.lead) : result;
  if (result.parts?.ack === NOTED) return { ...result, via: "ai", aiRejected: ai.rejected };
  return { ...fallback, parts: result.parts, via: "ai", voiceable: true, aiRejected: ai.rejected };
}

const COMMAND_CONCERN = "I want a cleaning and I also have a vent repair concern";
