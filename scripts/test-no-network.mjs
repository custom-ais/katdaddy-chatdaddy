// Tests may talk only to their loopback HTTP harness. Provider APIs must inject
// fake fetch implementations; a forgotten mock must never send a real message.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('External network fetch blocked in tests; inject a fake provider.');
  }
  return nativeFetch(input, { ...options, redirect: options?.redirect === 'manual' ? 'manual' : 'error' });
};
