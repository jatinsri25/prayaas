import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const baseURL = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname));
const backend = fileURLToPath(new URL('../../backend/', import.meta.url));
const email = `prayaas-report-${randomUUID()}@example.com`;
const password = `TestA1-${randomUUID()}`;
const screenshots = '/tmp/prayaas-checks';
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 960 } });
const page = await context.newPage();
page.setDefaultTimeout(20000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const draft = {
  title: 'Repair the corridor lights in Block B', category: 'Maintenance', severity: 'Medium',
  location: 'Block B corridor', affected_residents: 'Block B residents',
  formatted_description: 'Two lights are not working. Please arrange an electrician to inspect them.',
  solutions: [1, 2, 3].map(priority => ({ action: 'Arrange a qualified inspection.', responsible_party: 'Maintenance team', timeline: 'Within 24 hours', priority })),
  confidence_score: 0.9, auto_resolved: true,
};

try {
  await page.goto('/register');
  await page.locator('#name').fill('Report QA');
  await page.locator('#email').fill(email);
  await page.locator('#flat_number').fill('QA-101');
  await page.locator('#password').fill(password);
  await page.locator('#confirm').fill(password);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('**/dashboard');
  await page.goto('/problems/new');
  await page.locator('#problem-text').fill('Two corridor lights in Block B have stopped working. Please arrange an electrician.');

  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/problems/process/stream', async route => {
    await held;
    await route.abort().catch(() => {});
  });
  await page.locator('#process-ai-btn').click();
  await page.getByRole('heading', { name: 'Turning your report into action' }).waitFor();
  assert.equal(await page.getByText('Transcribe your recording').count(), 0);
  await page.screenshot({ path: `${screenshots}/report-progress-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${screenshots}/report-progress-mobile.png`, fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('[class*="aiOrb"]').evaluate(el => getComputedStyle(el).animationName), 'none');
  await page.getByRole('button', { name: 'Cancel and edit' }).click();
  release();
  await page.unrouteAll({ behavior: 'wait' });
  assert.match(await page.locator('#problem-text').inputValue(), /corridor lights/);
  console.log('PASS: cancel preserves input; mobile and reduced-motion progress UI');

  await page.route('**/api/problems/process/stream', route => route.fulfill({
    status: 200, contentType: 'application/x-ndjson',
    body: JSON.stringify({ type: 'error', detail: 'AI service is busy. Please try again.' }) + '\n',
  }));
  await page.locator('#process-ai-btn').click();
  await page.getByText('AI service is busy. Please try again.').waitFor();
  assert.match(await page.locator('#problem-text').inputValue(), /corridor lights/);
  await page.unrouteAll();
  console.log('PASS: streamed error keeps the report ready to retry');

  await page.route('**/api/problems/process/stream', route => route.fulfill({
    status: 200, contentType: 'application/x-ndjson',
    body: JSON.stringify({ type: 'progress', stage: 'checking' }) + '\n' + JSON.stringify({ type: 'complete', draft }) + '\n',
  }));
  await page.locator('#process-ai-btn').click();
  await page.locator('#post-problem-btn').waitFor();
  assert.equal(await page.getByText(/Auto-resolved/).count(), 0);
  await page.screenshot({ path: `${screenshots}/report-draft-mobile.png`, fullPage: true });
  await page.route('**/api/problems', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 503, json: { detail: 'Posting temporarily unavailable' } }) : route.continue());
  await page.locator('#post-problem-btn').click();
  await page.getByText('Posting temporarily unavailable').waitFor();
  assert.equal(await page.locator('fieldset input').first().inputValue(), draft.title);
  await page.unroute('**/api/problems');
  let posts = 0;
  await page.route('**/api/problems', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    posts++;
    await new Promise(resolve => setTimeout(resolve, 400));
    await route.fulfill({ status: 200, json: { id: 123, ...draft } });
  });
  await page.locator('#post-problem-btn').evaluate(button => { button.click(); button.click(); });
  await page.waitForURL('**/dashboard');
  assert.equal(posts, 1);
  assert.deepEqual(errors, []);
  console.log('PASS: draft review, failed-post recovery, and one submit on double-click');

  if (process.env.RUN_LIVE_AI === '1') {
    await page.unrouteAll();
    await page.goto('/problems/new');
    await page.locator('#problem-text').fill('The corridor lights on the third floor of Block B have not worked since yesterday. Please arrange a qualified electrician to inspect them.');
    const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/problems/process/stream') && response.status() !== 401, { timeout: 95000 });
    await page.locator('#process-ai-btn').click();
    const response = await responsePromise;
    assert.equal(response.status(), 200);
    const events = (await response.text()).trim().split('\n').map(line => JSON.parse(line));
    const terminal = events.at(-1);
    if (terminal.type === 'error') {
      await page.getByText(terminal.detail).waitFor();
      console.log(`LIVE AI BLOCKED: ${terminal.detail}`);
    } else {
      assert.equal(terminal.type, 'complete');
      assert.equal(terminal.draft.solutions.length, 3);
      await page.locator('#post-problem-btn').waitFor();
      assert.ok(events.some(event => event.stage === 'checking'));
      console.log(`PASS: real streamed draft via ${terminal.draft.last_model_used}; three validated solutions`);
    }
    assert.deepEqual(errors, []);
  }
} finally {
  await browser.close();
  const cleanup = spawnSync(`${backend}/venv/bin/python`, ['-c', `
import sys
from dotenv import load_dotenv
load_dotenv('../.env')
from database import SessionLocal
from models import User, AuditLog, AutoResolutionEvent
with SessionLocal() as db:
    user = db.query(User).filter(User.email == sys.argv[1], User.name == 'Report QA').first()
    if user:
        db.query(AuditLog).filter(AuditLog.user_id == user.id).delete()
        db.query(AutoResolutionEvent).filter(AutoResolutionEvent.user_id == user.id).delete()
        db.delete(user)
        db.commit()
`, email], { cwd: backend, encoding: 'utf8' });
  assert.equal(cleanup.status, 0, cleanup.stderr);
}
