import { test, expect } from "./fixtures";
import { sel } from "./helpers";

test.describe("responsive (mobile)", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test("sidebar starts closed and the preview pane is hidden", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(sel.editor)).toBeVisible();
    // sidebar is closed by default on a narrow viewport (not rendered)
    await expect(page.locator(".sidebar")).toHaveCount(0);
    // preview pane is hidden by the CSS media query (editor-only on mobile)
    await expect(page.locator(".preview")).toBeHidden();

    // the toggle still opens the list
    await page.locator(".topbar button.ghost").first().click();
    await expect(page.locator(".sidebar")).toBeVisible();
  });
});
