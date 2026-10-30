// BOB's deterministic booking conversation.
//
// Flow (Assistant Instructions & Rules Manual + Master Workflow Playbook, Oct 30 2026):
//   four starting paths → one question per message, each reply opening with a short
//   acknowledgment → recommendation with final calculated prices (base + gas / pedestal /
//   stacked) → Transparent Pricing Promise → "Accept" → contact details in order
//   (name → email → phone → SMS consent → address → notes, collected by the page)
//   → phone verification → live Jobber times → final approval → booked in Jobber.
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
  help: false, // "Help Me Choose Package" path
  repairScope: null, // the repair issue picked first on the repair path
  dryerHot: null, // emergency path: was the dryer running or hot?
  dryerOffConfirmed: false,
  concernDescribed: false,
  otherFor: null, // which question an "Other" answer belongs to, while BOB asks for a description
  notes: [], // the customer's own descriptions for "Other" answers
  safety: null,
  explained: [],
  addOns: {},
  zip: "",
  contact: { name: "", phone: "", email: "", address: "", city: "", notes: "", smsConsent: false },
  history: [],
  options: [],
});

/** Welcome cards (the playbook's four starting paths). The engine accepts them as typed text too. */
export const WELCOME = ["Emergency Clog / Overheating", "Standard Vent Cleaning", "Help Me Choose Package", "Repair / Reroute / Assessment"];
/** Starting-path names, including earlier button labels that may still be typed or sent by the AI layer. */
const START = {
  "emergency clog / overheating": "emergency",
  "standard vent cleaning": "cleaning",
  "dryer vent cleaning": "cleaning",
  "help me choose package": "help",
  "help me choose": "help",
  "repair / reroute / assessment": "repair",
  "repair / reroute / upgrade": "repair",
  "pest / nest removal": "nest",
  "ask a question (faqs)": "faq",
};
/** Every starting-path name the engine accepts, for the chat server's exact-button shortcut. */
export const START_LABELS = Object.keys(START);
export const GREETING = "👋 Hi! Welcome to Dryer Vent Squad West Valley! I'm your AI Booking & Diagnostic Assistant.\n\nHow can I help restore your dryer exhaust system today?";

export const QUESTIONS = {
  zip: { text: "What's the five-digit ZIP code for the service address?", options: [] },
  hasDryer: { text: "Do you currently have a dryer installed at the location, or do you only need the exhaust duct line serviced?", options: ["Have Dryer Installed", "No Dryer Present (Duct Only)"] },
  lastCleaned: { text: "Has your dryer vent been professionally cleaned in the last 12 months?", options: ["Yes", "No", "Not sure"] },
  stories: { text: "Is your home a 1-story or 2-story residence?", options: ["1-Story Home", "2-Story (1st Floor Laundry)", "2-Story (2nd Floor Laundry)", "Not sure"] },
  laundryFloor: { text: "Is the laundry room on the 1st floor or the 2nd floor?", options: ["1st Floor", "2nd Floor", "Not sure"] },
  power: { text: "Is your dryer gas or electric?", options: ["Electric Dryer", "Gas Dryer", "I don't know", "Other"], info: ["gas_electric", "why_we_ask"] },
  mount: { text: "Is your dryer standard, on a fixed pedestal, or stacked with a washer?", options: ["Standard Floor Setup", "Fixed Pedestal", "Stacked Washer/Dryer", "I don't know", "Other"], info: ["why_we_ask"] },
  symptoms: {
    text: "How is the dryer performing right now? Select all that apply.",
    options: ["Dries in one normal cycle", "Takes about 2 cycles", "Takes 3 or more cycles", "Clothes are still damp after multiple cycles", "Dryer is overheating or shutting off", "It's showing an airflow error code", "Other / not sure"],
    multi: true,
  },
  symptomClarify: { text: "Those answers don't match. How many drying cycles does it usually take? Please type it out in your own words.", options: [] },
  animals: { text: "Have you noticed any visible signs of animals around the vent?", options: ["Yes, signs of animals", "No signs", "I don't know", "Other"] },
  concern: { text: "Please describe the issue in a sentence or two. For example: the duct came apart in the attic, or the roof cap is crushed.", options: ["Skip"] },
  // Emergency path
  safetyCheck: { text: "🚨 Safety Priority Flag! Is your dryer currently running or extremely hot to the touch right now?", options: ["Yes, it's still running / hot", "No, it's turned off now"] },
  powerOff: { text: "🛑 Please turn off and unplug your dryer immediately to prevent motor burnout or a fire hazard.\n\nPlease confirm when the appliance is turned off so we can proceed with emergency scheduling.", options: ["Dryer is off now"] },
  triage: {
    text: "What is happening with the dryer? Select all that apply.",
    options: ["Overheating or shutting off", "Error code (D80/D90/D95)", "Little/no airflow outside", "Takes multiple cycles", "Possible nest/blockage", "Burning smell", "Other / something else"],
    multi: true,
  },
  // Repair path
  repairScope: { text: "What specific issue are you experiencing with your vent system?", options: ["Broken Vent Cap / Exterior Damage", "Disconnected Duct in Wall/Attic", "Bird / Pest Infestation", "Need Duct Rerouted", "Other Repair Issue"] },
  repairPerf: { text: "How is the dryer working right now?", options: ["Working Normal", "Takes more than 1 cycle", "Not working", "I don't know"] },
  // Any "Other" answer
  otherDetail: { text: "Could you briefly describe it in your own words?", options: [] },
};
/** What the setup fees cover, said the same way everywhere BOB mentions them. */
export const SETUP_WHY = {
  gas: "we shut off the gas, safely disconnect the dryer, reconnect it after cleaning, and perform a gas leak test before we leave",
  stacked: "we move stacked units with air sleds, so the washer and dryer slide out safely and go back into place",
  pedestal: "the raised dryer is heavier to handle, so moving the dryer and pedestal out together without tipping, reaching the vent connection, and setting everything back securely takes extra time and care",
};
const SETUP_KEY = { "Gas Appliance Safety Procedure": "gas", "Stacked Washer/Dryer Setup": "stacked", "Fixed Pedestal Setup": "pedestal" };

