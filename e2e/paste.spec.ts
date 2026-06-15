import { test, expect } from "./fixtures";
import { sel, purge, blankMemo } from "./helpers";

const hashId = (page: import("@playwright/test").Page) =>
  page.evaluate(() => Number(location.hash.replace("#", "")));

// dispatch a synthetic paste carrying a single image File of the given byte size
const pasteImage = (
  page: import("@playwright/test").Page,
  name: string,
  type: string,
  bytes: number[]
) =>
  page.evaluate(
    ({ name, type, bytes }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], name, { type }));
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      document.querySelector("textarea.editor")!.dispatchEvent(ev);
    },
    { name, type, bytes }
  );

test.describe("image paste", () => {
  test("a small pasted image is embedded inline as a base64 data URI", async ({ page, request }) => {
    await blankMemo(page);
    // 4 bytes [1,2,3,4] → base64 "AQIDBA=="
    await pasteImage(page, "shot.png", "image/png", [1, 2, 3, 4]);

    await expect(page.locator(sel.toast)).toContainText("이미지를 첨부했어요");
    await expect(page.locator(sel.editor)).toHaveValue(
      "# ![shot.png](data:image/png;base64,AQIDBA==)"
    );
    await expect(page.locator(".status")).toHaveText("Saved");

    // and it actually renders as an <img> in the live preview (the #49 goal)
    await expect(page.locator(".preview img")).toHaveAttribute(
      "src",
      "data:image/png;base64,AQIDBA=="
    );

    // persisted server-side as part of the memo content. A new memo is a local
    // temp until it materializes; focus pushes it to the server (id turns positive).
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page).toHaveURL(/#\d+$/);
    const id = await hashId(page);
    const body = (await (await request.get(`/api/memos/${id}`)).json()) as { content: string };
    expect(body.content).toContain("data:image/png;base64,AQIDBA==");
    await purge(request, id);
  });

  test("an image over 1MB is rejected with a toast, embedding nothing", async ({ page }) => {
    await blankMemo(page);
    await pasteImage(page, "big.png", "image/png", new Array(1024 * 1024 + 1).fill(0));

    await expect(page.locator(sel.toast)).toContainText("이미지가 너무 커요");
    await expect(page.locator(sel.editor)).toHaveValue("# "); // untouched
  });

  test("pasting a non-image file is ignored (no embed, no toast)", async ({ page }) => {
    await blankMemo(page);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(["hello"], "note.txt", { type: "text/plain" }));
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      document.querySelector("textarea.editor")!.dispatchEvent(ev);
    });

    // our handler leaves it to the browser; the synthetic event carries no text,
    // so nothing is inserted and no image toast appears
    await expect(page.locator(sel.editor)).toHaveValue("# ");
    await expect(page.locator(sel.toast)).toHaveCount(0);
  });
});
