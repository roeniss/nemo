import { defineConfig, devices } from "@playwright/test";

const PORT = 5173;
const BASE = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // shared local D1 + new-doc-default creates rows, so keep tests serial/deterministic
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: "e2e/.auth/user.json" },
      dependencies: ["setup"],
    },
  ],
  webServer: {
    // apply the schema to the local D1, then boot the worker+client dev server
    command: "npm run db:local && npm run dev",
    url: BASE,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
