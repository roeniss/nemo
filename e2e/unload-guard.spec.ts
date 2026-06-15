import { test, expect } from "./fixtures";
import { blankMemo, sel } from "./helpers";

// dispatch a real beforeunload event and report whether a handler cancelled it.
// dispatchEvent returns false iff a listener called preventDefault — which is how
// the app asks the browser to raise its native "Leave site?" confirmation.
async function unloadIsBlocked(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const e = new Event("beforeunload", { cancelable: true });
    return !window.dispatchEvent(e);
  });
}

// "저장 안끝났으면 이탈 방어 (cmd+w)" — while a save is still in flight, closing
// the tab / reloading must raise the browser's beforeunload confirmation so the
// last edits aren't dropped if the keepalive request never lands.
test.describe("unsaved-changes guard", () => {
  test("blocks unload while a save is in flight", async ({ page }) => {
    await blankMemo(page);
    // materialize the new temp into a real server memo first, so a subsequent edit
    // triggers a server PUT that can be held in flight (a temp only saves locally)
    await page.locator(sel.editor).fill("# guard me\n\nfirst");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page).toHaveURL(/#\d+$/);
    await expect(page.locator(".status")).toHaveText("Saved");

    // hold the PUT open so the editor stays in the "Saving…" state
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    await page.route("**/api/memos/*", async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      await gate;
      try {
        await route.continue();
      } catch {
        // released after teardown — nothing to continue
      }
    });

    await page.locator(sel.editor).fill("# guard me\n\nunsaved edits");
    await expect(page.locator(".status")).toHaveText("Saving…");

    expect(await unloadIsBlocked(page)).toBe(true);
    release();
  });

  test("allows unload once the memo is saved", async ({ page }) => {
    await blankMemo(page);
    await page.locator(sel.editor).fill("# all done\n\nsaved content");
    await expect(page.locator(".status")).toHaveText("Saved");

    expect(await unloadIsBlocked(page)).toBe(false);
  });
});
