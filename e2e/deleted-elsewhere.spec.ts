import { test, expect } from "@playwright/test";
import { sel, seedMemo, purge, uniq } from "./helpers";

test.describe("memo trashed in another session", () => {
  test("shows a banner and can recover the content as a new memo", async ({ page, request }) => {
    const title = uniq("Gone");
    const body = `# ${title}\n\noriginal text`;
    const id = await seedMemo(request, body);
    let newId: number | null = null;
    try {
      await page.goto(`/#${id}`);
      await expect(page.locator(sel.editor)).toHaveValue(body);

      // another session moves it to the trash
      await request.delete(`/api/memos/${id}`);

      // background sync (fired on focus) detects it's gone → banner
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      const banner = page.locator(".conflict", { hasText: "삭제되었습니다" });
      await expect(banner).toBeVisible();

      // recover as a new memo
      await banner.locator("button", { hasText: "새 메모로 복구" }).click();
      await expect(banner).toBeHidden();
      // recoverAsNew POSTs a new memo, then swaps the URL to its id
      await expect(page).not.toHaveURL(new RegExp(`#${id}$`));
      await expect(page).toHaveURL(/#\d+$/);
      newId = Number(await page.evaluate(() => location.hash.replace("#", "")));
      expect(newId).not.toBe(id);
      await expect(page.locator(sel.editor)).toHaveValue(body);
    } finally {
      await purge(request, id);
      if (newId) await purge(request, newId);
    }
  });

  test("discard drops the trashed memo", async ({ page, request }) => {
    const title = uniq("GoneD");
    const id = await seedMemo(request, `# ${title}\n\nx`);
    try {
      await page.goto(`/#${id}`);
      await expect(page.locator(sel.editor)).toHaveValue(`# ${title}\n\nx`);
      await request.delete(`/api/memos/${id}`);
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      const banner = page.locator(".conflict", { hasText: "삭제되었습니다" });
      await expect(banner).toBeVisible();
      await banner.locator("button", { hasText: "버리기" }).click();
      await expect(banner).toBeHidden();
    } finally {
      await purge(request, id);
    }
  });
});
