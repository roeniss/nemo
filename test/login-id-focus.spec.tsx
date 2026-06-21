// @vitest-environment happy-dom
import { it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/preact";

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
    const el = container.querySelector("form.login input") as HTMLInputElement;
    expect(el).toBeTruthy();
    return el;
  });
  await waitFor(() => expect(document.activeElement).toBe(id));
});

it("re-focuses the id input after a cancelled auto passkey prompt", async () => {
  // platform authenticator present → auto prompt fires; passkeyLogin's options
  // fetch 401s (see beforeEach) so it throws and settles via .catch → .finally,
  // mirroring a cancelled prompt → focus must return to the id input
  (window as any).PublicKeyCredential = {
    isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true),
  };

  vi.resetModules();
  const { default: App } = await import("../src/App");
  const { container } = render(<App />);
  const id = await waitFor(() => {
    const el = container.querySelector("form.login input") as HTMLInputElement;
    expect(el).toBeTruthy();
    return el;
  });
  await waitFor(() => expect(document.activeElement).toBe(id));
});
