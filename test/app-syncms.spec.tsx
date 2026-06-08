// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// App.tsx evaluates `SYNC_MS` at MODULE TOP LEVEL:
//   const SYNC_MS = typeof window !== "undefined" && typeof window.__NEMO_SYNC_MS__ === "number"
//     ? window.__NEMO_SYNC_MS__ : 10_000;
// The sibling app specs never set the e2e seam, so they only ever cover the
// `: 10_000` arm. This file sets window.__NEMO_SYNC_MS__ to a number BEFORE a
// fresh (reset-modules) dynamic import of App, so the module init takes the
// truthy arm of that conditional expression (line 42).

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  location.hash = "";
  // a clean matchMedia so App's boot (systemDark init + the change listener) works
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  localStorage.clear();
  location.hash = "";
  delete window.__NEMO_SYNC_MS__;
});

describe("SYNC_MS e2e override seam", () => {
  it("reads window.__NEMO_SYNC_MS__ for the background-sync cadence when set to a number", async () => {
    // set the seam BEFORE importing App so the module-level const sees it
    window.__NEMO_SYNC_MS__ = 50_000;

    // a fetch stub so App's boot effect (hydrate → /memos) resolves to an authed,
    // empty list and renders the app shell without touching a real network
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method || "GET").toUpperCase();
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (url.endsWith("/api/memos") && method === "GET") return json([]);
      if (url.endsWith("/api/memos") && method === "POST")
        return json({ id: 1, title: "Untitled", updated_at: 1, content: "", created_at: 1 });
      return json({ ok: true });
    });
    globalThis.fetch = fetchImpl as unknown as typeof fetch;
    localStorage.setItem("qm-authed", "1");

    const { render, waitFor, cleanup } = await import("@testing-library/preact");
    const { default: App } = await import("../src/App");
    try {
      const { container } = render(<App />);
      // app shell rendered → the module (with the overridden SYNC_MS) initialised fine
      await waitFor(() => expect(container.querySelector(".app")).toBeTruthy());
      expect(window.__NEMO_SYNC_MS__).toBe(50_000);
    } finally {
      cleanup();
    }
  });
});
