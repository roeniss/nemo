import type { APIRequestContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";

// dev credentials (match .dev.vars); overridable in CI via env
export const USER = process.env.TEST_USER || "roeniss";
export const PASS = process.env.TEST_PASS || "local-dev-only";
export const AUTH_STATE = "e2e/.auth/user.json";

let seq = 0;
// unique, stable-per-call label so tests don't collide in the shared local D1
export function uniq(prefix = "T"): string {
  seq += 1;
  return `${prefix}-${seq}-${process.pid.toString(36)}`;
}

// create a real server memo with the given body; returns its id
export async function seedMemo(request: APIRequestContext, content: string): Promise<number> {
  const create = await request.post("/api/memos");
  expect(create.ok()).toBeTruthy();
  const { id } = (await create.json()) as { id: number };
  const put = await request.put(`/api/memos/${id}`, { data: { content } });
  expect(put.ok()).toBeTruthy();
  return id;
}

// hard-delete a memo (cleanup)
export async function purge(request: APIRequestContext, id: number): Promise<void> {
  await request.delete(`/api/memos/${id}?purge=1`);
}

// land on a fresh blank "# " memo (the new-doc default) and wait until it is the
// stable current memo — avoids racing the async new-memo creation, where the old
// The editable editor is now CodeMirror (a contenteditable .cm-content made of
// per-line .cm-line divs), not a textarea — so its text can't be read with
// toHaveValue. editorText joins the rendered lines back into the document; the
// read-only trash viewer is still a real <textarea> (sel.viewer).
export async function editorText(page: Page): Promise<string> {
  return page.locator(`${sel.editor}`).evaluate((el) =>
    Array.from(el.querySelectorAll(".cm-line"))
      .map((l) => (l.textContent === "​" ? "" : l.textContent))
      .join("\n")
  );
}

// poll the editor document until it equals `expected` (the CM stand-in for
// `await expect(locator).toHaveValue(expected)`)
export async function expectEditor(page: Page, expected: string): Promise<void> {
  await expect.poll(() => editorText(page)).toBe(expected);
}

// replace the whole editor document. Focus, select-all, then insert the text in
// one insertText event (fast + multiline-safe — CM splits on the newlines).
export async function fillEditor(page: Page, text: string): Promise<void> {
  await page.locator(sel.editor).click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.insertText(text);
}

// blank memo still shows "# " before the new one becomes current
export async function blankMemo(page: Page): Promise<void> {
  await page.goto("/");
  await expectEditor(page, "# ");
  await expect(page).toHaveURL(/#\d+$/);
}

// open a specific memo by navigating to its hash and waiting for it to load
export async function openMemo(page: Page, id: number, expected?: string): Promise<void> {
  await page.goto(`/#${id}`);
  if (expected !== undefined) {
    await expectEditor(page, expected);
  } else {
    await expect(page.locator(sel.editor)).toBeVisible();
  }
}

export const sel = {
  editor: ".cm-editor .cm-content", // editable CodeMirror surface
  viewer: "textarea.editor", // read-only trash viewer (still a textarea)
  newBtn: ".topbar .new-memo",
  importBtn: ".topbar .import",
  downloadBtn: ".topbar .download",
  fileInput: 'input.file-input',
  folderInput: 'input.folder-input',
  importFolderBtn: ".topbar .import-folder",
  search: ".search",
  list: ".memo-list li",
  activeTitle: ".memo-list li.active .memo-title",
  toast: ".toast",
  themeToggle: ".topbar .theme-toggle",
};
