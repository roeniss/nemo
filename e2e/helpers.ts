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
// blank memo still shows "# " before the new one becomes current. A brand-new
// memo is a local temp until it gets content, so its hash id is negative.
export async function blankMemo(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator("textarea.editor")).toHaveValue("# ");
  await expect(page).toHaveURL(/#-?\d+$/);
}

// open a specific memo by navigating to its hash and waiting for it to load
export async function openMemo(page: Page, id: number, expected?: string): Promise<void> {
  await page.goto(`/#${id}`);
  if (expected !== undefined) {
    await expect(page.locator("textarea.editor")).toHaveValue(expected);
  } else {
    await expect(page.locator("textarea.editor")).toBeVisible();
  }
}

export const sel = {
  editor: "textarea.editor",
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
  githubLink: ".topbar .github-link",
  settingsBtn: '.topbar button[aria-label="Settings"]',
  settings: ".settings",
};
