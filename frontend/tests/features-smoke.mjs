import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

// Synthetic UI fixtures only. AI endpoints are intercepted; manual APIs are real.
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const baseURL = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(baseURL).hostname));
const backend = fileURLToPath(new URL("../../backend/", import.meta.url));
const email = `prayaas-feature-${randomUUID()}@example.com`;
const password = `TestA1-${randomUUID()}`;
const marker = `QA-${randomUUID().slice(0, 8)}`;
const original = `Wing B में गेट के पास पानी बह रहा है। ${marker} Contact test@example.com`;
const screenshots = "/tmp/prayaas-checks";
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const context = await browser.newContext({
  baseURL,
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
page.setDefaultTimeout(20000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let draftMode = "quota";
let draftCalls = 0;
let searchCalls = 0;
const filters = {
  status: "Open",
  category: null,
  location: "Wing B",
  keywords: ["water", "पानी"],
  created_after: null,
  created_before: null,
  sort: "newest",
};
const draft = {
  title: "Water leak near the gate",
  category: "Utilities",
  severity: "Medium",
  location: "Wing B",
  affected_residents: "Residents near the gate",
  raw_input: "Wing B mein gate ke paas paani beh raha hai.",
  formatted_description:
    "Water is leaking near the gate in Wing B. Please inspect the pipe.",
  description_en:
    "Water is leaking near the gate in Wing B. Please inspect the pipe.",
  description_hi:
    "Wing B के गेट के पास पानी बह रहा है। कृपया पाइप की जांच करें।",
  solutions: [1, 2, 3].map((priority) => ({
    action: "Inspect the leak safely.",
    responsible_party: "Maintenance team",
    timeline: "After review",
    priority,
  })),
  confidence_score: 0.8,
  cache_hit: false,
};
let posted;
let digestRevision = 1;
const digest = {
  week_start: "2026-10-12",
  summary_en: "One report needs committee review.",
  summary_hi: "एक रिपोर्ट पर समिति की समीक्षा आवश्यक है।",
  source_ids: [],
  generation_mode: "counts_only",
  model_used: null,
  revision: 1,
  edited: false,
  created_at: "2026-10-19T03:30:00",
  snapshot: {
    week_start: "2026-10-12",
    week_end: "2026-10-19",
    timezone: "Asia/Kolkata",
    total: 1,
    statuses: { Open: 1, "In Progress": 0, Resolved: 0 },
    categories: { Utilities: 1 },
    issues: [],
  },
};

await page.route("**/api/problems/process/**", (route) => {
  draftCalls++;
  return route.fulfill({
    status: 200,
    contentType: "application/x-ndjson",
    body:
      JSON.stringify(
        draftMode === "quota"
          ? {
              type: "error",
              detail:
                "AI provider quota is unavailable. You can post without AI.",
            }
          : { type: "complete", draft },
      ) + "\n",
  });
});
await page.route("**/api/insights/search", async (route) => {
  const payload = route.request().postDataJSON();
  if (payload.mode === "filters") return route.continue();
  searchCalls++;
  return route.fulfill({
    status: 200,
    json: {
      filters,
      mode: "ai",
      cache_hit: true,
      results: posted ? [posted] : [],
      has_more: false,
    },
  });
});

async function noOverflow() {
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
}

try {
  await page.goto("/register");
  await page.locator("#name").fill("Feature QA");
  await page.locator("#email").fill(email);
  await page.locator("#flat_number").fill("QA-101");
  await page.locator("#password").fill(password);
  await page.locator("#confirm").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/dashboard");

  const localStatus = page.waitForResponse(response => response.url().endsWith('/api/problems/ai-status'));
  await page.goto("/problems/new");
  assert.equal((await localStatus).status(), 200);
  await page.getByRole('button', { name: 'Water & power', exact: true }).click();
  await page.locator('#problem-text').fill('Water is leaking near the gate.');
  await page.locator('#report-location').fill('Wing B');
  await page.locator('#report-since').fill('Yesterday evening');
  await page.locator('#report-impact').fill('People using the entrance');
  const save = page.getByRole('button', { name: 'Save draft', exact: true });
  assert.equal(await save.isDisabled(), true);
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('prayaas_report_draft:')).length), 0);
  await page.getByRole('checkbox', { name: 'Allow saving my text on this device' }).check();
  await save.click();
  await page.getByText('Saved on this device. Save again after making changes.', { exact: true }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Restore draft', exact: true }).click();
  assert.equal(await page.locator('#problem-text').inputValue(), 'Water is leaking near the gate.');
  assert.equal(await page.locator('#report-location').inputValue(), 'Wing B');
  assert.equal(await page.locator('#report-since').inputValue(), 'Yesterday evening');
  assert.equal(await page.getByRole('button', { name: 'Water & power', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: `${screenshots}/report-notebook-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow();
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: `${screenshots}/report-notebook-mobile.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#manual-report-btn').click();
  assert.match(await page.locator('#description-en').inputValue(), /Location: Wing B\n\nSince: Yesterday evening\n\nImpact: People using the entrance/);
  await page.locator('#report-title').fill('Inspect the leaking pipe');
  await page.getByRole('checkbox', { name: 'Allow saving my text on this device' }).check();
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Restore draft', exact: true }).click();
  assert.equal(await page.locator('#report-title').inputValue(), 'Inspect the leaking pipe');
  assert.match(await page.locator('#description-en').inputValue(), /Since: Yesterday evening/);
  await page.getByRole('button', { name: 'Delete saved copy', exact: true }).click();
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('prayaas_report_draft:')).length), 0);
  assert.equal(draftCalls, 0);
  console.log('PASS: consent-only local snapshots restore input and review, guided details survive, expiry validated in unit tests; zero AI calls');

  await page.goto("/problems/new");
  await page.getByRole("button", { name: "हिंदी", exact: true }).click();
  await page.locator("#problem-text").fill(original);
  await page.locator("#manual-report-btn").click();
  assert.equal(await page.locator("#description-hi").inputValue(), original);
  assert.equal(await page.locator("#description-en").inputValue(), "");
  await page
    .locator("#report-title")
    .fill(`पानी के रिसाव की जांच करें ${marker}`);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'मसौदा सहेजें', exact: true }).click();
  await page.screenshot({
    path: `${screenshots}/bilingual-review-desktop.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow();
  await page.screenshot({
    path: `${screenshots}/bilingual-review-mobile.png`,
    fullPage: true,
  });
  const postResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/problems") &&
      response.request().method() === "POST",
  );
  await page.locator("#post-problem-btn").click();
  const response = await postResponse;
  assert.equal(response.status(), 200, await response.text());
  posted = await response.json();
  assert.equal(posted.drafting_mode, "manual");
  assert.equal(posted.input_language, "hi");
  assert.ok(posted.description_hi.includes("[REDACTED_EMAIL]"));
  assert.equal(posted.description_en, null);
  assert.equal(posted.ai_solutions, null);
  assert.equal(draftCalls, 0);
  await page.waitForURL("**/dashboard");
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('prayaas_report_draft:')).length), 0);
  await page.goto(`/problems/${posted.id}`);
  await page.getByRole("heading", { name: posted.title }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "हिंदी", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await noOverflow();
  console.log(
    "PASS: real Hindi manual post, PII masking, language persistence, mobile layout; no AI calls",
  );

  await page.goto("/search");
  await page.getByRole("button", { name: "English", exact: true }).click();
  await page
    .getByRole("button", { name: "Basic filters / no AI", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Up to 4 topics (separate with |)" })
    .fill(marker);
  await page
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await page.getByRole("link", { name: posted.title }).waitFor();
  assert.equal(searchCalls, 0);
  await noOverflow();
  console.log(
    "PASS: real basic search finds the submitted Hindi report without AI",
  );

  await page
    .getByRole("button", { name: "Plain language", exact: true })
    .click();
  await page.locator("#search-query").fill("Open water issues in Wing B");
  await page.getByRole("button", { name: "Find reports", exact: true }).click();
  await page.getByText("keywords: water / पानी", { exact: true }).waitFor();
  await page.screenshot({
    path: `${screenshots}/search-mobile.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: `${screenshots}/search-desktop.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Basic filters / no AI", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("textbox", { name: "Up to 4 topics (separate with |)" })
      .inputValue(),
    "water | पानी",
  );
  assert.equal(
    await page
      .getByRole("combobox", { name: "Status", exact: true })
      .inputValue(),
    "Open",
  );
  assert.equal(searchCalls, 1);
  console.log(
    "PASS: mocked search interpretation is visible and editable, including all topic alternatives",
  );

  await page.goto("/problems/new");
  await page.locator("#problem-text").fill(draft.raw_input);
  await page.locator("#process-ai-btn").click();
  await page
    .getByText("AI provider quota is unavailable. You can post without AI.", {
      exact: true,
    })
    .waitFor();
  await page.locator("#manual-report-btn").click();
  assert.equal(
    await page.locator("#description-en").inputValue(),
    draft.raw_input,
  );
  console.log(
    "PASS: mocked quota error preserves input and manual drafting remains available",
  );

  draftMode = "success";
  await page.goto("/problems/new");
  await page.locator("#problem-text").fill(draft.raw_input);
  await page.locator("#process-ai-btn").click();
  await page.locator("#description-hi").waitFor();
  assert.equal(
    await page.locator("#description-en").inputValue(),
    draft.description_en,
  );
  assert.equal(
    await page.locator("#description-hi").inputValue(),
    draft.description_hi,
  );
  await page.getByText(draft.raw_input, { exact: true }).waitFor();
  await page.screenshot({
    path: `${screenshots}/bilingual-ai-review.png`,
    fullPage: true,
  });
  console.log(
    "PASS: mocked bilingual draft shows both editable languages and original text",
  );

  const deniedDigest = page.waitForResponse(response => response.url().endsWith('/api/insights/digest') && response.status() === 403);
  await page.goto("/committee");
  assert.equal((await deniedDigest).status(), 403);
  await page.getByRole("alert").filter({ hasText: "Insufficient permissions" }).waitFor();
  assert.equal(await page.locator("#digest-en").count(), 0);
  console.log("PASS: real API denies a resident committee access");
  // Exercise the editor with a mocked admin response, without changing any real roles.
  await page.route("**/api/insights/digest**", (route) => {
    if (route.request().method() !== "PATCH")
      return route.fulfill({
        status: 200,
        json: { ...digest, revision: digestRevision },
      });
    const payload = route.request().postDataJSON();
    assert.equal(payload.revision, digestRevision);
    digestRevision++;
    return route.fulfill({
      status: 200,
      json: { ...digest, ...payload, revision: digestRevision, edited: true },
    });
  });
  await page.reload();
  await page.locator("#digest-en").waitFor();
  await page
    .locator("#digest-en")
    .fill("The committee should review this report.");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await page
    .getByText("Draft saved. Nothing has been sent.", { exact: true })
    .waitFor();
  assert.equal(digestRevision, 2);
  assert.equal(
    await page.getByRole("button", { name: /send|publish/i }).count(),
    0,
  );
  await page.screenshot({
    path: `${screenshots}/committee-desktop.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "हिंदी", exact: true }).click();
  await noOverflow();
  await page.screenshot({
    path: `${screenshots}/committee-mobile.png`,
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: mocked committee editor saves revisions, bilingual mobile layout, no sending action",
  );
} finally {
  await browser.close();
  const cleanup = spawnSync(
    `${backend}/venv/bin/python`,
    [
      "-c",
      `
import sys
from dotenv import load_dotenv
load_dotenv('../.env')
from database import SessionLocal
from models import User, Problem, Upvote, AICorrection, AuditLog, AutoResolutionEvent
with SessionLocal() as db:
    user = db.query(User).filter(User.email == sys.argv[1], User.name == 'Feature QA').first()
    if user:
        ids = [row.id for row in db.query(Problem).filter(Problem.author_id == user.id)]
        db.query(Upvote).filter(Upvote.problem_id.in_(ids)).delete(synchronize_session=False)
        db.query(AICorrection).filter(AICorrection.problem_id.in_(ids)).delete(synchronize_session=False)
        db.query(AutoResolutionEvent).filter(AutoResolutionEvent.user_id == user.id).delete()
        db.query(Problem).filter(Problem.author_id == user.id).delete()
        db.query(AuditLog).filter(AuditLog.user_id == user.id).delete()
        db.delete(user)
        db.commit()
`,
      email,
    ],
    { cwd: backend, encoding: "utf8" },
  );
  assert.equal(cleanup.status, 0, cleanup.stderr);
}
