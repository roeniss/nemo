// @vitest-environment happy-dom
// Tests for WebAuthn conditional UI (passkey autofill) on the login screen.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/preact";

// Mock @simplewebauthn/browser so we can spy on startAuthentication
vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
}));
import { startAuthentication } from "@simplewebauthn/browser";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeServer(opts: {
  passkeyOptionsStatus?: number;
  passkeyVerifyStatus?: number;
  startAuthShouldThrow?: Error | null;
} = {}) {
  const authed = { value: false };
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method || "GET").toUpperCase();
    const path = url.replace(/^.*\/api/, "");

    if (path === "/memos" && method === "GET") {
      if (!authed.value) return new Response("", { status: 401 });
      return json([]);
    }
    if (path === "/memos" && method === "POST") return json({ id: 1, title: "Untitled", updated_at: 1 });
    if (path === "/passkey/auth/options" && method === "POST") {
      const status = opts.passkeyOptionsStatus ?? 200;
      if (status !== 200) return new Response("", { status });
      return json({ challenge: "test-challenge", allowCredentials: [] });
    }
    if (path === "/passkey/auth/verify" && method === "POST") {
      const status = opts.passkeyVerifyStatus ?? 200;
      if (status !== 200) return new Response("", { status });
      authed.value = true;
      return json({ ok: true });
    }
    if (path === "/login" && method === "POST") return json({ ok: true });
    if (path === "/logout" && method === "POST") return json({ ok: true });
    return new Response("not found", { status: 404 });
  });
  return { fetchImpl, authed };
}

beforeEach(() => {
  localStorage.clear();
  location.hash = "";
  localStorage.removeItem("qm-authed");
  vi.mocked(startAuthentication).mockReset();

  // default: a platform authenticator is available, so the mount effect proceeds
  // to the immediate passkey prompt. Individual tests override this.
  (window as unknown as { PublicKeyCredential: unknown }).PublicKeyCredential = {
    isUserVerifyingPlatformAuthenticatorAvailable: vi.fn().mockResolvedValue(true),
  };

  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false; },
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  location.hash = "";
});

