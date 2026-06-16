import { test, expect } from "./fixtures";
import { sel, purge, blankMemo } from "./helpers";

const hashId = (page: import("@playwright/test").Page) =>
  page.evaluate(() => Number(location.hash.replace("#", "")));

test.describe("keyboard shortcuts", () => {
  test("Alt+N opens a new memo", async ({ page, request }) => {
    await blankMemo(page);
    const before = await hashId(page);
    await page.keyboard.press("Alt+KeyN");
    await expect(page).not.toHaveURL(new RegExp(`#${before}$`));
    await expect(page.locator(sel.editor)).toHaveValue("# ");
    await purge(request, await hashId(page));
  });

  test("Alt+D deletes the open memo and Alt+U undoes it", async ({ page, request }) => {
    await blankMemo(page);
    await page.locator(sel.editor).click();
    await page.keyboard.type("Delete me\n\nbody");
    await page.keyboard.press("ControlOrMeta+s");
    await expect(page.locator(".status")).toHaveText("Saved");
    // materialize the temp so the row has a real server id
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page).toHaveURL(/#\d+$/);
    const id = await hashId(page);

    await page.keyboard.press("Alt+KeyD");
    // the deleted memo drops out of the list and the undo banner appears
    await expect(page.locator(".memo-list")).not.toContainText("Delete me");
    await expect(page.getByText('Deleted "Delete me"')).toBeVisible();

    await page.keyboard.press("Alt+KeyU");
    await expect(page.locator(".memo-list")).toContainText("Delete me");
    await purge(request, id);
  });

  test("Cmd/Ctrl+S saves immediately without a browser dialog", async ({ page, request }) => {
    await blankMemo(page);
    await page.locator(sel.editor).click();
    await page.keyboard.type("Shortcut save\n\nbody");
    await page.keyboard.press("ControlOrMeta+s"); // preventDefault → no native save dialog
    await expect(page.locator(".status")).toHaveText("Saved");
    // a brand-new memo is a local temp until it materializes; focus pushes it to
    // the server, where the id turns positive
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page).toHaveURL(/#\d+$/);
    const id = await hashId(page);
    const r = await request.get(`/api/memos/${id}`);
    expect(((await r.json()) as { content: string }).content).toContain("Shortcut save");
    await purge(request, id);
  });
});
