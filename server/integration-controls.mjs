import { withConfigDefaults } from '../shared/domain.mjs';

const NAMES = new Set(['jobber', 'maps', 'verification', 'sms', 'email']);
const disabled = (name, code = 'INTEGRATION_DISABLED') => Object.assign(new Error(`The ${name} integration is disabled. Please contact the office.`), { code, integration: name });

/** Always reads persisted config: never retain a request/startup snapshot here.
 * Configuration read failures also fail closed. No database-off switch exists.
 */
export function createIntegrationControls({ store }) {
  async function enabled(name) {
    if (!NAMES.has(name)) return false;
    try { return withConfigDefaults(await store.config()).integrations?.[name] === true; }
    catch { return false; }
  }
  async function requireEnabled(name, code) {
    if (!await enabled(name)) throw disabled(name, code);
  }
  // Required in addition to method wrappers for providers whose compound methods
  // make multiple requests (Jobber client/property/job/visit, OAuth refresh, etc.).
  function fetchFor(nameOrResolver, fetchImpl = fetch) {
    return async (input, init, beforeSend) => {
      const name = typeof nameOrResolver === 'function' ? nameOrResolver(input, init) : nameOrResolver;
      await requireEnabled(name);
      await beforeSend?.();
      return fetchImpl(input, init);
    };
  }
  return { enabled, requireEnabled, fetchFor };
}

function wrap(provider, choose) {
  if (!provider) return provider;
  // Forward metadata reads/writes to the underlying provider (including test
  // doubles and mutable connection state); guard even subsequently replaced methods.
  return new Proxy(provider, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? choose(key, value.bind(target)) : value;
    },
  });
}

/** Metadata remains synchronous and describes credentials/capability, NOT whether
 * a toggle is on. UI/readiness must combine metadata with current config. Pure
 * diagnostic reads and local disconnect remain accessible while disabled.
 */
export function controlProviders({ controls, jobber, geo, twilio, sendgrid }) {
  const jobberOut = wrap(jobber, (key, fn) => {
    if (['authorizeUrl', 'disconnect', 'accountIdentityRevision', 'diagnostics', 'health'].includes(key)) return fn;
    if (key === 'connected') return async (...args) => await controls.enabled('jobber') ? fn(...args) : false;
    return async (...args) => { await controls.requireEnabled('jobber'); return fn(...args); };
  });
  const geoOut = wrap(geo, (key, fn) => {
    if (['lastIssue', 'diagnostics', 'health'].includes(key)) return fn;
    return async (...args) => {
      if (await controls.enabled('maps')) return fn(...args);
      if (key === 'driveMinutes') return Array(args[0]?.length || 0).fill(null);
      if (['suggestAddresses', 'serviceAreaSamples'].includes(key)) return [];
      if (key === 'addressFor') return null;
      throw disabled('maps', key === 'geocode' ? 'GEO_UNAVAILABLE' : 'ROUTING_UNAVAILABLE');
    };
  });
  const twilioOut = wrap(twilio, (key, fn) => async (...args) => {
    await controls.requireEnabled(key === 'sendSms' ? 'sms' : 'verification');
    if (key === 'sendSms') await args[2]?.beforeSend?.();
    return fn(...args);
  });
  const sendgridOut = wrap(sendgrid, (_key, fn) => async (...args) => {
    await controls.requireEnabled('email');
    return fn(...args);
  });
  return { jobber: jobberOut, geo: geoOut, twilio: twilioOut, sendgrid: sendgridOut };
}
