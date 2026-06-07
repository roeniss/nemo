import { test, expect } from "./fixtures";
import { sel, seedMemo, purge, uniq } from "./helpers";

test.describe("multi-session conflict", () => {
  test("editing a memo changed elsewhere shows a banner; Reload adopts the server copy", async ({
    page,
    request,
  }) => {
    const title = uniq("Conf");
    const id = await seedMemo(request, `# ${title}\n\nv1`);
    try {
      await page.goto(`/#${id}`);
      await expect(page.locator(sel.editor)).toHaveValue(`# ${title}\n\nv1`);

      // another session changes it → server updated_at advances past our base
      await request.put(`/api/memos/${id}`, { data: { content: `# ${title}\n\nEXTERNAL v2` } });

      // our local edit autosaves with the stale base → 409 → conflict banner
      await page.locator(sel.editor).click();
      await page.keyboard.type(" local");
      const banner = page.locator(".conflict", { hasText: "changed in another session" });
      await expect(banner).toBeVisible();

      await banner.locator("button", { hasText: "Reload" }).click();
      await expect(banner).toBeHidden();
      await expect(page.locator(sel.editor)).toHaveValue(`# ${title}\n\nEXTERNAL v2`);
    } finally {
      await purge(request, id);
    }
  });

  test("Overwrite forces the local version onto the server", async ({ page, request }) => {
    const title = uniq("ConfO");
    const id = await seedMemo(request, `# ${title}\n\nv1`);
    try {
      await page.goto(`/#${id}`);
      await expect(page.locator(sel.editor)).toHaveValue(`# ${title}\n\nv1`);
      await request.put(`/api/memos/${id}`, { data: { content: `# ${title}\n\nEXTERNAL v2` } });

      await page.locator(sel.editor).click();
      await page.keyboard.press("ControlOrMeta+End");
      await page.keyboard.type(" LOCAL-WINS");
      const banner = page.locator(".conflict", { hasText: "changed in another session" });
      await expect(banner).toBeVisible();

      await banner.locator("button", { hasText: "Overwrite" }).click();
      await expect(banner).toBeHidden();

      // server now holds the local content
      await expect
        .poll(async () => ((await (await request.get(`/api/memos/${id}`)).json()) as { content: string }).content)
        .toContain("LOCAL-WINS");
    } finally {
      await purge(request, id);
    }
  });
});
