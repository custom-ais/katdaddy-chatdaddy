// Fail-closed deployment preview: static responses only. Do not import runtime,
// database adapters, provider clients or environment-derived configuration here.
import { DEFAULT_CONFIG, BUNDLE_PRICE_CENTS, TIME_ZONE } from '../shared/domain.mjs';
import { initialSession, WELCOME } from '../shared/conversation.mjs';

export function isReadOnlyPreview(env = process.env) {
  return env.VERCEL_ENV === 'preview' || (env.VERCEL != null && env.VERCEL_ENV !== 'production');
}

export function previewPublicConfig() {
  return {
    preview: true, readOnly: true,
    businessName: DEFAULT_CONFIG.businessName,
    phone: '', email: '', bookingEnabled: false, smartChat: false,
    addressSuggestions: false, timeZone: TIME_ZONE,
    cleaningPriceCents: DEFAULT_CONFIG.cleaningPriceCents,
    assessmentPriceCents: DEFAULT_CONFIG.assessmentPriceCents,
    bundlePriceCents: BUNDLE_PRICE_CENTS,
    preparation: DEFAULT_CONFIG.preparation,
    pricesApproved: false, notificationsConfigured: false,
    textMessages: false, phoneVerification: false, verificationChannels: [],
    approverName: '', addOns: [], faqs: [], welcome: [...WELCOME],
  };
}

export function handleReadOnlyPreview(req, res) {
  const send = (status, data) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow',
    });
    res.end(JSON.stringify(data));
  };
  let path;
  try { path = new URL(req.url || '/', 'http://preview.invalid').pathname; }
  catch { return send(400, { preview: true, readOnly: true, error: 'Invalid preview request.' }); }
  const method = req.method || 'GET';
  if (method === 'GET' && path === '/api/health') {
    return send(200, { ok: true, preview: true, readOnly: true, bookingEnabled: false, runtimeInitialized: false });
  }
  if (method === 'GET' && path === '/api/public/config') return send(200, previewPublicConfig());
  // An inert bootstrap enables the existing initial screen, not interactive
  // simulation. This token has no persisted session and grants no permissions.
  if (method === 'POST' && path === '/api/session') {
    return send(201, { preview: true, readOnly: true, token: 'preview-read-only', session: initialSession(), config: previewPublicConfig() });
  }
  return send(403, { preview: true, readOnly: true, error: 'Read-only preview: booking, messages, verification, admin access and live integrations are disabled.' });
}
