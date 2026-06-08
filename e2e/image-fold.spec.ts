import { test, expect } from "./fixtures";
import { sel, seedMemo, purge, openMemo } from "./helpers";

// A pasted screenshot embeds as a multi-KB base64 data-URI. The editor should fold
// it to a short marker (readable source), while the saved/previewed content keeps
// the full bytes — folding must never corrupt or drop the image.
const big = "A".repeat(2000);
const uri = `data:image/png;base64,${big}`;

test.describe("inline image folding", () => {
  test("editor folds the base64 wall but the image and bytes survive", async ({ page, request }) => {
    const id = await seedMemo(request, `# screenshot\n\n![shot](${uri})\n\nbelow the image`);
    try {
      await openMemo(page, id);

      // the editor shows a short marker, not the 2KB wall of base64
      // (wait for the async revalidation to load the memo content)
      await expect(page.locator(sel.editor)).toHaveValue(/fold:0/);
      const shown = await page.locator(sel.editor).inputValue();
      expect(shown).not.toContain(big);
      expect(shown).toContain("below the image"); // surrounding text stays readable

      // the preview still renders the real image (content kept the full data-URI)
      await expect(page.locator(".preview.markdown img")).toHaveAttribute("src", uri);

      // editing around the fold saves the FULL bytes, not the marker
      await page.locator(sel.editor).press("End");
      await page.locator(sel.editor).pressSequentially(" edited");
      await expect(page.locator(".status")).toHaveText("Saved");

      const saved = (await (await request.get(`/api/memos/${id}`)).json()) as { content: string };
      expect(saved.content).toContain(uri); // image round-tripped through the fold
      expect(saved.content).toContain(" edited");
      expect(saved.content).not.toContain("fold:0"); // marker never reaches the server

      // reopening still folds for display and still shows the image
      await page.reload();
      await expect(page.locator(sel.editor)).toHaveValue(/fold:0/);
      expect(await page.locator(sel.editor).inputValue()).not.toContain(big);
      await expect(page.locator(".preview.markdown img")).toHaveAttribute("src", uri);
    } finally {
      await purge(request, id);
    }
  });
});
