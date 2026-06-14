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

  // regression: a write that the server committed but whose ack we never saw
  // (a keepalive ⌘W flush, or a save whose response was lost on a flaky LTE
  // connection) used to come back as a phantom "changed in another session" —
  // the session conflicting with its OWN edit. It must now re-base silently.
  test("a save whose ack was lost is recognised as our own write, not a conflict", async ({
    page,
    request,
  }) => {
    const title = uniq("Unack");
    const id = await seedMemo(request, `# ${title}\n\nv1`);
    try {
      await page.goto(`/#${id}`);
      await expect(page.locator(sel.editor)).toHaveValue(`# ${title}\n\nv1`);

      // the next save reaches and COMMITS on the server, but the browser sees a
      // network failure — so loadedAt stays stale though updated_at advanced.
      let dropped = false;
      await page.route("**/api/memos/*", async (route) => {
        if (route.request().method() === "PUT" && !dropped) {
          dropped = true;
          const body = JSON.parse(route.request().postData() || "{}");
          await request.put(`/api/memos/${id}`, { data: body }); // commit server-side
          await route.abort("connectionfailed"); // ...but drop the client's ack
          return;
        }
        return route.continue();
      });

      await page.locator(sel.editor).click();
      await page.keyboard.press("ControlOrMeta+End");
      await page.keyboard.type(" first");
      // the dropped-but-committed write lands on the server
      await expect
        .poll(async () => ((await (await request.get(`/api/memos/${id}`)).json()) as { content: string }).content)
        .toContain("first");

      // keep editing: this save sends the now-stale base → the server 409s
      // against our OWN committed write. It must re-base and save, NOT nag.
      await page.keyboard.type(" second");
      await expect
        .poll(async () => ((await (await request.get(`/api/memos/${id}`)).json()) as { content: string }).content)
        .toContain("second");

      await expect(
        page.locator(".conflict", { hasText: "changed in another session" })
      ).toBeHidden();
    } finally {
      await purge(request, id);
    }
  });
});
