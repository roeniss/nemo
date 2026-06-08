import { test, expect } from "./fixtures";
import { blankMemo, sel } from "./helpers";

const root = "html";

test.describe("dark mode", () => {
  test("toggle switches the theme and persists across reload", async ({ page }) => {
    await blankMemo(page);

    // default (no stored choice, light OS pref) → light; button offers dark
    await expect(page.locator(root)).not.toHaveAttribute("data-theme", "dark");
    const toggle = page.locator(sel.themeToggle);
    await expect(toggle).toHaveText("🌙");

    // switch to dark
    await toggle.click();
    await expect(page.locator(root)).toHaveAttribute("data-theme", "dark");
    await expect(toggle).toHaveText("☀️");
    expect(await page.evaluate(() => localStorage.getItem("qm-theme"))).toBe("dark");

    // the choice survives a reload, with no flash of the wrong theme
    await page.reload();
    await expect(page.locator(root)).toHaveAttribute("data-theme", "dark");
    await expect(page.locator(sel.themeToggle)).toHaveText("☀️");

    // switch back to light
    await page.locator(sel.themeToggle).click();
    await expect(page.locator(root)).not.toHaveAttribute("data-theme", "dark");
    expect(await page.evaluate(() => localStorage.getItem("qm-theme"))).toBe("light");
  });

  test("dark mode actually repaints the background", async ({ page }) => {
    await blankMemo(page);
    const bgOf = () =>
      page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    const light = await bgOf();
    await page.locator(sel.themeToggle).click();
    await expect(page.locator(root)).toHaveAttribute("data-theme", "dark");
    const dark = await bgOf();
    expect(dark).not.toBe(light);
  });
});
