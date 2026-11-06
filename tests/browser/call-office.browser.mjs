// Browser check: once BOB sends an emergency to the office, the page shows a tap-to-call button for
// the office's number (Settings → phone, else (623) 294-1826).
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

const reply = "Good. That reduces risk.\n\nPlease call our office at **(623) 294-1826** so the team can help you right away.";
for (const [name, phone, href, label] of [
  ['the office phone from Settings', '6232941826', 'tel:+16232941826', '(623) 294-1826'],
  ['no phone in Settings falls back to the office line', '', 'tel:+16232941826', '(623) 294-1826'],
  ['a different Settings phone is used', '(602) 555-0199', 'tel:+16025550199', '(602) 555-0199'],
]) {
  test(`call button: ${name}`, async (t) => {
    const { server, origin } = await serve();
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); server.close(); });
    const page = await browser.newPage();
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/api/session') return json({ token: 't'.repeat(43), session: { stage: 'welcome', options: ['Emergency'], history: [{ role: 'model', text: 'Hi!' }] }, config: { businessName: 'Dryer Vent Squad', bookingEnabled: true, phone, welcome: [] } });
      if (path === '/api/chat') return json({ session: { stage: 'call_office', intent: 'emergency', options: ['Book a Cleaning'], history: [] }, reply, options: ['Book a Cleaning'], action: 'call_office', phone: label });
      return json({});
    });
    await page.goto(`${origin}/chat`);
    const input = page.getByPlaceholder(/Type your message/i);
    await input.waitFor({ timeout: 15_000 });
    await input.fill('Dryer is off now');
    await input.press('Enter');
    const call = page.getByRole('link', { name: /Call the office/ });
    await call.waitFor({ timeout: 10_000 });
    assert.equal(await call.getAttribute('href'), href);
    assert.match(await call.textContent(), new RegExp(label.replace(/[()]/g, '\\$&')));
  });
}
