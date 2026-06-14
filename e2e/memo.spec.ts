import { test, expect } from "./fixtures";
import { sel, uniq, blankMemo, expectEditor } from "./helpers";

test.describe("memo editing", () => {
  test('new memo is prefilled with "# ", focused, cursor after it', async ({ page }) => {
    await page.goto("/");
    await page.locator(sel.newBtn).click();
    await expectEditor(page, "# ");
    // focus + caret are applied via rAF after the (async) new memo opens. Assert
    // the editor is focused, then that the caret sits right after the prefilled
    // "# " — a typed character lands immediately after it, not before / on a new
    // line. (CM keeps the caret in its own state, so we verify it by its effect.)
    await expect(page.locator(sel.editor)).toBeFocused();
    await page.keyboard.insertText("x");
    await expectEditor(page, "# x");
  });

  test("autosaves typed content and survives a reload", async ({ page }) => {
    const title = uniq("Auto");
    await blankMemo(page);
    const editor = page.locator(sel.editor);
    await editor.click();
    await page.keyboard.insertText(`${title}\n\nbody text`);
    // wait for status to settle to Saved
    await expect(page.locator(".status")).toHaveText("Saved");
    const hash = await page.evaluate(() => location.hash);
    expect(hash).toMatch(/^#\d+$/);

    // reload → content restored from the server for this memo
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`${hash}$`));
    await expectEditor(page, `# ${title}\n\nbody text`);
  });

  test("sidebar title follows the first line", async ({ page }) => {
    const title = uniq("Title");
    await blankMemo(page);
    await page.locator(sel.editor).click();
    await page.keyboard.insertText(`${title}\n\nx`);
    await expect(page.locator(".status")).toHaveText("Saved");
    await expect(page.locator(sel.activeTitle)).toHaveText(title);
  });

  test("delete shows an Undo toast and restores the memo", async ({ page }) => {
    const title = uniq("Del");
    await blankMemo(page);
    await page.locator(sel.editor).click();
    await page.keyboard.insertText(`${title}\n\nbody`);
    await expect(page.locator(".status")).toHaveText("Saved");

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
