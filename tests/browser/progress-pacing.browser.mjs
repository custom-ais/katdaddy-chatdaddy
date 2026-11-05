// Browser check of the "Finding your openings" popup: its steps are spread across the wait instead
// of the first three checking off within two seconds and the last one spinning for the rest.
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

const session = {
  stage: 'slots', options: [], package: 'premium', addOns: {},
  history: [{ role: 'model', text: 'Here are the soonest openings.' }],
  contact: { name: 'Pat Customer', address: '1 Main St', city: 'Surprise', zip: '85388', phone: '(623) 555-0100' },
};
const WAIT = 8_000;

test('openings popup checks steps off across the wait and remembers how long it took', async (t) => {
  const { server, origin } = await serve();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); server.close(); });
  const page = await browser.newPage();
  // This browser's last lookup took 8 seconds, so each of the four steps gets about 2 seconds.
  await page.addInitScript((ms) => { try { localStorage.setItem('bob:wait:openings', String(ms)); } catch {} }, WAIT);
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/session') return json({ token: 't'.repeat(43), session, config: { businessName: 'Dryer Vent Squad', bookingEnabled: true, welcome: [] } });
    if (path === '/api/availability') { await new Promise((r) => setTimeout(r, WAIT)); return json({ slots: [{ scheduledAt: '2026-11-13T19:30:00.000Z', nearby: false }], nextCursor: null, enabled: true }); }
    return json({});
  });
  await page.goto(`${origin}/chat`);
  const popup = page.getByRole('dialog', { name: 'Finding your openings' });
  await popup.waitFor({ timeout: 15_000 });
  const opened = Date.now();
  const checked = () => popup.locator('li svg.text-emerald-500').count();
  const at = async (ms) => { await page.waitForTimeout(Math.max(0, opened + ms - Date.now())); return checked(); };
  // Steps finish at about 2 s, 4 s and 6 s; sample between them.
  assert.equal(await at(1_000), 0, 'nothing is checked off in the first second');
  assert.equal(await at(3_000), 1, 'one step by 3 s (the old timer had three)');
  assert.equal(await at(5_000), 2, 'two steps by 5 s');
  assert.equal(await at(7_000), 3, 'three steps by 7 s, the last one still running');
  await popup.waitFor({ state: 'detached', timeout: 10_000 });
  await page.getByText('Friday, Nov 13').first().waitFor({ timeout: 5_000 });
  const remembered = Number(await page.evaluate(() => localStorage.getItem('bob:wait:openings')));
  assert.ok(Math.abs(remembered - WAIT) < 1_500, `remembers about ${WAIT} ms, got ${remembered}`);
});