describe("passkey conditional UI", () => {
  it("calls startAuthentication without useBrowserAutofill on login mount (immediate popup)", async () => {
    vi.mocked(startAuthentication).mockRejectedValue(
      Object.assign(new Error("NotAllowedError"), { name: "NotAllowedError" })
    );
    const { fetchImpl } = makeServer();
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    const { default: App } = await import("../src/App");
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".login")).toBeTruthy());

    // Wait for the immediate passkey call to fire
    await waitFor(() => {
      const calls = fetchImpl.mock.calls.filter(
        (c) => String(c[0]).includes("/passkey/auth/options")
      );
      expect(calls.length).toBeGreaterThan(0);
    });

    await waitFor(() => {
      expect(vi.mocked(startAuthentication)).toHaveBeenCalledWith(
        expect.not.objectContaining({ useBrowserAutofill: true })
      );
    });
  });

  it("does NOT auto-prompt when no platform authenticator is available", async () => {
    (window as unknown as { PublicKeyCredential: unknown }).PublicKeyCredential = {
      isUserVerifyingPlatformAuthenticatorAvailable: vi.fn().mockResolvedValue(false),
    };
    const { fetchImpl } = makeServer();
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    const { default: App } = await import("../src/App");
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".login")).toBeTruthy());

    // give any (unwanted) async prompt a chance to fire, then assert it didn't
    await new Promise((r) => setTimeout(r, 10));
    expect(vi.mocked(startAuthentication)).not.toHaveBeenCalled();
    expect(
      fetchImpl.mock.calls.filter((c) => String(c[0]).includes("/passkey/auth/options"))
    ).toHaveLength(0);
  });

  it("does NOT auto-prompt when WebAuthn is unsupported (no PublicKeyCredential)", async () => {
    delete (window as unknown as { PublicKeyCredential?: unknown }).PublicKeyCredential;
    const { fetchImpl } = makeServer();
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    const { default: App } = await import("../src/App");
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".login")).toBeTruthy());

    await new Promise((r) => setTimeout(r, 10));
    expect(vi.mocked(startAuthentication)).not.toHaveBeenCalled();
  });

  it("silently swallows NotAllowedError (user cancelled) and keeps login form usable", async () => {
    vi.mocked(startAuthentication).mockRejectedValue(
      Object.assign(new Error("NotAllowedError"), { name: "NotAllowedError" })
    );
    const { fetchImpl } = makeServer();
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    const { default: App } = await import("../src/App");
    const { container } = render(<App />);

    await waitFor(() => expect(container.querySelector(".login")).toBeTruthy());

    // Login form should still be present and no error message shown
    expect(container.querySelector(".login")).toBeTruthy();
    expect(container.querySelector(".err")).toBeFalsy();
  });

  it("silently swallows when passkey/auth/options returns non-ok", async () => {
    vi.mocked(startAuthentication).mockResolvedValue({} as any);
    const { fetchImpl } = makeServer({ passkeyOptionsStatus: 404 });
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    const { default: App } = await import("../src/App");
    const { container } = render(<App />);

    await waitFor(() => expect(container.querySelector(".login")).toBeTruthy());
    // No error shown; startAuthentication should not have been called
    expect(container.querySelector(".err")).toBeFalsy();
  });

  it("completes login when conditional UI succeeds (passkey available and chosen)", async () => {
    vi.mocked(startAuthentication).mockResolvedValue({ id: "cred-id" } as any);
    const { fetchImpl, authed } = makeServer();
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    const { default: App } = await import("../src/App");
    const { container } = render(<App />);

    await waitFor(() => expect(container.querySelector(".login")).toBeTruthy());

    // After the conditional UI flow completes, the app should be in authed state
    await waitFor(() => {
      expect(authed.value).toBe(true);
    });
    await waitFor(() => {
      expect(container.querySelector(".app")).toBeTruthy();
    });
  });

  it("username input has autocomplete='username webauthn'", async () => {
    vi.mocked(startAuthentication).mockRejectedValue(new Error("no passkeys"));
    const { fetchImpl } = makeServer();
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    const { default: App } = await import("../src/App");
    const { container } = render(<App />);

    await waitFor(() => expect(container.querySelector(".login")).toBeTruthy());

    const usernameInput = container.querySelector("input:not([type='password'])") as HTMLInputElement;
    expect(usernameInput).toBeTruthy();
    expect(usernameInput.getAttribute("autocomplete")).toBe("username webauthn");
  });

  it("shows an error when passkey verify returns non-ok", async () => {
    // conditional UI is rejected first; the manual button click then resolves
    // startAuthentication but the verify endpoint fails → passkeyLogin throws.
    vi.mocked(startAuthentication)
      .mockRejectedValueOnce(Object.assign(new Error("NotAllowedError"), { name: "NotAllowedError" }))
      .mockResolvedValueOnce({ id: "cred-id" } as any);

    const { fetchImpl } = makeServer({ passkeyVerifyStatus: 401 });
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    const { default: App } = await import("../src/App");
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".login")).toBeTruthy());
    await waitFor(() => expect(vi.mocked(startAuthentication)).toHaveBeenCalled());

    const passkeyBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Passkey")
    )!;
    passkeyBtn.click();

    await waitFor(() =>
      expect(container.querySelector(".err")?.textContent).toContain("Passkey login failed")
    );
  });

  it("passkey button still works as manual fallback", async () => {
    // conditional UI is silently rejected (no passkeys)
    vi.mocked(startAuthentication)
      .mockRejectedValueOnce(Object.assign(new Error("NotAllowedError"), { name: "NotAllowedError" }))
      // button click uses the manual flow (without useBrowserAutofill)
      .mockResolvedValueOnce({ id: "cred-id" } as any);

    const { fetchImpl, authed } = makeServer();
    globalThis.fetch = fetchImpl as unknown as typeof fetch;

    const { default: App } = await import("../src/App");
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".login")).toBeTruthy());

    // Wait for the conditional UI call to settle first
    await waitFor(() => expect(vi.mocked(startAuthentication)).toHaveBeenCalled());

    // Now click the passkey button
    const passkeyBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Passkey")
    );
    expect(passkeyBtn).toBeTruthy();
    passkeyBtn!.click();

    await waitFor(() => expect(authed.value).toBe(true));
    await waitFor(() => expect(container.querySelector(".app")).toBeTruthy());
  });
});
