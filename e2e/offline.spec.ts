import { test, expect } from "./fixtures";
import { sel, purge, uniq, seedMemo, expectEditor } from "./helpers";

// drop every /api/* call to simulate being offline
async function goOffline(page: import("@playwright/test").Page) {
  await page.route("**/api/**", (route) => route.abort());
}
async function goOnline(page: import("@playwright/test").Page) {
  await page.unroute("**/api/**");
}

test.describe("offline", () => {
  test("creates a local temp memo offline and materializes it on reconnect", async ({
    page,
    request,
  }) => {
    const body = uniq("Offline");
    let realId: number | null = null;
    try {
      // start online so the app loads, then cut the network
      await page.goto("/");
      await expect(page.locator(sel.editor)).toBeVisible();
      await goOffline(page);

      // new memo offline → local temp (negative id), offline banner
      await page.locator(sel.newBtn).click();
      await expect(page.locator(".status.offline")).toBeVisible();
      await expect(page).toHaveURL(/#-\d+$/); // temp ids are negative
      await page.locator(sel.editor).click();
      await page.keyboard.insertText(`${body}\n\nwritten while offline`);

      // reconnect → recover() materializes the temp to a real server memo
      await goOnline(page);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));

      await expect(page.locator(".status.offline")).toBeHidden();
      await expect(page).toHaveURL(/#\d+$/); // now a real (positive) id
      realId = Number(await page.evaluate(() => location.hash.replace("#", "")));
      expect(realId).toBeGreaterThan(0);

      // the content reached the server
      const r = await request.get(`/api/memos/${realId}`);
      expect(r.ok()).toBeTruthy();
      expect(((await r.json()) as { content: string }).content).toContain("written while offline");
    } finally {
      if (realId) await purge(request, realId);
    }
  });

  test("reopens a previously-viewed memo from cache while offline", async ({ page, request }) => {
    const title = uniq("OfflineRead");
    const body = `# ${title}\n\ncached body text`;
    const id = await seedMemo(request, body);
    try {
      // visit online once so the list (localStorage) and content (IndexedDB) are cached
      await page.goto(`/#${id}`);
      await expectEditor(page, body);

      // cut the network, then reload: the boot fetch fails and the app falls back
      // to the cached list + cached content for the hashed memo
      await goOffline(page);
      await page.reload();

      await expect(page.locator(".status.offline")).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`#${id}$`));
      await expectEditor(page, body); // served from cache, no network
    } finally {
      await goOnline(page);
      await purge(request, id);
    }
  });
});
