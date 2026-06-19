import { test, expect } from "./fixtures";
import { sel, purge, blankMemo } from "./helpers";

const hashId = (page: import("@playwright/test").Page) =>
  page.evaluate(() => Number(location.hash.replace("#", "")));

// #118 — on macOS, Option+N is a dead key for a combining tilde ("˜"). The bug
// report: creating a new memo with Option+N left a stray "˜" on the new memo's
// first line. The handler is meant to suppress this (Alt branch keys on e.code
// and preventDefault()s, which cancels the composition).
//
// CAVEAT: Playwright drives Chromium with synthetic CDP key events that do NOT
// pass through the OS input-method dead-key composition, so this CANNOT
// reproduce the true macOS behaviour — the real check is manual on a Mac. What
// it DOES guard: that the app's own Alt+N path inserts no stray character into
// the new memo (a regression net), reproducing the exact user action (editor
// focused, caret on the first line) that the existing shortcuts test skips.
test.describe("#118 Option+N dead-key", () => {
  test("Alt+N from the focused editor opens a clean new memo (no stray ˜)", async ({ page, request }) => {
    await blankMemo(page);
    await page.locator(sel.editor).click(); // focus + caret in the first line
    const before = await hashId(page);

    await page.keyboard.press("Alt+KeyN");

    await expect(page).not.toHaveURL(new RegExp(`#${before}$`));
    const value = await page.locator(sel.editor).inputValue();
    expect(value).toBe("# ");
    expect(value).not.toMatch(/[˜~]/);

    await purge(request, await hashId(page));
  });

  test("Option+N with the caret after first-line text leaves no ˜ behind", async ({ page, request }) => {
    await blankMemo(page);
    await page.locator(sel.editor).click();
    await page.keyboard.type("# my note"); // caret now at end of the first line
    await page.keyboard.press("ControlOrMeta+s");
    await expect(page.locator(".status")).toHaveText("Saved");
    await page.evaluate(() => window.dispatchEvent(new Event("focus"))); // materialize → real id
    await expect(page).toHaveURL(/#\d+$/);
    const typedId = await hashId(page);

    await page.keyboard.press("Alt+KeyN");

    // the brand-new memo's first line is clean...
    const value = await page.locator(sel.editor).inputValue();
    expect(value).toBe("# ");
    expect(value).not.toMatch(/[˜~]/);
    const newId = await hashId(page);

    // ...and the memo we typed in did not gain a ˜ either
    const typed = (await (await request.get(`/api/memos/${typedId}`)).json()) as { content: string };
    expect(typed.content).toBe("# my note");

    await purge(request, typedId);
    await purge(request, newId);
  });
});
