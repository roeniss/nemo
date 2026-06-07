import { test, expect } from "./fixtures";
import { blankMemo } from "./helpers";

test.describe("sidebar", () => {
  test("toggle hides and shows the memo list", async ({ page }) => {
    await blankMemo(page);
    const sidebar = page.locator(".sidebar");
    const toggle = page.locator(".topbar button.ghost").first(); // ◀ / ▶
    await expect(sidebar).toBeVisible();
    await toggle.click();
    await expect(sidebar).toBeHidden();
    await toggle.click();
    await expect(sidebar).toBeVisible();
  });
});
