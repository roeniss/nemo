import { test, expect } from "@playwright/test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sel } from "./helpers";

let bigPath: string;
test.beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "nemo-quota-"));
  bigPath = join(dir, "huge.txt");
  writeFileSync(bigPath, "data ".repeat(40_000)); // ~200 KB
});

test.describe("localStorage quota defense", () => {
  test("import into a full localStorage warns, keeps content, saves to server, no crash", async ({
    page,
    request,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));

    await page.goto("/");
    await page.locator(sel.newBtn).click();
    await expect(page.locator(sel.editor)).toHaveValue("# ");

    // simulate a permanently-full quota for sizable writes
    await page.evaluate(() => {
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k: string, v: string) {
        if (typeof v === "string" && v.length > 1000)
          throw new DOMException("full", "QuotaExceededError");
        return orig.call(this, k, v);
      };
    });

    await page.locator(sel.fileInput).setInputFiles(bigPath);
    await page.locator(".conflict", { hasText: "불러올까요" }).locator("button", { hasText: "불러오기" }).click();

    // graceful warning (not masked by the success toast), content kept in memory
    await expect(page.locator(sel.toast)).toContainText("로컬 저장 공간");
    await expect(page.locator(sel.editor)).toHaveValue(/^# huge\.txt/);

    // still persisted to the server despite the local quota
    await expect(page.locator(".status")).toHaveText("Saved");
    const id = Number(await page.evaluate(() => location.hash.replace("#", "")));
    const r = await request.get(`/api/memos/${id}`);
    expect(r.ok()).toBeTruthy();
    expect(((await r.json()) as { content: string }).content.length).toBeGreaterThan(100_000);

    expect(errors).toEqual([]); // no uncaught QuotaExceededError

    await request.delete(`/api/memos/${id}?purge=1`);
  });
});
