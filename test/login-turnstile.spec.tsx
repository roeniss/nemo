// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup, act } from "@testing-library/preact";

// ---------------------------------------------------------------------------
// These tests cover the Cloudflare Turnstile branch of <Login/>, which is dead
// in the normal test build because TURNSTILE_SITEKEY reads "" from
// import.meta.env at module load. We stub the env to a non-empty value and
// re-import App (vi.resetModules) so the const re-evaluates truthy, then mock
// window.turnstile so the widget effect runs.
// ---------------------------------------------------------------------------

// Minimal fake server: boot /api/memos returns 401 so <Login/> renders; /api/login
// status is configurable so submit() can take the success or failure path.
function makeServer() {
  // once login succeeds the app flips this so the follow-up /memos GET (and the
  // POST that newMemo() fires) behave like an authed session instead of 401ing.
  const opts = { loginStatus: 401, authed: false };
  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method || "GET").toUpperCase();
    const path = url.replace(/^.*\/api/, "");

    if (path === "/login" && method === "POST") {
      if (opts.loginStatus !== 200) return new Response("", { status: opts.loginStatus });
      opts.authed = true;
      return json({ ok: true });
    }
    if (path === "/memos" && method === "GET") {
      if (!opts.authed) return new Response("", { status: 401 });
      return json([]);
    }
    if (path === "/memos" && method === "POST") {
      // newMemo() after a successful login
      return json({ id: 1, title: "Untitled", updated_at: 1 });
    }
    return new Response("not found", { status: 404 });
  });
  return { opts, fetchImpl };
}

let server: ReturnType<typeof makeServer>;

// Load App with the sitekey stubbed truthy so the widget branch is live.
async function importApp() {
  vi.stubEnv("VITE_TURNSTILE_SITEKEY", "test-sitekey");
  vi.resetModules();
  const { default: App } = await import("../src/App");
  return App;
}

beforeEach(() => {
  localStorage.clear();
  location.hash = "";
  // not authed → boot 401 keeps authed false → <Login/> renders
  localStorage.removeItem("qm-authed");
  server = makeServer();
  globalThis.fetch = server.fetchImpl as unknown as typeof fetch;

  // clean matchMedia (some happy-dom versions lack addEventListener)
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

  // start each test with no injected script / no global turnstile
  delete (window as any).turnstile;
  delete (window as any).__cfTurnstileOnload;
  document.getElementById("cf-turnstile-script")?.remove();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
  cleanup();
  localStorage.clear();
  location.hash = "";
  delete (window as any).turnstile;
  delete (window as any).__cfTurnstileOnload;
  document.getElementById("cf-turnstile-script")?.remove();
});

