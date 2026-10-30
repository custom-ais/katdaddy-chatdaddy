// BOB's deterministic booking conversation.
//
// Flow (from the Dryer Vent Squad booking dashboard design):
//   welcome → evaluation questions, one at a time → recommendation with exact prices
//   → package details → "Accept & Continue" → contact details (collected by the page)
//   → phone verification → live times → final approval → booked.
//
// Business rules (rulebook / saved September policy) that stay in force:
//   • gas smell / smoke / fire stops everything; overheating or burning goes to team review
//   • a repair-first visit starts with an assessment; repairs are quoted separately
//   • cleaning + a repair concern gets the $248 cleaning + assessment offer, added only on a yes
//   • appliance problems, commercial work, complaints and "talk to a person" go to the team
//   • facts already given are reused, "Not sure" is accepted, and a question asked mid-booking
//     is answered before returning to the unfinished step
//
// The AI layer (server/assistant.mjs) only translates free text into the commands and
// facts below; every decision about price and booking happens here or on the server.

import { DEFAULT_CONFIG, money, serviceQuote, BUNDLE_PRICE_CENTS } from "./domain.mjs";
import { SERVICE_CATALOG, PACKAGES, TIERS, MORE, fromPrice, homeVariant } from "./catalog.mjs";

export const initialSession = () => ({
  v: 3,
  stage: "welcome",
  intent: null, // cleaning | repair | emergency | nest
  route: null, // cleaning | assessment | bundle
  package: null,
  suggested: null,
  serviceAccepted: false,
  offered: false,
  bundleAccepted: false,
  bundleDeclined: false,
  pending: null,
  property: {},
  concerns: [],
  concernSkipped: false,
  symptomConflict: null, // { tries } while BOB is waiting for a typed clarification
  safety: null,
  explained: [],
  addOns: {},
  zip: "",
  contact: { name: "", phone: "", email: "", address: "", city: "", notes: "", smsConsent: false },
  history: [],
  options: [],
});

/** Welcome cards. The page shows these; the engine accepts them as typed text too. */
export const WELCOME = [
  "Dryer Vent Cleaning",
  "Repair / Reroute / Upgrade",
  "Emergency Clog / Overheating",
  "Pest / Nest Removal",
  "Ask a Question (FAQs)",
  "Help Me Choose",
];

export const QUESTIONS = {
  zip: { text: "What's the five-digit ZIP code for the service address?", options: [] },
  hasDryer: { text: "Do you currently have a dryer installed, or is it just the vent?", options: ["Have Dryer", "No Dryer", "Not sure"] },
  lastCleaned: { text: "Has your dryer vent been professionally cleaned in the last 12 months?", options: ["Yes", "No", "Not sure"] },
  stories: { text: "Is your home a 1-story or 2-story?", options: ["1-Story", "2-Story", "Not sure"] },
  laundryFloor: { text: "Is the laundry room on the 1st floor or the 2nd floor?", options: ["1st Floor", "2nd Floor", "Not sure"] },
  power: { text: "Is your dryer gas or electric?", options: ["Electric", "Gas", "I don't know"], info: ["gas_electric", "why_we_ask"] },
  mount: { text: "Is your dryer standard, on a fixed pedestal, or stacked with a washer?", options: ["Standard", "Fixed Pedestal", "Stacked", "I don't know"], info: ["why_we_ask"] },
  exit: { text: "Does the vent exit through the roof or a side wall? Choose “Not sure” rather than climbing up to check.", options: ["Roof Vent", "Side Wall Vent", "Not sure"] },
  symptoms: {
    text: "How is the dryer performing right now? Select all that apply.",
    options: ["Dries in one normal cycle", "Takes about 2 cycles", "Takes 3 or more cycles", "Dryer is overheating or shutting off", "It's showing an airflow error code"],
    multi: true,
  },
  symptomClarify: { text: "Those answers don't match. How many drying cycles does it usually take? Please type it out in your own words.", options: [] },
  animals: { text: "Have you noticed any bird nests, pests, or animal activity around the outside vent?", options: ["Yes, signs of animals", "No signs", "Not sure"] },
  concern: { text: "In a sentence, what's going on with the vent? For example: disconnected behind the dryer, crushed, or needs rerouting.", options: ["Skip"] },
};

/** Property values the AI layer may fill in (anything else is ignored). */
export const FACT_VALUES = {
  hasDryer: ["Yes", "No", "Not sure"],
  lastCleaned: ["Yes", "No", "Not sure"],
  stories: ["1-story", "2-story", "Not sure"],
  laundryFloor: ["1st floor", "2nd floor", "Not sure"],
  power: ["Electric", "Gas", "Not sure"],
  mount: ["Standard", "Pedestal", "Stacked", "Not sure"],
  exit: ["Roof", "Wall", "Not sure"],
  animals: ["Yes", "No", "Not sure"],
};
export const SYMPTOMS = ["normal", "two", "three", "overheat", "error"];

