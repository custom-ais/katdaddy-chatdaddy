// Browser check of the review screen: optional add-ons must not look or act like the booking
// confirmation. They use Add / Remove buttons; the only checkbox is "...are correct", and the
// "You're booking" recap next to it shows exactly what (and what total) is being booked.
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

const AT = '2026-11-13T19:30:00.000Z'; // Fri Nov 13, 12:30 PM Arizona
const PREMIUM = { id: 'premium-1', name: 'Premium 1-2-3 See-It-Clean', cents: 17900 };
const DRYERFLEX = { id: 'addon-dryerflex', name: 'DryerFlex Transition Hose Upgrade', cents: 7900 };
const holdFor = (extras) => {
  const lineItems = [PREMIUM, ...(extras.dryerflex ? [DRYERFLEX] : [])];
  return { id: 'H1', scheduledAt: AT, expiresAt: Date.now() + 300_000, approvalRequired: false, quote: { route: 'cleaning', lineItems, totalCents: lineItems.reduce((n, l) => n + l.cents, 0) } };
};
const session = {
  stage: 'slots', options: [], package: 'premium', addOns: {},
  history: [{ role: 'model', text: 'Here are the soonest openings.' }],
  contact: { name: 'Pat Customer', address: '1 Main St', city: 'Surprise', zip: '85388', phone: '(623) 555-0100', email: 'pat@example.com' },
  upsell: {
    dryerflex: { name: 'DryerFlex Transition Hose Upgrade', cents: 7900, wasCents: 9900 },
    fogging: { name: 'Sanitation Fogging Add-On', cents: 7900 },
    bundleSavingsCents: 2000,
    ultimate: { name: 'Ultimate Protection', extraCents: 12000, pitch: 'exterior termination cleanout' },
  },
};

test('add-ons use Add/Remove buttons; the only checkbox is the booking confirmation', async (t) => {
  const { server, origin } = await serve();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); server.close(); });
  const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
  let extras = { dryerflex: false, fogging: false, ultimate: false };
  const extrasCalls = [];
  await page.route('**/api/**', async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/session') return json({ token: 't'.repeat(43), session, config: { businessName: 'Dryer Vent Squad', bookingEnabled: true, welcome: [] } });
    if (path === '/api/availability') return json({ slots: [{ scheduledAt: AT, nearby: false, bestFit: true }], nextCursor: null, enabled: true });
    if (path === '/api/holds' && req.method() === 'POST') return json({ hold: holdFor(extras) });
    if (path === '/api/holds/extras') {
      const body = req.postDataJSON(); extrasCalls.push(body);
      extras = { dryerflex: Boolean(body.dryerflex), fogging: Boolean(body.fogging), ultimate: Boolean(body.ultimate) };
      return json({ hold: holdFor(extras), extras });
    }
    return json({});
  });
  await page.goto(`${origin}/chat`);
  await page.getByText('Friday, Nov 13').first().click({ timeout: 15_000 });
  await page.getByText('Review your visit').waitFor({ timeout: 10_000 });

  const checkboxes = page.getByRole('checkbox');
  assert.equal(await checkboxes.count(), 1, 'only the confirmation is a checkbox');
  assert.match(await checkboxes.first().evaluate((el) => el.closest('label')?.textContent || ''), /are correct/);
  const recap = page.getByRole('region', { name: "You're booking" });
  assert.match(await recap.textContent(), /Total\$179/);
  const book = page.getByRole('button', { name: /Check the box above to book|Confirm & book/ });
  assert.equal(await book.isDisabled(), true);

  const add = page.getByRole('button', { name: /^Add DryerFlex/ });
  assert.equal(await add.getAttribute('aria-pressed'), 'false');
  await add.click();
  await page.getByRole('button', { name: /^Remove DryerFlex/ }).waitFor({ timeout: 5_000 });
  assert.deepEqual(extrasCalls, [{ holdId: 'H1', dryerflex: true, fogging: false, ultimate: false }]);
  assert.match(await recap.textContent(), /DryerFlex Transition Hose Upgrade\$79/);
  assert.match(await recap.textContent(), /Total\$258/);
  // Adding something never confirms the booking.
  assert.equal(await checkboxes.first().isChecked(), false);
  assert.equal(await book.isDisabled(), true);
});