describe("Login Turnstile", () => {
  it("renders the widget immediately when window.turnstile already exists at mount", async () => {
    const render2 = vi.fn();
    (window as any).turnstile = { render: render2, reset: vi.fn() };

    const App = await importApp();
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".login")).toBeTruthy());

    // TURNSTILE_SITEKEY is truthy → the widget div is in the DOM
    const widgetEl = container.querySelector(".turnstile");
    expect(widgetEl).toBeTruthy();

    await waitFor(() => expect(render2).toHaveBeenCalledTimes(1));
    const [el, optsArg] = render2.mock.calls[0];
    expect(el).toBe(widgetEl);
    expect(optsArg.sitekey).toBe("test-sitekey");
    expect(typeof optsArg.callback).toBe("function");
  });

  it("injects the script when window.turnstile is not defined, then renders on script load", async () => {
    // Note: happy-dom prints a benign "JavaScript file loading is disabled"
    // DOMException to stderr when the real cross-origin <script src> connects to
    // the document. It is not thrown and does not fail/affect any assertion below
    // (the append still happens and is asserted); it's just console noise.

    // no window.turnstile at mount
    const App = await importApp();
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".login")).toBeTruthy());

    // script appended to head + onload global wired up
    await waitFor(() => {
      expect(document.getElementById("cf-turnstile-script")).toBeTruthy();
    });
    const script = document.getElementById("cf-turnstile-script") as HTMLScriptElement;
    expect(script.tagName).toBe("SCRIPT");
    expect(script.getAttribute("src")).toContain("challenges.cloudflare.com");
    expect(script.getAttribute("src")).toContain("onload=__cfTurnstileOnload");
    expect(typeof window.__cfTurnstileOnload).toBe("function");

    // simulate the CF script loading: define turnstile then fire onload
    const render2 = vi.fn();
    (window as any).turnstile = { render: render2, reset: vi.fn() };
    await act(async () => {
      window.__cfTurnstileOnload!();
    });

    const widgetEl = container.querySelector(".turnstile");
    expect(render2).toHaveBeenCalledTimes(1);
    expect(render2.mock.calls[0][0]).toBe(widgetEl);
    expect(render2.mock.calls[0][1].sitekey).toBe("test-sitekey");
  });

  it("does not append the script twice when it is already present", async () => {
    // pre-insert the script so the guard skips appending a new one
    const pre = document.createElement("script");
    pre.id = "cf-turnstile-script";
    document.head.appendChild(pre);

    const App = await importApp();
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".login")).toBeTruthy());

    // still exactly one script with that id (the pre-inserted one)
    expect(document.querySelectorAll("#cf-turnstile-script").length).toBe(1);
    // the onload global was still wired up even though no new script was added
    expect(typeof window.__cfTurnstileOnload).toBe("function");
  });

  it("calls turnstile.reset and clears the token on a failed login", async () => {
    const reset = vi.fn();
    let captured: ((t: string) => void) | undefined;
    const render2 = vi.fn((_el: HTMLElement, optsArg: { callback: (t: string) => void }) => {
      captured = optsArg.callback;
    });
    (window as any).turnstile = { render: render2, reset };

    server.opts.loginStatus = 401; // submit takes the failure path

    const App = await importApp();
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".login")).toBeTruthy());
    await waitFor(() => expect(captured).toBeTruthy());

    const widgetEl = container.querySelector(".turnstile");

    // deliver a token via the Turnstile callback
    await act(async () => {
      captured!("tok-123");
    });

    const inputs = container.querySelectorAll("input");
    fireEvent.input(inputs[0], { target: { value: "user" } });
    fireEvent.input(inputs[1], { target: { value: "wrong" } });
    fireEvent.submit(container.querySelector("form.login")!);

    // failure path: error renders + reset(widget.current) called + token cleared
    await waitFor(() =>
      expect(container.querySelector(".err")?.textContent).toContain("Invalid username or password")
    );
    await waitFor(() => expect(reset).toHaveBeenCalledTimes(1));
    expect(reset.mock.calls[0][0]).toBe(widgetEl);

    // assert the token was actually passed to onLogin (proves the callback wired it)
    const loginCall = server.fetchImpl.mock.calls.find(
      (c) => String(c[0]).includes("/login") && (c[1] as RequestInit)?.method === "POST"
    )!;
    expect(JSON.parse((loginCall[1] as RequestInit).body as string).turnstileToken).toBe("tok-123");
  });

  it("returns early (no reset) on a successful login", async () => {
    const reset = vi.fn();
    let captured: ((t: string) => void) | undefined;
    const render2 = vi.fn((_el: HTMLElement, optsArg: { callback: (t: string) => void }) => {
      captured = optsArg.callback;
    });
    (window as any).turnstile = { render: render2, reset };

    server.opts.loginStatus = 200; // submit() takes the `if (res.ok) return;` path

    const App = await importApp();
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".login")).toBeTruthy());
    await waitFor(() => expect(captured).toBeTruthy());

    await act(async () => {
      captured!("tok-ok");
    });

    const inputs = container.querySelectorAll("input");
    fireEvent.input(inputs[0], { target: { value: "user" } });
    fireEvent.input(inputs[1], { target: { value: "pass" } });
    fireEvent.submit(container.querySelector("form.login")!);

    // login posted; success path returns early → no reset, no error message
    await waitFor(() => {
      const loginCall = server.fetchImpl.mock.calls.find(
        (c) => String(c[0]).includes("/login") && (c[1] as RequestInit)?.method === "POST"
      );
      expect(loginCall).toBeTruthy();
    });
    expect(reset).not.toHaveBeenCalled();
    expect(container.querySelector(".err")).toBeFalsy();
  });
});
