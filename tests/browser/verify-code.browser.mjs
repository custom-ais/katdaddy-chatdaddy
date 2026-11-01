// Browser check of the booking page's code step: type the code, click Verify, and the page
// must actually call /api/verify/check. Unit tests can't see the page's own guards (a stale
// "6 digits" check once made Verify silently do nothing).
// Run after `npm run build`: npm run test:browser
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
// Playwright isn't a project dependency: use the one installed on the machine (npx playwright install chromium).
const { chromium } = createRequire(import.meta.url)('playwright');
import { CODE_DIGITS } from '../../shared/verification-code.mjs';

const dist = new URL('../../dist/', import.meta.url).pathname;
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

async function serve() {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = path.startsWith('/assets/') || extname(path) ? join(dist, path) : join(dist, 'index.html');
    try { res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }); res.end(await readFile(file)); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

// A conversation waiting at the code step, with a code already sent by `channel`.
function verifySession(channel) {
  const contact = { name: 'Pat Customer', phone: '+16235550100', email: 'pat@example.com' };
  return {
    stage: 'verify', options: [], history: [{ role: 'model', text: 'Almost done — confirm your contact details.' }], contact,
    verification: { provider: 'twilio', channel, to: channel === 'email' ? contact.email : contact.phone, expires: Date.now() + 600_000, attempts: 0 },
    verifyLastAttempt: Date.now() - 60_000,
  };
}

for (const channel of ['email', 'sms']) {
  test(`${channel}: typing a ${CODE_DIGITS}-digit code and clicking Verify checks it`, async (t) => {
    const { server, origin } = await serve();
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); server.close(); });
    const page = await browser.newPage();
    const checks = [];
    await page.route('**/api/**', async (route) => {
      const req = route.request(), path = new URL(req.url()).pathname;
      const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/api/session') return json({ token: 't'.repeat(43), session: verifySession(channel), config: { businessName: 'Dryer Vent Squad', bookingEnabled: true, verificationChannels: ['sms', 'email'], welcome: [] } });
      if (path === '/api/verify/check') { checks.push(req.postDataJSON()); return json({ verified: true, session: { ...verifySession(channel), stage: 'slots', verification: undefined, verifiedContact: { channel } } }); }
      return json({ slots: [], days: [] });
    });
    await page.goto(`${origin}/chat`);
    const box = page.getByLabel('Verification code');
    await box.waitFor({ timeout: 15_000 });
    assert.equal(await box.getAttribute('maxlength'), String(CODE_DIGITS));
    await assert.doesNotReject(page.getByText(`${channel === 'email' ? 'emailed' : 'texted'} a ${CODE_DIGITS}-digit code`).waitFor({ timeout: 5_000 }));
    await box.fill('123456789'.slice(0, CODE_DIGITS + 2)); // extra digits are cut to the code length
    assert.equal(await box.inputValue(), '123456789'.slice(0, CODE_DIGITS));
    await page.getByRole('button', { name: 'Verify' }).click();
    await page.waitForFunction(() => !document.querySelector('[aria-label="Verification code"]'), null, { timeout: 5_000 }).catch(() => {});
    assert.deepEqual(checks, [{ code: '123456789'.slice(0, CODE_DIGITS) }], 'Verify must send the code to the server');
  });
}
