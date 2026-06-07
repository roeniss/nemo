import { test, expect } from "./fixtures";
import { sel, seedMemo, purge, uniq } from "./helpers";

const memosTab = '.side-tabs .tab:has-text("Memos")';
const trashTab = '.side-tabs .tab:has-text("Trash")';

test.describe("trash", () => {
  test("delete → appears in Trash → restore brings it back", async ({ page, request }) => {
    const title = uniq("TrashR");
    const id = await seedMemo(request, `# ${title}\n\nbody`);
    try {
      await page.goto("/");
      await page.reload();
      const row = page.locator(`${sel.list}:has(.memo-title:text-is("${title}"))`);
      await expect(row).toBeVisible();
      await row.locator(".del").click();
      await expect(row).toHaveCount(0);

      // shows up under Trash
      await page.click(trashTab);
      const trashRow = page.locator(`${sel.list}:has(.memo-title:text-is("${title}"))`);
      await expect(trashRow).toBeVisible();

      // restore
      await trashRow.locator(".restore").click();
      await expect(trashRow).toHaveCount(0);

      // back under Memos
      await page.click(memosTab);
      await expect(page.locator(`.memo-title:text-is("${title}")`)).toBeVisible();
    } finally {
      await purge(request, id);
    }
  });

  test("hide permanently removes a memo from the Trash view", async ({ page, request }) => {
    const title = uniq("TrashH");
    const id = await seedMemo(request, `# ${title}\n\nbody`);
    try {
      await page.goto("/");
      await page.reload();
      const row = page.locator(`${sel.list}:has(.memo-title:text-is("${title}"))`);
      await expect(row).toBeVisible();
      await row.locator(".del").click();
      await expect(row).toHaveCount(0);

      await page.click(trashTab);
      const trashRow = page.locator(`${sel.list}:has(.memo-title:text-is("${title}"))`);
      await expect(trashRow).toBeVisible();
      await trashRow.locator(".del").click(); // × in trash = hide
      await expect(trashRow).toHaveCount(0);

      // reload Trash → still gone
      await page.click(memosTab);
      await page.click(trashTab);
      await expect(page.locator(`.memo-title:text-is("${title}")`)).toHaveCount(0);
    } finally {
      await purge(request, id);
    }
  });
});
