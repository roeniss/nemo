// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/preact";
import { Settings } from "../src/Settings";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Handler = (path: string, method: string, body: any) => Response | Promise<Response>;
let handler: Handler;

function mockFetch() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.replace(/^.*\/api/, "");
    const method = (init?.method || "GET").toUpperCase();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    return handler(path, method, body);
  }) as unknown as typeof fetch;
}

function setClipboard(writeText: (t: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
}

beforeEach(() => mockFetch());
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("Settings — token list", () => {
  it("lists active tokens with label and usage state", async () => {
    handler = (path, method) =>
      path === "/tokens" && method === "GET"
        ? json([
            { id: 1, label: "phone", created_at: 1, last_used_at: 5 },
            { id: 2, label: "", created_at: 2, last_used_at: null },
          ])
        : json({}, 404);

    const { container } = render(<Settings flash={vi.fn()} />);
    await waitFor(() => expect(container.querySelectorAll(".token-list li").length).toBe(2));
    expect(container.textContent).toContain("phone");
    expect(container.textContent).toContain("(no label)"); // empty label fallback
    expect(container.textContent).toContain("used");
    expect(container.textContent).toContain("never used");
  });

  it("shows an empty state when there are no tokens", async () => {
    handler = () => json([]);
    const { container } = render(<Settings flash={vi.fn()} />);
    await waitFor(() => expect(container.textContent).toContain("No tokens yet"));
  });

  it("falls back to an empty list when the list request is not ok", async () => {
    handler = (path, method) =>
      path === "/tokens" && method === "GET" ? new Response("", { status: 500 }) : json({});
    const { container } = render(<Settings flash={vi.fn()} />);
    await waitFor(() => expect(container.textContent).toContain("No tokens yet"));
  });

  it("falls back to an empty list when the list request throws (offline)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    const { container } = render(<Settings flash={vi.fn()} />);
    await waitFor(() => expect(container.textContent).toContain("No tokens yet"));
  });
});

describe("Settings — generate / copy / revoke", () => {
  it("generates a token, reveals it once, copies it, and dismisses", async () => {
    handler = (path, method) => {
      if (path === "/tokens" && method === "GET") return json([]);
      if (path === "/tokens" && method === "POST")
        return json({ id: 9, label: "siri", created_at: 1, last_used_at: null, token: "nemo_secret" }, 201);
      return json({}, 404);
    };
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    const flash = vi.fn();

    const { container } = render(<Settings flash={flash} />);
    await waitFor(() => expect(container.textContent).toContain("No tokens yet"));

    fireEvent.input(container.querySelector(".token-create input")!, {
      target: { value: "siri" },
    });
    fireEvent.click(container.querySelector(".token-create button")!);

    // plaintext revealed exactly once
    await waitFor(() =>
      expect(container.querySelector(".token-value")?.textContent).toBe("nemo_secret")
    );

    const [copyBtn, doneBtn] = container.querySelectorAll(".token-reveal-actions button");
    fireEvent.click(copyBtn);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("nemo_secret"));
    expect(flash).toHaveBeenCalledWith("Token copied");

    fireEvent.click(doneBtn); // dismiss the reveal
    await waitFor(() => expect(container.querySelector(".token-reveal")).toBeFalsy());
  });

  it("flashes a fallback message when clipboard copy fails", async () => {
    handler = (path, method) => {
      if (path === "/tokens" && method === "GET") return json([]);
      if (path === "/tokens" && method === "POST")
        return json({ id: 9, label: "", created_at: 1, last_used_at: null, token: "nemo_x" }, 201);
      return json({}, 404);
    };
    setClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    const flash = vi.fn();

    const { container } = render(<Settings flash={flash} />);
    await waitFor(() => expect(container.textContent).toContain("No tokens yet"));
    fireEvent.click(container.querySelector(".token-create button")!);
    await waitFor(() => expect(container.querySelector(".token-value")).toBeTruthy());

    fireEvent.click(container.querySelector(".token-reveal-actions button")!); // Copy
    await waitFor(() =>
      expect(flash).toHaveBeenCalledWith("Copy failed — select the token and copy it manually")
    );
  });

  it("revokes a token and refreshes the list", async () => {
    let list = [{ id: 3, label: "temp", created_at: 1, last_used_at: null }];
    handler = (path, method) => {
      if (path === "/tokens" && method === "GET") return json(list);
      if (path === "/tokens/3" && method === "DELETE") {
        list = [];
        return json({ ok: true });
      }
      return json({}, 404);
    };

    const { container } = render(<Settings flash={vi.fn()} />);
    await waitFor(() => expect(container.textContent).toContain("temp"));
    fireEvent.click(container.querySelector(".token-list .del")!);
    await waitFor(() => expect(container.textContent).toContain("No tokens yet"));
  });
});
