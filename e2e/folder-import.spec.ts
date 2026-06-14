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

    // 2 text files registered; blob.bin skipped (binary), nested/deep.txt excluded
    // (recursive, so not counted as skipped) — toast reports both the added and skip counts
    await expect(page.locator(sel.toast)).toContainText("2개 문서를 등록했어요 (1개 건너뜀)");
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
    const bBody = (await (await request.get(`/api/memos/${b!.id}`)).json()) as { content: string };
    expect(aBody.content).toBe(`# ${alpha}\n\nalpha body line`);
    expect(bBody.content).toBe(`# ${beta}\n\nbeta body line`);

    await purge(request, a!.id);
    await purge(request, b!.id);
  });

  test("a clean folder of only text files registers all with no skip suffix", async ({
    page,
    request,
  }) => {
    const one = `${uniq("one")}.md`;
    const two = `${uniq("two")}.txt`;
    const dir = mkdtempSync(join(tmpdir(), "nemo-folder-clean-"));
    writeFileSync(join(dir, one), "one body");
    writeFileSync(join(dir, two), "two body");

    await blankMemo(page);
    await page.locator(sel.folderInput).setInputFiles(dir);

    // nothing skipped → the toast carries no "(N개 건너뜀)" suffix
    await expect(page.locator(sel.toast)).toHaveText("2개 문서를 등록했어요.");

    const list = (await (await request.get("/api/memos")).json()) as Meta[];
    const a = list.find((m) => m.title === one);
    const b = list.find((m) => m.title === two);
    expect(a, "one memo registered").toBeTruthy();
    expect(b, "two memo registered").toBeTruthy();
    await purge(request, a!.id);
    await purge(request, b!.id);
  });

  test("a large file (>100KB) in a folder registers without a confirmation prompt", async ({
    page,
    request,
  }) => {
    // single-file Import holds files this big behind a confirm banner; folder upload must not
    const big = `${uniq("big")}.txt`;
    const dir = mkdtempSync(join(tmpdir(), "nemo-folder-big-"));
    writeFileSync(join(dir, big), "lorem ipsum ".repeat(12_000)); // ~144 KB > 100 KB

    await blankMemo(page);
    await page.locator(sel.folderInput).setInputFiles(dir);

    await expect(page.locator(sel.toast)).toHaveText("1개 문서를 등록했어요.");
    // no large-file confirmation banner appears for folder upload
    await expect(page.locator(".conflict", { hasText: "불러올까요" })).toHaveCount(0);
    await expect(page.locator(".memo-list")).toContainText(big);

    const list = (await (await request.get("/api/memos")).json()) as Meta[];
    const m = list.find((x) => x.title === big);
    expect(m, "large memo registered").toBeTruthy();
    await purge(request, m!.id);
  });

  test("a folder with no importable files reports nothing was registered", async ({ page }) => {
    const dir = mkdtempSync(join(tmpdir(), "nemo-folder-empty-"));
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03])); // binary only

    await blankMemo(page);
    await page.locator(sel.folderInput).setInputFiles(dir);

    await expect(page.locator(sel.toast)).toContainText("등록할 텍스트 파일이 없어요");
    await expect(page.locator(sel.editor)).toHaveValue("# ");
  });

  test("a folder whose files are all in subfolders registers nothing (non-recursive)", async ({
    page,
  }) => {
    // top level has no direct files — only a subfolder — so direct[] is empty and the
    // "folder is empty" branch fires (distinct from the "no text files" branch above)
    const dir = mkdtempSync(join(tmpdir(), "nemo-folder-sub-"));
    mkdirSync(join(dir, "only-sub"));
    writeFileSync(join(dir, "only-sub", "inside.txt"), "deep file, must be ignored");

    await blankMemo(page);
    await page.locator(sel.folderInput).setInputFiles(dir);

    await expect(page.locator(sel.toast)).toContainText("폴더가 비어 있어요");
    await expect(page.locator(sel.editor)).toHaveValue("# ");
  });
});
