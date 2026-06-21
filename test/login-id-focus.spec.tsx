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

it("re-focuses the id input when the window regains focus (passkey popup closed)", async () => {
  const { id } = await renderLogin();
  await waitFor(() => expect(document.activeElement).toBe(id));

  // simulate the native passkey popup having blurred the page, then closing
  id.blur();
  expect(document.activeElement).not.toBe(id);
  window.dispatchEvent(new Event("focus"));
  await waitFor(() => expect(document.activeElement).toBe(id));
});

it("does not steal focus from the password field on window focus", async () => {
  const { container, id } = await renderLogin();
  await waitFor(() => expect(document.activeElement).toBe(id));
  const pw = container.querySelectorAll("form.login input")[1] as HTMLInputElement;
  pw.focus();
  window.dispatchEvent(new Event("focus"));
  expect(document.activeElement).toBe(pw); // guard: stays in the password field
});
