import { test as base } from "@playwright/test";

// Slow the app's periodic background sync to effectively-never during tests, so the
// 10s timer can't re-render mid-assertion and cause rare nav/routing flakiness. The
// focus-triggered sync (used by the offline + deleted-elsewhere specs) still runs.
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.addInitScript(() => {
      (window as unknown as { __NEMO_SYNC_MS__?: number }).__NEMO_SYNC_MS__ = 600_000;
    });
    await use(page);
  },
});

export { expect } from "@playwright/test";
