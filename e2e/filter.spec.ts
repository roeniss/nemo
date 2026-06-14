import { test, expect } from "./fixtures";
import { sel, seedMemo, purge, uniq } from "./helpers";

test.describe("badge filter", () => {
  test("filters the list by the title's first word", async ({ page, request }) => {
    // shared tag so a single search narrows the (shared) local D1 to just these
    // three memos — and therefore narrows the badge bar to their keywords too.
    const tag = uniq("ztag");
    const a1 = await seedMemo(request, `# Alpha ${tag} one\n\nx`);
    const a2 = await seedMemo(request, `# alpha ${tag} two\n\ny`);
    const b1 = await seedMemo(request, `# Beta ${tag} three\n\nz`);
    try {
      await page.goto("/");
      await page.reload();
      await page.fill(sel.search, tag);
      await expect(page.locator(sel.list)).toHaveCount(3);

      // keywords are lowercased, deduped case-insensitively, sorted alphabetically
      await expect(page.locator(".badges .badge")).toHaveText(["alpha", "beta"]);

      // click "alpha" -> only the two alpha memos (case-insensitive grouping)
      await page.click('.badge:text-is("alpha")');
      await expect(page.locator(".badge.active")).toHaveText("alpha");
      await expect(page.locator(sel.list)).toHaveCount(2);
      await expect(page.locator(`.memo-title:has-text("Beta ${tag}")`)).toHaveCount(0);

      // every keyword stays visible/clickable while one is selected
      await expect(page.locator(".badges .badge")).toHaveText(["alpha", "beta"]);

      // selecting another badge replaces the selection (single-select)
      await page.click('.badge:text-is("beta")');
      await expect(page.locator(".badge.active")).toHaveText("beta");
      await expect(page.locator(sel.list)).toHaveCount(1);
      await expect(page.locator(`.memo-title:has-text("Beta ${tag}")`)).toBeVisible();

      // clicking the active badge again clears the filter
      await page.click('.badge:text-is("beta")');
      await expect(page.locator(".badge.active")).toHaveCount(0);
      await expect(page.locator(sel.list)).toHaveCount(3);
    } finally {
      await purge(request, a1);
      await purge(request, a2);
      await purge(request, b1);
    }
  });
});
