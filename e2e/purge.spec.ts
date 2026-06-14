import { test, expect } from "./fixtures";
import { sel, purge, blankMemo, expectEditor } from "./helpers";

const hashId = (page: import("@playwright/test").Page) =>
  page.evaluate(() => Number(location.hash.replace("#", "")));

// the shared local D1 carries many leftover "Untitled" rows, so target the
// current memo by the .active row rather than by title
const activeRow = (page: import("@playwright/test").Page) =>
  page.locator(`${sel.list}.active`);

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
    await page.keyboard.insertText("Keep me\n\nhas content");
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

  // bug: clicking the open "Untitled" row in the sidebar used to purge it via
  // leaveCurrent() and then re-open the now-deleted memo, so it vanished
  test("clicking the open Untitled memo in the sidebar keeps it", async ({ page, request }) => {
    await blankMemo(page);
    const id = await hashId(page);
    try {
      await activeRow(page).locator(".memo-title").click();

      // still the current memo, still in the list, still on the server
      await expect(page).toHaveURL(new RegExp(`#${id}$`));
      await expect(activeRow(page)).toHaveCount(1);
      await expectEditor(page, "# ");
      expect((await request.get(`/api/memos/${id}`)).ok()).toBeTruthy();
    } finally {
      await purge(request, id);
    }
  });

  // bug: deleting an unchanged Untitled memo should hard-purge it, not send an
  // empty placeholder to the Trash
  test("deleting an unchanged Untitled memo purges it instead of trashing it", async ({
    page,
    request,
  }) => {
    await blankMemo(page);
    const id = await hashId(page);
    let purged = false;
    try {
      await activeRow(page).locator(".del").click();
      await expect(page).not.toHaveURL(new RegExp(`#${id}$`));

      // gone from trash too (a soft-delete would leave /api/trash/:id readable);
      // poll since the purge DELETE is fire-and-forget from the click handler
      await expect
        .poll(async () => (await request.get(`/api/trash/${id}`)).status())
        .toBe(404);
      await expect
        .poll(async () => (await request.get(`/api/memos/${id}`)).status())
        .toBe(404);
      purged = true;

      // no Undo toast for an unchanged memo
      await expect(page.locator(sel.toast)).toHaveCount(0);
    } finally {
      if (!purged) await purge(request, id);
    }
  });
});
