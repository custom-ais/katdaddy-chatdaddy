import { ADDONS, LAYOUTS, PACKAGES, SEVERITY_CREDIT, SURCHARGES } from './catalog';

const SEVERE_SIGNS = ['three_plus', 'damp', 'overheating', 'error_code'];

export const PERFORMANCE_LABELS = {
  one_cycle: 'Dries in one normal cycle',
  two_cycles: 'Takes about 2 cycles',
  three_plus: 'Takes 3 or more cycles',
  damp: 'Clothes still damp after several cycles',
  overheating: 'Overheating or shutting off',
  error_code: 'Showing an airflow error code',
  unsure: 'Not sure',
};

export const SYMPTOM_LABELS = {
  overheating: 'Overheating or shutting off',
  error_code: 'Error code (D80, D90, D95)',
  low_airflow: 'Little or no airflow outside',
  multiple_cycles: 'Takes several cycles to dry',
  nest: 'Possible nest or blockage',
  burning: 'Burning smell',
  other: 'Something else',
};

export function layoutOf(answers) {
  if (answers.stories === 'two') return answers.floor === 'second' ? 'twoSecond' : 'twoFirst';
  return 'one';
}

// How restricted the airflow probably is, from what the customer told BOB.
export function severityOf(answers) {
  if (answers.path === 'emergency') return 'severe';
  const perf = answers.performance || [];
  if (perf.some((p) => SEVERE_SIGNS.includes(p))) return 'severe';
  if (perf.includes('two_cycles')) return 'moderate';
  return 'good';
}

// Which packages to show and which one BOB suggests.
export function recommend(answers) {
  if (answers.path === 'repair') {
    return { kind: 'repair', suggested: 'repair', options: ['repair'], severity: null };
  }
  if (answers.express) {
    return { kind: 'express', suggested: 'express', options: ['express'], severity: null };
  }
  const severity = severityOf(answers);
  const suggested = severity === 'severe' ? 'total' : severity === 'moderate' ? 'performance' : 'essential';
  const options = ['essential', 'performance', 'total'];
  if (answers.path === 'emergency') options.push('emergency');
  const nestSigns = answers.pests === 'yes' || (answers.symptoms || []).includes('nest');
  if (nestSigns) options.push('nest');
  return { kind: 'core', suggested, options, severity };
}

// The price for one package, broken into lines, plus how long the visit takes.
export function quote(packageId, answers, addons = []) {
  const pkg = PACKAGES[packageId];
  if (!pkg) throw new Error(`Unknown package: ${packageId}`);
  const layout = layoutOf(answers);
  const severity = severityOf(answers);
  const lines = [];
  let minutes;

  if (pkg.kind === 'core' || pkg.kind === 'express') {
    let base = pkg.prices[layout];
    minutes = pkg.minutes[layout];
    let note = LAYOUTS[layout];
    if (packageId === 'total' && severity === 'severe' && answers.path !== 'repair') {
      base -= SEVERITY_CREDIT;
      note += `, includes $${SEVERITY_CREDIT} severity credit`;
    }
    lines.push({ label: pkg.name, note, amount: base });
  } else {
    minutes = pkg.minutes;
    lines.push({ label: pkg.name, note: '', amount: pkg.price });
  }

  if (pkg.kind === 'core') {
    if (answers.fuel === 'gas') {
      lines.push({ label: SURCHARGES.gas.label, note: '', amount: SURCHARGES.gas.amount });
      minutes += SURCHARGES.gas.minutes;
    }
    if (answers.config === 'pedestal') lines.push({ label: SURCHARGES.pedestal.label, note: '', amount: SURCHARGES.pedestal.amount });
    if (answers.config === 'stacked') lines.push({ label: SURCHARGES.stacked.label, note: '', amount: SURCHARGES.stacked.amount });
  }

  for (const id of addons) {
    const addon = ADDONS[id];
    if (!addon) continue;
    lines.push({ label: addon.name, note: addon.description, amount: addon.price });
    minutes += addon.minutes;
  }

  const total = lines.reduce((sum, l) => sum + l.amount, 0);
  return { packageId, name: pkg.name, lines, total, minutes };
}

export function money(n) {
  return `$${Number(n).toLocaleString('en-US')}`;
}

// Add-ons a customer can choose for a package.
export function addonsFor(packageId) {
  const kind = PACKAGES[packageId]?.kind;
  return kind === 'core' || kind === 'express' || packageId === 'nest' ? ['fogging'] : [];
}
