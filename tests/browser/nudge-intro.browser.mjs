// Browser check of the website nudge against a real local BOB (fresh in-memory database), on a page
// from another site: nothing until the visitor scrolls, then BOB introduces itself with a page-aware
// booking button and "Ask a question", which opens the chat's common questions with the message box
// ready. Once dismissed it stays away.
// Run after `npm run build`: npm run test:browser
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const root = new URL('../../', import.meta.url).pathname;
const freePort = () => new Promise((resolve) => { const s = netServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

async function startBob() {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), ADMIN_PASSWORD: 'Local-browser-test-only-2026', BOB_PGLITE_DIR: 'memory://nudge-intro' };
  for (const key of Object.keys(env)) if (/^(DATABASE_URL|POSTGRES_|SUPABASE_|NEXT_PUBLIC_SUPABASE|VERCEL)/.test(key)) delete env[key];
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('BOB did not start')), 20_000);
    child.stdout.on('data', (d) => { if (String(d).includes('BOB on')) { clearTimeout(timer); resolve(); } });
    child.on('exit', (code) => reject(new Error(`BOB exited ${code}`)));
  });
  return { origin: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}
// A tall website page on another origin. The path picks the page topic (/ = general, /prices = cleaning).
async function serveSite(bobOrigin) {
  const server = createServer((req, res) => {
    // The home page's title names cleaning and repair, like the real one; it still gets the general offer.
    const title = req.url.startsWith('/prices') ? 'Dryer vent cleaning prices' : 'Professional dryer vent cleaning & repair';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${title}</title><h1>${title}</h1><div style="height:3000px"></div><script src="${bobOrigin}/embed.js" defer></script>`);
  });
  await new Promise((r) => server.listen(0, 'localhost', r));
  return { server, origin: `http://localhost:${server.address().port}` };
}

test('BOB introduces itself once the visitor scrolls, and Ask a question opens its questions', async (t) => {
  const bob = await startBob();
  const site = await serveSite(bob.origin);
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); bob.stop(); site.server.close(); });

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${site.origin}/`);
  const nudge = page.locator('#dvs-bob-widget .nudge');
  await page.locator('#dvs-bob-widget .launcher').waitFor();
  await page.waitForTimeout(1500);
  assert.equal(await nudge.isVisible(), false, 'nothing before they scroll');
  await page.mouse.wheel(0, 40);
  await page.waitForTimeout(400);
  assert.equal(await nudge.isVisible(), false, 'a little nudge of the trackpad is not scrolling');
  await page.mouse.wheel(0, 300);
  await nudge.waitFor({ state: 'visible', timeout: 5_000 });
  await page.waitForTimeout(500); // it slides in
  const words = (await nudge.textContent()).replace(/\s+/g, ' ');
  assert.match(words, /Hi, I'm BOB!/);
  assert.match(words, /Dryer Vent Squad's booking assistant\. I can help you book a visit, or answer any questions about your dryer vent\./);
  assert.ok(await nudge.getByRole('button', { name: 'Book a visit' }).isVisible());
  const ask = nudge.getByRole('button', { name: 'Ask a question' });
  assert.ok(await ask.isVisible());
  // It sits above the launcher, not on it.
  const [n, l] = [await nudge.boundingBox(), await page.locator('#dvs-bob-widget .launcher').boundingBox()];
  assert.ok(n.y + n.height <= l.y, 'above the launcher');

  // Ask a question: the chat opens with its common questions and the message box ready.
  await ask.click();
  assert.equal(await nudge.isVisible(), false);
  await page.waitForFunction(() => document.getElementById('dvs-bob-widget').shadowRoot.querySelector('iframe')?.src.includes('start=question'));
  const frame = await (async () => { for (let i = 0; i < 50; i++) { const f = page.frames().find((x) => x.url().includes('start=question')); if (f) return f; await page.waitForTimeout(100); } return null; })();
  assert.ok(frame, 'chat opened');
  await frame.getByText('Tap a question to ask BOB').waitFor({ timeout: 15_000 });
  await frame.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Message BOB', null, { timeout: 5_000 });

  // Shown once per visit: reloading and scrolling again doesn't bring it back.
  await page.reload();
  await page.locator('#dvs-bob-widget .launcher').waitFor();
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(800);
  assert.equal(await nudge.isVisible(), false, 'once per visit');

  // A pricing page offers the price, and the x keeps it away.
  const other = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await other.goto(`${site.origin}/prices`);
  await other.locator('#dvs-bob-widget .launcher').waitFor();
  await other.mouse.wheel(0, 300);
  const priced = other.locator('#dvs-bob-widget .nudge');
  await priced.waitFor({ state: 'visible', timeout: 5_000 });
  await other.waitForTimeout(500);
  assert.match((await priced.textContent()).replace(/\s+/g, ' '), /Hi, I'm BOB!.*I can get your exact price and book a cleaning in about a minute, or answer your questions\./);
  assert.ok(await priced.getByRole('button', { name: 'Get my price' }).isVisible());
  const [pn, pl] = [await priced.boundingBox(), await other.locator('#dvs-bob-widget .launcher').boundingBox()];
  assert.ok(pn.x >= 0 && pn.x + pn.width <= 390 && pn.y + pn.height <= pl.y, 'fits a phone screen, above the launcher: ' + JSON.stringify({ pn, pl }));
  await priced.getByRole('button', { name: 'Dismiss message' }).click();
  assert.equal(await priced.isVisible(), false);
  assert.ok(Number(await other.evaluate(() => localStorage.getItem('bob-nudge-dismissed'))) > 0, 'kept away for two weeks');
});
