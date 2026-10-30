// Everything BOB knows about Dryer Vent Squad West Valley's services.
// Prices, durations and hours live here so the chat, the Jobber booking and
// the AI answers all use the same numbers. Change a price here and it changes everywhere.

export const BUSINESS = {
  name: 'Dryer Vent Squad West Valley',
  phone: '(623) 294-1826',
  tel: '+16232941826',
  website: 'https://dryerventsquadaz.com',
  logo: 'https://dryerventsquadaz.com/wp-content/uploads/2025/09/Official-dvs-west-logo.png',
  timezone: 'America/Phoenix', // Arizona does not change clocks, so this is UTC-7 all year
};

// When customers can book. 0 = Sunday ... 6 = Saturday. Hours are local, 24h clock.
export const HOURS = {
  1: { open: 9, close: 17 },
  2: { open: 9, close: 17 },
  3: { open: 9, close: 17 },
  4: { open: 9, close: 17 },
  5: { open: 9, close: 17 },
  6: { open: 10, close: 14 },
};

export const HOURS_TEXT = 'Mon–Fri 9am–5pm, Sat 10am–2pm';

export const BOOKING = {
  leadMinutes: 120, // earliest bookable time is at least this far from now
  horizonDays: 14, // how far ahead BOB offers times
  stepMinutes: 30, // start times are offered on the half hour
  bufferMinutes: 30, // drive time kept clear before and after other visits
};

export const LAYOUTS = {
  one: '1-story home',
  twoFirst: '2-story home, laundry on the 1st floor',
  twoSecond: '2-story home, laundry on the 2nd floor',
};

export const PACKAGES = {
  essential: {
    name: 'Essential See-It-Clean',
    short: 'Essential',
    kind: 'core',
    prices: { one: 189, twoFirst: 229, twoSecond: 219 },
    minutes: { one: 60, twoFirst: 80, twoSecond: 70 },
    features: [
      'Full vent cleaning with a live camera inspection',
      'Airflow checked before and after',
      'Lint screen, lint cavity and dryer drum cleaned',
      'Area around the dryer cleaned up',
    ],
  },
  performance: {
    name: 'Performance See-It-Clean',
    short: 'Performance',
    kind: 'core',
    prices: { one: 249, twoFirst: 289, twoSecond: 269 },
    minutes: { one: 90, twoFirst: 110, twoSecond: 100 },
    features: [
      'Everything in Essential',
      'Before-and-after photos',
      'DryerFlex transition hose upgrade',
    ],
  },
  total: {
    name: 'Total System See-It-Clean',
    short: 'Total System',
    kind: 'core',
    prices: { one: 349, twoFirst: 389, twoSecond: 369 },
    minutes: { one: 120, twoFirst: 140, twoSecond: 130 },
    features: [
      'Everything in Performance',
      'Termination cleanout, with roof access when needed',
      'Correction of significant airflow restrictions',
      'Reusable wool dryer balls',
      'Full clogs and nests are extra, with $50 off if removal is needed',
    ],
  },
  express: {
    name: 'Express Vent Cleaning',
    short: 'Express',
    kind: 'express',
    prices: { one: 149, twoFirst: 189, twoSecond: 169 },
    minutes: { one: 40, twoFirst: 60, twoSecond: 50 },
    features: ['Vent-only cleaning, no dryer needed', 'Live camera inspection during service'],
  },
  emergency: {
    name: 'Emergency Same-Day Clog Relief',
    short: 'Emergency clog relief',
    kind: 'specialty',
    price: 349,
    minutes: 75,
    features: [
      'Urgent blockage removal',
      'Airflow restored and verified',
      'Live camera inspection',
    ],
  },
  nest: {
    name: 'Nest Removal Plus Cleaning',
    short: 'Nest removal',
    kind: 'specialty',
    price: 389,
    minutes: 90,
    features: ['Nest removal plus a full vent cleaning', 'Before-and-after photos', 'Airflow verified'],
  },
  repair: {
    name: 'Comprehensive Repair Assessment',
    short: 'Repair assessment',
    kind: 'repair',
    price: 119,
    minutes: 60,
    features: [
      'Airflow velocity test',
      'Visual and in-duct camera scan',
      'Attic or roof access if needed',
      'Report with marked-up photos and upfront repair quotes',
      'Fully credited toward the repair if you hire us',
    ],
  },
};

// Extra charges on the core See-It-Clean packages only.
export const SURCHARGES = {
  gas: { label: 'Gas appliance safety procedure', amount: 49, minutes: 15 },
  pedestal: { label: 'Fixed pedestal setup', amount: 20, minutes: 0 },
  stacked: { label: 'Stacked washer and dryer', amount: 45, minutes: 0 },
};

export const ADDONS = {
  fogging: {
    name: 'Sanitation fogging',
    price: 79,
    minutes: 15,
    description: 'Antimicrobial fogging treatment for the vent line',
  },
};

export const SEVERITY_CREDIT = 50;

export const REPAIR_STEPS = [
  'Inspect and report',
  'Protect and prep the workspace',
  'Rebuild and restore',
  'Patch and match the drywall texture',
  'Test, with a 3-year guarantee',
];

export const PRICING_NOTE =
  'Most cleanings are finished at the package price. If the vent turns out to be over 35 ft, damaged, out of code or badly clogged, we give you an updated price before any extra work starts.';
