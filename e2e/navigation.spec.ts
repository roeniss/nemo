import { test, expect } from "@playwright/test";
import { sel, seedMemo, purge, uniq } from "./helpers";

test.describe("Alt+J / Alt+K memo navigation", () => {
  test("moves to next/previous and clamps at the ends", async ({ page, request }) => {
    // three memos created newest-last → list order (by recency) is C, B, A at the top
    const a = uniq("NavA");
    const b = uniq("NavB");
    const c = uniq("NavC");
    const idA = await seedMemo(request, `# ${a}\n\na`);
    const idB = await seedMemo(request, `# ${b}\n\nb`);
    const idC = await seedMemo(request, `# ${c}\n\nc`);
    const altK = async () => { await page.keyboard.down("Alt"); await page.keyboard.press("KeyK"); await page.keyboard.up("Alt"); };
    const altJ = async () => { await page.keyboard.down("Alt"); await page.keyboard.press("KeyJ"); await page.keyboard.up("Alt"); };
    try {
      await page.goto(`/#${idC}`); // start at the top of the list (C)
      await expect(page.locator(sel.activeTitle)).toHaveText(c);

      // Alt+K at the very top → clamps (stays on C)
      await altK();
      await expect(page.locator(sel.activeTitle)).toHaveText(c);

      // Alt+J → down to B, then A
      await altJ();
      await expect(page.locator(sel.activeTitle)).toHaveText(b);
      await altJ();
      await expect(page.locator(sel.activeTitle)).toHaveText(a);

      // Alt+K → back up to B
      await altK();
      await expect(page.locator(sel.activeTitle)).toHaveText(b);
    } finally {
      await purge(request, idA);
      await purge(request, idB);
      await purge(request, idC);
    }
  });

  test("Alt+J fires from inside the editor without typing a character", async ({ page, request }) => {
    const a = uniq("NavX");
    const b = uniq("NavY");
    const idA = await seedMemo(request, `# ${a}\n\na`);
    const idB = await seedMemo(request, `# ${b}\n\nb`); // newest → top of list
    try {
      await page.goto(`/#${idB}`);
      await expect(page.locator(sel.activeTitle)).toHaveText(b);
      await expect(page.locator(sel.editor)).toHaveValue(`# ${b}\n\nb`);

      await page.locator(sel.editor).click(); // focus the textarea
      await page.keyboard.down("Alt");
      await page.keyboard.press("KeyJ");
      await page.keyboard.up("Alt");

      // the shortcut navigated (down to A) even though focus was in the editor
      await expect(page.locator(sel.activeTitle)).toHaveText(a);
      // and B was not mutated by a stray Option+J character (check the server copy)
      const r = await request.get(`/api/memos/${idB}`);
      expect(((await r.json()) as { content: string }).content).toBe(`# ${b}\n\nb`);
    } finally {
      await purge(request, idA);
      await purge(request, idB);
    }
  });
});