/** Help Me Choose asks performance first, with the playbook's wording. */
const HELP_SYMPTOMS = { text: "To match you with the right service level, how is your dryer currently performing?", options: ["Dries in 1 normal cycle", "Takes 2+ cycles to dry", "Overheating / Error Code", "Just moved in / Preventative"] };
/** Questions that offer "Other", and how the description is labeled for the technician. */
const OTHER_LABELS = { power: "Gas or electric", mount: "Dryer setup", symptoms: "Dryer performance", animals: "Signs of animals", triage: "What's happening", repairScope: "Repair issue" };

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
  if (/\b(?:one normal cycle|normal cycle|dries (?:fine|normally|in one)|working normal(?:ly)?|no problems?|just moved in|preventa?tive)\b/.test(t) || /(?<!than )\b(?:one|1) (?:normal )?cycle\b/.test(t)) out.push("normal");
  if (/\b(?:about 2 cycles|2 cycles|2\+ cycles|two cycles|more than one(?: cycle| time| load| try)?|takes (?:a )?(?:bit )?longer)\b/.test(t)) out.push("two");
  if (/\b(?:3 or more|three or more|3 cycles|three cycles|3\+|multiple cycles|forever|still damp)\b/.test(t)) out.push("three");
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
    // "Other" on any question: note it, then ask for a short description in the next message.
    const other = OTHER_LABELS[key] && /(?:^|,\s*)other\b/.test(t);
    const askOther = () => {
      s.otherFor = key;
      s.pending = "otherDetail";
    };
    if (key === "zip") {
      const m = t.match(/\b(\d{5})\b/);
      if (m) s.zip = m[1];
    } else if (key === "otherDetail") {
      if (t.length >= 2 && !UNKNOWN.test(t)) {
        const note = String(text).trim().slice(0, 500);
        if (s.otherFor === "repairScope") {
          s.concerns.push(note);
          s.concernDescribed = true;
        } else s.notes.push(`${OTHER_LABELS[s.otherFor] || "Other"}: ${note}`);
      }
      if (t.length >= 2) s.otherFor = null;
    } else if (key === "symptoms" || key === "symptomClarify") {
      learnSymptoms(t, s, key === "symptomClarify");
      if (other && key === "symptoms") {
        if (!Array.isArray(p.symptoms) && !s.symptomConflict) p.symptoms = [];
        if (!s.symptomConflict) askOther();
      }
    } else if (key === "triage") {
      const picked = String(text).split(/,\s*/).map((x) => x.trim()).filter((x) => QUESTIONS.triage.options.some((o) => normalize(o) === normalize(x)));
      if (picked.length || t.length >= 3) {
        p.triage = picked.length ? picked : [String(text).slice(0, 200)];
        const found = parseSymptoms(t).filter((x) => x !== "normal");
        if (found.length && !Array.isArray(p.symptoms)) p.symptoms = [...new Set(found)];
        if (/possible nest/.test(t)) p.animals = "Yes";
        if (other) askOther();
      }
    } else if (key === "safetyCheck") {
      if (/^(?:yes|it's still running|still running|running|hot)\b/.test(t)) s.dryerHot = true;
      else if (/^(?:no|it's (?:turned )?off|turned off|off)\b/.test(t)) {
        s.dryerHot = false;
        s.dryerOffConfirmed = true;
      }
    } else if (key === "powerOff") {
      if (/\b(?:off|unplugged|done|yes|ok(?:ay)?)\b/.test(t)) s.dryerOffConfirmed = true;
    } else if (key === "repairScope") {
      const option = QUESTIONS.repairScope.options.find((o) => normalize(o) === t);
      if (other || /^other\b/.test(t)) {
        s.repairScope = "Other";
        askOther();
      } else if (option) {
        s.repairScope = option;
        if (!/bird|pest/i.test(option)) s.concerns.push(option);
      } else if (t.length >= 8 && !ACCEPT.test(t) && !PICKS.some(([, re]) => re.test(t))) {
        // They described it in their own words.
        s.repairScope = "Described";
        s.concerns.push(String(text).slice(0, 500));
        s.concernDescribed = true;
      }
    } else if (key === "repairPerf") {
      if (/^working normal/.test(t)) p.dryerWorking = "Working normally";
      else if (/more than (?:1|one) cycle|cycles?/.test(t)) p.dryerWorking = "Takes more than 1 cycle";
      else if (/not working|won't|doesn't work/.test(t)) p.dryerWorking = "Not working";
      else if (UNKNOWN.test(t)) p.dryerWorking = "Not sure";
    } else if (key === "concern") {
      if (/^skip$/.test(t)) s.concernSkipped = true;
      else if (t.length >= 3 && !PICKS.some(([, re]) => re.test(t)) && !START[t]) {
        s.concerns.push(String(text).slice(0, 500));
        s.concernDescribed = true;
      }
    } else if (other) {
      p[key] = "Not sure";
      askOther();
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

/** Which questions apply, in order, for this visit (rules manual §3–4, playbook §3–7). */
export function questionOrder(s) {
  const p = s.property;
  if (!s.intent) return [];
  const layout = ["stories", twoStory(s) && "laundryFloor"];
  if (s.intent === "cleaning") {
    const help = s.help && s.route !== "bundle";
    return [
      help && !s.package && "symptoms", // Help Me Choose starts with performance
      "zip",
      "hasDryer",
      hasDryer(s) && "lastCleaned",
      ...layout,
      hasDryer(s) && "power",
      hasDryer(s) && "mount",
      !help && hasDryer(s) && !s.package && s.route !== "bundle" && "symptoms",
      !["nest", "restoration"].includes(s.package) && "animals",
    ].filter(Boolean);
  }
  if (s.intent === "repair") {
    return [!s.concernDescribed && "repairScope", "zip", ...layout, "power", "mount", "repairPerf", "concern"].filter(Boolean);
  }
  if (s.intent === "emergency") {
    return ["safetyCheck", s.dryerHot && "powerOff", "triage", "zip", ...layout, hasDryer(s) && "power"].filter(Boolean);
  }
  // nest: what price and access depend on
  return ["zip", "hasDryer", ...layout, hasDryer(s) && "power"].filter(Boolean);
}

const answered = (s, key) => {
  switch (key) {
    case "zip":
      return Boolean(s.zip);
    case "concern":
      return s.concernDescribed || s.concernSkipped;
    case "symptoms":
      return Array.isArray(s.property.symptoms);
    case "triage":
      return Array.isArray(s.property.triage);
    case "safetyCheck":
      return s.dryerHot != null;
    case "powerOff":
      return s.dryerOffConfirmed;
    case "repairScope":
      return s.repairScope != null;
    case "repairPerf":
      return s.property.dryerWorking != null;
    default:
      return s.property[key] != null;
  }
};

/**
 * The recommended See-It-Clean package from everything the customer told us.
 * Performance ⭐ is the standard pick. Total System when drying shows a significant restriction
 * (3+ cycles, still damp, or an airflow error code), or when 2-cycle drying comes with a vent
 * that's overdue for cleaning or a stacked/pedestal setup that crushes the transition hose.
 */
export function recommendTier(p = {}) {
  const sym = p.symptoms || [];
  const severe = sym.includes("three") || sym.includes("error");
  const slow = sym.includes("two");
  const overdue = ["No", "Not sure"].includes(p.lastCleaned);
  const tight = ["Stacked", "Pedestal"].includes(p.mount);
  return severe || (slow && (overdue || tight)) ? "total" : "performance";
}

/** Estimated drying efficiency from cycles: 2 cycles ≈ 50%, 3 or more ≈ 33% or less. */
export function dryingEfficiency(p = {}) {
  const sym = p.symptoms || [];
  if (sym.includes("three")) return { percent: "about 33% or less", times: "three times or more" };
  if (sym.includes("two")) return { percent: "about 50%", times: "about twice" };
  return null;
}

/** The airflow analysis shown under the prices: estimate, causes, energy cost, and why this package. */
export function airflowAnalysis(p = {}, recommended = recommendTier(p)) {
  const sym = p.symptoms || [];
  const eff = dryingEfficiency(p);
  const parts = [];
  const paragraphs = [];
  if (sym.includes("three")) parts.push(`Taking 3 or more cycles means each load takes ${eff.times} as long to dry, so your dryer is likely running at ${eff.percent} efficiency. That usually points to a significant airflow restriction in the vent line.`);
  else if (sym.includes("two")) parts.push(`Taking about 2 cycles means each load takes ${eff.times} as long to dry, so your dryer is likely running at ${eff.percent} efficiency, a sign of a moderate airflow restriction.`);
  else if (Array.isArray(p.symptoms) && sym.includes("normal")) parts.push("Drying in one normal cycle suggests airflow is in good shape for now.");
  if (sym.includes("error")) parts.push("The airflow error code means the dryer itself is detecting restricted airflow.");
  if (p.lastCleaned === "No") parts.push("It hasn't been professionally cleaned in the last 12 months, so lint buildup in the line is likely.");
  else if (p.lastCleaned === "Not sure") parts.push("If it hasn't been cleaned in the last 12 months, some lint buildup in the line is likely.");
  if (p.mount === "Stacked" || p.mount === "Pedestal") parts.push(`With a ${p.mount === "Stacked" ? "stacked" : "pedestal"} setup, the transition hose behind the dryer is often kinked or crushed, which the DryerFlex hose upgrade fixes.`);
  if (p.power === "Gas") parts.push("Gas dryers also get our Gas Appliance Safety Procedure: a safe disconnect and reconnect, plus a gas leak test before we leave.");
  paragraphs.push(parts.splice(0).join(" "));
  parts.push(
    eff
      ? `At ${eff.percent} efficiency you're paying for ${eff.times} the drying time on every load. Restoring airflow brings that back down and saves energy and wear on the dryer.`
      : "A clear vent keeps drying times short, which saves energy and wear on the dryer.",
  );
  parts.push(
    recommended === "total"
      ? "That's why I recommend **Total System See-It-Clean**: it adds termination cleanout and airflow restriction correction to restore full airflow."
      : "That's why I recommend **Performance See-It-Clean**: it includes the DryerFlex transition hose upgrade and before-and-after photos so you can see the result.",
  );
  parts.push("Symptoms aren't a diagnosis; your technician measures airflow before and after.");
  const [energy, ...why] = parts;
  return [...paragraphs, energy, why.join(" ")].filter(Boolean).join("\n\n");
}

/**
 * Estimated airflow restriction (0–100) for the gauge, from the customer's answers.
 * Cycles set the base (1 cycle ≈ clear, 2 ≈ half efficiency, 3+ ≈ severe); an error code,
 * an overdue cleaning and a stacked/pedestal setup push it up.
 */
export function airflowEstimate(p = {}) {
  const sym = p.symptoms || [];
  let score = sym.includes("three") ? 72 : sym.includes("two") ? 50 : sym.includes("normal") ? 12 : 25;
  if (sym.includes("error")) score = Math.max(score, 66);
  if (p.lastCleaned === "No") score += 10;
  else if (p.lastCleaned === "Not sure") score += 5;
  if (p.mount === "Stacked" || p.mount === "Pedestal") score += 5;
  score = Math.max(5, Math.min(95, score));
  const level = score < 34 ? "clear" : score < 67 ? "restricted" : "severe";
  const eff = dryingEfficiency(p);
  return {
    score,
    level,
    headline: level === "clear" ? "Airflow looks clear" : level === "restricted" ? "Airflow looks restricted" : "Airflow looks severely restricted",
    efficiency: eff ? `Estimated drying efficiency: ${eff.percent}` : "",
  };
}

/** The answers that shaped the estimate, as short labels for the gauge. */
export function airflowFactors(p = {}) {
  const sym = p.symptoms || [];
  const f = [];
  if (sym.includes("three")) f.push("Takes 3 or more cycles");
  else if (sym.includes("two")) f.push("Takes about 2 cycles");
  else if (sym.includes("normal")) f.push("Dries in one normal cycle");
  if (sym.includes("error")) f.push("Airflow error code");
  if (p.lastCleaned === "No") f.push("Not cleaned in the last 12 months");
  else if (p.lastCleaned === "Not sure") f.push("Last cleaning unknown");
  else if (p.lastCleaned === "Yes") f.push("Cleaned in the last 12 months");
  if (p.mount === "Stacked") f.push("Stacked setup: transition hose often crushed");
  if (p.mount === "Pedestal") f.push("Fixed pedestal: transition hose often crushed");
  if (p.power === "Gas") f.push("Gas dryer: disconnect, reconnect & leak test");
  return f;
}

/** Two sentences under the gauge: what the answers suggest, and why BOB's pick fits. */
export function airflowSummary(p = {}, recommended = recommendTier(p)) {
  const sym = p.symptoms || [];
  const eff = dryingEfficiency(p);
  const finding = eff
    ? `Each load is taking ${eff.times} as long to dry, so your dryer is likely running at ${eff.percent} efficiency, and you're paying for that extra drying time on every load.`
    : sym.includes("error")
      ? "Your dryer is reporting restricted airflow with an error code."
      : "Drying in one normal cycle suggests airflow is in good shape for now.";
  const why =
    recommended === "total"
      ? "**Total System See-It-Clean** adds termination cleanout and airflow restriction correction to restore full airflow."
      : eff || sym.includes("error")
        ? "**Performance See-It-Clean** clears the line and adds the DryerFlex transition hose upgrade, with before-and-after photos so you can see the result."
        : "**Performance See-It-Clean** keeps it that way with the DryerFlex transition hose upgrade and before-and-after photos.";
  return `${finding} ${why}`;
}

/** What each step up adds, for comparisons. */
const UPGRADES = {
  performance: "before-and-after photos and a DryerFlex transition hose upgrade",
  total: "termination cleanout, roof or attic access when needed, airflow restriction correction, and a set of wool dryer balls",
  restoration: "sanitation fogging, a DryerFlex transition hose upgrade, a full system reset, and a set of four wool dryer lint balls",
};

export function turn(text, current, config = DEFAULT_CONFIG, faqs = [], opts = {}) {
  const s = structuredClone(current || initialSession());
  if (!s.v) Object.assign(s, { ...initialSession(), ...s, v: 3 });
  const t = normalize(text);
  const services = config.services || SERVICE_CATALOG;
  const priced = Boolean(config.pricesAcknowledged);
  const approvedFaqs = (faqs || []).filter((f) => f && f.status !== "draft");
  s.history = [...(s.history || []).slice(-39), { role: "user", text: String(text).slice(0, 2000) }];

  let ack = "";
  const respond = (reply, options = [], extra = {}) => {
    if (ack) {
      reply = `${ack}\n\n${reply}`;
      ack = "";
    }
    s.history.push({ role: "assistant", text: reply, ...(extra.card ? { card: extra.card } : {}) });
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
  /** Final calculated price: base package plus gas, pedestal and stacked surcharges. */
  const totalOf = (family) => {
    try {
      return quoteFor(family).priceCents;
    } catch {
      return fromPrice(services, family);
    }
  };
  const variantKnown = () => homeVariant(s.property).certain;
  // Before the home questions, sized packages show their lowest ("from") price.
  const sized = (family) => ["essential", "performance", "total", "express", "postservice"].includes(family) && s.property.stories == null;
  const amountOf = (family) => (sized(family) ? `${money(fromPrice(services, family) ?? 0)}+` : money(totalOf(family) ?? 0));
  const priceOf = (family) => (priced ? amountOf(family) : "");
  const label = (family) => {
    const amount = priceOf(family);
    return amount ? `${PACKAGES[family].label} · ${amount}` : PACKAGES[family].label;
  };
  const offerLabel = (family, star) => (TIERS.includes(family) ? selectLabel(family, star) : label(family));
  const selectLabel = (family, star) => {
    const amount = priceOf(family);
    return `Select ${PACKAGES[family].label}${star ? " ⭐" : ""}${amount ? ` (${amount})` : ""}`;
  };
  const line = (family, star) =>
    `• **${PACKAGES[family].short}${priced ? ` — ${sized(family) ? "from " + money(fromPrice(services, family) ?? 0) : money(totalOf(family) ?? 0)}` : ""}**${star ? " ⭐ Suggested" : ""}: ${PACKAGES[family].pitch}.`;
  /** One package as a card: final price, length, what's included, and the button text. */
  const pickCard = (family, recommended) => {
    let q = null;
    try {
      q = quoteFor(family);
    } catch {}
    const item = services.find((x) => x.family === family && x.active !== false);
    const [summary] = (q?.lineItems[0]?.description || item?.description || PACKAGES[family].pitch).replace(/\s*—.*$/, "").split(/\.\s+/);
    const bullets = summary
      .replace(/\.$/, "")
      .split(/,\s*(?:(?:and|plus)\s+)?|\s+plus\s+/i)
      .filter((x) => x.trim().length > 2)
      .map((x) => x.trim().replace(/^./, (c) => c.toUpperCase()));
    return {
      family,
      name: PACKAGES[family].short,
      price: priced ? (sized(family) ? `from ${money(fromPrice(services, family) ?? 0)}` : money(totalOf(family) ?? 0)) : "",
      minutes: q && !sized(family) ? q.durationMins : null,
      includes: priced && q && !sized(family) ? q.lineItems.slice(1).map((l) => `${l.name} ${money(l.cents)}`) : [],
      bullets,
      option: offerLabel(family, recommended),
      recommended: Boolean(recommended),
    };
  };
  /** Which surcharges a price already includes, e.g. "the $49 Gas Appliance Safety Procedure". */
  const feesNote = (family) => {
    if (!priced) return "";
    let extras = [];
    try {
      extras = quoteFor(family).lineItems.slice(1);
    } catch {}
    if (!extras.length) return "";
    const names = extras.map((l) => `the ${money(l.cents)} ${l.name}`);
    return `\n\nPrices include ${names.length > 1 ? names.slice(0, -1).join(", ") + " and " + names.at(-1) : names[0]}.`;
  };
  const unverified = "The team needs to verify the standalone service price before a price-confirmed appointment can be made.";
  const gasNote = () => feesNote(s.package || (s.offerFamilies || [])[0] || "essential");
  const homeLabel = () => {
    const { variant, certain } = homeVariant(s.property);
    if (!certain) return "";
    return variant === "1-story" ? " for a 1-story home" : variant === "2-story-upstairs" ? " for a 2-story home with upstairs laundry" : " for a 2-story home";
  };
  const needsApproval = (family) => (config.approvalServices || ["emergency"]).includes(family);

  const layoutPhrase = () => {
    const p = s.property;
    if (p.stories === "1-story") return "1-story home";
    if (p.stories === "2-story" && p.laundryFloor === "2nd floor") return "2-story home with second-floor laundry";
    if (p.stories === "2-story" && p.laundryFloor === "1st floor") return "2-story home with first-floor laundry";
    if (p.stories === "2-story") return "2-story home";
    return "";
  };
  const ackFor = (key) => {
    const p = s.property;
    switch (key) {
      case "zip":
        return `Thanks, ZIP ${s.zip}.`;
      case "hasDryer":
        return p.hasDryer === "No"
          ? `Got it, duct line service only.${priced ? ` For an unoccupied line cleaning, our Express Vent Cleaning service (from ${money(fromPrice(services, "express") ?? 0)}) is ideal.` : ""}`
          : "Understood.";
      case "lastCleaned":
        return "Thanks.";
      case "stories":
      case "laundryFloor":
        if (p.stories === "Not sure" || p.laundryFloor === "Not sure") return "No problem, your technician will confirm the layout.";
        if (p.stories === "2-story" && p.laundryFloor === "2nd floor") return "Understood, second-floor laundry setup.";
        return layoutPhrase() ? `Got it, ${layoutPhrase()} setup.` : "Got it.";
      case "power":
        if (p.power === "Gas") {
          if (s.intent === "repair") return `Got it, a gas dryer line. If the dryer has to be moved, ${SETUP_WHY.gas}.`;
          const fee = feeLabel("gas").replace(/[ ()+]/g, "");
          return `Got it, a gas dryer line. ${fee ? `The ${fee} Gas Appliance Safety Procedure means` : "For gas dryers,"} ${SETUP_WHY.gas}.`;
        }
        return p.power === "Electric" ? "Understood, an electric dryer." : "No problem, your technician will confirm it on site.";
      case "mount": {
        if (p.mount !== "Stacked" && p.mount !== "Pedestal") return "Got it.";
        const key = p.mount === "Stacked" ? "stacked" : "pedestal";
        const fee = s.intent === "cleaning" ? feeLabel(key).replace(/[ ()+]/g, "") : "";
        const why = SETUP_WHY[key].replace(/^./, (c) => c.toUpperCase());
        return p.mount === "Stacked"
          ? `Got it, a stacked setup. ${fee ? `The ${fee} stacked setup fee covers moving it with air sleds, so the washer and dryer slide out safely and go back into place.` : `${why}.`}`
          : `Got it, a fixed pedestal. ${fee ? `The ${fee} pedestal fee covers the extra labor: ${SETUP_WHY.pedestal}.` : `${why}.`}`;
      }
      case "symptoms":
      case "symptomClarify":
        return "Thanks, that helps me match the right service.";
      case "animals":
        return p.animals === "Yes" ? "Got it, signs of animals at the vent." : p.animals === "No" ? "Good, no signs of animals." : "No problem.";
      case "safetyCheck":
        return s.dryerHot ? "Understood." : "Thank you for confirming the dryer is powered down.";
      case "powerOff":
        return "Thank you for confirming the dryer is powered down.";
      case "triage":
        return "Thank you, that helps us prepare our emergency equipment.";
      case "repairScope":
      case "concern":
        return "Thanks for providing those details.";
      case "repairPerf":
        return "Understood.";
      case "otherDetail":
        return "Thanks for the details.";
      default:
        return "";
    }
  };

  // -- steps ---------------------------------------------------------------------------
  const feeLabel = (variant) => {
    const item = services.find((x) => x.family === "addon" && x.variant === variant && x.active !== false);
    return priced && item ? ` (+${money(item.priceCents)})` : "";
  };
  const optionsFor = (key) => {
    const q = QUESTIONS[key];
    if (key === "power" && s.intent !== "repair") return q.options.map((o) => (o === "Gas Dryer" ? `Gas Dryer${feeLabel("gas")}` : o));
    if (key === "mount" && s.intent === "cleaning") return q.options.map((o) => (o === "Fixed Pedestal" ? `Fixed Pedestal${feeLabel("pedestal")}` : o === "Stacked Washer/Dryer" ? `Stacked Washer/Dryer${feeLabel("stacked")}` : o));
    return q.options;
  };
  const ask = (key) => {
    s.pending = key;
    s.stage = "evaluating";
    if (key === "symptoms" && s.help) return respond(HELP_SYMPTOMS.text, HELP_SYMPTOMS.options);
    const q = QUESTIONS[key];
    return respond(q.text, optionsFor(key), { ...(q.multi ? { multi: true } : {}), ...(q.info ? { info: q.info } : {}) });
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

  const welcome = (lead = GREETING) => {
    s.stage = "welcome";
    s.pending = null;
    return respond(lead, WELCOME);
  };

  const tierOffer = (brief) => {
    const suggested = recommendTier(s.property);
    s.suggested = suggested;
    s.offerFamilies = TIERS;
    s.stage = "offer";
    const others = TIERS.filter((f) => f !== suggested);
    const options = [selectLabel(suggested, true), ...others.map((f) => selectLabel(f)), "Compare Packages", "More services"];
    const extra = { suggested: selectLabel(suggested, true) };
    if (brief) return respond("Which package would you like?", options, extra);
    const p = s.property;
    const fuel = p.power === "Gas" ? "a gas dryer" : p.power === "Electric" ? "an electric dryer" : "your dryer";
    const setup = p.mount === "Stacked" ? "stacked" : p.mount === "Pedestal" ? "fixed pedestal" : p.mount === "Standard" ? "standard" : "";
    const lead = `Based on your ${layoutPhrase() || "home"} with ${fuel}${setup ? ` in a ${setup} configuration` : ""}:`;
    const airflow = airflowEstimate(p);
    const analysis = airflowAnalysis(p, suggested).split("\n\n");
    const price = (f) => (priced ? ` — ${sized(f) ? "from " + money(fromPrice(services, f) ?? 0) : money(totalOf(f) ?? 0)}` : "");
    const pricing =
      `⭐ **BOB's pick for you: ${PACKAGES[suggested].short}${price(suggested)}**\n` +
      others.map((f) => `• **${PACKAGES[f].short}${price(f)}**: ${PACKAGES[f].pitch}.`).join("\n") +
      (priced ? (variantKnown() ? "" : "\n\nPrices shown are for a 2-story home with first-floor laundry; your technician confirms on site.") + feesNote(suggested) : `\n\n${unverified}`);
    const card = {
      kind: "recommendation",
      airflow: { ...airflow, factors: airflowFactors(p) },
      lead,
      summary: airflowSummary(p, suggested),
      question: "Which package would you like?",
      picks: [pickCard(suggested, true), ...others.map((f) => pickCard(f, false))],
      note: priced ? (variantKnown() ? "" : "Prices shown are for a 2-story home with first-floor laundry; your technician confirms on site.") : unverified,
    };
    // Rules manual §5: diagnosis and pricing are separate parts of the message (|||).
    const reply = `${airflow.headline}. ${airflow.efficiency ? airflow.efficiency + "." : ""}\n\n${lead}\n\n${analysis.join("\n\n")}\n|||\n${explain("cleaning")}${pricing}\n\nWhich package would you like?`;
    return respond(reply, options, { ...extra, info: ["pricing"], card });
  };

  const specialOffer = (families, suggested, lead, brief, extraOptions = ["Ask a question"]) => {
    s.suggested = suggested;
    s.offerFamilies = families;
    s.stage = "offer";
    const options = [...families.map(label), ...extraOptions];
    if (brief) return respond("Which option would you like?", options, { suggested: label(suggested) });
    const list = families.map((f) => line(f, families.length > 1 && f === suggested)).join("\n");
    const card = { kind: "offer", lead, picks: families.map((f) => pickCard(f, families.length > 1 && f === suggested)), note: priced ? "" : unverified };
    return respond(`${lead}\n\n${list}${priced ? gasNote() : "\n\n" + unverified}`, options, { suggested: label(suggested), card });
  };

  const assessmentOffer = (brief) => {
    s.route = "assessment";
    s.stage = "offer";
    s.suggested = null;
    const options = ["Book Assessment", "Ask a Question"];
    if (brief) return respond("Would you like to book the assessment?", options);
    const q = serviceQuote("assessment", config);
    const credit = config.assessmentCredited === false ? "" : " It's credited 100% toward the repair when you hire us for the work.";
    const price = priced
      ? `**Comprehensive Repair Assessment: ${money(q.priceCents)}.**${credit} This is the assessment, not the repair. Any repair work is quoted separately for your approval.`
      : unverified;
    return respond(`For a vent repair issue, we start with an assessment. ${explain("assessment")}${price}\n\nWould you like to book the assessment?`, options);
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
        "For an urgent blockage, our **Emergency Same-Day Clog Relief** is the right service: urgent blockage removal and airflow restoration. Same-day visits need a quick approval from our team before they're confirmed. You'll pick a time and we'll ask them right away. Keep the dryer off until the technician arrives.",
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
    const options = ["Accept", s.intent === "cleaning" && TIERS.includes(q.package) ? "Compare Packages" : "Back to options", "Ask a question"];
    const title = `**${q.name}${priced ? ` — ${money(q.priceCents)}` : ""}**`;
    if (brief) return respond(`Ready to continue with ${title}?`, options);
    const switched =
      s.package !== q.package
        ? q.package === "express"
          ? "Since no dryer is installed, this visit is our Express Vent Cleaning (vent only).\n\n"
          : `Since a dryer is installed, this visit is our ${PACKAGES[q.package].short}.\n\n`
        : "";
    s.package = q.package;
    const [summary, ...fine] = q.lineItems[0].description.replace(/\s*—.*$/, "").split(/\.\s+/);
    const finePrint = fine.join(". ").replace(/\.?$/, ".");
    const bullets = summary
      .replace(/\.$/, "")
      .split(/,\s*(?:(?:and|plus)\s+)?|\s+plus\s+/i)
      .filter((x) => x.trim().length > 2)
      .map((x) => "• " + x.trim().replace(/^./, (c) => c.toUpperCase()))
      .join("\n") + (fine.length ? `\n\n${finePrint}` : "");
    const extras = q.lineItems.slice(1);
    const covers = extras.filter((l) => SETUP_KEY[l.name]).map((l) => `• **${l.name}:** ${SETUP_WHY[SETUP_KEY[l.name]].replace(/^./, (c) => c.toUpperCase())}.`);
    const total = priced
      ? extras.length
        ? `\n\n${q.lineItems.map((l) => `${l.name}: ${money(l.cents)}`).join("\n")}\n**Total: ${money(q.priceCents)}**${covers.length ? `\n\n**What the extras cover**\n${covers.join("\n")}` : ""}`
        : ""
      : `\n\n${unverified}`;
    const note = q.priceNote && priced ? `\n\n${q.priceNote}` : "";
    const approval = needsApproval(q.package) ? "\n\nThis service needs approval from our team before it's confirmed." : "";
    return respond(`${switched}${title}\n${bullets}${total}${note}${approval}\n\n**Transparent Pricing Promise**\nMost dryer vent cleanings are completed at the package price selected.`, options, { info: ["pricing"] });
  };

  const contactStep = () => {
    s.stage = "contact";
    s.pending = null;
    let locked = "";
    try {
      const q = s.route === "assessment" || s.route === "bundle" ? serviceQuote(s.route, config) : quoteFor(s.package);
      const name = s.route === "assessment" ? "the Comprehensive Repair Assessment" : s.route === "bundle" ? "cleaning + assessment" : q.name;
      locked = `I have locked in **${name}**${priced ? ` at **${money(q.priceCents)}**` : ""}. `;
    } catch {}
    return respond(
      `${locked}Next I'll collect your details one at a time, then show live openings on our schedule. Nothing is booked until you approve the final summary and get a confirmation.`,
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
    // An "Other" answer gets a short description before anything else.
    if (s.otherFor) {
      if (s.pending === "otherDetail") return ask("otherDetail");
      s.otherFor = null;
    }
    // A contradictory symptom answer is clarified in the customer's own words before anything else.
    if (s.symptomConflict) {
      if (s.pending === "symptomClarify") return askSymptomClarify();
      s.symptomConflict = null;
    }
    // An open $248 offer needs a yes or no before anything else.
    if (s.stage === "bundle_offer" && s.offered && !s.bundleAccepted && !s.bundleDeclined) return bundleOffer();
    const missing = questionOrder(s).find((k) => !answered(s, k));
    if (missing) return ask(missing);
    s.pending = null;
    if (s.serviceAccepted) return contactStep();
    if (s.package) return details(brief);
    return offer(brief);
  };

  /** An answer to a side question, then an offer to continue scheduling (playbook §9). */
  const resume = (lead, { faq = false } = {}) => {
    const body = faq ? `💡 I can answer that for you:\n\n${lead}` : lead;
    if (s.stage === "review") return respond(body, [], { action: "request" });
    if (["emergency", "confirmed"].includes(s.stage)) return respond(body, []);
    if (["contact", "verify", "slots", "approval"].includes(s.stage)) return respond(`${body}\n\nWhen you're ready, continue with the booking below.`, [], { action: "resume" });
    if (s.stage === "bundle_offer") return respond(`${body}\n\nWould you like to include the assessment with cleaning for ${money(BUNDLE_PRICE_CENTS)} total?`, ["Include assessment", "Cleaning only"]);
    return respond(`${body}\n\nWould you like to continue scheduling your service visit?`, ["Yes, let's schedule", "Ask another question"]);
  };

  const startIntent = (intent, { keepPackage = false, help = false } = {}) => {
    s.intent = intent;
    s.help = help;
    s.serviceAccepted = false;
    s.pending = null;
    if (!keepPackage) s.package = null;
    if (intent === "repair") s.route = "assessment";
    else if (s.route !== "bundle") s.route = "cleaning";
  };

  // -- safety first ----------------------------------------------------------------------
  const start = START[t];
  const emergencyAnswer = ["safetyCheck", "powerOff", "triage", "otherDetail"].includes(s.pending) && s.intent === "emergency";
  const detected = start ? null : detectSafety(t);
  // On the emergency path, "overheating" or "burning smell" is the reason for the visit; gas, smoke and fire still stop everything.
  const safety = emergencyAnswer && detected === "stop" ? null : detected;
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
  // Help Me Choose: "Overheating / Error Code" moves to the emergency path, which starts with the safety check.
  if (safety === "stop" && s.help && s.pending === "symptoms" && s.intent === "cleaning") {
    const found = parseSymptoms(t);
    startIntent("emergency");
    if (found.length) s.property.symptoms = found;
    ack = "Overheating needs priority attention, so let's handle this as an emergency.";
    return next();
  }
  if (safety === "stop") {
    s.safety = "stop";
    s.stage = "review";
    s.serviceAccepted = false;
    s.pending = null;
    return respond("Stop using the dryer if you can do so safely, and arrange a professional evaluation. If there is smoke, fire, or a suspected gas leak, leave immediately and call 911 from a safe location. I'll route this to our team for review rather than book a routine cleaning.", [], { action: "request" });
  }

  // An answer written by the AI layer: show it, then offer to continue scheduling.
  if (typeof opts.answer === "string" && opts.answer.trim()) return { ...resume(opts.answer.trim(), { faq: true }), ai: true };

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
    return respond("I'm BOB, Dryer Vent Squad's automated online booking assistant — not a person. I can explain our services and prices, check the live schedule, and send a request to the team.", ["Request a callback", ...(s.intent ? ["Continue booking"] : [WELCOME[1], WELCOME[3]])]);
  }
  if (s.stage === "review" && !/^(?:continue|continue booking)$/.test(t)) {
    return respond("You can send the request below. The team will review it; no appointment or appointment change is confirmed by a request.", [], { action: "request" });
  }
  if (s.stage === "confirmed") return respond("This conversation already has a confirmed booking. Start a new conversation for another visit.", ["Start over"]);

  // -- starting paths (playbook §2) --------------------------------------------------------
  if (start === "cleaning" || /^(?:schedule (?:a )?(?:regular )?cleaning|book (?:dryer vent )?cleaning|book dryer vent cleaning)$/.test(t)) {
    if (s.intent === "cleaning" && s.package && !/regular/.test(t)) return next();
    startIntent("cleaning");
    s.bundleAccepted = false;
    s.route = "cleaning";
    ack = "Great, let's get your standard vent cleaning set up.";
    return next();
  }
  if (start === "help") {
    startIntent("cleaning", { help: true });
    s.bundleAccepted = false;
    s.route = "cleaning";
    ack = "I'd be glad to help you pick the perfect package.";
    return next();
  }
  if (start === "repair" || (/^(?:vent issue or repair|book assessment|assessment)$/.test(t) && !s.intent)) {
    startIntent("repair");
    ack = "Understood, specialized repair and assessment inquiry.";
    return next();
  }
  if (start === "emergency" || /^emergency clog(?: relief)?$/.test(t)) {
    startIntent("emergency");
    ack = "Emergency priority acknowledged.";
    return next();
  }
  if (start === "nest") {
    startIntent("nest");
    s.property.animals = "Yes";
    ack = "Understood, a bird or pest problem.";
    return next();
  }
  if (start === "faq" || /^(?:ask (?:a|another) question|faqs?)$/.test(t)) {
    const picks = approvedFaqs.slice(0, 5).map((f) => f.question);
    return respond("What would you like to know? Your booking answers stay in this conversation.", [...picks, ...(s.intent ? ["Continue booking"] : [])]);
  }
  if (/^(?:yes,? let'?s schedule|let'?s schedule)[.!]?$/.test(t)) return s.intent ? next() : welcome("Great! How can I help restore your dryer exhaust system today?");
  if (/^(?:continue|continue booking|back to (?:my )?booking|resume)$/.test(t)) return s.intent ? next() : welcome();

  const pendingBefore = s.pending;
  learn(text, s);
  const changed = (x) =>
    [JSON.stringify(x?.property || {}), x?.zip || "", x?.concerns?.length || 0, Boolean(x?.concernSkipped), x?.symptomConflict?.tries || 0, x?.otherFor || "", x?.notes?.length || 0, x?.repairScope || "", x?.dryerHot, Boolean(x?.dryerOffConfirmed), Boolean(x?.concernDescribed)].join("|");
  if (changed(current) !== changed(s) && pendingBefore && !s.symptomConflict && !s.otherFor) ack = ackFor(pendingBefore);
  if (pendingBefore === "repairScope" && s.repairScope === "Bird / Pest Infestation") {
    startIntent("nest");
    s.property.animals = "Yes";
    ack = "Understood, a bird or pest problem. Those need to be removed before the vent is cleaned.";
    return next();
  }
  // A free-text answer to "what's going on with the vent?" is recorded, not re-routed.
  if (["concern", "repairScope", "otherDetail", "triage", "safetyCheck", "powerOff"].includes(pendingBefore) && changed(current) !== changed(s)) return next();

  // -- package picks -----------------------------------------------------------------------
  const pickText = t.replace(/^select\s+/, "");
  const pick = s.stage !== "bundle_offer" && PICKS.find(([, re]) => re.test(pickText));
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
    // Compare what the customer is actually looking at: nest work compares nest options, not the routine tiers.
    const nestFlow = s.intent === "nest" || ["nest", "restoration"].includes(s.package) || (s.offerFamilies || []).includes("restoration");
    const families = nestFlow ? ["nest", "restoration"] : TIERS;
    const price = (f) => (priced ? totalOf(f) ?? 0 : null);
    // Cheapest first; each step up says what the extra money adds.
    const rows = families.map((f, i) => {
      const item = services.find((x) => x.family === f && x.active !== false);
      const head = `**${PACKAGES[f].short}${priced ? ` (${money(price(f))})` : ""}**`;
      if (i === 0) return `• ${head}: ${(item?.description || PACKAGES[f].pitch).replace(/\.$/, "")}.`;
      const more = priced && price(f) > price(families[i - 1]) ? ` for ${money(price(f) - price(families[i - 1]))} more` : "";
      return `• ${head}: everything in ${PACKAGES[families[i - 1]].short}${more}, plus ${UPGRADES[f]}.`;
    });
    const top = families[families.length - 1];
    s.stage = s.package ? "details" : "offer";
    if (!s.intent) s.intent = nestFlow ? "nest" : "cleaning";
    if (nestFlow) s.offerFamilies = families;
    const options = [...families.map(label), nestFlow ? "Ask a question" : "More services"];
    return respond(
      `Here's how the packages compare${homeLabel()}:\n\n${rows.join("\n")}\n\n**${PACKAGES[top].short}** is our most complete option.`,
      options,
      { suggested: s.suggested ? label(s.suggested) : undefined },
    );
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
    if (!s.intent) return respond(`${yes} Is there a specific vent issue you need evaluated?`, [WELCOME[3], WELCOME[1], "Ask a question"]);
    return resume(yes, { faq: true });
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
    s.concernDescribed = true;
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
    return resume(answer, { faq: true });
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
  if (faq) return { ...resume(faq.answer, { faq: true }), faq: faq.id };

  // -- answers to the pending question ---------------------------------------------------------
  if (s.stage === "evaluating" || (s.intent && !s.serviceAccepted && !["offer", "details", "bundle_offer"].includes(s.stage))) {
    if (changed(current) !== changed(s)) return next();
    if (s.pending === "zip") return respond("Please enter the five-digit ZIP code for the service address.", []);
    if (s.pending && !isQuestion) {
      ack = "Sorry, I didn't catch that.";
      return ask(s.pending);
    }
  }
  if (s.stage === "contact" || s.serviceAccepted) return resume("Your service is selected.");
  if ((s.stage === "offer" || s.stage === "details") && NO.test(t)) return respond("No problem — nothing has been booked. You can choose another option, ask a question, or ask the team to call you.", ["Back to packages", "Ask a question", "Request a callback"]);
  if (/^(?:request a callback|callback)$/.test(t)) {
    s.stage = "review";
    return respond("Send your details below and the team will follow up. A request doesn't book an appointment by itself.", [], { action: "request" });
  }
  if (intent.route === "clarify" || /^help me choose$/.test(t)) {
    return respond("Are you looking to schedule a routine cleaning, or is there a specific vent problem you need evaluated?", [WELCOME[1], WELCOME[3]]);
  }
  if (!s.intent && /^(?:hi|hello|hey|good (?:morning|afternoon|evening))[.!]?$/.test(t)) return welcome();
  return {
    ...resume("I don't have a verified answer to that yet. I can send the question to the team, or we can keep going with your booking."),
    unanswered: true,
  };
}
