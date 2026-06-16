import { test, expect } from "./fixtures";
import { sel, uniq } from "./helpers";

// the shared auth state belongs to the seeded CI user, which is an admin —
// so these tests (except the non-admin one) run as that admin session.
test.describe("Admin panel", () => {
  test("an admin session sees the Admin: Users section in settings", async ({ page }) => {
    await page.goto("/#settings");
    await expect(page.locator(sel.settings)).toBeVisible();
    await expect(page.locator('.settings h2:text-is("Admin: Users")')).toBeVisible();
  });

  test("create a new user → it appears in the user list", async ({ page, request }) => {
    const username = uniq("user").toLowerCase();
    await page.goto("/#settings");
    await expect(page.locator('.settings h2:text-is("Admin: Users")')).toBeVisible();

    // the admin's create-user form is the last .token-create on the page
    const form = page.locator(".token-create").last();
    await form.locator('input[placeholder="username"]').fill(username);
    await form.locator('input[placeholder="password"]').fill("pw-12345678");
    await form.locator('button:text-is("추가")').click();

    await expect(page.locator(`.token-label:has-text("${username}")`)).toBeVisible();

    // cleanup
    const users = (await (await request.get("/api/admin/users")).json()) as { id: number; username: string }[];
    const created = users.find((u) => u.username === username);
    if (created) await request.delete(`/api/admin/users/${created.id}`);
  });

  test("delete a user (auto-accepting the confirm dialog) removes it", async ({ page, request }) => {
    // seed a user to delete via the API
    const username = uniq("del").toLowerCase();
    const res = await request.post("/api/admin/users", { data: { username, password: "pw-12345678" } });
    expect(res.ok()).toBeTruthy();

    page.on("dialog", (d) => d.accept());

    await page.goto("/#settings");
    const row = page.locator(".token-list li", { hasText: username });
    await expect(row).toBeVisible();

    await row.locator('button:text-is("삭제")').click();
    await expect(page.locator(`.token-label:has-text("${username}")`)).toHaveCount(0);
  });

  test("reset a user's password (handling the prompt dialog)", async ({ page, request }) => {
    const username = uniq("reset").toLowerCase();
    const res = await request.post("/api/admin/users", { data: { username, password: "pw-original" } });
    expect(res.ok()).toBeTruthy();
    const { id } = (await res.json()) as { id: number };

    const newPw = "pw-changed-9999";
    page.on("dialog", (d) => d.accept(newPw)); // window.prompt returns the new password

    await page.goto("/#settings");
    const row = page.locator(".token-list li", { hasText: username });
    await expect(row).toBeVisible();
    await row.locator('button:text-is("비밀번호 재설정")').click();

    // the panel confirms the reset
    await expect(page.locator('.settings .muted:text-is("Password reset")')).toBeVisible();

    // verify the new password actually logs in
    const login = await request.post("/api/login", { data: { username, password: newPw } });
    expect(login.ok()).toBeTruthy();

    await request.delete(`/api/admin/users/${id}`);
  });

  test("a non-admin user does NOT see the admin panel", async ({ browser, request }) => {
    const username = uniq("plain").toLowerCase();
    const password = "pw-12345678";
    const res = await request.post("/api/admin/users", { data: { username, password } });
    expect(res.ok()).toBeTruthy();
    const { id } = (await res.json()) as { id: number };

    // a fresh, unauthenticated context (ignore the shared admin auth state)
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const page = await context.newPage();
      await page.addInitScript(() => {
        (window as unknown as { __NEMO_SYNC_MS__?: number }).__NEMO_SYNC_MS__ = 600_000;
      });
      await page.goto("/");
      await page.fill('input[placeholder="id"]', username);
      await page.fill('input[placeholder="password"]', password);
      await page.click('button[type="submit"]');
      await expect(page.locator(sel.editor)).toBeVisible();

      await page.goto("/#settings");
      await expect(page.locator(sel.settings)).toBeVisible();
      await expect(page.locator('.settings h2:text-is("API tokens")')).toBeVisible();
      // the admin section must not render for a non-admin session
      await expect(page.locator('.settings h2:text-is("Admin: Users")')).toHaveCount(0);
    } finally {
      await context.close();
      await request.delete(`/api/admin/users/${id}`);
    }
  });
});
