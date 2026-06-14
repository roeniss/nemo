import { test, expect } from "./fixtures";
import { sel, seedMemo, purge, uniq, expectEditor, fillEditor } from "./helpers";

test.describe("list sync", () => {
  test("a stale background sync does not revert a just-saved title", async ({ page, request }) => {
    const id = await seedMemo(request, "# Original\n\nx");
    try {
      await page.goto(`/#${id}`);
      await expectEditor(page, "# Original\n\nx");

      // rename (first line = title) and let it save → sidebar shows "Edited"
      await fillEditor(page, "# Edited\n\nx");
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

  test("a background sync pulls in content changed elsewhere when there are no local edits", async ({
    page,
    request,
  }) => {
    const title = uniq("SyncPull");
    const id = await seedMemo(request, `# ${title}\n\nv1`);
    try {
      await page.goto(`/#${id}`);
      // open + revalidate settles loadedAt to the seeded updated_at
      await expectEditor(page, `# ${title}\n\nv1`);

      // another session edits the body — server updated_at advances past our base.
      // We have NO local draft (we never typed), so the sync is free to adopt it.
      await request.put(`/api/memos/${id}`, { data: { content: `# ${title}\n\nEXTERNAL v2` } });

      // background sync (fired on focus) notices the newer updated_at and reloads
      // the open memo's content into the editor — no banner, no conflict
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await expectEditor(page, `# ${title}\n\nEXTERNAL v2`);
      await expect(page.locator(".conflict")).toHaveCount(0);
    } finally {
      await purge(request, id);
    }
  });
});
