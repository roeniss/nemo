import { test, expect } from "./fixtures";
import { blankMemo, sel } from "./helpers";

test.describe("github link", () => {
  test("shows a GitHub icon linking to the repo's pull-requests page", async ({ page }) => {
    await blankMemo(page);

    const link = page.locator(sel.githubLink);
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", "https://github.com/roeniss/nemo/pulls");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);

    // an inline SVG icon, sitting right next to the colour/theme toggle
    await expect(link.locator("svg")).toBeVisible();
    await expect(page.locator(`${sel.themeToggle} + .github-link`)).toHaveCount(1);
  });
});
