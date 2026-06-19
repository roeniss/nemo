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
    await page.keyboard.press("End"); // caret at the end of the "# " first line
    await page.keyboard.type("my note");
    await expect(page.locator(sel.editor)).toHaveValue("# my note");

    await page.keyboard.press("Alt+KeyN");

    // the brand-new memo's first line is exactly the prefix — no composed tilde
    const value = await page.locator(sel.editor).inputValue();
    expect(value).toBe("# ");
    expect(value).not.toMatch(/[˜~]/);

    // cleanup: Alt+N flushed the typed memo to the server — purge it + the new temp
    const list = (await (await request.get("/api/memos")).json()) as { id: number; title: string }[];
    for (const m of list) if (m.title === "my note") await purge(request, m.id);
    await purge(request, await hashId(page));
  });
});
