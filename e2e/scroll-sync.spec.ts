import { test, expect } from "./fixtures";
import { sel, blankMemo } from "./helpers";

// Desktop-only feature: the rendered preview follows the editor's scroll so
// typing past the fold doesn't strand the rendered text out of view. Unit
// tests fake scrollHeight/clientHeight (happy-dom doesn't lay out), so this
// real-layout check is what actually proves scrolling follows.
test.describe("desktop preview scroll sync", () => {
  // a long doc so BOTH panes genuinely overflow and have somewhere to scroll
  const longDoc = "# Title\n\n" + Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n\n");

  function overflow(page: import("@playwright/test").Page) {
    return page.evaluate(() => {
      const ed = document.querySelector("textarea.editor") as HTMLTextAreaElement;
      const pv = document.querySelector(".preview") as HTMLElement;
      return {
        edMax: ed.scrollHeight - ed.clientHeight,
        pvMax: pv.scrollHeight - pv.clientHeight,
        pvFraction: pv.scrollTop / (pv.scrollHeight - pv.clientHeight),
      };
    });
  }

  test("preview follows the editor to the bottom and back", async ({ page }) => {
    await blankMemo(page);
    await page.fill(sel.editor, longDoc);
    // wait for the debounced preview to render the whole document
    await expect(page.locator(".preview p").last()).toBeVisible();

    // both panes must actually overflow, else the test proves nothing
    const before = await overflow(page);
    expect(before.edMax).toBeGreaterThan(0);
    expect(before.pvMax).toBeGreaterThan(0);

    // scroll the editor to the top → preview follows back up
    await page.evaluate(() => {
      const ed = document.querySelector("textarea.editor") as HTMLTextAreaElement;
      ed.scrollTop = 0;
    });
    await expect.poll(async () => (await overflow(page)).pvFraction).toBeLessThan(0.1);

    // scroll the editor to the bottom → preview follows to (near) its bottom
    await page.evaluate(() => {
      const ed = document.querySelector("textarea.editor") as HTMLTextAreaElement;
      ed.scrollTop = ed.scrollHeight;
    });
    await expect.poll(async () => (await overflow(page)).pvFraction).toBeGreaterThan(0.9);
  });
});
