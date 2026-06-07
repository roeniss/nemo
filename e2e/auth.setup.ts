import { test as setup, expect } from "@playwright/test";
import { USER, PASS, AUTH_STATE } from "./helpers";

// log in once via the API and persist the auth cookie for the other projects
setup("authenticate", async ({ request }) => {
  const r = await request.post("/api/login", { data: { username: USER, password: PASS } });
  expect(r.ok()).toBeTruthy();
  await request.storageState({ path: AUTH_STATE });
});
