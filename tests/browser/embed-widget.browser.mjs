// Browser check of the website widget (public/embed.js) on a page from another site, like
// dryerventsquadaz.com or its staging copy: while the chat is open the launcher becomes a round close
// button in the same spot, below the chat window, on desktop and phone; and a chat window that was refused (or failed to load) is loaded
// again when it's reopened, while a working one is kept as it is.
// Run after `npm run build`: npm run test:browser
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const dist = new URL('../../dist/', import.meta.url).pathname;
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon' };

// BOB's built files (the chat's API calls just fail here, which is fine: the chat still starts).
async function serveBob() {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = path.startsWith('/assets/') || extname(path) ? join(dist, path) : join(dist, 'index.html');
    try { const body = await readFile(file); res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}
// A website page on a different origin that loads the widget the way WordPress does.
async function serveSite(bobOrigin) {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>Dryer vent cleaning</title><h1>Website</h1><script src="${bobOrigin}/embed.js" data-nudge="off" defer></script>`);
  });
  await new Promise((r) => server.listen(0, 'localhost', r));
  return { server, origin: `http://localhost:${server.address().port}/` };
}

const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

test('the website widget: close button below the chat, and a refused chat is retried on reopen', async (t) => {
  const bob = await serveBob();
  const site = await serveSite(bob.origin);
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); bob.server.close(); site.server.close(); });

  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    await page.goto(site.origin);
    const launcher = page.locator('#dvs-bob-widget .launcher');
    await launcher.waitFor();
    assert.equal(await page.locator('#dvs-bob-widget .close').isVisible(), false, 'no close button while the chat is closed');
    const spot = await launcher.boundingBox();
    await launcher.click();
    const panel = page.locator('#dvs-bob-widget .panel'), close = page.locator('#dvs-bob-widget .close');
    await close.waitFor();
    const [p, c] = [await panel.boundingBox(), await close.boundingBox()];
    assert.ok(!overlaps(p, c), `${viewport.width}px: the close button is outside the chat window`);
    assert.ok(c.y >= p.y + p.height, 'below it');
    assert.equal(await launcher.isVisible(), false, 'it takes the launcher\'s place');
    assert.ok(Math.abs((c.x + c.width) - (spot.x + spot.width)) <= 1 && Math.abs((c.y + c.height) - (spot.y + spot.height)) <= 1, 'in the same corner');
    assert.ok(c.x >= 0 && c.y + c.height <= viewport.height, 'on screen');
    await close.click();
    assert.equal(await panel.isVisible(), false, 'closes the chat');
    assert.ok(await launcher.isVisible(), 'and the launcher is back');
    // With the keyboard, focus follows: launcher -> close button -> launcher.
    const focused = () => page.evaluate(() => document.getElementById('dvs-bob-widget').shadowRoot.activeElement?.className || '');
    await launcher.focus();
    await page.keyboard.press('Enter');
    assert.equal(await focused(), 'close open');
    await page.keyboard.press('Enter');
    assert.equal(await focused(), 'launcher');
    await page.close();
  }

  // The first chat request is refused the way a browser refuses a site BOB doesn't allow.
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const loads = [];
  page.on('request', (r) => { if (r.url().includes('/chat?embed=1')) loads.push(r.url()); });
  let refuse = true;
  await page.route('**/chat?embed=1*', (route) => {
    if (!refuse) return route.continue();
    refuse = false;
    return route.fulfill({ status: 200, headers: { 'content-type': 'text/html', 'content-security-policy': "frame-ancestors 'none'" }, body: '<p>refused</p>' });
  });
  await page.goto(site.origin);
  const launcher = page.locator('#dvs-bob-widget .launcher');
  await launcher.click();
  await page.waitForTimeout(3500);
  assert.equal(loads.length, 1);
  const chatFrame = () => page.frames().find((f) => f.url().includes('/chat?embed=1') && f !== page.mainFrame());
  assert.equal(await chatFrame()?.locator('text=BOB').count().catch(() => 0) ?? 0, 0, 'the refused chat shows nothing');

  // Closing and opening it again loads it again, and this time it works.
  await page.locator('#dvs-bob-widget .close').click();
  await launcher.click();
  await page.waitForFunction(() => document.getElementById('dvs-bob-widget').shadowRoot.querySelectorAll('iframe').length === 1);
  assert.equal(loads.length, 2, 'loaded again on reopen');
  const frame = await (async () => { for (let i = 0; i < 50; i++) { const f = chatFrame(); if (f && await f.locator('text=BOB').count().catch(() => 0)) return f; await page.waitForTimeout(200); } return null; })();
  assert.ok(frame, 'the chat is running after the retry');

  // A chat that's working is kept: reopening it later doesn't start it over.
  await page.waitForTimeout(3500);
  await page.locator('#dvs-bob-widget .close').click();
  await launcher.click();
  await page.waitForTimeout(500);
  assert.equal(loads.length, 2, 'not reloaded');
});
