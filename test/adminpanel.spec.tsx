// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor, screen } from "@testing-library/preact";
import { AdminPanel } from "../src/AdminPanel";

afterEach(cleanup);

type User = {
  id: number;
  username: string;
  is_admin: number;
  created_at: number;
  last_login_at: number | null;
};

const admin: User = { id: 1, username: "root", is_admin: 1, created_at: 0, last_login_at: null };
const plain: User = { id: 2, username: "alice", is_admin: 0, created_at: 0, last_login_at: 1 };

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Mutable fetch handler so individual tests can tailor responses per-call.
let handler: (url: string, init?: RequestInit) => Promise<Response>;

beforeEach(() => {
  // default: GET /admin/users returns [admin, plain]
  handler = async (url) => {
    if (url === "/api/admin/users") return jsonRes([admin, plain]);
    return jsonRes({}, 404);
  };
  globalThis.fetch = vi.fn((url: any, init?: any) => handler(String(url), init)) as any;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AdminPanel", () => {
  it("loads users on mount and renders admin + non-admin rows", async () => {
    const { container } = render(<AdminPanel />);
    await screen.findByText("alice");
    // admin row shows the "(admin)" suffix (split text node)
    expect(container.textContent).toContain("root");
    expect(container.textContent).toContain("(admin)");
    // non-admin row has the two action buttons; admin row has none
    expect(screen.getByText("삭제")).toBeTruthy();
    expect(screen.getByText("비밀번호 재설정")).toBeTruthy();
  });

  it("does not update list when GET /admin/users fails", async () => {
    handler = async (url) => {
      if (url === "/api/admin/users") return jsonRes({}, 403);
      return jsonRes({}, 404);
    };
    render(<AdminPanel />);
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(screen.queryByText("alice")).toBeNull();
  });

  it("createUser: success clears inputs, shows 'User created', reloads", async () => {
    let getCalls = 0;
    handler = async (url, init) => {
      if (url === "/api/admin/users" && init?.method === "POST") return jsonRes({ ok: true });
      if (url === "/api/admin/users") {
        getCalls += 1;
        return jsonRes([admin]);
      }
      return jsonRes({}, 404);
    };
    render(<AdminPanel />);
    await waitFor(() => expect(getCalls).toBe(1));

    const username = screen.getByPlaceholderText("username") as HTMLInputElement;
    const password = screen.getByPlaceholderText("password") as HTMLInputElement;
    fireEvent.input(username, { target: { value: "bob" } });
    fireEvent.input(password, { target: { value: "pw" } });
    fireEvent.click(screen.getByText("추가"));

    await screen.findByText("User created");
    expect(username.value).toBe("");
    expect(password.value).toBe("");
    // load() called again after create
    await waitFor(() => expect(getCalls).toBe(2));
  });

  it("createUser: failure with error field shows that error", async () => {
    handler = async (url, init) => {
      if (url === "/api/admin/users" && init?.method === "POST")
        return jsonRes({ error: "taken" }, 409);
      if (url === "/api/admin/users") return jsonRes([]);
      return jsonRes({}, 404);
    };
    render(<AdminPanel />);
    fireEvent.click(await screen.findByText("추가"));
    await screen.findByText("taken");
  });

  it("createUser: failure without error field falls back to 'error'", async () => {
    handler = async (url, init) => {
      if (url === "/api/admin/users" && init?.method === "POST") return jsonRes({}, 500);
      if (url === "/api/admin/users") return jsonRes([]);
      return jsonRes({}, 404);
    };
    render(<AdminPanel />);
    fireEvent.click(await screen.findByText("추가"));
    await screen.findByText("error");
  });

  it("deleteUser: confirms then DELETEs and reloads", async () => {
    const calls: Array<[string, string | undefined]> = [];
    handler = async (url, init) => {
      calls.push([url, init?.method]);
      if (url === "/api/admin/users") return jsonRes([admin, plain]);
      return jsonRes({ ok: true });
    };
    globalThis.confirm = vi.fn(() => true) as any;
    render(<AdminPanel />);
    fireEvent.click(await screen.findByText("삭제"));
    await waitFor(() =>
      expect(calls).toContainEqual(["/api/admin/users/2", "DELETE"]),
    );
  });

  it("deleteUser: cancel aborts the request", async () => {
    const calls: Array<[string, string | undefined]> = [];
    handler = async (url, init) => {
      calls.push([url, init?.method]);
      return jsonRes([admin, plain]);
    };
    globalThis.confirm = vi.fn(() => false) as any;
    render(<AdminPanel />);
    fireEvent.click(await screen.findByText("삭제"));
    expect(calls.some((c) => c[1] === "DELETE")).toBe(false);
  });

  it("resetPassword: with a password PATCHes and shows 'Password reset'", async () => {
    const calls: Array<[string, string | undefined]> = [];
    handler = async (url, init) => {
      calls.push([url, init?.method]);
      return jsonRes([admin, plain]);
    };
    globalThis.prompt = vi.fn(() => "newpw") as any;
    render(<AdminPanel />);
    fireEvent.click(await screen.findByText("비밀번호 재설정"));
    await waitFor(() =>
      expect(calls).toContainEqual(["/api/admin/users/2/password", "PATCH"]),
    );
    await screen.findByText("Password reset");
  });

  it("resetPassword: cancel (empty prompt) does nothing", async () => {
    const calls: Array<[string, string | undefined]> = [];
    handler = async (url, init) => {
      calls.push([url, init?.method]);
      return jsonRes([admin, plain]);
    };
    globalThis.prompt = vi.fn(() => null) as any;
    render(<AdminPanel />);
    fireEvent.click(await screen.findByText("비밀번호 재설정"));
    expect(calls.some((c) => c[1] === "PATCH")).toBe(false);
  });
});
