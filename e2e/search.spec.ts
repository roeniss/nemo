import { test, expect } from "@playwright/test";
import { sel, seedMemo, purge, uniq } from "./helpers";

test.describe("search", () => {
  test("filters the memo list by title", async ({ page, request }) => {
    const apple = uniq("Apple");
    const banana = uniq("Banana");
    const idA = await seedMemo(request, `# ${apple}\n\nx`);
    const idB = await seedMemo(request, `# ${banana}\n\ny`);
    try {
      await page.goto("/");
      await page.reload();
      await expect(page.locator(`.memo-title:text-is("${apple}")`)).toBeVisible();
      await expect(page.locator(`.memo-title:text-is("${banana}")`)).toBeVisible();

      await page.fill(sel.search, apple);
      await expect(page.locator(`.memo-title:text-is("${apple}")`)).toBeVisible();
      await expect(page.locator(`.memo-title:text-is("${banana}")`)).toHaveCount(0);

      await page.fill(sel.search, "zzz-no-such-title");
      await expect(page.locator(".memo-list li.empty")).toHaveText("No matches");
    } finally {
      await purge(request, idA);
      await purge(request, idB);
    }
  });
});
