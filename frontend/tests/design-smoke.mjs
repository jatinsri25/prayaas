import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const baseURL = process.env.TEST_BASE_URL || "http://127.0.0.1:3000";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname));
const screenshots = process.env.TEST_SCREENSHOTS || "/tmp/prayaas-design";
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({
  baseURL,
  viewport: { width: 1440, height: 1000 },
});
page.setDefaultTimeout(20000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

try {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1, name: /Good things/ }).waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.match(
    await page.locator("h1").evaluate((el) => getComputedStyle(el).fontFamily),
    /Fraunces/,
  );
  assert.match(
    await page
      .locator("body")
      .evaluate((el) => getComputedStyle(el).fontFamily),
    /Public Sans/,
  );
  assert.equal(await page.locator("h1").count(), 1);
  for (const href of await page
    .locator('a[href^="#"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")))) {
    assert.ok(
      href.length > 1 && (await page.locator(href).count()),
      `Broken section link: ${href}`,
    );
  }
  console.log(
    "PASS: original fonts, one main heading, and working section links",
  );

  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
      `Overflow at ${width}px`,
    );
    const overflowingText = await page
      .locator("main h1, main h2, main h3, main button")
      .evaluateAll((elements) =>
        elements
          .filter((el) => {
            const rect = el.getBoundingClientRect();
            return (
              rect.width &&
              (rect.right > innerWidth + 1 ||
                rect.left < -1 ||
                el.scrollWidth > el.clientWidth + 1)
            );
          })
          .map((el) => el.textContent),
      );
    assert.deepEqual(overflowingText, [], `Text clipping at ${width}px`);
    if ([390, 1440].includes(width))
      await page.screenshot({
        path: `${screenshots}/home-${width}.png`,
        fullPage: true,
        animations: "disabled",
      });
  }
  console.log(
    "PASS: five responsive widths, no horizontal overflow or clipped headings",
  );

  await page.getByRole("button", { name: /Give it a little clarity/ }).click();
  assert.equal(
    await page
      .getByRole("button", { name: /Give it a little clarity/ })
      .getAttribute("aria-pressed"),
    "true",
  );
  assert.match(
    await page.locator("#walkthrough-preview").innerText(),
    /Main gate pathway/,
  );
  await page.getByRole("button", { name: /Keep the effort visible/ }).focus();
  await page.keyboard.press("Enter");
  assert.match(
    await page.locator("#walkthrough-preview").innerText(),
    /The committee updates/,
  );
  const question = page
    .locator("summary")
    .filter({ hasText: "What does the AI actually do?" });
  await question.focus();
  await page.keyboard.press("Enter");
  assert.equal(
    await question.evaluate((el) => el.closest("details").open),
    true,
  );
  console.log("PASS: interactive walkthrough and FAQ work with the keyboard");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Mobile navigation" })
    .getByRole("link", { name: "How it works" })
    .focus();
  await page.keyboard.press("Escape");
  assert.equal(
    await page
      .getByRole("button", { name: "Menu", exact: true })
      .getAttribute("aria-expanded"),
    "false",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Menu", exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page
    .getByRole("navigation", { name: "Mobile navigation" })
    .getByRole("link", { name: "How it works" })
    .click();
  assert.equal(
    await page
      .getByRole("button", { name: "Menu", exact: true })
      .getAttribute("aria-expanded"),
    "false",
  );
  console.log(
    "PASS: mobile navigation, Escape dismissal, and focus restoration",
  );

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert.equal(
    await page
      .locator("[data-parallax]")
      .first()
      .evaluate((el) => getComputedStyle(el).transform),
    "none",
  );
  const animated = await page
    .locator("main svg *")
    .evaluateAll(
      (elements) =>
        elements.filter((el) => getComputedStyle(el).animationName !== "none")
          .length,
    );
  assert.equal(animated, 0);
  assert.equal(
    await page
      .locator("html")
      .evaluate((el) => getComputedStyle(el).scrollBehavior),
    "auto",
  );
  console.log(
    "PASS: reduced motion disables illustration animation and parallax",
  );

  await page
    .getByRole("link", { name: "Join your neighbourhood", exact: true })
    .click();
  await page.waitForURL("**/register");
  await page.getByRole("heading", { name: "Come on in." }).waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.screenshot({
    path: `${screenshots}/register-mobile.png`,
    fullPage: true,
  });
  await page.getByRole("link", { name: "Sign in", exact: true }).click();
  await page.waitForURL("**/login");
  await page.getByRole("heading", { name: "Welcome back." }).waitFor();
  await page.screenshot({
    path: `${screenshots}/login-mobile.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({
    path: `${screenshots}/login-desktop.png`,
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log(
    "PASS: homepage-to-signup-to-login navigation; no uncaught browser errors",
  );
} finally {
  await browser.close();
}
