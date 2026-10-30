import { PERFORMANCE_LABELS, SYMPTOM_LABELS } from './pricing';

const opts = (labels) => Object.entries(labels).map(([value, label]) => ({ value, label }));

const afterLayout = (a) => (a.express ? 'recommend' : 'fuel');

// Each step: what BOB says, how the customer answers, and where it goes next.
// `ack` is an extra line BOB says before the next question for some answers.
export const STEPS = {
  start: {
    say: () =>
      "Hi, I'm BOB. I'll ask a few quick questions about your dryer, show your price, and book a time that's open on our schedule. What do you need today?",
    type: 'single',
    options: [
      { value: 'emergency', label: 'My dryer is overheating or clogged', urgent: true },
      { value: 'clean', label: 'Book a dryer vent cleaning' },
      { value: 'help', label: 'Help me choose a service' },
      { value: 'repair', label: 'Repair, reroute or upgrade a vent' },
    ],
    apply: (a, v) => ({ path: v }),
    next: (a) => (a.path === 'emergency' ? 'running' : a.path === 'repair' ? 'stories' : 'hasDryer'),
  },

  running: {
    say: () => "Let's handle this safely first. Is the dryer running or heating right now?",
    type: 'single',
    key: 'running',
    options: [
      { value: 'yes', label: "Yes, it's running or hot" },
      { value: 'no', label: "No, it's off" },
    ],
    next: (a) => (a.running === 'yes' ? 'stopNow' : 'symptoms'),
  },

  stopNow: {
    say: () =>
      "Please turn the dryer off now if you can do it safely. If you see smoke or fire, get out and call 911. I'll wait right here.",
    type: 'single',
    options: [{ value: 'off', label: "It's off now" }],
    apply: (a) => a,
    next: () => 'symptoms',
  },

  symptoms: {
    say: (a) =>
      a.running === 'yes'
        ? "Thanks, that lowers the risk. What's been happening with it? Pick everything that applies."
        : "Good. What's been happening with it? Pick everything that applies.",
    type: 'multi',
    key: 'symptoms',
    options: opts(SYMPTOM_LABELS),
    next: () => 'stories',
  },

  hasDryer: {
    say: (a) =>
      a.path === 'help'
        ? "Happy to help you pick. First, is a dryer installed, or is it just the vent?"
        : 'Great. First, is a dryer installed, or is it just the vent?',
    type: 'single',
    options: [
      { value: 'have', label: 'A dryer is installed' },
      { value: 'none', label: 'Just the vent' },
    ],
    apply: (a, v) => ({ ...a, express: v === 'none' }),
    next: (a) => (a.express ? 'stories' : a.path === 'clean' ? 'history' : 'stories'),
  },

  history: {
    say: () => 'When was the dryer vent last professionally cleaned?',
    type: 'single',
    key: 'history',
    options: [
      { value: 'within30', label: 'Within the last 30 days' },
      { value: 'over30', label: 'More than 30 days ago' },
      { value: 'unknown', label: "I don't know" },
    ],
    ack: { unknown: "No problem. I'll plan for a standard check." },
    next: (a) => (a.history === 'within30' ? 'hose' : 'stories'),
  },

  hose: {
    say: () => 'Was the transition hose behind the dryer replaced at that visit?',
    type: 'single',
    options: [
      { value: 'yes', label: 'Yes, it was replaced' },
      { value: 'no', label: 'No' },
    ],
    apply: (a, v) => ({ ...a, express: v === 'yes' }),
    next: () => 'stories',
  },

  stories: {
    say: (a) =>
      a.path === 'repair'
        ? "You're in the right place. Our in-house crew handles everything from simple fixes to full vent reroutes. A few quick questions so the team knows what to expect: is your home 1-story or 2-story?"
        : 'Is your home 1-story or 2-story?',
    type: 'single',
    key: 'stories',
    options: [
      { value: 'one', label: '1-story' },
      { value: 'two', label: '2-story' },
    ],
    apply: (a, v) => {
      const next = { ...a, stories: v };
      if (v === 'one') delete next.floor;
      return next;
    },
    next: (a) => (a.stories === 'two' ? 'floor' : afterLayout(a)),
  },

  floor: {
    say: () => 'Which floor is the laundry room on?',
    type: 'single',
    key: 'floor',
    options: [
      { value: 'first', label: '1st floor' },
      { value: 'second', label: '2nd floor' },
    ],
    next: afterLayout,
  },

  fuel: {
    say: () => 'Is your dryer gas or electric?',
    type: 'single',
    info: ['gasElectric', 'whyAsk'],
    options: [
      { value: 'gas', label: 'Gas' },
      { value: 'electric', label: 'Electric' },
      { value: 'unknown', label: "I don't know" },
    ],
    apply: (a, v) => ({ ...a, fuel: v === 'unknown' ? 'electric' : v }),
    ack: { unknown: "No problem. Most homes here are electric, so I'll plan for that." },
    next: () => 'config',
  },

  config: {
    say: () => 'Is the dryer standard, on a fixed pedestal, or stacked with the washer?',
    type: 'single',
    info: ['whyAsk'],
    options: [
      { value: 'standard', label: 'Standard' },
      { value: 'pedestal', label: 'On a fixed pedestal' },
      { value: 'stacked', label: 'Stacked with the washer' },
      { value: 'unknown', label: "I don't know" },
    ],
    apply: (a, v) => ({ ...a, config: v === 'unknown' ? 'standard' : v }),
    ack: { unknown: "No problem. I'll plan for a standard setup." },
    next: (a) => (a.path === 'repair' ? 'repairState' : a.path === 'emergency' ? 'recommend' : 'performance'),
  },

  performance: {
    say: () => 'How is the dryer drying right now? Pick everything that applies.',
    type: 'multi',
    key: 'performance',
    options: opts(PERFORMANCE_LABELS),
    next: () => 'pests',
  },

  pests: {
    say: () => 'Have you noticed birds or other animals around the outside vent?',
    type: 'single',
    key: 'pests',
    options: [
      { value: 'yes', label: 'Yes, I have' },
      { value: 'no', label: 'No' },
      { value: 'unknown', label: "I'm not sure" },
    ],
    next: () => 'recommend',
  },

  repairState: {
    say: () => 'How is the dryer working right now?',
    type: 'single',
    key: 'repairState',
    options: [
      { value: 'normal', label: 'Working normally' },
      { value: 'multi_cycle', label: 'Takes more than 1 cycle' },
      { value: 'not_working', label: 'Not working' },
      { value: 'unknown', label: "I don't know" },
    ],
    next: () => 'details',
  },

  details: {
    say: () => 'In a sentence or two, what needs fixing or changing?',
    type: 'text',
    key: 'details',
    placeholder: 'For example: the vent pipe in the attic came apart',
    next: () => 'assessment',
  },

  // Card steps: the chat shows a panel instead of answer buttons.
  assessment: { type: 'card' },
  recommend: { type: 'card' },
  promise: { type: 'card' },
  contact: { type: 'card' },
  slots: { type: 'card' },
  done: { type: 'card' },
};

// Which part of the booking the customer is in, for the progress line.
export const PHASES = ['Your dryer', 'Your price', 'Your details', 'Your time'];

export function phaseOf(stepId) {
  if (['recommend', 'promise', 'assessment'].includes(stepId)) return 1;
  if (stepId === 'contact') return 2;
  if (stepId === 'slots' || stepId === 'done') return 3;
  return 0;
}
