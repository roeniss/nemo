import { test, expect } from "./fixtures";
import { sel, blankMemo } from "./helpers";

// Desktop-only feature. Unit tests fake getBoundingClientRect (happy-dom doesn't
// lay out), so this real-layout check is what actually proves (a) the rendered
// block under the caret gets centered in the preview, and (b) the editor's tall
// bottom padding lets you scroll past the last line.
test.describe("desktop preview caret centering", () => {
  const filler = Array.from({ length: 60 }, (_, i) => `filler line ${i}`).join("\n\n");
  // MIDMARK sits deep in the doc with plenty of content on both sides, so it can
  // actually reach the vertical center of the preview.
  const doc = "# Top\n\n" + filler + "\n\n## MIDMARK\n\n" + filler + "\n\n## ENDMARK\n\nlast";

  test("centers the rendered block under the editor caret", async ({ page }) => {
    await blankMemo(page);
    await page.fill(sel.editor, doc);
    await expect(page.locator(".preview", { hasText: "MIDMARK" })).toBeVisible();

    // put the caret on the MIDMARK line and notify the editor (onSelect)
    await page.evaluate(() => {
      const ed = document.querySelector("textarea.editor") as HTMLTextAreaElement;
      const idx = ed.value.indexOf("MIDMARK");
      ed.focus();
      ed.setSelectionRange(idx, idx);
      ed.dispatchEvent(new Event("select", { bubbles: true }));
    });

    // the MIDMARK block's vertical center should land near the preview's center
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const pv = document.querySelector(".preview") as HTMLElement;
          const blocks = Array.from(pv.querySelectorAll<HTMLElement>("[data-source-line]"));
          const el = blocks.find((b) => b.textContent?.includes("MIDMARK"))!;
          const pr = pv.getBoundingClientRect();
          const er = el.getBoundingClientRect();
          const blockCenter = er.top + er.height / 2 - pr.top;
          return Math.abs(blockCenter - pv.clientHeight / 2);
        })
      )
      .toBeLessThan(40); // within 40px of dead center
  });

  test("editor can scroll past the last line (tall bottom padding)", async ({ page }) => {
    await blankMemo(page);
    await page.fill(sel.editor, doc);

    const { padBottom, viewportH, edMax } = await page.evaluate(() => {
      const ed = document.querySelector("textarea.editor") as HTMLTextAreaElement;
      return {
        padBottom: parseFloat(getComputedStyle(ed).paddingBottom),
        viewportH: window.innerHeight,
        edMax: ed.scrollHeight - ed.clientHeight,
      };
    });
    // ~50vh of scroll-past-end space below the content
    expect(padBottom).toBeGreaterThan(viewportH * 0.4);
    // and that padding is part of the scrollable range, so you can scroll well
    // beyond where the text ends
    expect(edMax).toBeGreaterThan(padBottom);
  });
});
