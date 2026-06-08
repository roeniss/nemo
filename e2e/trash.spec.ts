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

  test("clicking a trashed memo shows its content read-only", async ({ page, request }) => {
    const title = uniq("TrashV");
    const id = await seedMemo(request, `# ${title}\n\nhidden body text`);
    try {
      await page.goto("/");
      await page.reload();
      const row = page.locator(`${sel.list}:has(.memo-title:text-is("${title}"))`);
      await expect(row).toBeVisible();
      await row.locator(".del").click();
      await expect(row).toHaveCount(0);

      // open it from the Trash view
      await page.click(trashTab);
      const trashRow = page.locator(`${sel.list}:has(.memo-title:text-is("${title}"))`);
      await trashRow.click();

      // content shows, read-only, with the restore/hide banner
      const editor = page.locator("textarea.editor");
      await expect(editor).toHaveValue(`# ${title}\n\nhidden body text`);
      await expect(editor).toHaveAttribute("readonly", "");
      await expect(page.locator(".conflict")).toContainText("읽기 전용");
      await expect(page.locator(".preview.markdown")).toContainText("hidden body text");

      // restoring from the banner closes the read-only view and returns it to Memos
      await page.locator(".conflict button", { hasText: "복구" }).click();
      await expect(page.locator(".conflict")).toHaveCount(0);
      await page.click(memosTab);
      await expect(page.locator(`.memo-title:text-is("${title}")`)).toBeVisible();
    } finally {
      await purge(request, id);
    }
  });

  test("the read-only trash view folds inline base64 like the editor", async ({ page, request }) => {
    const title = uniq("TrashImg");
    const big = "A".repeat(2000);
    const uri = `data:image/png;base64,${big}`;
    const id = await seedMemo(request, `# ${title}\n\n![shot](${uri})`);
    try {
      await page.goto("/");
      await page.reload();
      const row = page.locator(`${sel.list}:has(.memo-title:text-is("${title}"))`);
      await expect(row).toBeVisible();
      await row.locator(".del").click();
      await expect(row).toHaveCount(0);

      // open it from the Trash view
      await page.click(trashTab);
      await page.locator(`${sel.list}:has(.memo-title:text-is("${title}"))`).click();

      // the read-only editor shows the fold marker, not the 2KB base64 wall…
      const editor = page.locator("textarea.editor");
      await expect(editor).toHaveAttribute("readonly", "");
      await expect(editor).toHaveValue(/fold:0/);
      expect(await editor.inputValue()).not.toContain(big);
      // …while the preview still renders the real image
      await expect(page.locator(".preview.markdown img")).toHaveAttribute("src", uri);
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
