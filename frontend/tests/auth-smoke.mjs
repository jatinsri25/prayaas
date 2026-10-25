import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

// Run against the local launcher. PLAYWRIGHT_MODULE may point to a shared install.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseURL = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname), 'Use a local test server');
const backend = fileURLToPath(new URL('../../backend/', import.meta.url));
const email = `prayaas-smoke-${randomUUID()}@example.com`;
const password = `TestA1-${randomUUID()}`;
const screenshots = process.env.TEST_SCREENSHOTS || '/tmp/prayaas-checks';
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 960 } });
const page = await context.newPage();
page.setDefaultTimeout(20000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

async function dashboardReady() {
  await page.waitForURL('**/dashboard');
  await page.getByRole('heading', { name: 'Welcome back, Smoke.' }).waitFor();
  await page.locator('[aria-label="Society issue metrics"] article strong').first().filter({ hasText: /^\d+$/ }).waitFor();
}

try {
  await page.goto('/dashboard');
  await page.waitForURL('**/login');
  console.log('PASS: signed-out dashboard redirects to login');

  await page.goto('/register');
  await page.locator('#name').fill('Smoke Resident');
  await page.locator('#email').fill(email);
  await page.locator('#flat_number').fill('QA-101');
  await page.locator('#password').fill(password);
  await page.locator('#confirm').fill(password);
  const signup = page.waitForResponse((r) => r.url().endsWith('/api/auth/register'));
  await page.getByRole('button', { name: 'Create account' }).click();
  assert.equal((await signup).status(), 200);
  await dashboardReady();
  console.log('PASS: browser signup and authenticated dashboard load');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(baseURL + '/');
  await page.goto('/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  const login = page.waitForResponse((r) => r.url().endsWith('/api/auth/login'));
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  assert.equal((await login).status(), 200);
  await dashboardReady();
  await page.reload();
  await dashboardReady();
  await page.screenshot({ path: `${screenshots}/dashboard-desktop.png`, fullPage: true });
  console.log('PASS: browser login, refresh cookie, and reload');

  const buildings = page.locator('[class*="sceneBuildings"] span').first();
  const firstTransform = await buildings.evaluate((el) => getComputedStyle(el).transform);
  await page.waitForTimeout(500);
  const nextTransform = await buildings.evaluate((el) => getComputedStyle(el).transform);
  assert.notEqual(firstTransform, nextTransform, 'Society animation should move');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${screenshots}/dashboard-mobile.png`, fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const towers = await page.locator('[class*="sceneBuildings"]').boundingBox();
  const metrics = await page.locator('[class*="sceneStats"]').boundingBox();
  assert.ok(towers.y + towers.height <= metrics.y, 'Buildings must not overlap status metrics');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await buildings.evaluate((el) => getComputedStyle(el).animationName), 'none');
  console.log('PASS: animation, mobile layout, and reduced motion');

  await page.route('**/api/problems', (route) => route.fulfill({ status: 503, json: { detail: 'Temporarily unavailable' } }));
  await page.reload();
  await page.getByRole('heading', { name: 'Updates are unavailable' }).waitFor();
  assert.equal(await page.getByText('Start the first visible issue thread.').count(), 0);
  await page.unroute('**/api/problems');
  await page.getByRole('button', { name: 'Try again' }).click();
  await dashboardReady();
  console.log('PASS: unavailable API shows an error and retry restores updates');

  // Refresh failure must settle both concurrent dashboard requests.
  await page.route('**/api/problems', (route) => route.fulfill({ status: 503, json: {} }));
  await page.reload();
  await page.getByRole('button', { name: 'Try again' }).waitFor();
  await page.unroute('**/api/problems');
  await page.route('**/api/problems', (route) => route.fulfill({ status: 401, json: {} }));
  await page.route('**/api/groups/my', (route) => route.fulfill({ status: 401, json: {} }));
  let refreshes = 0;
  await page.route('**/api/auth/refresh', async (route) => {
    refreshes += 1;
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({ status: 503, json: {} });
  });
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.getByText('Could not reconnect your session. Please try again.').waitFor();
  assert.equal(refreshes, 1);
  assert.ok(await page.evaluate(() => localStorage.getItem('prayaas_user')));
  await page.unrouteAll();
  await page.getByRole('button', { name: 'Try again' }).click();
  await dashboardReady();
  console.log('PASS: concurrent refresh failure returns promptly, preserves session, and recovers');

  await page.route('**/api/auth/refresh', (route) => route.fulfill({ status: 401, json: { detail: 'Expired session' } }));
  await page.reload();
  await page.waitForURL('**/login');
  assert.equal(await page.evaluate(() => localStorage.getItem('prayaas_user')), null);
  assert.deepEqual(errors, []);
  console.log('PASS: expired session returns to login; no uncaught browser exceptions');
} finally {
  await browser.close();
  // Delete only the uniquely named test resident created by this run.
  const cleanup = spawnSync(`${backend}/venv/bin/python`, ['-c', `
import sys
from dotenv import load_dotenv
load_dotenv('../.env')
from database import SessionLocal
from models import User, AuditLog
with SessionLocal() as db:
    user = db.query(User).filter(User.email == sys.argv[1], User.name == 'Smoke Resident').first()
    if user:
        db.query(AuditLog).filter(AuditLog.user_id == user.id).delete()
        db.delete(user)
        db.commit()
`, email], { cwd: backend, encoding: 'utf8' });
  assert.equal(cleanup.status, 0, `Test account cleanup failed: ${cleanup.stderr}`);
}
