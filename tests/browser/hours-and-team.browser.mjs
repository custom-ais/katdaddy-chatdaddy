// Browser check of Settings → Scheduling & team, against a real local BOB (fresh in-memory database):
// the "Business hours" dialog (each day open or closed with its times, and the start-time spacing)
// saves straight away; each technician has Edit and Remove; Add technician opens the same dialog.
// Run after `npm run build`: npm run test:browser
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const root = new URL('../../', import.meta.url).pathname;
const PASSWORD = 'Local-browser-test-only-2026';
const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

async function startBob() {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), ADMIN_PASSWORD: PASSWORD, BOB_PGLITE_DIR: 'memory://hours-and-team' };
  for (const key of Object.keys(env)) if (/^(DATABASE_URL|POSTGRES_|SUPABASE_|NEXT_PUBLIC_SUPABASE|VERCEL)/.test(key)) delete env[key];
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('BOB did not start')), 20_000);
    child.stdout.on('data', (d) => { if (String(d).includes('BOB on')) { clearTimeout(timer); resolve(); } });
    child.on('exit', (code) => reject(new Error(`BOB exited ${code}`)));
  });
  return { origin: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

test('business hours and technicians can be edited from dialogs that save right away', async (t) => {
  const bob = await startBob();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); bob.stop(); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const saved = () => page.request.get(`${bob.origin}/api/admin/data`).then((r) => r.json());
  await page.goto(`${bob.origin}/admin`);
  const password = page.locator('input[type=password]').first();
  await password.fill(PASSWORD);
  await password.press('Enter');
  const settings = page.getByRole('button', { name: /^Settings$/ });
  await settings.first().waitFor({ timeout: 15_000 });
  await settings.first().click();
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Scheduling & team' }).click();

  // ---- Business hours: starts from today's lists (closed Sundays).
  const hours = page.locator('[data-business-hours]');
  await hours.waitFor({ timeout: 10_000 });
  assert.equal(await hours.locator('[data-hours-summary]').textContent(), 'Mon–Fri 9am–5pm, Sat 10am–2pm');
  assert.match(await hours.locator('[data-hours-starts]').textContent(), /Mon–Fri 09:00, 11:00, 13:00, 15:00; Sat 10:00, 12:00; closed Sun/);
  await hours.getByRole('button', { name: 'Edit hours' }).click();
  const dialog = page.getByRole('dialog', { name: 'Business hours' });
  await dialog.waitFor();
  const sunday = dialog.getByRole('switch', { name: 'Open Sunday' });
  assert.equal(await sunday.getAttribute('aria-checked'), 'false');
  assert.equal(await dialog.locator('[data-day="Sunday"]').getByLabel('Opens').isDisabled(), true, 'greyed out while closed');
  assert.match(await dialog.locator('[data-start-times="Monday"]').textContent(), /9 AM, 11 AM, 1 PM, 3 PM/);

  // Open Sundays 10–2, close Wednesdays, Friday until 3, a start time every 1½ hours.
  await sunday.click();
  const sun = dialog.locator('[data-day="Sunday"]');
  await sun.getByLabel('Opens').fill('10:00');
  await sun.getByLabel('Closes').fill('14:00');
  await dialog.getByRole('switch', { name: 'Open Wednesday' }).click();
  await dialog.locator('[data-day="Friday"]').getByLabel('Closes').fill('15:00');
  await dialog.getByLabel('Offer a start time every').selectOption('90');
  assert.match(await dialog.locator('[data-start-times="Sunday"]').textContent(), /10 AM, 11:30 AM, 1 PM/);
  assert.match(await dialog.locator('[data-start-times="Friday"]').textContent(), /9 AM, 10:30 AM, noon, 1:30 PM$/);
  assert.equal(await dialog.locator('[data-start-times="Wednesday"]').count(), 0);
  assert.ok(await dialog.getByText('Saving replaces your typed-in start times').isVisible());
  // Closing before opening can't be saved.
  const save = dialog.getByRole('button', { name: 'Save' });
  await dialog.locator('[data-day="Monday"]').getByLabel('Closes').fill('08:00');
  assert.equal(await save.isDisabled(), true);
  assert.ok(await dialog.getByText('Closing time needs to be after opening time.').isVisible());
  await dialog.locator('[data-day="Monday"]').getByLabel('Closes').fill('17:00');
  await save.click();
  await dialog.waitFor({ state: 'detached', timeout: 10_000 });
  assert.equal(await hours.locator('[data-hours-summary]').textContent(), 'Mon–Tue 9am–5pm, Thu 9am–5pm, Fri 9am–3pm, Sat–Sun 10am–2pm');
  assert.equal(await hours.locator('[data-hours-starts]').textContent(), 'A start time every 1½ hours, from opening');
  const afterHours = await saved();
  assert.deepEqual(afterHours.config.openWeek, ['10:00-14:00', '09:00-17:00', '09:00-17:00', '', '09:00-17:00', '09:00-15:00', '10:00-14:00']);
  assert.equal(afterHours.config.arrivalEveryMins, 90);
  assert.equal(await page.getByText(/Unsaved/).count(), 0, 'nothing left to save on the page');

  // ---- Technicians: Edit saves straight away.
  const ryan = page.locator('[data-tech="tech-ryan"]');
  await ryan.getByRole('button', { name: 'Edit Ryan Boucher' }).click();
  const editor = page.getByRole('dialog', { name: 'Edit technician' });
  await editor.waitFor();
  await editor.getByLabel('Truck or van').fill('Van 7');
  await editor.getByLabel('Status today').selectOption('available');
  await editor.getByRole('button', { name: 'Save' }).click();
  await editor.waitFor({ state: 'detached', timeout: 10_000 });
  assert.match(await ryan.locator('[data-tech-details]').textContent(), /Van 7/);
  assert.equal((await saved()).technicians.find((x) => x.id === 'tech-ryan').vehicle, 'Van 7');

  // Add technician: the same dialog; a name is required.
  await page.getByRole('button', { name: 'Add technician' }).first().click();
  const adder = page.getByRole('dialog', { name: 'Add technician' });
  await adder.waitFor();
  await adder.getByRole('button', { name: 'Add technician' }).click();
  assert.ok(await adder.getByText('Add their name.').isVisible());
  await adder.getByLabel('Name').fill('Test Tech');
  await adder.getByLabel('Truck or van').fill('Van 9');
  await adder.getByRole('button', { name: 'Add technician' }).click();
  await adder.waitFor({ state: 'detached', timeout: 10_000 });
  const added = (await saved()).technicians.find((x) => x.name === 'Test Tech');
  assert.ok(added, 'saved');
  const card = page.locator(`[data-tech="${added.id}"]`);
  assert.match(await card.locator('[data-tech-details]').textContent(), /Van 9/);

  // Remove: asks first, then it's gone.
  await card.getByRole('button', { name: 'Remove Test Tech' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Remove Test Tech?' });
  await confirm.waitFor();
  await confirm.getByRole('button', { name: 'Remove', exact: true }).click();
  await card.waitFor({ state: 'detached', timeout: 10_000 });
  assert.equal((await saved()).technicians.some((x) => x.name === 'Test Tech'), false);
  assert.equal(await page.getByText(/Unsaved/).count(), 0);
});
