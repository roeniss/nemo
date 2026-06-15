import { test, expect } from "./fixtures";
import { sel, blankMemo } from "./helpers";

test.describe("markdown rendering + sanitization", () => {
  test("renders markdown in the preview pane", async ({ page }) => {
    await blankMemo(page);
    await page.fill(sel.editor, "# Heading\n\n**bold** and `code` and\n\n- item one\n- item two");
    const preview = page.locator(".preview");
    await expect(preview.locator("h1")).toHaveText("Heading");
    await expect(preview.locator("strong")).toHaveText("bold");
    await expect(preview.locator("code")).toHaveText("code");
    await expect(preview.locator("li")).toHaveCount(2);
  });

  test("still renders the preview for very large documents (no size cap)", async ({ page }) => {
    await blankMemo(page);
    // ~250 KB of content — the old size cap would have skipped this; now it renders
    await page.fill(sel.editor, "# big\n\n" + "lorem ipsum ".repeat(22_000));
    await expect(page.locator(".preview h1")).toHaveText("big");
    await expect(page.locator(".preview p").first()).toBeVisible();
  });

  test("neutralizes XSS in memo content (DOMPurify)", async ({ page }) => {
    await blankMemo(page);
    await page.fill(
      sel.editor,
      '# x\n\n<img src=x onerror="window.__pwned=true">\n\n<script>window.__pwned=true</script>\n\n[evil](javascript:window.__pwned=true)'
    );
    const preview = page.locator(".preview");

    // the dangerous bits are stripped before they ever hit the DOM
    await expect(preview.locator("script")).toHaveCount(0);
    const imgOnerror = await preview
      .locator("img")
      .first()
      .evaluate((el) => el.hasAttribute("onerror"))
      .catch(() => false);
    expect(imgOnerror).toBe(false);
    const jsHref = await preview
      .locator("a")
      .first()
      .evaluate((el) => (el as HTMLAnchorElement).getAttribute("href") ?? "")
      .catch(() => "");
    expect(/^(javascript|data|vbscript):/i.test(jsHref)).toBe(false);

    // and nothing executed
    expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBeUndefined();
  });
});
