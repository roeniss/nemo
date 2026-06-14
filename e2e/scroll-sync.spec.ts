import { test, expect } from "./fixtures";
import { blankMemo, fillEditor } from "./helpers";

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
    await fillEditor(page, doc);
    await expect(page.locator(".preview", { hasText: "MIDMARK" })).toBeVisible();

    // put the caret on the MIDMARK line. The doc is long and CodeMirror only
    // renders the lines near the viewport, so MIDMARK isn't in the DOM to click —
    // drive the caret through the editor view exposed on its root element.
    await page.evaluate(() => {
      const view = (document.querySelector(".cm-editor") as unknown as { cmView: any }).cmView;
      const idx = view.state.doc.toString().indexOf("## MIDMARK");
      view.focus();
      view.dispatch({ selection: { anchor: idx } });
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
    await fillEditor(page, doc);

    const { padBottom, viewportH, edMax } = await page.evaluate(() => {
      const content = document.querySelector(".cm-content") as HTMLElement;
      const scroller = document.querySelector(".cm-scroller") as HTMLElement;
      return {
        padBottom: parseFloat(getComputedStyle(content).paddingBottom),
        viewportH: window.innerHeight,
        edMax: scroller.scrollHeight - scroller.clientHeight,
      };
    });
    // ~50vh of scroll-past-end space below the content
    expect(padBottom).toBeGreaterThan(viewportH * 0.4);
    // and that padding is part of the scrollable range, so you can scroll well
    // beyond where the text ends
    expect(edMax).toBeGreaterThan(padBottom);
  });
});
