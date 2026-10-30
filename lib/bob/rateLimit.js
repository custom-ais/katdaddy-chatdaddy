// Small per-visitor limit so the public booking and question endpoints can't be spammed.
// It lives in server memory, so it resets when Vercel starts a fresh instance.
const buckets = new Map();

export function allow(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  if (b.count >= max) return false;
  b.count += 1;
  return true;
}

export function clientIp(request) {
  return (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
}
