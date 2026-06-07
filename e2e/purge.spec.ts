import { test, expect } from "./fixtures";
import { sel, purge, blankMemo } from "./helpers";

const hashId = (page: import("@playwright/test").Page) =>
  page.evaluate(() => Number(location.hash.replace("#", "")));

test.describe("empty-memo cleanup", () => {
  test("an untouched new memo is purged when you leave it", async ({ page, request }) => {
    await blankMemo(page);
    const emptyId = await hashId(page);
    expect(emptyId).toBeGreaterThan(0);

    // create another memo → leaving the blank one purges it
    await page.locator(sel.newBtn).click();
    await expect(page).not.toHaveURL(new RegExp(`#${emptyId}$`));
    const keepId = await hashId(page);
    try {
      const r = await request.get(`/api/memos/${emptyId}`);
      expect(r.status()).toBe(404); // hard-purged, not just trashed
    } finally {
      await purge(request, keepId);
    }
  });

  test("an untouched new memo is purged on tab reload (beforeunload)", async ({ page, request }) => {
    await blankMemo(page);
    const emptyId = await hashId(page);
    expect(emptyId).toBeGreaterThan(0);

    await page.reload(); // fires beforeunload → keepalive purge
    await expect(page.locator(sel.editor)).toBeVisible();
    const keepId = await hashId(page);
    try {
      // keepalive runs during unload; poll until the server reflects the purge
      await expect
        .poll(async () => (await request.get(`/api/memos/${emptyId}`)).status())
        .toBe(404);
    } finally {
      await purge(request, keepId);
    }
  });

  test("a new memo with content is NOT purged", async ({ page, request }) => {
    await blankMemo(page);
    await page.locator(sel.editor).click();
    await page.keyboard.type("Keep me\n\nhas content");
    await expect(page.locator(".status")).toHaveText("Saved");
    const id = await hashId(page);
    try {
      await page.locator(sel.newBtn).click(); // leave it
      await expect(page).not.toHaveURL(new RegExp(`#${id}$`));
      const r = await request.get(`/api/memos/${id}`);
      expect(r.ok()).toBeTruthy(); // still there
    } finally {
      await purge(request, id);
      await purge(request, await hashId(page));
    }
  });
});
