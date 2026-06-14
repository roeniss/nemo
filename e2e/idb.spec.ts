import { test, expect } from "./fixtures";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sel, purge, blankMemo, uniq, editorText } from "./helpers";

let bigPath: string;
let bigName: string;
test.beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "nemo-idb-"));
  bigName = `${uniq("huge")}.txt`;
  bigPath = join(dir, bigName);
  writeFileSync(bigPath, "data ".repeat(60_000)); // ~300 KB — well past the old ~5MB-shared localStorage pain
});

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
  test("large imported content persists to IndexedDB (not localStorage) and survives reload", async ({
    page,
    request,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    // importing a large file registers it as its own memo, body cached in IDB
    await blankMemo(page);
    await page.locator(sel.fileInput).setInputFiles(bigPath);
    await expect(page.locator(sel.toast)).toContainText("1개 문서를 등록했어요");

    const list = (await (await request.get("/api/memos")).json()) as { id: number; title: string }[];
    const memo = list.find((m) => m.title === bigName);
    expect(memo, "imported memo registered").toBeTruthy();
    const id = memo!.id;

    // open the new memo — its large body renders straight from the IDB cache
    await page.goto(`/#${id}`);
    await expect.poll(() => editorText(page)).toMatch(new RegExp(`^# ${bigName}`));

    // cached in IndexedDB, large, and NOT bloating localStorage
    const cached = await idbGet(page, `qm-cache-${id}`);
    expect((cached ?? "").length).toBeGreaterThan(100_000);
    expect(await page.evaluate((i) => localStorage.getItem(`qm-cache-${i}`), id)).toBeNull();

    // survives a reload (read back from IDB for instant offline display)
    await page.reload();
    await expect.poll(() => editorText(page)).toMatch(new RegExp(`^# ${bigName}`));

    expect(errors).toEqual([]); // no uncaught storage errors
    await purge(request, id);
  });
});
