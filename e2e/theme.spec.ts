import { test, expect } from "./fixtures";
import { blankMemo, sel } from "./helpers";

const root = "html";

test.describe("dark mode", () => {
  test("toggle cycles light → dark → system and persists across reload", async ({
    page,
  }) => {
    await blankMemo(page);

    // default (no stored choice) → follow system; light OS pref resolves to light
    await expect(page.locator(root)).not.toHaveAttribute("data-theme", "dark");
    const toggle = page.locator(sel.themeToggle);
    await expect(toggle).toHaveText("🖥️");

    // system → light
    await toggle.click();
    await expect(page.locator(root)).not.toHaveAttribute("data-theme", "dark");
    await expect(toggle).toHaveText("☀️");
    expect(await page.evaluate(() => localStorage.getItem("qm-theme"))).toBe("light");

    // light → dark
    await toggle.click();
    await expect(page.locator(root)).toHaveAttribute("data-theme", "dark");
    await expect(toggle).toHaveText("🌙");
    expect(await page.evaluate(() => localStorage.getItem("qm-theme"))).toBe("dark");

    // the choice survives a reload, with no flash of the wrong theme
    await page.reload();
    await expect(page.locator(root)).toHaveAttribute("data-theme", "dark");
    await expect(page.locator(sel.themeToggle)).toHaveText("🌙");

    // dark → system (light OS pref → light)
    await page.locator(sel.themeToggle).click();
    await expect(page.locator(root)).not.toHaveAttribute("data-theme", "dark");
    await expect(page.locator(sel.themeToggle)).toHaveText("🖥️");
    expect(await page.evaluate(() => localStorage.getItem("qm-theme"))).toBe("system");
  });

  test("dark mode actually repaints the background", async ({ page }) => {
    await blankMemo(page);
    const bgOf = () =>
      page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    const light = await bgOf();
    // system → light → dark
    await page.locator(sel.themeToggle).click();
    await page.locator(sel.themeToggle).click();
    await expect(page.locator(root)).toHaveAttribute("data-theme", "dark");
    const dark = await bgOf();
    expect(dark).not.toBe(light);
  });
});
