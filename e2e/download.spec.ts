import { test, expect } from "./fixtures";
import { readFileSync } from "node:fs";
import { sel, seedMemo, purge, uniq } from "./helpers";

test.describe("download", () => {
  test("downloads the current memo as a .md named after its title", async ({ page, request }) => {
    const title = uniq("Down");
    const body = `# ${title}\n\nline one\nline two`;
    const id = await seedMemo(request, body);
    try {
      await page.goto(`/#${id}`);
      await expect(page.locator(sel.editor)).toHaveValue(body);

      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.locator(sel.downloadBtn).click(),
      ]);
      expect(download.suggestedFilename()).toBe(`${title}.md`);
      const path = await download.path();
      expect(readFileSync(path, "utf-8")).toBe(body);
    } finally {
      await purge(request, id);
    }
  });

  test("sanitizes path-unsafe characters in the download filename", async ({ page, request }) => {
    const body = `# a/b:c?d\n\nx`;
    const id = await seedMemo(request, body);
    try {
      await page.goto(`/#${id}`);
      await expect(page.locator(sel.editor)).toHaveValue(body);
      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.locator(sel.downloadBtn).click(),
      ]);
      // / : ? are replaced with _
      expect(download.suggestedFilename()).toBe("a_b_c_d.md");
    } finally {
      await purge(request, id);
    }
  });
});
