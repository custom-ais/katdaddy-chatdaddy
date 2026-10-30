import { ADDONS, PACKAGES } from './catalog';
import { addonsFor, recommend } from './pricing';

const ONE_OF = {
  path: ['emergency', 'clean', 'help', 'repair'],
  stories: ['one', 'two'],
  floor: ['first', 'second'],
  fuel: ['gas', 'electric'],
  config: ['standard', 'pedestal', 'stacked'],
  pests: ['yes', 'no', 'unknown'],
  repairState: ['normal', 'multi_cycle', 'not_working', 'unknown'],
  history: ['within30', 'over30', 'unknown'],
  running: ['yes', 'no'],
};
const MANY_OF = {
  performance: ['one_cycle', 'two_cycles', 'three_plus', 'damp', 'overheating', 'error_code', 'unsure'],
  symptoms: ['overheating', 'error_code', 'low_airflow', 'multiple_cycles', 'nest', 'burning', 'other'],
};

const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Keeps only answers BOB actually asks for, so prices are always worked out from known values.
export function cleanAnswers(raw = {}) {
  const a = {};
  for (const [k, allowed] of Object.entries(ONE_OF)) if (allowed.includes(raw[k])) a[k] = raw[k];
  for (const [k, allowed] of Object.entries(MANY_OF)) {
    if (Array.isArray(raw[k])) a[k] = raw[k].filter((v) => allowed.includes(v));
  }
  a.express = raw.express === true;
  a.details = text(raw.details, 600);
  if (!a.path) a.path = 'clean';
  return a;
}

// The package must be one BOB actually offered for these answers.
export function checkPackage(packageId, answers, addons) {
  const rec = recommend(answers);
  if (!PACKAGES[packageId] || !rec.options.includes(packageId)) return null;
  const allowed = addonsFor(packageId);
  const cleanAddons = (Array.isArray(addons) ? addons : []).filter((id) => ADDONS[id] && allowed.includes(id));
  return { packageId, addons: [...new Set(cleanAddons)] };
}

export function cleanContact(raw = {}) {
  const c = {
    firstName: text(raw.firstName, 60),
    lastName: text(raw.lastName, 60),
    email: text(raw.email, 120).toLowerCase(),
    phone: String(raw.phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''),
    street: text(raw.street, 120),
    city: text(raw.city, 60),
    zip: String(raw.zip || '').replace(/\D/g, '').slice(0, 5),
    notes: text(raw.notes, 500),
  };
  const problems = [];
  if (!c.firstName) problems.push('first name');
  if (!c.lastName) problems.push('last name');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) problems.push('email');
  if (!/^\d{10}$/.test(c.phone)) problems.push('10-digit phone number');
  if (!c.street) problems.push('street address');
  if (!c.city) problems.push('city');
  if (!/^\d{5}$/.test(c.zip)) problems.push('5-digit ZIP');
  return { contact: c, problems };
}
