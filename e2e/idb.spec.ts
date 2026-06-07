import { test, expect } from "./fixtures";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sel, purge, blankMemo } from "./helpers";

let bigPath: string;
test.beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "nemo-idb-"));
  bigPath = join(dir, "huge.txt");
  writeFileSync(bigPath, "data ".repeat(60_000)); // ~300 KB — well past the old ~5MB-shared localStorage pain
});

const hashId = (page: import("@playwright/test").Page) =>
  page.evaluate(() => Number(location.hash.replace("#", "")));

// read a key from the IndexedDB content store, in the page context
const idbGet = (page: import("@playwright/test").Page, key: string) =>
  page.evaluate(
    (k) =>
      new Promise<string | null>((resolve) => {
        const req = indexedDB.open("nemo", 1);
        req.onsuccess = () => {
          const g = req.result.transaction("kv").objectStore("kv").get(k);
          g.onsuccess = () => resolve((g.result as string) ?? null);
          g.onerror = () => resolve(null);
        };
        req.onerror = () => resolve(null);
      }),
    key
  );

test.describe("IndexedDB content store", () => {
  test("large content persists to IndexedDB (not localStorage) and survives reload", async ({
    page,
    request,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await blankMemo(page);
    await page.locator(sel.fileInput).setInputFiles(bigPath);
    await page
      .locator(".conflict", { hasText: "불러올까요" })
      .locator("button", { hasText: "불러오기" })
      .click();
    await expect(page.locator(sel.editor)).toHaveValue(/^# huge\.txt/);
    await expect(page.locator(".status")).toHaveText("Saved");

    const id = await hashId(page);
    // cached in IndexedDB, large, and NOT bloating localStorage
    const cached = await idbGet(page, `qm-cache-${id}`);
    expect((cached ?? "").length).toBeGreaterThan(100_000);
    expect(await page.evaluate((i) => localStorage.getItem(`qm-cache-${i}`), id)).toBeNull();

    // survives a reload (read back from IDB for instant offline display)
    await page.reload();
    await expect(page.locator(sel.editor)).toHaveValue(/^# huge\.txt/);

    expect(errors).toEqual([]); // no uncaught storage errors
    await purge(request, id);
  });
});
