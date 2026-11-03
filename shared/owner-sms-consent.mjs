export const OWNER_SMS_CONSENT_VERSION = 'custom-ais-owner-alerts-v3';
export const OWNER_SMS_PURPOSES = Object.freeze(['booking_success','after_hours_emergency_requests','actionable_operational_failures']);
/** Earlier consent still covers what it said: v2 never mentioned after-hours emergency requests. */
export const OWNER_SMS_LEGACY_PURPOSES = Object.freeze({ 'custom-ais-owner-alerts-v2': Object.freeze(['booking_success','actionable_operational_failures']) });
export const OWNER_SMS_PROGRAM = 'Custom-AIs ChatDaddy Owner Alerts';
export const OWNER_SMS_TERMS_URL = 'https://custom-ais.com/sms-terms';
export const OWNER_SMS_PRIVACY_URL = 'https://custom-ais.com/privacy';
export const OWNER_SMS_SUPPORT_EMAIL = 'support@custom-ais.com';
export const OWNER_SMS_DISCLOSURE = 'I control this mobile number and agree to receive recurring automated text messages from Custom-AIs ChatDaddy Owner Alerts about successful ChatDaddy bookings, after-hours emergency requests that need my answer, and service errors that need my attention. These are not marketing messages. Consent is not a condition of purchase. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help. SMS Terms: https://custom-ais.com/sms-terms Privacy Policy: https://custom-ais.com/privacy';
