import { test, expect } from "@playwright/test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sel, uniq } from "./helpers";

let dir: string;
let smallPath: string;
let bigPath: string;
let binPath: string;

test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "nemo-e2e-"));
  smallPath = join(dir, "small-note.md");
  bigPath = join(dir, "big-note.txt");
  binPath = join(dir, "blob.bin");
  writeFileSync(smallPath, "imported line one\nimported line two\n");
  writeFileSync(bigPath, "lorem ipsum ".repeat(12_000)); // ~144 KB > 100 KB
  writeFileSync(binPath, Buffer.from([0x50, 0x4b, 0x03, 0x00, 0x01, 0x00, 0x02])); // NUL inside
});

test.describe("file import", () => {
  test("small file imports into a blank memo, titled by file name", async ({ page }) => {
    await page.goto("/");
    await page.locator(sel.newBtn).click();
    await expect(page.locator(sel.editor)).toHaveValue("# ");
    await page.locator(sel.fileInput).setInputFiles(smallPath);
    await expect(page.locator(sel.editor)).toHaveValue(
      "# small-note.md\n\nimported line one\nimported line two\n"
    );
    await expect(page.locator(sel.activeTitle)).toHaveText("small-note.md");
  });

  test("rejects a binary file with a toast, leaving the body untouched", async ({ page }) => {
    await page.goto("/");
    await page.locator(sel.newBtn).click();
    await expect(page.locator(sel.editor)).toHaveValue("# ");
    await page.locator(sel.fileInput).setInputFiles(binPath);
    await expect(page.locator(sel.toast)).toContainText("텍스트 파일만");
    await expect(page.locator(sel.editor)).toHaveValue("# ");
  });

  test("large file (>100KB) asks for confirmation; cancel keeps it out", async ({ page }) => {
    await page.goto("/");
    await page.locator(sel.newBtn).click();
    await expect(page.locator(sel.editor)).toHaveValue("# ");
    await page.locator(sel.fileInput).setInputFiles(bigPath);
    const banner = page.locator(".conflict", { hasText: "불러올까요" });
    await expect(banner).toBeVisible();
    await expect(page.locator(sel.editor)).toHaveValue("# "); // not loaded yet
    await banner.locator("button", { hasText: "취소" }).click();
    await expect(banner).toBeHidden();
    await expect(page.locator(sel.editor)).toHaveValue("# ");
  });

  test("large file confirm loads it, titled by file name", async ({ page }) => {
    await page.goto("/");
    await page.locator(sel.newBtn).click();
    await expect(page.locator(sel.editor)).toHaveValue("# ");
    await page.locator(sel.fileInput).setInputFiles(bigPath);
    const banner = page.locator(".conflict", { hasText: "불러올까요" });
    await banner.locator("button", { hasText: "불러오기" }).click();
    await expect(banner).toBeHidden();
    await expect(page.locator(sel.editor)).toHaveValue(/^# big-note\.txt\n\nlorem ipsum /);
  });

  test("drag-and-drop a text file inserts its contents", async ({ page }) => {
    await page.goto("/");
    await page.locator(sel.newBtn).click();
    await expect(page.locator(sel.editor)).toHaveValue("# ");
    const dt = await page.evaluateHandle(() => {
      const d = new DataTransfer();
      d.items.add(new File(["dropped line A\ndropped line B"], "dropped.txt", { type: "text/plain" }));
      return d;
    });
    await page.dispatchEvent(sel.editor, "drop", { dataTransfer: dt });
    await expect(page.locator(sel.editor)).toHaveValue("# dropped.txt\n\ndropped line A\ndropped line B");
  });
});
