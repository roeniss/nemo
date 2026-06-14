import { test, expect } from "./fixtures";
import { sel, purge, blankMemo, expectEditor } from "./helpers";

const hashId = (page: import("@playwright/test").Page) =>
  page.evaluate(() => Number(location.hash.replace("#", "")));

test.describe("keyboard shortcuts", () => {
  test("Cmd/Ctrl+K opens a new memo", async ({ page, request }) => {
    await blankMemo(page);
    const before = await hashId(page);
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page).not.toHaveURL(new RegExp(`#${before}$`));
    await expectEditor(page, "# ");
    await purge(request, await hashId(page));
  });

  test("Cmd/Ctrl+S saves immediately without a browser dialog", async ({ page, request }) => {
    await blankMemo(page);
    await page.locator(sel.editor).click();
    await page.keyboard.insertText("Shortcut save\n\nbody");
    // CM applies insertText asynchronously; wait for the edit to land (→ onChange
    // → state) before the immediate save, else Cmd+S races and persists the blank
    await expectEditor(page, "# Shortcut save\n\nbody");
    await page.keyboard.press("ControlOrMeta+s"); // preventDefault → no native save dialog
    await expect(page.locator(".status")).toHaveText("Saved");
    const id = await hashId(page);
    const r = await request.get(`/api/memos/${id}`);
    expect(((await r.json()) as { content: string }).content).toContain("Shortcut save");
    await purge(request, id);
  });
});
