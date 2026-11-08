// Browser check of Settings → Scheduling & team → a technician's "Edit schedule" dialog, against a
// real local BOB (fresh in-memory database): a switch and start/end times for each day, greyed out on days
// off, Save writes it right away, and "Use business hours" goes back to the default.
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
  // A fresh in-memory database for each run (the local default is a folder that keeps data).
  const env = { ...process.env, PORT: String(port), ADMIN_PASSWORD: PASSWORD, BOB_PGLITE_DIR: 'memory://tech-schedule-editor' };
  for (const key of Object.keys(env)) if (/^(DATABASE_URL|POSTGRES_|SUPABASE_|NEXT_PUBLIC_SUPABASE|VERCEL)/.test(key)) delete env[key];
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('BOB did not start')), 20_000);
    child.stdout.on('data', (d) => { if (String(d).includes('BOB on')) { clearTimeout(timer); resolve(); } });
    child.on('exit', (code) => reject(new Error(`BOB exited ${code}`)));
  });
  return { origin: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

test('each technician has an Edit schedule dialog that saves their days and hours', async (t) => {
  const bob = await startBob();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); bob.stop(); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.goto(`${bob.origin}/admin`);
  const password = page.locator('input[type=password]').first();
  await password.fill(PASSWORD);
  await password.press('Enter');
  const settings = page.getByRole('button', { name: /^Settings$/ });
  await settings.first().waitFor({ timeout: 15_000 });
  await settings.first().click();
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Scheduling & team' }).click();

  const card = page.locator('[data-tech-schedule="tech-ryan"]');
  await card.waitFor({ timeout: 10_000 });
  assert.match(await card.locator('[data-schedule-summary]').textContent(), /Business hours/);
  await card.getByRole('button', { name: 'Edit schedule' }).click();

  const dialog = page.getByRole('dialog', { name: 'Edit schedule' });
  await dialog.waitFor();
  // Starts from the business hours: Sunday off (times greyed out but shown), Monday 9 to 5.
  const sunday = dialog.getByRole('switch', { name: /works Sunday/ });
  assert.equal(await sunday.getAttribute('aria-checked'), 'false');
  const sun = dialog.locator('[data-day="Sunday"]');
  assert.equal(await sun.getByLabel('Start time').isDisabled(), true);
  assert.equal(await sun.getByLabel('Start time').inputValue(), '09:00');
  const mon = dialog.locator('[data-day="Monday"]');
  assert.equal(await dialog.getByRole('switch', { name: /works Monday/ }).getAttribute('aria-checked'), 'true');
  assert.deepEqual([await mon.getByLabel('Start time').inputValue(), await mon.getByLabel('End time').inputValue()], ['09:00', '17:00']);

  // Mon–Fri 8 to 4, Saturday off. An end before the start can't be saved.
  for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) {
    const row = dialog.locator(`[data-day="${day}"]`);
    await row.getByLabel('Start time').fill('08:00');
    await row.getByLabel('End time').fill('16:00');
  }
  await dialog.getByRole('switch', { name: /works Saturday/ }).click();
  assert.equal(await dialog.locator('[data-day="Saturday"]').getByLabel('End time').isDisabled(), true);
  const tue = dialog.locator('[data-day="Tuesday"]');
  await tue.getByLabel('End time').fill('07:00');
  const save = dialog.getByRole('button', { name: 'Save' });
  assert.equal(await save.isDisabled(), true);
  assert.ok(await dialog.getByText('End time needs to be after the start time.').isVisible());
  await tue.getByLabel('End time').fill('16:00');
  assert.equal(await save.isDisabled(), false);

  // Cancel leaves it as it was.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.match(await card.locator('[data-schedule-summary]').textContent(), /Business hours/);

  // Save writes it straight away (no page Save needed).
  await card.getByRole('button', { name: 'Edit schedule' }).click();
  await dialog.waitFor();
  for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) {
    const row = dialog.locator(`[data-day="${day}"]`);
    await row.getByLabel('Start time').fill('08:00');
    await row.getByLabel('End time').fill('16:00');
  }
  await dialog.getByRole('switch', { name: /works Saturday/ }).click();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 10_000 });
  assert.equal(await card.locator('[data-schedule-summary]').textContent(), 'Mon–Fri 8am–4pm');
  // Ryan is the only tech taking online bookings, and now nobody works Saturdays: Settings says so.
  const gaps = page.locator('[data-schedule-gaps]');
  await gaps.waitFor({ timeout: 5_000 });
  assert.match(await gaps.textContent(), /Nobody who takes online bookings works Saturdays/);
  const saved = await page.request.get(`${bob.origin}/api/admin/data`).then((r) => r.json());
  const ryan = saved.technicians.find((x) => x.id === 'tech-ryan');
  assert.deepEqual(ryan.workWeek.map((d) => d.on), [false, true, true, true, true, true, false]);
  assert.deepEqual([ryan.workWeek[1].start, ryan.workWeek[1].end], ['08:00', '16:00']);
  assert.equal(await page.getByText(/Unsaved technicians/).count(), 0, 'nothing left to save on the page');

  // Reopening shows the saved hours; "Use business hours" goes back to the default.
  await card.getByRole('button', { name: 'Edit schedule' }).click();
  await dialog.waitFor();
  assert.equal(await dialog.locator('[data-day="Monday"]').getByLabel('End time').inputValue(), '16:00');
  await dialog.getByRole('button', { name: 'Use business hours' }).click();
  await dialog.waitFor({ state: 'detached', timeout: 10_000 });
  assert.match(await card.locator('[data-schedule-summary]').textContent(), /Business hours/);
  assert.equal(await page.locator('[data-schedule-gaps]').count(), 0, "covered again: no warning");
  // Turning everyone off for online bookings warns right away, before saving.
  const ryanOnline = page.getByRole('checkbox', { name: 'Ryan Boucher' }).first();
  await ryanOnline.evaluate((el) => el.scrollIntoView({ block: 'center' })); // clear of the sticky header
  await ryanOnline.uncheck({ force: true });
  assert.match(await page.locator('[data-schedule-gaps]').textContent(), /No technician takes online bookings/);
  await ryanOnline.check({ force: true });
  const reset = await page.request.get(`${bob.origin}/api/admin/data`).then((r) => r.json());
  assert.equal(reset.technicians.find((x) => x.id === 'tech-ryan').workWeek, null);
});
