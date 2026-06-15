import { test, expect } from "./fixtures";
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

      // case-insensitive
      await page.fill(sel.search, apple.toUpperCase());
      await expect(page.locator(`.memo-title:text-is("${apple}")`)).toBeVisible();

      await page.fill(sel.search, "zzz-no-such-title");
      await expect(page.locator(".memo-list li.empty")).toHaveText("No matches");
    } finally {
      await purge(request, idA);
      await purge(request, idB);
    }
  });

  test("also matches the memo body, not just the title", async ({ page, request }) => {
    const aTitle = uniq("Alpha");
    const bTitle = uniq("Beta");
    const bodyWord = uniq("Zucchini"); // appears only inside B's body
    const idA = await seedMemo(request, `# ${aTitle}\n\nnothing special here`);
    const idB = await seedMemo(request, `# ${bTitle}\n\nthis one hides ${bodyWord} inside`);
    try {
      await page.goto("/");
      await page.reload();
      await expect(page.locator(`.memo-title:text-is("${aTitle}")`)).toBeVisible();
      await expect(page.locator(`.memo-title:text-is("${bTitle}")`)).toBeVisible();

      // a word that exists only in B's body → B matches (by content), A drops out
      await page.fill(sel.search, bodyWord);
      await expect(page.locator(`.memo-title:text-is("${bTitle}")`)).toBeVisible();
      await expect(page.locator(`.memo-title:text-is("${aTitle}")`)).toHaveCount(0);
    } finally {
      await purge(request, idA);
      await purge(request, idB);
    }
  });
});
