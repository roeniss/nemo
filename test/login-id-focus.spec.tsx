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

it("focuses the id input on the login page", async () => {
  vi.resetModules();
  const { default: App } = await import("../src/App");
  const { container } = render(<App />);
  const id = await waitFor(() => {
    const el = container.querySelector('form.login input[placeholder="id"]') as HTMLInputElement;
    expect(el).toBeTruthy();
    return el;
  });
  await waitFor(() => expect(document.activeElement).toBe(id));
});

it("does not auto-trigger the passkey prompt on mount", async () => {
  // a platform authenticator is present, but we no longer auto-prompt — the popup
  // stole focus from the id input, so passkey login is manual-only now
  (window as any).PublicKeyCredential = {
    isUserVerifyingPlatformAuthenticatorAvailable: vi.fn(() => Promise.resolve(true)),
  };
  vi.resetModules();
  const { default: App } = await import("../src/App");
  const { container } = render(<App />);
  await waitFor(() => expect(container.querySelector("form.login")).toBeTruthy());
  await new Promise((r) => setTimeout(r, 50));
  // no passkey options request was fired automatically
  const calls = (globalThis.fetch as any).mock.calls.map((c: any[]) => String(c[0]));
  expect(calls.some((u: string) => u.includes("/passkey/auth/options"))).toBe(false);
});
