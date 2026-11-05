// Browser check: an emergency that came in after the 2 p.m. same-day cutoff hears about it when the
// times are shown (after verifying), not before the safety questions. Other visits get the usual line.
// Run after `npm run build`: npm run test:browser
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

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

const contact = { name: 'Pat Customer', phone: '+16235550100', email: 'pat@example.com', address: '1 Main St', city: 'Surprise', zip: '85388' };
const verifying = (extra) => ({
  stage: 'verify', options: [], intent: 'emergency', package: 'premium', history: [{ role: 'model', text: 'Almost done.' }], contact,
  verification: { provider: 'twilio', channel: 'sms', to: contact.phone, expires: Date.now() + 600_000, attempts: 0 }, verifyLastAttempt: Date.now() - 60_000, ...extra,
});

for (const [name, extra, expected, absent] of [
  ['after the cutoff', { emergencyAfterCutoff: true }, /past our 2 p\.m\. cutoff for same-day visits, so these are our soonest regular openings\. We do have an on-call technician/, null],
  ['before the cutoff', {}, /Here are the soonest openings for the full visit\./, /2 p\.m\. cutoff/],
]) {
  test(`emergency ${name}: the scheduling message`, async (t) => {
    const { server, origin } = await serve();
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); server.close(); });
    const page = await browser.newPage();
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/api/session') return json({ token: 't'.repeat(43), session: verifying(extra), config: { businessName: 'Dryer Vent Squad', bookingEnabled: true, verificationChannels: ['sms', 'email'], welcome: [] } });
      if (path === '/api/verify/check') return json({ verified: true, session: { ...verifying(extra), stage: 'slots', verification: undefined, verifiedContact: { channel: 'sms' } } });
      if (path === '/api/availability') return json({ slots: [], nextCursor: null, enabled: true });
      return json({});
    });
    await page.goto(`${origin}/chat`);
    const box = page.getByLabel('Verification code');
    await box.waitFor({ timeout: 15_000 });
    await box.fill('1234');
    await page.getByRole('button', { name: 'Verify' }).click();
    await page.getByText(/your phone is confirmed/).waitFor({ timeout: 10_000 });
    const said = await page.getByText(/your phone is confirmed/).first().textContent();
    assert.match(said, expected);
    if (absent) assert.doesNotMatch(said, absent);
  });
}
