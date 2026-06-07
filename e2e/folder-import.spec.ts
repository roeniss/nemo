import { test, expect } from "./fixtures";
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sel, purge, blankMemo, uniq } from "./helpers";

type Meta = { id: number; title: string };

test.describe("folder upload", () => {
  test("registers each top-level file as its own memo, skipping binaries and subfolders", async ({
    page,
    request,
  }) => {
    // unique names so the assertion survives the shared local D1 across reruns
    const alpha = `${uniq("alpha")}.md`;
    const beta = `${uniq("beta")}.txt`;
    const dir = mkdtempSync(join(tmpdir(), "nemo-folder-"));
    writeFileSync(join(dir, alpha), "alpha body line");
    writeFileSync(join(dir, beta), "beta body line");
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0x50, 0x4b, 0x00, 0x01])); // NUL → binary
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "deep.txt"), "should be ignored (recursive)");

    await blankMemo(page);
    // a webkitdirectory input takes the folder path and yields the whole tree
    await page.locator(sel.folderInput).setInputFiles(dir);

    // 2 text files registered; blob.bin + nested/deep.txt skipped
    await expect(page.locator(sel.toast)).toContainText("2개 문서를 등록했어요");
    await expect(page.locator(".memo-list")).toContainText(alpha);
    await expect(page.locator(".memo-list")).toContainText(beta);

    // the open blank memo is untouched by the folder upload
    await expect(page.locator(sel.editor)).toHaveValue("# ");

    // verify server-side: each file is its own memo, titled by filename, body
    // prefixed with the "# name" heading — and the recursive/binary files are absent
    const list = (await (await request.get("/api/memos")).json()) as Meta[];
    const a = list.find((m) => m.title === alpha);
    const b = list.find((m) => m.title === beta);
    expect(a, "alpha memo registered").toBeTruthy();
    expect(b, "beta memo registered").toBeTruthy();
    expect(list.some((m) => m.title === "deep.txt"), "subfolder file not registered").toBe(false);
    expect(list.some((m) => m.title === "blob.bin"), "binary file not registered").toBe(false);

    const aBody = (await (await request.get(`/api/memos/${a!.id}`)).json()) as { content: string };
    expect(aBody.content).toBe(`# ${alpha}\n\nalpha body line`);

    await purge(request, a!.id);
    await purge(request, b!.id);
  });

  test("a folder with no importable files reports nothing was registered", async ({ page }) => {
    const dir = mkdtempSync(join(tmpdir(), "nemo-folder-empty-"));
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03])); // binary only

    await blankMemo(page);
    await page.locator(sel.folderInput).setInputFiles(dir);

    await expect(page.locator(sel.toast)).toContainText("등록할 텍스트 파일이 없어요");
    await expect(page.locator(sel.editor)).toHaveValue("# ");
  });
});
