// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/preact";
import { AdminPanel } from "../src/AdminPanel";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
let handler: Handler;

function mockFetch() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init);
  }) as unknown as typeof fetch;
}

beforeEach(() => mockFetch());
afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

const sampleUsers = [
  { id: 1, username: "alice", is_admin: 1, created_at: 1000, last_login_at: 2000 },
  { id: 2, username: "bob", is_admin: 0, created_at: 1001, last_login_at: null },
];

describe("AdminPanel — user list", () => {
  it("loads and displays users on mount", async () => {
    handler = (url) =>
      url === "/api/admin/users" ? json(sampleUsers) : json({}, 404);

    const { container } = render(<AdminPanel flash={vi.fn()} />);
    await waitFor(() => expect(container.querySelectorAll(".token-list li").length).toBe(2));
    expect(container.textContent).toContain("alice (admin)");
    expect(container.textContent).toContain("bob");
  });

  it("does not add (admin) suffix for non-admin users", async () => {
    handler = () => json([{ id: 2, username: "bob", is_admin: 0, created_at: 1, last_login_at: null }]);
    const { container } = render(<AdminPanel flash={vi.fn()} />);
    await waitFor(() => expect(container.textContent).toContain("bob"));
    expect(container.textContent).not.toContain("bob (admin)");
  });

  it("does not show delete button for admin users", async () => {
    handler = () => json([{ id: 1, username: "alice", is_admin: 1, created_at: 1, last_login_at: null }]);
    const { container } = render(<AdminPanel flash={vi.fn()} />);
    await waitFor(() => expect(container.textContent).toContain("alice (admin)"));
    const buttons = container.querySelectorAll(".token-list li button");
    const deleteButton = Array.from(buttons).find((b) => b.textContent === "삭제");
    expect(deleteButton).toBeUndefined();
  });

  it("shows delete button for non-admin users", async () => {
    handler = () => json([{ id: 2, username: "bob", is_admin: 0, created_at: 1, last_login_at: null }]);
    const { container } = render(<AdminPanel flash={vi.fn()} />);
    await waitFor(() => expect(container.textContent).toContain("bob"));
    const buttons = container.querySelectorAll(".token-list li button");
    const deleteButton = Array.from(buttons).find((b) => b.textContent === "삭제");
    expect(deleteButton).toBeTruthy();
  });
});

describe("AdminPanel — create user", () => {
  it("creates a user and refreshes the list", async () => {
    let users = [...sampleUsers];
    handler = (url, init) => {
      if (url === "/api/admin/users" && (!init?.method || init.method === "GET")) return json(users);
      if (url === "/api/admin/users" && init?.method === "POST") {
        const body = JSON.parse(init.body as string);
        users = [...users, { id: 3, username: body.username, is_admin: 0, created_at: 2000, last_login_at: null }];
        return json({ id: 3 }, 201);
      }
      return json({}, 404);
    };

    const flash = vi.fn();
    const { container } = render(<AdminPanel flash={flash} />);
    await waitFor(() => expect(container.querySelectorAll(".token-list li").length).toBe(2));

    fireEvent.input(container.querySelector('input[placeholder="username"]')!, { target: { value: "carol" } });
    fireEvent.input(container.querySelector('input[placeholder="password"]')!, { target: { value: "pass123" } });
    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => expect(flash).toHaveBeenCalledWith("유저 생성됨"));
    await waitFor(() => expect(container.querySelectorAll(".token-list li").length).toBe(3));
  });

  it("flashes an error when create fails", async () => {
    handler = (url, init) => {
      if (url === "/api/admin/users" && (!init?.method || init.method === "GET")) return json([]);
      if (url === "/api/admin/users" && init?.method === "POST") return json({ error: "이미 존재함" }, 409);
      return json({}, 404);
    };

    const flash = vi.fn();
    const { container } = render(<AdminPanel flash={flash} />);
    await waitFor(() => expect(container.querySelector("form")).toBeTruthy());

    fireEvent.input(container.querySelector('input[placeholder="username"]')!, { target: { value: "dup" } });
    fireEvent.input(container.querySelector('input[placeholder="password"]')!, { target: { value: "pw" } });
    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => expect(flash).toHaveBeenCalledWith("이미 존재함"));
  });

  it("flashes generic error when create fails with no error field", async () => {
    handler = (url, init) => {
      if (url === "/api/admin/users" && (!init?.method || init.method === "GET")) return json([]);
      if (url === "/api/admin/users" && init?.method === "POST") return json({}, 500);
      return json({}, 404);
    };

    const flash = vi.fn();
    const { container } = render(<AdminPanel flash={flash} />);
    await waitFor(() => expect(container.querySelector("form")).toBeTruthy());

    fireEvent.input(container.querySelector('input[placeholder="username"]')!, { target: { value: "x" } });
    fireEvent.input(container.querySelector('input[placeholder="password"]')!, { target: { value: "y" } });
    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => expect(flash).toHaveBeenCalledWith("오류"));
  });
});

describe("AdminPanel — delete user", () => {
  it("deletes a non-admin user and refreshes the list", async () => {
    let users = [{ id: 2, username: "bob", is_admin: 0, created_at: 1, last_login_at: null }];
    handler = (url, init) => {
      if (url === "/api/admin/users") return json(users);
      if (url === "/api/admin/users/2" && init?.method === "DELETE") {
        users = [];
        return json({ ok: true });
      }
      return json({}, 404);
    };

    const { container } = render(<AdminPanel flash={vi.fn()} />);
    await waitFor(() => expect(container.textContent).toContain("bob"));

    const deleteBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "삭제")!;
    fireEvent.click(deleteBtn);

    await waitFor(() => expect(container.querySelectorAll(".token-list li").length).toBe(0));
  });
});

describe("AdminPanel — reset password", () => {
  it("resets password when prompt is confirmed", async () => {
    handler = (url, init) => {
      if (url === "/api/admin/users") return json([{ id: 2, username: "bob", is_admin: 0, created_at: 1, last_login_at: null }]);
      if (url === "/api/admin/users/2/password" && init?.method === "PATCH") return json({ ok: true });
      return json({}, 404);
    };
    window.prompt = vi.fn().mockReturnValue("newpass");
    const flash = vi.fn();

    const { container } = render(<AdminPanel flash={flash} />);
    await waitFor(() => expect(container.textContent).toContain("bob"));

    const resetBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "비밀번호 변경")!;
    fireEvent.click(resetBtn);

    await waitFor(() => expect(flash).toHaveBeenCalledWith("비밀번호 변경됨"));
  });

  it("does nothing when prompt is cancelled", async () => {
    handler = () => json([{ id: 2, username: "bob", is_admin: 0, created_at: 1, last_login_at: null }]);
    window.prompt = vi.fn().mockReturnValue(null);
    const flash = vi.fn();

    const { container } = render(<AdminPanel flash={flash} />);
    await waitFor(() => expect(container.textContent).toContain("bob"));

    const resetBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "비밀번호 변경")!;
    fireEvent.click(resetBtn);

    // flash should not be called
    await new Promise((r) => setTimeout(r, 50));
    expect(flash).not.toHaveBeenCalled();
  });
});
