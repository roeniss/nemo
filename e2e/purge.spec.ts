import { test, expect } from "./fixtures";
import { sel, purge, blankMemo, uniq } from "./helpers";

const hashId = (page: import("@playwright/test").Page) =>
  page.evaluate(() => Number(location.hash.replace("#", "")));

const tempsOf = (page: import("@playwright/test").Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("qm-temps") || "[]") as { id: number }[]);

// the shared local D1 carries many leftover "Untitled" rows, so target the
// current memo by the .active row rather than by title
const activeRow = (page: import("@playwright/test").Page) =>
  page.locator(`${sel.list}.active`);

test.describe("untouched memos stay off the server (#51)", () => {
  test("an untouched new memo is a local temp, never uploaded", async ({ page }) => {
    await blankMemo(page);
    const tempId = await hashId(page);
    expect(tempId).toBeLessThan(0); // a local temp id (negative) — not a server row

    // create another memo → leaving the blank one drops it locally
    await page.locator(sel.newBtn).click();
    await expect(page).not.toHaveURL(new RegExp(`#${tempId}$`));
    // the next one is also a local temp until it gets content. poll: newMemo()
    // briefly clears currentId (so the hash blanks to "") mid-transition, and a
    // one-shot read of that window parses "" as 0 → spurious failure
    await expect.poll(() => hashId(page)).toBeLessThan(0);
  });

  test("an untouched new memo leaves nothing behind on reload (beforeunload)", async ({ page }) => {
    await blankMemo(page);
    const tempId = await hashId(page);
    expect(tempId).toBeLessThan(0);
    expect((await tempsOf(page)).some((t) => t.id === tempId)).toBe(true);

    await page.reload(); // beforeunload drops the blank temp; boot cleanup is the backstop
    await expect(page.locator(sel.editor)).toBeVisible();

    // the abandoned blank temp is gone from local storage (and was never on the
    // server). poll: boot cleanup runs in the async load effect, which can lag the
    // editor becoming visible
    await expect.poll(() => tempsOf(page).then((ts) => ts.some((t) => t.id === tempId))).toBe(false);
  });

  test("a new memo with content materializes to the server", async ({ page, request }) => {
    await blankMemo(page);
    expect(await hashId(page)).toBeLessThan(0); // starts as a local temp
    await page.locator(sel.editor).click();
    const body = uniq("Keep");
    await page.keyboard.type(`${body}\n\nhas content`);
    await expect(page.locator(".status")).toHaveText("Saved");

    // focus triggers sync()/materializeTemps() (the e2e fixture slows the poll timer)
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page).toHaveURL(/#\d+$/); // now a real (positive) server id
    const id = await hashId(page);
    expect(id).toBeGreaterThan(0);
    try {
      const r = await request.get(`/api/memos/${id}`);
      expect(r.ok()).toBeTruthy();
      expect(((await r.json()) as { content: string }).content).toContain("has content");
    } finally {
      await purge(request, id);
    }
  });

  // re-clicking the open Untitled temp in the sidebar must not drop it
  test("clicking the open Untitled temp in the sidebar keeps it", async ({ page }) => {
    await blankMemo(page);
    const tempId = await hashId(page);
    expect(tempId).toBeLessThan(0);

    await activeRow(page).locator(".memo-title").click();

    await expect(page).toHaveURL(new RegExp(`#${tempId}$`));
    await expect(activeRow(page)).toHaveCount(1);
    await expect(page.locator(sel.editor)).toHaveValue("# ");
  });

  // deleting an unchanged Untitled temp drops it locally — no trash, no undo toast
  test("deleting an unchanged Untitled temp drops it (no trash, no toast)", async ({ page }) => {
    await blankMemo(page);
    const tempId = await hashId(page);
    expect(tempId).toBeLessThan(0);

    await activeRow(page).locator(".del").click();
    await expect(page).not.toHaveURL(new RegExp(`#${tempId}$`));

    await expect(page.locator(sel.toast)).toHaveCount(0); // no undo toast for an unchanged memo
    // gone from local temps (poll: the temp removal settles independently of the URL change)
    await expect.poll(() => tempsOf(page).then((ts) => ts.some((t) => t.id === tempId))).toBe(false);
  });
});
