// @vitest-environment happy-dom
import { it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/preact";

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear(); location.hash = ""; localStorage.removeItem("qm-authed");
  globalThis.fetch = vi.fn(async () => new Response("", { status: 401 })) as any;
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){}, dispatchEvent(){return false;} })) as any;
  delete (window as any).PublicKeyCredential;
});

async function renderLogin() {
  vi.resetModules();
  const { default: App } = await import("../src/App");
  const { container } = render(<App />);
  const id = await waitFor(() => {
    const el = container.querySelector("form.login input") as HTMLInputElement;
    expect(el).toBeTruthy();
    return el;
  });
  return { container, id };
}

it("focuses the id input on the login page", async () => {
  const { id } = await renderLogin();
  await waitFor(() => expect(document.activeElement).toBe(id));
});

it("re-focuses the id input after the auto passkey prompt settles (cancel/fail)", async () => {
  // platform authenticator present → auto prompt fires; passkeyLogin's options
  // fetch 401s so it throws → .finally(refocusId). Simulate the dialog having
  // blurred the input first, then assert the retry puts the cursor back.
  (window as any).PublicKeyCredential = {
    isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true),
  };
  const { id } = await renderLogin();
  id.blur();
  expect(document.activeElement).not.toBe(id);
  await waitFor(() => expect(document.activeElement).toBe(id), { timeout: 1000 });
});

it("does not steal focus from the password field", async () => {
  (window as any).PublicKeyCredential = {
    isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true),
  };
  const { container, id } = await renderLogin();
  await waitFor(() => expect(document.activeElement).toBe(id));
  const pw = container.querySelectorAll("form.login input")[1] as HTMLInputElement;
  pw.focus();
  // let any pending refocus retries fire — the guard must leave the password alone
  await new Promise((r) => setTimeout(r, 350));
  expect(document.activeElement).toBe(pw);
});
