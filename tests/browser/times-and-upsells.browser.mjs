// Browser check: appointment options lead with the start time and show the arrival window small
// beside it; the review screen shows the upsell wording from Settings; and after booking, the
// confirmation stays up for a full minute before returning to the website.
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

const MORNING = '2026-11-13T16:00:00.000Z'; // Fri Nov 13, 9:00 AM Arizona
const NOON = '2026-11-14T18:30:00.000Z'; // Sat Nov 14, 11:30 AM Arizona (window crosses noon)
const PREMIUM = { id: 'premium-1', name: 'Premium 1-2-3 See-It-Clean', cents: 17900 };
const hold = { id: 'H1', scheduledAt: MORNING, expiresAt: Date.now() + 300_000, approvalRequired: false, quote: { route: 'cleaning', lineItems: [PREMIUM], totalCents: 17900 } };
const session = {
  stage: 'slots', options: [], package: 'premium', addOns: {},
  history: [{ role: 'model', text: 'Here are the soonest openings.' }],
  contact: { name: 'Pat Customer', address: '1 Main St', city: 'Surprise', zip: '85388', phone: '(623) 555-0100', email: 'pat@example.com' },
  // As upsellFor() builds it from Settings → Upsells at checkout (badge cleared, wording edited).
  upsell: {
    dryerflex: { name: 'DryerFlex Transition Hose Upgrade', title: 'Flex hose', badge: '', points: ['Lasts for years', 'Never kinks'], cents: 7900 },
    fogging: { name: 'Sanitation Fogging Add-On', title: 'Vent fog', description: 'Freshens the line.', cents: 7900 },
  },
};
const receipt = {
  id: 'DVS-T1', status: 'confirmed', scheduledAt: MORNING, service: PREMIUM.name, lineItems: [PREMIUM], priceCents: 17900, route: 'cleaning',
  name: 'Pat Customer', address: '1 Main St', city: 'Surprise', zip: '85388', preparation: 'Please clear the laundry area.', notification: 'A confirmation email is on its way.',
};

test('slots show the start time with the arrival window; Settings wording shows at checkout; the receipt waits a minute', async (t) => {
  const { server, origin } = await serve();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); server.close(); });
  const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
  await page.clock.install();
  await page.route('https://dryerventsquadaz.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>DVS site</title>' }));
  await page.route('**/api/**', async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/session') return json({ token: 't'.repeat(43), session, config: { businessName: 'Dryer Vent Squad', bookingEnabled: true, welcome: [] } });
    if (path === '/api/availability') return json({ slots: [{ scheduledAt: MORNING, bestFit: true }, { scheduledAt: NOON }], nextCursor: null, enabled: true });
    if (path === '/api/holds' && req.method() === 'POST') return json({ hold });
    if (path === '/api/bookings') return json({ receipt, pending: false });
    return json({});
  });
  await page.goto(`${origin}/chat`);

  // The option cards: the day, the actual start time in large type, and the window small beside it.
  const first = page.getByRole('button', { name: /Friday, Nov 13/ });
  await first.waitFor({ timeout: 15_000 });
  assert.match(await first.textContent(), /Friday, Nov 13\s*9:00 AMArrival window 8:30–9:30 AM/);
  const start = first.getByText('9:00 AM', { exact: true });
  const window = first.getByText('Arrival window 8:30–9:30 AM');
  const size = (l) => l.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  assert.ok(await size(start) > await size(window) + 4, 'the start time is the big number; the window is small');
  assert.match(await page.getByRole('button', { name: /Saturday, Nov 14/ }).textContent(), /11:30 AMArrival window 11:00 AM–12:00 PM/, 'a window across noon keeps both AM and PM');

  await first.click();
  await page.getByText('Review your visit').waitFor({ timeout: 10_000 });
  const review = await page.locator('main, body').first().textContent();
  assert.match(review, /9:00 AMArrival window 8:30–9:30 AM · Arizona time/);

  // Upsell wording from Settings, with no badge when it's been cleared.
  assert.ok(await page.getByText('Flex hose', { exact: true }).isVisible());
  assert.ok(await page.getByText('Lasts for years').isVisible());
  assert.ok(await page.getByText('Never kinks').isVisible());
  assert.equal(await page.getByText('Online booking special').count(), 0);
  assert.ok(await page.getByText('Vent fog', { exact: true }).isVisible());
  assert.ok(await page.getByText('Freshens the line.').isVisible());
  assert.equal(await page.getByText(/UL 2158A/).count(), 0, 'no built-in DryerFlex points once Settings has its own');

  await page.getByRole('checkbox').check({ force: true });
  await page.getByRole('button', { name: /Confirm & book/ }).click();
  await page.getByText("You're booked!").waitFor({ timeout: 30_000 });
  // The confirmation offers saving it, not starting over (the header still has its restart button).
  const card = page.locator('div', { has: page.getByRole('heading', { name: "You're booked!" }) }).filter({ has: page.getByRole('button', { name: /Save confirmation/ }) }).last();
  assert.equal(await card.getByRole('button', { name: /Save confirmation/ }).count(), 1);
  assert.equal(await card.getByRole('button', { name: /Start over/i }).count(), 0, 'no Start over on the confirmation');
  const timer = page.getByRole('timer').filter({ hasText: /Returning to dryerventsquadaz\.com/ });
  assert.match(await timer.textContent(), /in (60|59)s/);
  await page.clock.runFor(30_000);
  assert.match(await timer.textContent(), /in (30|29)s/, 'still up after 30 seconds');
  assert.ok(!page.url().startsWith('https://dryerventsquadaz.com'));
  await page.clock.runFor(31_000);
  await page.waitForURL(/dryerventsquadaz\.com/, { timeout: 10_000 });
});
