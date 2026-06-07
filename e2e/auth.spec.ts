import { test, expect } from "@playwright/test";
import { USER, PASS, sel } from "./helpers";

// these tests start logged OUT (ignore the shared auth state)
test.use({ storageState: { cookies: [], origins: [] } });

test.describe("auth", () => {
  test("shows the login form when unauthenticated", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("form.login")).toBeVisible();
    await expect(page.locator("form.login h1")).toHaveText("nemo");
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
