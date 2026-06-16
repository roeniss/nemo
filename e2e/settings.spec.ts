import { test, expect } from "./fixtures";
import { sel, uniq } from "./helpers";

test.describe("Settings — API tokens", () => {
  test("toggle navigation: open via the Settings button, close again", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(sel.editor)).toBeVisible();
    await page.click(sel.settingsBtn);
    await expect(page.locator(sel.settings)).toBeVisible();
    await expect(page.locator(".settings h2").first()).toHaveText("Keyboard shortcuts");
    // the shortcuts reference lists the documented bindings
    await expect(page.locator(".shortcut-list")).toContainText("New memo");
    await expect(page.locator(".shortcut-row")).toHaveCount(5);
    // the same button closes settings and returns to the editor
    await page.click(sel.settingsBtn);
    await expect(page.locator(sel.settings)).toBeHidden();
    await expect(page.locator(sel.editor)).toBeVisible();
  });

  test("generate a token: value is revealed once and the label appears in the list", async ({ page, request }) => {
    const label = uniq("Token");
    await page.goto("/#settings");
    await expect(page.locator(sel.settings)).toBeVisible();

    await page.fill('.token-create input', label);
    await page.click('.token-create button');

    // the plaintext token is revealed exactly once
    const reveal = page.locator(".token-reveal .token-value");
    await expect(reveal).toBeVisible();
    const tokenValue = (await reveal.textContent())?.trim() ?? "";
    expect(tokenValue.length).toBeGreaterThan(0);

    // and the labelled token shows up in the persisted list
    await expect(page.locator(`.token-list .token-label:text-is("${label}")`)).toBeVisible();

    // dismiss the reveal — it should disappear (shown once)
    await page.click('.token-reveal-actions .ghost'); // "Done"
    await expect(reveal).toBeHidden();

    // cleanup: revoke every token we can see for this label via the UI in the next test;
    // here, scrub directly through the API so the shared list stays tidy
    const list = (await (await request.get("/api/tokens")).json()) as { id: number; label: string }[];
    for (const t of list.filter((t) => t.label === label)) {
      await request.delete(`/api/tokens/${t.id}`);
    }
  });

  test("revoke a token removes it from the list", async ({ page }) => {
    const label = uniq("Revoke");
    await page.goto("/#settings");
    await expect(page.locator(sel.settings)).toBeVisible();

    await page.fill('.token-create input', label);
    await page.click('.token-create button');

    const row = page.locator(".token-list li", { hasText: label });
    await expect(row).toBeVisible();

    await row.locator("button.del").click();
    await expect(page.locator(`.token-list .token-label:text-is("${label}")`)).toHaveCount(0);
  });

  test('empty state shows "No tokens yet" when there are no tokens', async ({ page, request }) => {
    // start from a clean slate: revoke any pre-existing tokens for this session
    const existing = (await (await request.get("/api/tokens")).json()) as { id: number }[];
    for (const t of existing) await request.delete(`/api/tokens/${t.id}`);

    await page.goto("/#settings");
    await expect(page.locator(sel.settings)).toBeVisible();
    await expect(page.locator(".token-list .empty")).toHaveText("No tokens yet");
  });
});
