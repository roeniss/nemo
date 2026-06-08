import { test, expect } from "./fixtures";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sel, purge, blankMemo, uniq } from "./helpers";

type Meta = { id: number; title: string };

let dir: string;

test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "nemo-e2e-"));
});

test.describe("file import", () => {
  test("a single file becomes its own memo, titled by file name", async ({ page, request }) => {
    const name = `${uniq("note")}.md`;
    writeFileSync(join(dir, name), "imported line one\nimported line two\n");

    await blankMemo(page);
    await page.locator(sel.fileInput).setInputFiles(join(dir, name));

    await expect(page.locator(sel.toast)).toContainText("1개 문서를 등록했어요");
    await expect(page.locator(".memo-list")).toContainText(name);
    // the open blank memo is untouched — the file lands in a new memo, not the body
    await expect(page.locator(sel.editor)).toHaveValue("# ");

    const list = (await (await request.get("/api/memos")).json()) as Meta[];
    const m = list.find((x) => x.title === name);
    expect(m, "memo registered").toBeTruthy();
    const body = (await (await request.get(`/api/memos/${m!.id}`)).json()) as { content: string };
    expect(body.content).toBe(`# ${name}\n\nimported line one\nimported line two\n`);
    await purge(request, m!.id);
  });

  test("multiple selected files each become their own memo", async ({ page, request }) => {
    const a = `${uniq("multi-a")}.md`;
    const b = `${uniq("multi-b")}.txt`;
    writeFileSync(join(dir, a), "body A");
    writeFileSync(join(dir, b), "body B");

    await blankMemo(page);
    await page.locator(sel.fileInput).setInputFiles([join(dir, a), join(dir, b)]);

    await expect(page.locator(sel.toast)).toContainText("2개 문서를 등록했어요");
    await expect(page.locator(".memo-list")).toContainText(a);
    await expect(page.locator(".memo-list")).toContainText(b);
    await expect(page.locator(sel.editor)).toHaveValue("# ");

    const list = (await (await request.get("/api/memos")).json()) as Meta[];
    const ma = list.find((x) => x.title === a);
    const mb = list.find((x) => x.title === b);
    expect(ma, "memo a registered").toBeTruthy();
    expect(mb, "memo b registered").toBeTruthy();
    await purge(request, ma!.id);
    await purge(request, mb!.id);
  });

  test("a large file (>100KB) imports straight away, with no confirmation gate", async ({
    page,
    request,
  }) => {
    const name = `${uniq("big")}.txt`;
    writeFileSync(join(dir, name), "lorem ipsum ".repeat(12_000)); // ~144 KB

    await blankMemo(page);
    await page.locator(sel.fileInput).setInputFiles(join(dir, name));

    await expect(page.locator(sel.toast)).toContainText("1개 문서를 등록했어요");
    await expect(page.locator(".conflict")).toHaveCount(0); // no "불러올까요" banner
    await expect(page.locator(sel.editor)).toHaveValue("# ");

    const list = (await (await request.get("/api/memos")).json()) as Meta[];
    const m = list.find((x) => x.title === name);
    expect(m, "memo registered").toBeTruthy();
    await purge(request, m!.id);
  });

  test("rejects a binary file with a toast, creating no memo", async ({ page }) => {
    const name = `${uniq("blob")}.bin`;
    writeFileSync(join(dir, name), Buffer.from([0x50, 0x4b, 0x03, 0x00, 0x01, 0x00, 0x02])); // NUL inside

    await blankMemo(page);
    await page.locator(sel.fileInput).setInputFiles(join(dir, name));

    await expect(page.locator(sel.toast)).toContainText("등록할 텍스트 파일이 없어요");
    await expect(page.locator(sel.editor)).toHaveValue("# ");
    await expect(page.locator(".memo-list")).not.toContainText(name);
  });

  test("drag-and-drop a text file creates a new memo", async ({ page, request }) => {
    const name = `${uniq("dropped")}.txt`;
    await blankMemo(page);
    const dt = await page.evaluateHandle((fname) => {
      const d = new DataTransfer();
      d.items.add(new File(["dropped line A\ndropped line B"], fname, { type: "text/plain" }));
      return d;
    }, name);
    await page.dispatchEvent(sel.editor, "drop", { dataTransfer: dt });

    await expect(page.locator(sel.toast)).toContainText("1개 문서를 등록했어요");
    await expect(page.locator(".memo-list")).toContainText(name);
    // the editor (open blank memo) keeps its content — the drop didn't insert into it
    await expect(page.locator(sel.editor)).toHaveValue("# ");

    const list = (await (await request.get("/api/memos")).json()) as Meta[];
    const m = list.find((x) => x.title === name);
    expect(m, "memo registered").toBeTruthy();
    const body = (await (await request.get(`/api/memos/${m!.id}`)).json()) as { content: string };
    expect(body.content).toBe(`# ${name}\n\ndropped line A\ndropped line B`);
    await purge(request, m!.id);
  });
});
