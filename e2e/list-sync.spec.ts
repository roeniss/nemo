import { test, expect } from "./fixtures";
import { sel, seedMemo, purge } from "./helpers";

test.describe("list sync", () => {
  test("a stale background sync does not revert a just-saved title", async ({ page, request }) => {
    const id = await seedMemo(request, "# Original\n\nx");
    try {
      await page.goto(`/#${id}`);
      await expect(page.locator(sel.editor)).toHaveValue("# Original\n\nx");

      // rename (first line = title) and let it save → sidebar shows "Edited"
      await page.fill(sel.editor, "# Edited\n\nx");
      await expect(page.locator(".status")).toHaveText("Saved");
      await expect(page.locator(sel.activeTitle)).toHaveText("Edited");

      // arm a stale /memos GET (old title + ancient updated_at)
      await page.route("**/api/memos", async (route, req) => {
        if (req.method() === "GET") {
          await route.fulfill({ json: [{ id, title: "Original", updated_at: 1 }] });
        } else {
          await route.continue();
        }
      });

      // trigger a sync — the merge must keep the newer local title, not revert it
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await page.waitForTimeout(500);
      await expect(page.locator(sel.activeTitle)).toHaveText("Edited");
    } finally {
      await page.unroute("**/api/memos").catch(() => {});
      await purge(request, id);
    }
  });
});
