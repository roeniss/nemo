import { test as setup, expect } from "@playwright/test";
import { USER, PASS, AUTH_STATE } from "./helpers";

// log in once via the API and persist the auth cookie for the other projects
setup("authenticate", async ({ request }) => {
  const r = await request.post("/api/login", { data: { username: USER, password: PASS } });
  expect(r.ok()).toBeTruthy();
  await request.storageState({ path: AUTH_STATE });
});

// warm the dev server once (vite optimizes deps + builds the client bundle on the
// first page load) so the first real test isn't slow enough to flake on cold start
setup("warm up", async ({ page }) => {
  await page.goto("/");
  await page.locator("form.login, .cm-editor .cm-content").first().waitFor({ timeout: 60_000 });
});
