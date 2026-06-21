// @vitest-environment happy-dom
import { it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/preact";

// Regression for #143: entering the homepage should land the cursor in the editor,
// including the deep-link path where boot openMemo()s a memo from a stale #hash
// (which, unlike newMemo(), never set focusOnOpen — autoFocus covers it).
function server() {
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json" } });
  return vi.fn(async (input: any, init?: RequestInit) => {
    const path = String(input).replace(/^.*\/api/, ""); const method = (init?.method || "GET").toUpperCase();
    if (path === "/me") return json({ admin: false });
    if (path === "/memos" && method === "GET") return json([{ id: 7, title: "Hi", updated_at: 1 }]);
    if (path === "/memos/7") return json({ id: 7, title: "Hi", content: "# Hi", updated_at: 1 });
    return new Response("nf", { status: 404 });
  });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("qm-authed", "1");
  location.hash = "7"; // deep-link to existing memo → boot openMemo(), not newMemo()
  globalThis.fetch = server() as any;
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){}, dispatchEvent(){return false;} })) as any;
});

it("editor is focused on entering homepage via deep-linked memo (#143)", async () => {
  vi.resetModules();
  const { default: App } = await import("../src/App");
  const { container } = render(<App />);
  const ta = await waitFor(() => {
    const el = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    expect(el).toBeTruthy();
    return el;
  });
  await waitFor(() => expect(document.activeElement).toBe(ta));
});
