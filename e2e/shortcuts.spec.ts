import { test, expect } from "./fixtures";
import { sel, purge, blankMemo } from "./helpers";

const hashId = (page: import("@playwright/test").Page) =>
  page.evaluate(() => Number(location.hash.replace("#", "")));

test.describe("keyboard shortcuts", () => {
  test("Alt+C opens a new memo", async ({ page, request }) => {
    await blankMemo(page);
    const before = await hashId(page);
    await page.keyboard.press("Alt+KeyC");
    await expect(page).not.toHaveURL(new RegExp(`#${before}$`));
    await expect(page.locator(sel.editor)).toHaveValue("# ");
    await purge(request, await hashId(page));
  });

  // regression for #118: new-memo/undo were remapped off the macOS dead keys
  // (Alt+N→Alt+C, Alt+U→Alt+Z), so the old Option+N / Option+U bindings must be
  // inert — pressing them does nothing (and never opens a memo).
  test("Alt+N and Alt+U are no longer bound", async ({ page }) => {
    await blankMemo(page);
    const before = await hashId(page);
    await page.locator(sel.editor).click();
    await page.keyboard.press("Alt+KeyN");
    await page.keyboard.press("Alt+KeyU");
    await page.waitForTimeout(300); // allow any (unwanted) async new-memo to settle
    expect(await hashId(page)).toBe(before); // still the same memo — nothing fired
    await expect(page.locator(sel.editor)).toHaveValue("# ");
  });

  test("Alt+D deletes the open memo and Alt+Z undoes it", async ({ page, request }) => {
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

    // Re-fire until it lands: the Alt-shortcut keydown effect re-registers with
    // the fresh `undo` a passive-effect tick after the toast renders, so a single
    // press can race that re-registration (CI's retries used to mask this).
    await expect(async () => {
      await page.keyboard.press("Alt+KeyZ");
      await expect(page.locator(".memo-list")).toContainText("Delete me", { timeout: 1000 });
    }).toPass();
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
