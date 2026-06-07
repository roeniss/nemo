import { test, expect } from "./fixtures";
import { USER, PASS, sel } from "./helpers";

// these tests start logged OUT (ignore the shared auth state)
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("auth", () => {
  test("shows the login form when unauthenticated", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("form.login")).toBeVisible();
    await expect(page.locator("form.login h1")).toHaveText("nemo");
  });

  test("Turnstile widget stays dormant when no sitekey is configured", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("form.login")).toBeVisible();
    // skip where a sitekey IS configured (e.g. a local .env.local) — there the
    // widget is expected to render; this asserts the unconfigured CI/prod default
    const count = await page.locator(".turnstile").count();
    test.skip(count > 0, "VITE_TURNSTILE_SITEKEY is configured in this environment");
    expect(count).toBe(0);
  });

  test("rejects wrong credentials with a message", async ({ page }) => {
    await page.goto("/");
    await page.fill('input[placeholder="id"]', USER);
    await page.fill('input[placeholder="password"]', "definitely-wrong");
    await page.click('button[type="submit"]');
    await expect(page.locator(".login .err")).toBeVisible();
    await expect(page.locator("form.login")).toBeVisible(); // still on login
  });

  test("logs in with valid credentials and reaches the editor", async ({ page }) => {
    await page.goto("/");
    await page.fill('input[placeholder="id"]', USER);
    await page.fill('input[placeholder="password"]', PASS);
    await page.click('button[type="submit"]');
    // new-doc default → editor opens prefilled
    await expect(page.locator(sel.editor)).toBeVisible();
    await expect(page.locator(sel.newBtn)).toBeVisible();
  });

  test("logout returns to the login form", async ({ page }) => {
    await page.goto("/");
    await page.fill('input[placeholder="id"]', USER);
    await page.fill('input[placeholder="password"]', PASS);
    await page.click('button[type="submit"]');
    await expect(page.locator(sel.editor)).toBeVisible();
    await page.click("text=Logout");
    await expect(page.locator("form.login")).toBeVisible();
  });
});
