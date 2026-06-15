import { test, expect } from "./fixtures";
import { sel, seedMemo, purge, uniq } from "./helpers";

test.describe("per-memo URL routing", () => {
  test("a fresh visit defaults to a new blank document", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(sel.editor)).toHaveValue("# ");
    await expect(page).toHaveURL(/#-?\d+$/); // a fresh blank memo is a local temp (negative id)
  });

  test("opening a memo reflects its id in the URL hash", async ({ page, request }) => {
    const title = uniq("Route");
    const id = await seedMemo(request, `# ${title}\n\nbody`);
    try {
      await page.goto("/");
      await page.reload(); // pick up the seeded memo in the list
      await page.locator(`.memo-title:text-is("${title}")`).click();
      await expect(page).toHaveURL(new RegExp(`#${id}$`));
      await expect(page.locator(sel.editor)).toHaveValue(`# ${title}\n\nbody`);
    } finally {
      await purge(request, id);
    }
  });

  test("reloading a memo URL reopens that exact memo (not new-doc default)", async ({ page, request }) => {
    const title = uniq("Reload");
    const id = await seedMemo(request, `# ${title}\n\nkeep me`);
    try {
      await page.goto(`/#${id}`);
      await expect(page.locator(sel.editor)).toHaveValue(`# ${title}\n\nkeep me`);
      await page.reload();
      await expect(page).toHaveURL(new RegExp(`#${id}$`));
      await expect(page.locator(sel.editor)).toHaveValue(`# ${title}\n\nkeep me`);
    } finally {
      await purge(request, id);
    }
  });

  test("back/forward navigates between memos", async ({ page, request }) => {
    const a = uniq("BackA");
    const b = uniq("BackB");
    const idA = await seedMemo(request, `# ${a}\n\naaa`);
    const idB = await seedMemo(request, `# ${b}\n\nbbb`);
    // wait for the hash to register (hashchange → openMemo) before the content
    const at = async (id: number, title: string, body: string) => {
      await expect(page).toHaveURL(new RegExp(`#${id}$`));
      await expect(page.locator(sel.editor)).toHaveValue(`# ${title}\n\n${body}`);
    };
    try {
      await page.goto(`/#${idA}`);
      await at(idA, a, "aaa");
      // navigate to B via its hash (pushes history)
      await page.locator(`.memo-title:text-is("${b}")`).click();
      await at(idB, b, "bbb");

      await page.goBack();
      await at(idA, a, "aaa");
      await page.goForward();
      await at(idB, b, "bbb");
    } finally {
      await purge(request, idA);
      await purge(request, idB);
    }
  });
});

test.describe("named-view URL routing (#settings / #trash)", () => {
  test("direct navigation to /#settings shows the settings view", async ({ page }) => {
    await page.goto("/#settings");
    await expect(page.locator(sel.settings)).toBeVisible();
    await expect(page).toHaveURL(/#settings$/);
  });

  test("direct navigation to /#trash shows the trash view", async ({ page }) => {
    await page.goto("/#trash");
    // the trash tab becomes active and the trash list renders (empty or not)
    await expect(page.locator(".side-tabs .tab.active")).toHaveText("Trash");
    await expect(page).toHaveURL(/#trash$/);
  });

  test("the Settings button sets #settings; clicking again clears it", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(sel.editor)).toBeVisible();
    await page.click(sel.settingsBtn);
    await expect(page.locator(sel.settings)).toBeVisible();
    await expect(page).toHaveURL(/#settings$/);
    // toggling off returns to the memos view and drops the named hash
    await page.click(sel.settingsBtn);
    await expect(page.locator(sel.settings)).toBeHidden();
    await expect(page).not.toHaveURL(/#settings$/);
  });

  test("reloading on /#settings stays on settings", async ({ page }) => {
    await page.goto("/#settings");
    await expect(page.locator(sel.settings)).toBeVisible();
    await page.reload();
    await expect(page.locator(sel.settings)).toBeVisible();
    await expect(page).toHaveURL(/#settings$/);
  });

  test("back/forward between #trash and #settings named views", async ({ page }) => {
    await page.goto("/#trash");
    await expect(page.locator(".side-tabs .tab.active")).toHaveText("Trash");
    await expect(page).toHaveURL(/#trash$/);

    // navigate to settings (pushes a history entry)
    await page.goto("/#settings");
    await expect(page.locator(sel.settings)).toBeVisible();
    await expect(page).toHaveURL(/#settings$/);

    // back → trash view
    await page.goBack();
    await expect(page).toHaveURL(/#trash$/);
    await expect(page.locator(sel.settings)).toBeHidden();
    await expect(page.locator(".side-tabs .tab.active")).toHaveText("Trash");

    // forward → settings view
    await page.goForward();
    await expect(page).toHaveURL(/#settings$/);
    await expect(page.locator(sel.settings)).toBeVisible();
  });
});
