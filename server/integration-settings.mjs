import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const INTEGRATION_FIELDS = [
  ['GEMINI_API_KEY', 'Gemini API key', 'AI'], ['GOOGLE_MAPS_API_KEY', 'Google Maps API key', 'Maps'],
  ['JOBBER_CLIENT_ID', 'Jobber client ID', 'Jobber'], ['JOBBER_CLIENT_SECRET', 'Jobber client secret', 'Jobber'], ['JOBBER_REDIRECT_URI', 'Jobber redirect URL', 'Jobber'],
  ['LC_PRIVATE_TOKEN', 'HighLevel private integration token', 'HighLevel'], ['LC_LOCATION_ID', 'HighLevel location ID', 'HighLevel'], ['LC_FROM_NUMBER', 'HighLevel sending number', 'HighLevel'],
  ['SMTP_HOST', 'SMTP host', 'Email'], ['SMTP_PORT', 'SMTP port (465 or 587)', 'Email'], ['SMTP_USER', 'Email account', 'Email'], ['SMTP_PASSWORD', 'Email app password', 'Email'],
  ['EMAIL_FROM', 'From email address', 'Email'], ['EMAIL_REPLY_TO', 'Reply-to email address', 'Email'],
].map(([key, label, group]) => ({ key, label, group }));
const allowed = new Set(INTEGRATION_FIELDS.map((f) => f.key));

function encryptionKey(env) {
  const value = String(env.BOB_SECRET_KEY || '').trim();
  const key = /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  return key.length === 32 ? key : null;
}

export function createIntegrationSettings({ store, env = process.env }) {
  const key = encryptionKey(env);
  const open = (sealed) => {
    if (!sealed) return {};
    if (!key) throw new Error('BOB_SECRET_KEY is required to unlock saved integration settings.');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAAD(Buffer.from('bob:integration-settings:v1'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8'));
  };
  const seal = (values) => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('bob:integration-settings:v1'));
    const data = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()]);
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  };
  return {
    async resolve() {
      const saved = await store.kvGet('integrations:encrypted');
      return { revision: saved?.revision || '', values: open(saved?.sealed) };
    },
    async status() {
      let values = {}, issue = '';
      try { values = (await this.resolve()).values; } catch { issue = 'Saved keys could not be unlocked. Check BOB_SECRET_KEY in Vercel.'; }
      return { writable: Boolean(key), issue, fields: INTEGRATION_FIELDS.map((f) => ({ ...f, configured: Boolean(values[f.key] || env[f.key]), source: values[f.key] ? 'dashboard' : env[f.key] ? 'vercel' : 'missing' })) };
    },
    async update({ values = {}, remove = [] }) {
      if (!key) throw new Error('Add a 32-byte BOB_SECRET_KEY in Vercel to enable encrypted key storage.');
      if (!values || typeof values !== 'object' || Array.isArray(values) || !Array.isArray(remove)) throw new Error('Invalid integration settings.');
      for (const [name, value] of Object.entries(values)) {
        if (!allowed.has(name) || typeof value !== 'string' || !value.trim() || value.length > 8000 || /[\r\n]/.test(value)) throw new Error('Invalid integration field.');
        if (name === 'SMTP_PORT' && !['465', '587'].includes(value.trim())) throw new Error('Use SMTP port 465 or 587.');
        if (name === 'JOBBER_REDIRECT_URI' && !value.startsWith('https://')) throw new Error('The Jobber redirect URL must use HTTPS.');
      }
      if (remove.some((name) => !allowed.has(name))) throw new Error('Invalid integration field.');
      if (!(await store.lock('integration-settings', 15))) throw new Error('Settings are being saved. Try again shortly.');
      try {
        const current = (await this.resolve()).values;
        for (const name of remove) delete current[name];
        for (const [name, value] of Object.entries(values)) current[name] = value.trim();
        await store.kvSet('integrations:encrypted', { sealed: seal(current), revision: randomBytes(12).toString('hex'), at: store.clock() });
        await store.audit('integrations.updated', [...Object.keys(values), ...remove].join(', '));
      } finally { await store.unlock('integration-settings'); }
      return this.status();
    },
  };
}
