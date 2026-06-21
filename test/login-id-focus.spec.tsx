// @vitest-environment happy-dom
import { it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/preact";

// boot /api/memos 401 → <Login/> renders. Assert the id input is focused on mount.
beforeEach(() => {
  localStorage.clear(); location.hash = ""; localStorage.removeItem("qm-authed");
  globalThis.fetch = vi.fn(async () => new Response("", { status: 401 })) as any;
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){}, dispatchEvent(){return false;} })) as any;
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
