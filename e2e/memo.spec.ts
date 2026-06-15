import { test, expect } from "./fixtures";
import { sel, uniq, blankMemo } from "./helpers";

test.describe("memo editing", () => {
  test('new memo is prefilled with "# ", focused, cursor after it', async ({ page }) => {
    await page.goto("/");
    await page.locator(sel.newBtn).click();
    const editor = page.locator(sel.editor);
    await expect(editor).toHaveValue("# ");
    // focus + caret are applied via rAF after the (async) new memo opens
    await expect
      .poll(() =>
        page.evaluate(() => {
          const t = document.querySelector("textarea.editor") as HTMLTextAreaElement;
          return document.activeElement === t && t.selectionStart === 2 && t.selectionEnd === 2;
        })
      )
      .toBe(true);
  });

  test("autosaves typed content and survives a reload", async ({ page }) => {
    const title = uniq("Auto");
    await blankMemo(page);
    const editor = page.locator(sel.editor);
    await editor.click();
    await page.keyboard.type(`${title}\n\nbody text`);
    // wait for status to settle to Saved
    await expect(page.locator(".status")).toHaveText("Saved");
    const hash = await page.evaluate(() => location.hash);
    expect(hash).toMatch(/^#-?\d+$/); // a local temp until it materializes; content is saved either way

    // reload → content restored (from the local draft for a temp, or the server)
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`${hash}$`));
    await expect(editor).toHaveValue(`# ${title}\n\nbody text`);
  });

  test("sidebar title follows the first line", async ({ page }) => {
    const title = uniq("Title");
    await blankMemo(page);
    await page.locator(sel.editor).click();
    await page.keyboard.type(`${title}\n\nx`);
    await expect(page.locator(".status")).toHaveText("Saved");
    await expect(page.locator(sel.activeTitle)).toHaveText(title);
  });

  test("delete shows an Undo toast and restores the memo", async ({ page }) => {
    const title = uniq("Del");
    await blankMemo(page);
    await page.locator(sel.editor).click();
    await page.keyboard.type(`${title}\n\nbody`);
    await expect(page.locator(".status")).toHaveText("Saved");
    // materialize the new temp to a real server memo — deleting a temp would just
    // drop it locally (no trash, no Undo), whereas a server memo soft-deletes
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page).toHaveURL(/#\d+$/);

    const row = page.locator(`${sel.list}:has(.memo-title:text-is("${title}"))`);
    await expect(row).toBeVisible();
    await row.locator(".del").click();

    // gone from the list, Undo toast shown
    await expect(row).toHaveCount(0);
    const toast = page.locator(sel.toast);
    await expect(toast).toContainText(`Deleted "${title}"`);
    await toast.locator("button", { hasText: "Undo" }).click();

    // restored
    await expect(page.locator(`.memo-title:text-is("${title}")`)).toBeVisible();
  });
});
