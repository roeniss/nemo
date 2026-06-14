import { test, expect } from "./fixtures";
import { sel, seedMemo, purge, uniq, expectEditor } from "./helpers";

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
    // settle on a memo fully (editor content loaded) before the next keypress, so a
    // press can't race the previous openMemo's async tail
    const settled = async (title: string, body: string) => {
      await expectEditor(page, `# ${title}\n\n${body}`);
      await expect(page.locator(sel.activeTitle)).toHaveText(title);
    };
    try {
      await page.goto(`/#${idC}`); // start at the top of the list (C)
      await settled(c, "c");

      // Alt+K at the very top → clamps (stays on C)
      await altK();
      await settled(c, "c");

      // Alt+J → down to B, then A
      await altJ();
      await settled(b, "b");
      await altJ();
      await settled(a, "a");

      // Alt+K → back up to B
      await altK();
      await settled(b, "b");
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
      await expectEditor(page, `# ${b}\n\nb`);

      await page.locator(sel.editor).click(); // focus the editor
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
