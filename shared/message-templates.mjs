import { normalizeClientHubUrl } from './client-hub.mjs';

export const MESSAGE_TEMPLATE_FIELDS = [
  { key: 'confirmationSms', label: 'Customer confirmation SMS', maxLength: 1200, maxRenderedLength: 1577 },
  { key: 'confirmationEmailSubject', label: 'Confirmation email subject', maxLength: 200, maxRenderedLength: 998, subject: true },
  { key: 'confirmationEmailBody', label: 'Confirmation email body', maxLength: 20000, maxRenderedLength: 200000 },
  { key: 'ownerBookingSms', label: 'Owner booking SMS', maxLength: 1200, maxRenderedLength: 1600 },
];
export const DEFAULT_MESSAGE_TEMPLATES = Object.freeze(Object.fromEntries(MESSAGE_TEMPLATE_FIELDS.map(f => [f.key, ''])));
export const MESSAGE_VARIABLES = [
  ['customer_first_name', 'Customer first name', 'Alex'],
  ['customer_name', 'Customer full name', 'Alex Example'],
  ['company_name', 'Company name', 'Example Service Company'],
  ['service', 'Booked service', 'Dryer Vent Cleaning'],
  ['appointment_date', 'Appointment date (Arizona)', 'Mon, Nov 2, 2026'],
  ['appointment_time', 'Appointment start time (Arizona)', '11:00 AM Arizona time'],
  ['service_address', 'Service address', '100 Example St, Example City, AZ 85000'],
  ['booking_reference', 'Booking reference', 'DVS-SAMPLE'],
  ['total', 'Service total', '$179.00'],
  ['company_phone', 'Company phone', '(623) 555-0100'],
  ['preparation', 'Preparation instructions', 'Clear a path to the laundry area.'],
  ['client_hub_url', 'Account-bound Client Hub link (blank if unavailable)', 'https://clienthub.getjobber.com/'],
].map(([key,label,sample]) => ({key,label,sample}));
const allowed = new Set(MESSAGE_VARIABLES.map(v => v.key));
for (const field of MESSAGE_TEMPLATE_FIELDS) field.variables = MESSAGE_VARIABLES.filter(v => v.key !== 'client_hub_url' || field.key === 'confirmationEmailBody').map(v => v.key);
const fields = new Map(MESSAGE_TEMPLATE_FIELDS.map(f => [f.key,f]));
export const CUSTOMER_SMS_FOOTER = 'Reply STOP to opt out.';
function templateErrors(template, { subject = false, maxLength = 20000, variables = [...allowed] } = {}) {
  if (typeof template !== 'string') return ['must be text'];
  const errors = [];
  if (template.length > maxLength) errors.push(`must be at most ${maxLength} characters`);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(template) || subject && /[\r\n]/.test(template)) errors.push('contains unsupported control characters');
  const rest = template.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (_, key) => { if (!allowed.has(key) || !variables.includes(key)) errors.push(`unknown variable: ${key}`); return ''; });
  if (/[{}]/.test(rest)) errors.push('contains malformed variable syntax; use {{variable_name}}');
  return errors;
}
export function validateMessageTemplates(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['Message templates must be an object.'];
  const errors = [];
  for (const [key, template] of Object.entries(value)) {
    if (!fields.has(key)) { errors.push(`Unknown message template: ${key}.`); continue; }
    errors.push(...templateErrors(template, fields.get(key)).map(e => `${fields.get(key).label} ${e}.`));
  }
  return errors;
}
export function renderMessageTemplate(template, values, options = {}) {
  const errors = templateErrors(template, options);
  if (errors.length) throw new Error(`Invalid message template: ${errors.join('; ')}`);
  // One pass only: customer data cannot introduce new substitutions or executable code.
  const result = template.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (_, key) => {
    const value = String(values?.[key] ?? '');
    return options.subject ? value.replace(/[\x00-\x1f\x7f]+/g, ' ') : value;
  });
  const limit = options.maxRenderedLength ?? (options.subject ? 998 : 200000);
  if (result.length > limit) throw new Error('Rendered message is too long.');
  return result;
}
export function messageTemplateValues(appt, config, { clientHubUrl = '' } = {}) {
  let hub = '';
  try { hub = normalizeClientHubUrl(clientHubUrl); } catch {}
  const date = new Date(appt.scheduledAt);
  const validDate = Number.isFinite(date.getTime());
  const format = opts => validDate ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/Phoenix', ...opts }).format(date) : '';
  const name = String(appt.customerName || '').trim();
  const digits = String(config.phone || '').replace(/\D/g, '').slice(-10);
  return {
    customer_first_name: name.split(/\s+/)[0] || 'there', customer_name: name,
    company_name: String(config.businessName || ''), service: String(appt.package || ''),
    appointment_date: format({ weekday:'short',month:'short',day:'numeric',year:'numeric' }),
    appointment_time: validDate ? format({hour:'numeric',minute:'2-digit'}) + ' Arizona time' : '',
    service_address: [appt.address,appt.city,['AZ',appt.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    booking_reference: String(appt.id || ''),
    total: Number.isFinite(appt.price) ? new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(appt.price) : '',
    company_phone: digits.length === 10 ? `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}` : String(config.phone || ''),
    preparation: String(config.preparation || ''), client_hub_url: hub,
  };
}