const normalize = (t) => String(t || "").toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
const ACCEPT = /^(?:accept(?: & continue| and continue)?|book this service|book (?:the )?assessment|book it|yes(?:,? please)?|yep|yeah|sure|sounds good|ok(?:ay)?|let'?s do it|continue with (?:this|it))[.!]?$/;
const ACCEPT_BUNDLE = /^(?:yes|yeah|yep|sure|please|sounds good|okay|ok|include (?:it|the assessment|assessment)|schedule both|add (?:the )?assessment|book (?:both|it)|yes[, ]+(?:include (?:the )?assessment|both|please))[.!]?$/;
const NO = /^(no|nope|no thanks|not now|decline|just (?:the )?cleaning|cleaning only|skip assessment)[.!]?$/;
const PRICE = /\b(how much|price|prices|pricing|cost|costs|charge|total|quote|\$248|248)\b/;
const QUESTION = /^(how|what|when|where|why|who|can|could|do|does|is|are|will|would|should|tell me|explain|if)\b/;
const CLEAN = /\b(clean(?:ing)?|cleaned|maintenance|annual|routine)\b/;
const REPAIR = /\b(repair|fix|replac\w*|rerout\w*|disconnect\w*|crush\w*|damag\w*|came (?:apart|off)|fallen|fell off|broken|loose|hole|leak\w*|install\w*|upgrade)\b/;
const VENT = /\b(vent|duct|hose|connection|outlet|termination|roof cap|dryerbox|dryerjack|line)\b/;
const NEG_REPAIR = /\b(no|not|without|don't need|do not need)\s+(?:any |a |an )?(?:repairs?|damage|assessment|problem|issue|replacement)\b/;
const NO_CLEAN = /\b(no cleaning|not cleaning|don't (?:need|want) (?:a |the )?cleaning|do not (?:need|want) (?:a |the )?cleaning|cancel (?:the )?cleaning|assessment (?:only|instead)|just (?:the |an? )?assessment|only (?:an? )?assessment)\b/;
const NEST = /\b(nests?|birds?|rodents?|pests?|critters?|squirrels?|mouse|mice|rats?|chirping)\b/;
const URGENT = /\b(emergency|urgent|urgently|asap|same[- ]day|right away|today|completely (?:clogged|blocked)|totally (?:clogged|blocked)|fully (?:clogged|blocked))\b/;
const CLOG = /\b(clog\w*|blocked|blockage|no airflow|lint (?:buildup|build-up))\b/;
const UNKNOWN = /^(?:i(?:'m| am)? )?(?:don't know|do not know|not sure|unsure|unknown|no idea|i don't know)[.!]?$/;
const PICKS = [
  ["essential", /^essential\b/],
  ["performance", /^performance\b/],
  ["total", /^total(?: system)?\b/],
  ["express", /^(?:book )?express\b/],
  ["postservice", /^post-?service\b/],
  ["nest", /^nest(?: removal)?\b/],
  ["restoration", /^(?:full system )?restoration\b|^full system restoration\b/],
  ["emergency", /^(?:book )?emergency(?: same-day)?(?: ·|$| clog relief)/],
];

export function detectSafety(text) {
  const t = normalize(text);
  if (/^(?:what|how|can|does|is|do|why)\b/.test(t) && /\b(?:prevent|risk|cause|what if|what should|what do|mean)\b/.test(t) && !/(?:my|our|there is|i smell)/.test(t)) return null;
  const clauses = t.split(/[.;]|\bbut\b/).filter((c) => !/^\s*(?:there is |there's |i have |we have )?(?:no |not |without |isn't |aren't |don't smell |do not smell )/.test(c));
  const actual = clauses
    .join(" ")
    .replace(/\b(?:i |we )?(?:do not|don't|cannot|can't) (?:smell|see) (?:any )?(?:gas|smoke|flames)\b/g, "")
    .replace(/\b(?:no|not|without) (?:a |any )?(?:gas (?:smell|odor|odour|leak)|smoke|flames|burning smell|overheating)\b/g, "");
  if (/\b(gas (?:smell|odor|odour|leak)|smell(?:ing)? (?:natural )?gas|smells like (?:natural )?gas|rotten eggs)\b/.test(actual)) return "gas";
  if (/\b(smell(?:ing)? smoke|smoke (?:in|from|around)|full of smoke|smoke (?:coming|is coming)|(?:see|seeing|there is|there's) smoke|smoking|on fire|flames|fire (?:in|coming|behind)|dryer (?:has |is )?smoke)\b/.test(actual)) return "fire";
  if (/\b(burning smell|smell(?:s|ing)? (?:like )?(?:something )?burning|overheat(?:ing|s|ed)?|hot to (?:the )?touch|shutting off)\b/.test(actual)) return "stop";
  return null;
}

export function classify(text, session = initialSession()) {
  const t = normalize(text), s = detectSafety(t);
  if (s === "gas" || s === "fire") return { route: "emergency", safety: s };
  if (/\b(?:kitchen ventilation|kitchen exhaust|chimney|hvac|air ducts)\b/.test(t)) return { route: "review" };
  if (/\b(?:human|person|someone|representative|callback|call me|call back|talk to (?:the )?team|complaint|warranty|refund|reschedule|cancel (?:my |the )?(?:appointment|booking)|commercial|hoa|apartments|multi-unit)\b/.test(t)) return { route: "review" };
  if (/\b(dryer|machine|appliance)\b/.test(t) && /\b(won't (?:turn on|start|spin|heat)|will not (?:turn on|start|spin|heat)|not (?:turning on|starting|spinning|heating)|motor|drum|control board|dryer is broken|broken dryer|repair my dryer)\b/.test(t) && !VENT.test(t)) return { route: "appliance" };
  if (NO_CLEAN.test(t)) return { route: "assessment", explicitSwitch: true };
  if (NEST.test(t)) return { route: "nest_offer" };
  if (URGENT.test(t) && !/\b(?:can you (?:come|get here)|available|availability|open)\b.*\btoday\b/.test(t)) return { route: "emergency_offer" };
  if (CLOG.test(t) && !REPAIR.test(t)) return { route: "clog_offer" };
  if (/^(?:do|can|could) you (?:also )?(?:do |handle )?(?:repairs?|repair (?:dryer )?vents|fix (?:dryer )?vents)[?!.]*$/.test(t)) return { route: null, faq: "repair" };
  const wantsCleaning = CLEAN.test(t) && !(/\b(?:recently|already|just|last (?:week|month)|after|had it|was|been)\s+(?:had (?:it|the vent) )?cleaned\b/.test(t) && !/(?:need|want|schedule|book).*clean/.test(t));
  const setupOnly = /^(?:i |we )?(?:have (?:a |an )?|there is )?(?:no dryer|(?:a |an )?(?:gas|electric|stacked|standard) dryer|dryer (?:is |is not |not )?installed)[.!]?$/.test(t);
  const repair = REPAIR.test(t) && !NEG_REPAIR.test(t) && !setupOnly;
  const assessment = /\b(?:assessment|evaluate|evaluation|recurr\w*)\b/.test(t) || /\bcheck (?:the |my |our )?(?:connection|roof (?:vent|outlet)|outlet)\b/.test(t);
  if (wantsCleaning && session.route === "assessment" && /\b(?:also|too|both|with|add)\b/.test(t)) return { route: "bundle_offer", safety: s };
  if ((repair || assessment) && wantsCleaning) return { route: "bundle_offer", safety: s };
  if ((repair || assessment) && session.intent === "cleaning" && !NO_CLEAN.test(t)) return { route: "bundle_offer", safety: s };
  if (repair || assessment) return { route: "assessment", safety: s };
  if (wantsCleaning) return { route: "cleaning", safety: s };
  if (s === "stop") return { route: "review", safety: s };
  if (/\b(takes? (?:too )?long|two cycles|2 cycles|multiple cycles|still damp|airflow error|d80|d90|error code)\b/.test(t)) return { route: session.route || "clarify" };
  return { route: null };
}

// ---- property facts ------------------------------------------------------------------

function parseField(key, t) {
  switch (key) {
    case "hasDryer":
      if (/^(?:have dryer|yes|yep|yeah|i have (?:a |one)|dryer is installed|it's installed)/.test(t)) return "Yes";
      if (/^(?:no dryer|no|nope|just the vent|vent only|not installed)/.test(t)) return "No";
      return null;
    case "lastCleaned":
    case "animals":
      if (/^(?:yes|yep|yeah)\b/.test(t)) return "Yes";
      if (/^(?:no|nope|never|no signs)\b/.test(t)) return "No";
      return null;
    case "stories":
      if (/\b(?:1|one|single)[- ]?stor(?:y|ey)\b/.test(t)) return "1-story";
      if (/\b(?:2|two)[- ]?stor(?:y|ey)\b/.test(t)) return "2-story";
      return null;
    case "laundryFloor":
      if (/\b(?:1st|first) floor|downstairs|ground floor\b/.test(t)) return "1st floor";
      if (/\b(?:2nd|second) floor|upstairs\b/.test(t)) return "2nd floor";
      return null;
    case "power":
      if (/\belectric\b/.test(t) && !/\b(?:not|no) electric\b/.test(t)) return "Electric";
      if (/\bgas\b/.test(t) && !/\b(?:not|no) gas\b/.test(t)) return "Gas";
      return null;
    case "mount":
      if (/\b(?:not stacked|standard|side[- ]by[- ]side|regular)\b/.test(t)) return "Standard";
      if (/\bstacked\b/.test(t)) return "Stacked";
      if (/\bpedestal\b/.test(t)) return "Pedestal";
      return null;
    case "exit":
      if (/\broof\b/.test(t)) return "Roof";
      if (/\b(?:side wall|wall)\b/.test(t)) return "Wall";
      return null;
    default:
      return null;
  }
}

export function parseSymptoms(t) {
  const out = [];
  if (/\b(?:one normal cycle|normal cycle|dries (?:fine|normally|in one)|working normal(?:ly)?|no problems?)\b/.test(t) || /(?<!than )\b(?:one|1) (?:normal )?cycle\b/.test(t)) out.push("normal");
  if (/\b(?:about 2 cycles|2 cycles|two cycles|more than one(?: cycle| time| load| try)?|takes (?:a )?(?:bit )?longer)\b/.test(t)) out.push("two");
  if (/\b(?:3 or more|three or more|3 cycles|three cycles|3\+|multiple cycles|forever)\b/.test(t)) out.push("three");
  if (/\b(?:overheat\w*|shutting off|shuts off|hot to (?:the )?touch)\b/.test(t)) out.push("overheat");
  if (/\b(?:error code|airflow error|d80|d90|d95|check vent)\b/.test(t)) out.push("error");
  return out;
}

/** Only one drying-cycle answer can be true: one normal cycle, about two, or three or more. */
export function cycleConflict(found) {
  return found.filter((x) => ["normal", "two", "three"].includes(x)).length > 1;
}

function learnSymptoms(t, s, clarifying) {
  const found = [...new Set(parseSymptoms(t))];
  const tries = s.symptomConflict?.tries || 1;
  const settle = (list) => {
    s.property.symptoms = list;
    s.symptomConflict = null;
  };
  // Contradictory answers are never guessed at: BOB asks for the answer in the customer's own words.
  if (cycleConflict(found)) {
    if (clarifying && tries >= 2) return settle([]);
    s.symptomConflict = { tries: clarifying ? tries + 1 : 1 };
    s.pending = "symptomClarify";
    return;
  }
  if (found.length) return settle(found);
  if (UNKNOWN.test(t)) return settle([]);
  if (clarifying) {
    if (tries >= 2) return settle([]); // unclear twice: recorded as not sure, the technician checks on site
    s.symptomConflict = { tries: tries + 1 };
  }
}

/** Learn property facts from what the customer said. Questions and hypotheticals teach nothing. */
function learn(text, s) {
  const t = normalize(text), p = s.property;
  const hypothetical = QUESTION.test(t) || t.endsWith("?") || /\b(?:what if|if i|if we|would it|suppose)\b/.test(t);
  if (s.pending && QUESTIONS[s.pending] && !hypothetical) {
    const key = s.pending;
    if (key === "zip") {
      const m = t.match(/\b(\d{5})\b/);
      if (m) s.zip = m[1];
    } else if (key === "symptoms" || key === "symptomClarify") {
      learnSymptoms(t, s, key === "symptomClarify");
    } else if (key === "concern") {
      if (/^skip$/.test(t)) s.concernSkipped = true;
      else if (t.length >= 3 && !PICKS.some(([, re]) => re.test(t)) && !WELCOME.map(normalize).includes(t)) s.concerns.push(String(text).slice(0, 500));
    } else if (UNKNOWN.test(t) || /^not sure\b/.test(t)) {
      p[key] = "Not sure";
    } else {
      const v = parseField(key, t);
      if (v) p[key] = v;
    }
  }
  if (hypothetical) return;
  // Volunteered details ("2-story with a gas dryer upstairs").
  for (const key of ["stories", "laundryFloor", "power", "mount"]) {
    if (p[key] && p[key] !== "Not sure") continue;
    const v = parseField(key, t);
    if (v && (key !== "power" || !detectSafety(t))) p[key] = v;
  }
  if (!p.hasDryer && /\b(?:no dryer|don't have a dryer|do not have a dryer|dryer (?:was )?removed|dryer is not installed|vent only|just the vent)\b/.test(t)) p.hasDryer = "No";
  else if (!p.hasDryer && /\b(?:have (?:a |an )?(?:gas |electric )?dryer|dryer installed|have dryer|my dryer)\b/.test(t)) p.hasDryer = "Yes";
  if (!p.exit && /\b(?:roof vent|exits? (?:through|on|out) the roof)\b/.test(t)) p.exit = "Roof";
  if (!p.exit && /\b(?:side wall|wall vent|exits? (?:through|out) the (?:side )?wall)\b/.test(t)) p.exit = "Wall";
  if (!s.zip) {
    const m = t.match(/\b(?:zip(?: code)?|in|at)\s*:?\s*(\d{5})\b/) || (s.pending === "zip" ? t.match(/\b(\d{5})\b/) : null);
    if (m) s.zip = m[1];
  }
}

/** Apply facts from the AI layer, keeping only allowed values. */
export function applyFacts(session, facts = {}) {
  const p = session.property;
  for (const [key, values] of Object.entries(FACT_VALUES)) {
    if (values.includes(facts[key])) p[key] = facts[key];
  }
  if (Array.isArray(facts.symptoms)) {
    const list = [...new Set(facts.symptoms.filter((x) => SYMPTOMS.includes(x)))];
    if (cycleConflict(list)) {
      session.symptomConflict = { tries: 1 };
      session.pending = "symptomClarify";
    } else if (list.length) {
      p.symptoms = list;
      session.symptomConflict = null;
    }
  }
  if (typeof facts.zip === "string" && /^\d{5}$/.test(facts.zip)) session.zip = facts.zip;
  if (typeof facts.concern === "string" && facts.concern.trim().length >= 3 && !session.concerns.includes(facts.concern.trim())) {
    session.concerns.push(facts.concern.trim().slice(0, 500));
  }
  return session;
}

// ---- the conversation -----------------------------------------------------------------

const hasDryer = (s) => s.property.hasDryer !== "No";
const twoStory = (s) => s.property.stories === "2-story";

/** Which questions apply, in order, for this visit. */
export function questionOrder(s) {
  const p = s.property;
  if (!s.intent) return [];
  const base = ["zip", "hasDryer"];
  if (s.intent === "cleaning") {
    return [
      ...base,
      hasDryer(s) && "lastCleaned",
      "stories",
      twoStory(s) && "laundryFloor",
      hasDryer(s) && "power",
      hasDryer(s) && "mount",
      p.hasDryer === "No" && "exit",
      hasDryer(s) && !s.package && s.route !== "bundle" && "symptoms",
      !["nest", "restoration"].includes(s.package) && "animals",
    ].filter(Boolean);
  }
  if (s.intent === "repair") {
    return [...base, "stories", twoStory(s) && "laundryFloor", hasDryer(s) && "power", hasDryer(s) && "mount", "exit", "concern"].filter(Boolean);
  }
  // emergency + nest: only what price and access depend on.
  return [...base, "stories", twoStory(s) && "laundryFloor", hasDryer(s) && "power"].filter(Boolean);
}

const answered = (s, key) =>
  key === "zip" ? Boolean(s.zip) : key === "concern" ? s.concerns.length > 0 || s.concernSkipped : key === "symptoms" ? Array.isArray(s.property.symptoms) : s.property[key] != null;

export function turn(text, current, config = DEFAULT_CONFIG, faqs = [], opts = {}) {
  const s = structuredClone(current || initialSession());
  if (!s.v) Object.assign(s, { ...initialSession(), ...s, v: 3 });
  const t = normalize(text);
  const services = config.services || SERVICE_CATALOG;
  const priced = Boolean(config.pricesAcknowledged);
  const approvedFaqs = (faqs || []).filter((f) => f && f.status !== "draft");
  s.history = [...(s.history || []).slice(-39), { role: "user", text: String(text).slice(0, 2000) }];

  const respond = (reply, options = [], extra = {}) => {
    s.history.push({ role: "assistant", text: reply });
    s.options = options;
    return { session: s, reply, options, ...extra };
  };

  // -- copy helpers --------------------------------------------------------------------
  const explain = (route) => {
    if (s.explained.includes(route)) return "";
    s.explained.push(route);
    if (route === "cleaning") return config.cleaningProcess + "\n\n";
    if (route === "assessment") return config.assessmentProcess + "\n\n";
    return config.cleaningProcess + " " + config.assessmentProcess + "\n\n";
  };
  const quoteFor = (family) => serviceQuote("cleaning", config, { package: family, property: s.property, addOns: s.addOns });
  const exact = (family) => {
    try {
      const q = quoteFor(family);
      return q.lineItems[0].cents;
    } catch {
      return fromPrice(services, family);
    }
  };
  const variantKnown = () => homeVariant(s.property).certain;
  // Before the home questions, sized packages show their lowest ("from") price.
  const sized = (family) => ["essential", "performance", "total", "express", "postservice"].includes(family) && s.property.stories == null;
  const amountOf = (family) => (sized(family) ? `${money(fromPrice(services, family) ?? 0)}+` : money(exact(family) ?? 0));
  const priceOf = (family) => (priced ? amountOf(family) : "");
  const label = (family) => {
    const amount = priceOf(family);
    return amount ? `${PACKAGES[family].label} · ${amount}` : PACKAGES[family].label;
  };
  const line = (family, star) =>
    `• **${PACKAGES[family].short}${priced ? ` — ${sized(family) ? "from " + money(fromPrice(services, family) ?? 0) : money(exact(family) ?? 0)}` : ""}**${star ? " ⭐ Suggested" : ""}: ${PACKAGES[family].pitch}.`;
  const unverified = "The team needs to verify the standalone service price before a price-confirmed appointment can be made.";
  const gasNote = () => (s.property.power === "Gas" ? "\n\nGas dryers add the $49 Gas Appliance Safety Procedure (safe disconnect and reconnect)." : "");
  const homeLabel = () => {
    const { variant, certain } = homeVariant(s.property);
    if (!certain) return "";
    return variant === "1-story" ? " for a 1-story home" : variant === "2-story-upstairs" ? " for a 2-story home with upstairs laundry" : " for a 2-story home";
  };
  const needsApproval = (family) => (config.approvalServices || ["emergency"]).includes(family);

  // -- steps ---------------------------------------------------------------------------
  const ask = (key) => {
    s.pending = key;
    s.stage = "evaluating";
    const q = QUESTIONS[key];
    return respond(q.text, q.options, { ...(q.multi ? { multi: true } : {}), ...(q.info ? { info: q.info } : {}) });
  };

  const askSymptomClarify = () => {
    s.pending = "symptomClarify";
    s.stage = "evaluating";
    const again = (s.symptomConflict?.tries || 1) > 1;
    const lead = again
      ? "Sorry, I still can't tell which one is right."
      : "Those answers don't match: a dryer can't take one cycle and more than one cycle at the same time.";
    return respond(`${lead} Please type out how many cycles it usually takes, in your own words. For example: "it dries in one cycle" or "about two cycles".`, []);
  };

  const welcome = (lead = "How can I help with your dryer vent today?") => {
    s.stage = "welcome";
    s.pending = null;
    return respond(lead, WELCOME.filter((x) => x !== "Help Me Choose"));
  };

  const tierOffer = (brief) => {
    const sym = s.property.symptoms || [];
    const suggested = sym.includes("three") || sym.includes("error") ? "total" : sym.includes("two") ? "performance" : "essential";
    s.suggested = suggested;
    s.offerFamilies = TIERS;
    s.stage = "offer";
    const why =
      suggested === "total"
        ? "Since drying takes 3 or more cycles or shows an airflow error, I'd suggest **Total System**: it adds termination cleanout and correction of significant airflow restriction. Symptoms alone aren't a diagnosis; your technician verifies airflow before and after."
        : suggested === "performance"
          ? "Since loads are taking about 2 cycles, I'd suggest **Performance**: it adds before-and-after photos and a DryerFlex transition hose upgrade. Your technician verifies airflow before and after."
          : "For routine maintenance, **Essential** covers the full vent cleaning and inspection.";
    const options = [...TIERS.map(label), "Compare Packages", "More services"];
    if (brief) return respond("Which package would you like?", options, { suggested: label(suggested) });
    const intro = explain("cleaning");
    const prices = priced
      ? `Here are your options${homeLabel()}:\n` + TIERS.map((f) => line(f, f === suggested)).join("\n") + (variantKnown() ? "" : "\n\nPrices shown are for a 2-story home with first-floor laundry; your technician confirms on site.") + gasNote()
      : TIERS.map((f) => line(f, f === suggested)).join("\n") + "\n\n" + unverified;
    return respond(`${intro}${why}\n\n${prices}`, options, { suggested: label(suggested), info: ["pricing"] });
  };

  const specialOffer = (families, suggested, lead, brief, extraOptions = ["Ask a question"]) => {
    s.suggested = suggested;
    s.offerFamilies = families;
    s.stage = "offer";
    const options = [...families.map(label), ...extraOptions];
    if (brief) return respond("Which option would you like?", options, { suggested: label(suggested) });
    const list = families.map((f) => line(f, families.length > 1 && f === suggested)).join("\n");
    return respond(`${lead}\n\n${list}${priced ? gasNote() : "\n\n" + unverified}`, options, { suggested: label(suggested) });
  };

  const assessmentOffer = (brief) => {
    s.route = "assessment";
    s.stage = "offer";
    s.suggested = null;
    if (brief) return respond("Would you like to book the assessment?", ["Book assessment", "Ask a question"]);
    const q = serviceQuote("assessment", config);
    const price = priced ? `**Dryer-vent assessment: ${money(q.priceCents)}.** This is the assessment, not the repair. Any repair work is quoted separately for your approval.` : unverified;
    return respond(`For a vent repair issue, we start with an assessment. ${explain("assessment")}${price}\n\nWould you like to book the assessment?`, ["Book assessment", "Ask a question"]);
  };

  const bundleOffer = () => {
    s.stage = "bundle_offer";
    s.offered = true;
    s.pending = null;
    return respond(
      `${explain("bundle")}For that additional concern, the assessment lets us evaluate the issue and explain the recommended repair options. With your cleaning, the assessment is 50% off — **${money(BUNDLE_PRICE_CENTS)} total for cleaning + assessment** (Essential See-It-Clean plus the assessment). Any repair work is quoted separately.\n\nWould you like to include the assessment?`,
      ["Include assessment", "Cleaning only", "Ask a question"],
    );
  };

  const offer = (brief = false) => {
    if (s.intent === "repair") return assessmentOffer(brief);
    if (s.intent === "emergency") {
      return specialOffer(
        ["emergency"],
        "emergency",
        "For a vent that's fully clogged and needs attention fast, there's our same-day service. Same-day visits need a quick approval from our team before they're confirmed — you'll pick a time and we'll ask them right away. If the dryer is overheating or smells like burning, stop using it now.",
        brief,
        ["Schedule regular cleaning", "Ask a question"],
      );
    }
    if (s.intent === "nest" || s.property.animals === "Yes") {
      return specialOffer(["nest", "restoration"], "nest", "Birds or pests in a vent need to be removed before the vent is cleaned.", brief);
    }
    if (s.property.hasDryer === "No") {
      return specialOffer(["express"], "express", "With no dryer installed, the visit is our **Express Vent Cleaning** — vent only, so there's no appliance to move or disconnect.", brief);
    }
    return tierOffer(brief);
  };

  const details = (brief = false) => {
    s.stage = "details";
    s.route = "cleaning";
    s.pending = null;
    let q;
    try {
      q = quoteFor(s.package);
    } catch {
      s.package = null;
      return respond("That service isn't available online right now. You can choose another option or send the team a request.", ["Back to packages", "Request a callback"]);
    }
    const options = ["Accept & Continue", s.intent === "cleaning" && TIERS.includes(q.package) ? "Compare Packages" : "Back to options", "Ask a question"];
    const title = `**${q.name}${priced ? ` — ${money(q.lineItems[0].cents)}` : ""}**`;
    if (brief) return respond(`Ready to continue with ${title}?`, options);
    const switched =
      s.package !== q.package
        ? q.package === "express"
          ? "Since no dryer is installed, this visit is our Express Vent Cleaning (vent only).\n\n"
          : `Since a dryer is installed, this visit is our ${PACKAGES[q.package].short}.\n\n`
        : "";
    s.package = q.package;
    const bullets = q.lineItems[0].description
      .replace(/\s*—.*$/, "")
      .replace(/\.$/, "")
      .split(/,\s*(?:(?:and|plus)\s+)?|\s+plus\s+/i)
      .filter((x) => x.trim().length > 2)
      .map((x) => "• " + x.trim().replace(/^./, (c) => c.toUpperCase()))
      .join("\n");
    const extras = q.lineItems.slice(1);
    const total = priced
      ? extras.length
        ? `\n\n${q.lineItems.map((l) => `${l.name}: ${money(l.cents)}`).join("\n")}\n**Total: ${money(q.priceCents)}**`
        : ""
      : `\n\n${unverified}`;
    const note = q.priceNote && priced ? `\n\n${q.priceNote}` : "";
    const approval = needsApproval(q.package) ? "\n\nThis service needs approval from our team before it's confirmed." : "";
    return respond(`${switched}${title}\n${bullets}${total}${note}${approval}\n\n**Upfront pricing:** most visits are completed at the package price.`, options, { info: ["pricing"] });
  };

  const contactStep = () => {
    s.stage = "contact";
    s.pending = null;
    return respond(
      "Let's get your contact details and service address. Then I'll check live availability for the full visit. Your appointment isn't booked until you approve the final summary and receive a confirmation.",
      [],
      { action: "contact" },
    );
  };

  /** Where the booking stands: the next unanswered question, the offer, the details, or contact. */
  const next = (brief = false) => {
    if (!s.intent) return welcome();
    if (s.zip && !(config.serviceZips || []).includes(s.zip)) {
      s.stage = "review";
      s.pending = null;
      return respond("I need the team to confirm service coverage for that ZIP code before offering an appointment. You can send a request for review below.", [], { action: "request" });
    }
    // A contradictory symptom answer is clarified in the customer's own words before anything else.
    if (s.symptomConflict) {
      if (s.pending === "symptomClarify") return askSymptomClarify();
      s.symptomConflict = null;
    }
    // An open $248 offer needs a yes or no before anything else.
    if (s.stage === "bundle_offer" && s.offered && !s.bundleAccepted && !s.bundleDeclined) return bundleOffer();
    // Repairs, same-day and nest removal don't depend on the home's size: show the offer
    // first, then ask the questions the visit needs.
    if (!s.serviceAccepted && !s.package && ["repair", "emergency", "nest"].includes(s.intent)) return offer(brief);
    const missing = questionOrder(s).find((k) => !answered(s, k));
    if (missing) return ask(missing);
    s.pending = null;
    if (s.serviceAccepted) return contactStep();
    if (s.package) return details(brief);
    return offer(brief);
  };

  /** A short reminder of the unfinished step, for after an answered question. */
  const resume = (lead) => {
    const before = { stage: s.stage, pending: s.pending, explained: [...s.explained] };
    if (s.stage === "review") return respond(lead, [], { action: "request" });
    if (["emergency", "confirmed"].includes(s.stage)) return respond(lead, []);
    if (["contact", "verify", "slots", "approval"].includes(s.stage)) return respond(`${lead}\n\nWhen you're ready, continue with the booking below.`, [], { action: "resume" });
    if (!s.intent) return welcome(`${lead}\n\nIs there anything I can help you book?`);
    if (s.stage === "bundle_offer") return respond(`${lead}\n\nWould you like to include the assessment with cleaning for ${money(BUNDLE_PRICE_CENTS)} total?`, ["Include assessment", "Cleaning only"]);
    const step = next(true);
    s.explained = before.explained;
    s.history.pop();
    const body = `${lead}\n\n${step.reply}`;
    s.history.push({ role: "assistant", text: body });
    return { ...step, reply: body };
  };

  const startIntent = (intent, { keepPackage = false } = {}) => {
    s.intent = intent;
    s.serviceAccepted = false;
    s.pending = null;
    if (!keepPackage) s.package = null;
    if (intent === "repair") s.route = "assessment";
    else if (s.route !== "bundle") s.route = "cleaning";
  };

  // -- safety first ----------------------------------------------------------------------
  const welcomeCard = WELCOME.map(normalize).indexOf(t);
  const safety = welcomeCard >= 0 ? null : detectSafety(t);
  if (safety === "gas" || safety === "fire") {
    s.stage = "emergency";
    s.safety = safety;
    s.pending = null;
    s.serviceAccepted = false;
    return respond(
      safety === "gas"
        ? "Leave the building immediately and call 911 and your gas utility from a safe location. Do not operate switches, plugs, appliance controls, flames, or anything that could create a spark. Do not move or disconnect the dryer."
        : "Leave the building immediately, stay outside, and call 911 from a safe location. Do not go back inside for the dryer or try to continue the booking.",
      [],
      { action: "emergency" },
    );
  }
  if (s.stage === "emergency") return respond("Do not resume using the dryer. Emergency responders or a qualified professional must confirm the immediate danger is resolved. For non-emergency follow-up, you can send the DVS team a request.", [], { action: "request" });
  if (safety === "stop") {
    s.safety = "stop";
    s.stage = "review";
    s.serviceAccepted = false;
    s.pending = null;
    return respond("Stop using the dryer if you can do so safely, and arrange a professional evaluation. If there is smoke, fire, or a suspected gas leak, leave immediately and call 911 from a safe location. I'll route this to our team for review rather than book a routine cleaning.", [], { action: "request" });
  }

  // An answer written by the AI layer: show it, then return to the unfinished step.
  if (typeof opts.answer === "string" && opts.answer.trim()) return { ...resume(opts.answer.trim()), ai: true };

  // -- global commands -------------------------------------------------------------------
  if (/^(?:start over|restart|new conversation|reset)$/.test(t)) {
    const fresh = initialSession();
    Object.assign(s, { ...fresh, history: s.history });
    return welcome();
  }
  if (/\b(ignore (?:all|previous|your)|system prompt|change (?:your |the )?rules|pretend.*(?:book|confirm)|make (?:it|the price) free|developer mode)\b/.test(t)) {
    return respond("I can help with approved DVS services, prices, and booking requests. I can't change pricing or confirm an appointment outside the booking system.", s.intent ? ["Continue booking", "Ask a question"] : WELCOME.slice(0, 4));
  }
  if (/\b(?:are you (?:a |an )?(?:real person|human|ai|bot|robot)|who are you|is this (?:a |an )?(?:ai|bot|automated assistant))\b/.test(t)) {
    return respond("I'm BOB, Dryer Vent Squad's automated online booking assistant — not a person. I can explain our services and prices, check the live schedule, and send a request to the team.", ["Request a callback", ...(s.intent ? ["Continue booking"] : ["Dryer Vent Cleaning", "Repair / Reroute / Upgrade"])]);
  }
  if (s.stage === "review" && !/^(?:continue|continue booking)$/.test(t)) {
    return respond("You can send the request below. The team will review it; no appointment or appointment change is confirmed by a request.", [], { action: "request" });
  }
  if (s.stage === "confirmed") return respond("This conversation already has a confirmed booking. Start a new conversation for another visit.", ["Start over"]);

  // -- welcome cards ---------------------------------------------------------------------
  if (welcomeCard === 0 || welcomeCard === 5 || /^(?:schedule (?:a )?(?:regular )?cleaning|book (?:dryer vent )?cleaning|book dryer vent cleaning)$/.test(t)) {
    if (s.intent === "cleaning" && s.package && !/regular/.test(t)) return next();
    startIntent("cleaning");
    s.bundleAccepted = false;
    s.route = "cleaning";
    return next();
  }
  if (welcomeCard === 1 || /^(?:vent issue or repair|book assessment|assessment)$/.test(t) && !s.intent) {
    startIntent("repair");
    return next();
  }
  if (welcomeCard === 2 || /^emergency clog(?: relief)?$/.test(t)) {
    startIntent("emergency");
    return next();
  }
  if (welcomeCard === 3) {
    startIntent("nest");
    return next();
  }
  if (welcomeCard === 4 || /^(?:ask (?:a|another) question|faqs?)$/.test(t)) {
    const picks = approvedFaqs.slice(0, 5).map((f) => f.question);
    return respond("What would you like to know? Your booking answers stay in this conversation.", [...picks, ...(s.intent ? ["Continue booking"] : [])]);
  }
  if (/^(?:continue|continue booking|back to (?:my )?booking|resume)$/.test(t)) return s.intent ? next() : welcome();

  const pendingBefore = s.pending;
  learn(text, s);
  const changed = (x) => JSON.stringify(x?.property || {}) + (x?.zip || "") + (x?.concerns?.length || 0) + Boolean(x?.concernSkipped) + "|" + (x?.symptomConflict?.tries || 0);
  // A free-text answer to "what's going on with the vent?" is recorded, not re-routed.
  if (pendingBefore === "concern" && changed(current) !== changed(s)) return next();

  // -- package picks -----------------------------------------------------------------------
  const pick = s.stage !== "bundle_offer" && PICKS.find(([, re]) => re.test(t));
  if (pick) {
    const family = pick[0];
    if (!s.intent || (s.intent === "repair" && s.route !== "bundle")) s.intent = family === "emergency" ? "emergency" : ["nest", "restoration"].includes(family) ? "nest" : "cleaning";
    if (family === "emergency") s.intent = "emergency";
    s.route = "cleaning";
    s.bundleAccepted = false;
    s.package = family;
    s.serviceAccepted = false;
    s.pending = null;
    return next();
  }
  if (/^(?:compare(?: packages)?|compare the packages)$/.test(t)) {
    const options = [...TIERS.map(label), "More services"];
    const rows = TIERS.map((f) => {
      const item = services.find((x) => x.family === f && x.active !== false);
      return `• **${PACKAGES[f].short}${priced ? ` (${money(exact(f) ?? 0)})` : ""}**: ${(item?.description || PACKAGES[f].pitch).replace(/\.$/, "")}.`;
    });
    s.stage = s.package ? "details" : "offer";
    if (!s.intent) s.intent = "cleaning";
    return respond(`Here's how the packages compare${homeLabel()}:\n\n${rows.join("\n")}`, options, { suggested: s.suggested ? label(s.suggested) : undefined });
  }
  if (/^(?:more services|see all services|other services)$/.test(t)) {
    if (!s.intent) s.intent = "cleaning";
    s.stage = "offer";
    s.serviceAccepted = false;
    return respond("Here are our other services:\n" + MORE.map((f) => line(f)).join("\n"), [...MORE.map(label), "Back to packages"]);
  }
  if (/^(?:back to (?:packages|options))$/.test(t)) {
    s.package = null;
    s.serviceAccepted = false;
    if (!s.intent || s.intent === "repair") s.intent = "cleaning";
    if (s.intent === "emergency" || s.intent === "nest") s.intent = "cleaning";
    s.route = "cleaning";
    return next();
  }

  // -- bundle offer answers ------------------------------------------------------------------
  if (NO_CLEAN.test(t) && (s.route === "bundle" || s.stage === "bundle_offer" || s.intent === "cleaning")) {
    s.intent = "repair";
    s.route = "assessment";
    s.bundleAccepted = false;
    s.offered = false;
    s.serviceAccepted = false;
    s.package = null;
    const r = next();
    if (s.stage === "offer") {
      s.history.pop();
      const reply = `Without cleaning, the combined offer doesn't apply.\n\n${r.reply}`;
      s.history.push({ role: "assistant", text: reply });
      return { ...r, reply };
    }
    return r;
  }
  if (s.stage === "bundle_offer") {
    if (ACCEPT_BUNDLE.test(t)) {
      s.intent = "cleaning";
      s.route = "bundle";
      s.package = "essential";
      s.bundleAccepted = true;
      s.serviceAccepted = true;
      s.stage = "evaluating";
      return next();
    }
    if (NO.test(t)) {
      s.route = "cleaning";
      s.bundleDeclined = true;
      s.offered = false;
      s.serviceAccepted = false;
      s.stage = "evaluating";
      if (s.concerns.some((c) => /disconnect|came apart|crush|collapsed|fell off/i.test(c))) {
        s.stage = "review";
        return respond("I've noted that you declined the assessment. Because the reported vent condition may prevent safe cleaning, the team needs to review the request before confirming a cleaning-only visit.", [], { action: "request" });
      }
      const r = next();
      s.history.pop();
      const reply = `We'll keep this as cleaning only and note your concern. The assessment isn't included, and cleaning isn't a promise to resolve that issue.\n\n${r.reply}`;
      s.history.push({ role: "assistant", text: reply });
      return { ...r, reply };
    }
  }

  // -- accepting the offer -------------------------------------------------------------------
  if (ACCEPT.test(t) && ["details", "offer"].includes(s.stage) && !s.pending) {
    if (s.stage === "offer" && s.intent === "repair") {
      s.route = "assessment";
      s.serviceAccepted = true;
      return next();
    }
    if (s.stage === "offer" && !s.package) {
      s.package = s.suggested || "essential";
      return next();
    }
    s.serviceAccepted = true;
    return next();
  }

  // -- routing from free text ----------------------------------------------------------------
  const intent = classify(text, s);
  if (intent.route === "review" || intent.route === "appliance") {
    s.stage = "review";
    s.pending = null;
    return respond(
      intent.route === "appliance"
        ? "That may be an appliance issue rather than a dryer-vent issue, so I won't promise a vent service will fix it. Send the details below and the team will help find the right next step."
        : "I can send your request to the team. Include the appointment reference for a change or cancellation. A request doesn't change an existing appointment by itself.",
      [],
      { action: "request" },
    );
  }
  if (intent.faq === "repair") {
    const yes = "Yes. For a vent repair concern, we start with an assessment, and repairs are quoted separately.";
    if (!s.intent) return respond(`${yes} Is there a specific vent issue you need evaluated?`, ["Repair / Reroute / Upgrade", "Dryer Vent Cleaning", "Ask a question"]);
    return resume(yes);
  }
  const early = ["welcome", "evaluating", "offer", "details"].includes(s.stage) && !s.serviceAccepted;
  if (intent.route === "bundle_offer" && early && !s.bundleAccepted && !s.bundleDeclined && ["cleaning", "repair", null].includes(s.intent) && (!s.package || TIERS.includes(s.package))) {
    s.intent = "cleaning";
    s.route = "cleaning";
    s.concerns.push(String(text).slice(0, 500));
    return bundleOffer();
  }
  if (intent.route === "assessment" && early && s.intent !== "repair" && !s.serviceAccepted) {
    if (s.intent === "cleaning" && !s.bundleDeclined && !intent.explicitSwitch) {
      s.concerns.push(String(text).slice(0, 500));
      return bundleOffer();
    }
    startIntent("repair");
    s.concerns.push(String(text).slice(0, 500));
    return next();
  }
  if (["nest_offer", "emergency_offer", "clog_offer"].includes(intent.route) && early && !s.package) {
    s.concerns.push(String(text).slice(0, 500));
    if (intent.route === "nest_offer") {
      startIntent("nest");
      s.property.animals = "Yes";
    } else if (intent.route === "emergency_offer") startIntent("emergency");
    else startIntent("cleaning");
    return next();
  }
  // -- prices and questions ------------------------------------------------------------------
  const bare = /\b(just (?:the )?(?:price|total|number)|only (?:the )?price)\b/.test(t);
  if (PRICE.test(t) && /\b(includ\w*|covers?|replacing|replacement|repair work|repair itself)\b/.test(t) && (s.route === "bundle" || s.offered || /248/.test(t))) {
    return resume(`The **${money(BUNDLE_PRICE_CENTS)} covers cleaning and assessment**, not repairs, parts, or replacement work. Any repair work is quoted separately for your approval.`);
  }
  if (PRICE.test(t) && (QUESTION.test(t) || t.endsWith("?") || bare || /^(?:price|prices|pricing|cost)$/.test(t))) {
    if (intent.route === "cleaning" && !s.intent) startIntent("cleaning");
    let answer;
    if (s.route === "bundle" || (s.offered && !s.bundleDeclined)) answer = `Cleaning + assessment is **${money(BUNDLE_PRICE_CENTS)} total**. Repairs are quoted separately.`;
    else if (s.intent === "repair" || /\b(?:repair|assessment)\b/.test(t)) {
      answer = priced ? `${bare ? "" : explain("assessment")}The dryer-vent assessment is **${money(config.assessmentPriceCents)}**. Repairs are quoted separately.` : unverified;
    } else if (!priced) answer = unverified;
    else if (s.package) {
      const q = quoteFor(s.package);
      answer = `${q.name}: **${money(q.priceCents)}**${q.lineItems.length > 1 ? ` (${q.lineItems.map((l) => `${l.name} ${money(l.cents)}`).join(" + ")})` : ""}.${q.priceNote ? " " + q.priceNote : ""}`;
    } else if (s.stage === "offer" && Array.isArray(s.offerFamilies) && s.offerFamilies.some((f) => !TIERS.includes(f))) {
      answer = s.offerFamilies.map((f) => `${PACKAGES[f].short}: **${money(exact(f) ?? 0)}**`).join(". ") + "." + (variantKnown() ? "" : " Priced for a 2-story home with first-floor laundry; your technician confirms on site.");
    } else {
      const lead = bare ? "" : explain("cleaning");
      answer = `${lead}Cleaning packages${homeLabel() || ""}: ` + TIERS.map((f) => `${PACKAGES[f].label} ${variantKnown() ? "" : "from "}${money(variantKnown() ? exact(f) : fromPrice(services, f))}`).join(", ") + `. Vent-only Express (no dryer installed) ${variantKnown() ? "" : "from "}${money(variantKnown() ? exact("express") : fromPrice(services, "express"))}.` + (s.property.power === "Gas" ? " Gas dryers add the $49 Gas Appliance Safety Procedure." : variantKnown() ? "" : " Your exact price depends on your home and dryer.");
    }
    return resume(answer);
  }
  if (intent.route === "cleaning" && !s.intent) {
    startIntent("cleaning");
    return next();
  }
  const isQuestion = QUESTION.test(t) || t.endsWith("?");
  const exactFaq = approvedFaqs.find((f) => normalize(f.question).replace(/[?!.]/g, "") === t.replace(/[?!.]/g, ""));
  const scored = approvedFaqs
    .map((f) => ({ f, score: (f.keywords || []).reduce((n, k) => n + (t.includes(normalize(k)) ? 1 : 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)[0]?.f;
  const faq = exactFaq || (isQuestion ? scored : null);
  if (faq) return { ...resume(faq.answer), faq: faq.id };

  // -- answers to the pending question ---------------------------------------------------------
  if (s.stage === "evaluating" || (s.intent && !s.serviceAccepted && !["offer", "details", "bundle_offer"].includes(s.stage))) {
    if (changed(current) !== changed(s)) return next();
    if (s.pending === "zip") return respond("Please enter the five-digit ZIP code for the service address.", []);
    if (s.pending && !isQuestion) {
      const q = QUESTIONS[s.pending];
      return respond(`Sorry, I didn't catch that. ${q.text}`, q.options, { ...(q.multi ? { multi: true } : {}), ...(q.info ? { info: q.info } : {}) });
    }
  }
  if (s.stage === "contact" || s.serviceAccepted) return resume("Your service is selected.");
  if ((s.stage === "offer" || s.stage === "details") && NO.test(t)) return respond("No problem — nothing has been booked. You can choose another option, ask a question, or ask the team to call you.", ["Back to packages", "Ask a question", "Request a callback"]);
  if (/^(?:request a callback|callback)$/.test(t)) {
    s.stage = "review";
    return respond("Send your details below and the team will follow up. A request doesn't book an appointment by itself.", [], { action: "request" });
  }
  if (intent.route === "clarify" || /^help me choose$/.test(t)) {
    return respond("Are you looking to schedule a routine cleaning, or is there a specific vent problem you need evaluated?", ["Dryer Vent Cleaning", "Repair / Reroute / Upgrade"]);
  }
  if (!s.intent && /^(?:hi|hello|hey|good (?:morning|afternoon|evening))[.!]?$/.test(t)) return welcome("Hi! I'm BOB, Dryer Vent Squad's online booking assistant. What can I help you with?");
  return {
    ...resume("I don't have a verified answer to that yet. I can send the question to the team, or we can keep going with your booking."),
    unanswered: true,
  };
}
