// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup, act } from "@testing-library/preact";
import App from "../src/App";
import { kv, hydrate } from "../src/idb";
import { DRAFT, CONTENT_CACHE, TEMPS_KEY, LIST_CACHE } from "../src/lib";

// ---------------------------------------------------------------------------
// In-memory fake server keyed by url + method. Holds memos/trash and responds
// the way the worker would, so the app's effects behave realistically.
// ---------------------------------------------------------------------------
type Row = { id: number; title: string; updated_at: number; content: string; created_at: number };

// Memo ids are monotonic across the WHOLE file (never reset per test). The shared
// module-level kv mirror is written by zombie in-flight save()/persist calls from a
// prior test's unmounted App that resolve during a later test; if ids reset per test
// those late writes would land on the new test's reused id and bleed stale content.
// Monotonic ids make every zombie write target a dead, never-reopened id. (The one
// test that reads a fixed id uses 5 — permanently below this 100+ range.)
let idSeq = 100;

function makeServer() {
  const memos: Row[] = []; // live memos
  const trash: Row[] = []; // trashed memos
  let clock = 1000;
  const now = () => ++clock;

  // hooks tests can flip to force errors / specific statuses
  const opts = {
    meStatus: 200, // /me and /memos auth check
    postThrows: false, // POST /api/memos network failure (offline path)
    putStatus: 0, // override PUT status (409/404) when > 0, else normal
    loginStatus: 200, // /login result
    searchThrows: false, // GET /api/search network failure (offline path)
    searchStatus: 0, // override GET /api/search status (e.g. 500) when > 0
  };

  function meta(r: Row) {
    return { id: r.id, title: r.title, updated_at: r.updated_at };
  }
  function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method || "GET").toUpperCase();
    const path = url.replace(/^.*\/api/, ""); // strip "/api"

    // ---- auth / list ----
    if (path === "/me") {
      if (opts.meStatus !== 200) return new Response("", { status: opts.meStatus });
      return json({ ok: true });
    }
    if (path === "/login" && method === "POST") {
      if (opts.loginStatus !== 200) return new Response("", { status: opts.loginStatus });
      return json({ ok: true });
    }
    if (path === "/logout" && method === "POST") return json({ ok: true });

    if (path === "/memos" && method === "GET") {
      if (opts.meStatus === 401) return new Response("", { status: 401 });
      return json(memos.map(meta).sort((a, b) => b.updated_at - a.updated_at));
    }
    if (path === "/memos" && method === "POST") {
      if (opts.postThrows) throw new Error("offline");
      const r: Row = { id: idSeq++, title: "Untitled", updated_at: now(), content: "", created_at: now() };
      memos.unshift(r);
      return json(meta(r));
    }
    if (path === "/trash" && method === "GET") {
      return json(trash.map(meta));
    }
    // read a single trashed memo's full content (trash-view-document feature)
    let tv = path.match(/^\/trash\/(-?\d+)$/);
    if (tv && method === "GET") {
      const id = Number(tv[1]);
      const row = trash.find((x) => x.id === id);
      if (!row) return new Response("", { status: 404 });
      return json(row);
    }

    // ---- per-memo ----
    let m = path.match(/^\/memos\/(-?\d+)$/);
    if (m) {
      const id = Number(m[1]);
      const idx = memos.findIndex((x) => x.id === id);
      if (method === "GET") {
        if (idx === -1) return new Response("", { status: 404 });
        return json(memos[idx]);
      }
      if (method === "PUT") {
        if (opts.putStatus === 409) return new Response("", { status: 409 });
        if (opts.putStatus === 404) return new Response("", { status: 404 });
        if (idx === -1) return new Response("", { status: 404 });
        const body = init?.body ? JSON.parse(init.body as string) : {};
        memos[idx].content = body.content ?? "";
        memos[idx].title = (body.content || "Untitled").split("\n")[0].replace(/^#+\s*/, "").trim() || "Untitled";
        memos[idx].updated_at = now();
        return json({ title: memos[idx].title, updated_at: memos[idx].updated_at });
      }
      if (method === "DELETE") {
        if (idx !== -1) {
          const [row] = memos.splice(idx, 1);
          if (!url.includes("purge=1")) trash.unshift(row);
        }
        return json({ ok: true });
      }
    }

    m = path.match(/^\/memos\/(-?\d+)\/restore$/);
    if (m && method === "POST") {
      const id = Number(m[1]);
      const ti = trash.findIndex((x) => x.id === id);
      if (ti !== -1) {
        const [row] = trash.splice(ti, 1);
        row.updated_at = now();
        memos.unshift(row);
      }
      return json({ ok: true });
    }
    m = path.match(/^\/memos\/(-?\d+)\/hide$/);
    if (m && method === "POST") {
      const id = Number(m[1]);
      const ti = trash.findIndex((x) => x.id === id);
      if (ti !== -1) trash.splice(ti, 1);
      return json({ ok: true });
    }

    // ---- body search (server-side; the sidebar list only carries titles) ----
    if (path.startsWith("/search") && method === "GET") {
      if (opts.searchThrows) throw new Error("offline");
      if (opts.searchStatus) return new Response("", { status: opts.searchStatus });
      const q = (new URLSearchParams(path.split("?")[1] ?? "").get("q") ?? "").trim().toLowerCase();
      if (!q) return json([]);
      return json(
        memos
          .filter((r) => r.title.toLowerCase().includes(q) || r.content.toLowerCase().includes(q))
          .map(meta)
          .sort((a, b) => b.updated_at - a.updated_at)
      );
    }

    return new Response("not found", { status: 404 });
  });

  return { memos, trash, opts, fetchImpl, seed: (r: Partial<Row>) => {
    const row: Row = { id: idSeq++, title: "Untitled", updated_at: now(), content: "", created_at: now(), ...r };
    memos.push(row);
    return row;
  }, now };
}

let server: ReturnType<typeof makeServer>;

// the IDB kv mirror is a module-level Map that survives across tests; clear the
// per-memo draft/cache keys so a reused memo id can't read a previous test's
// content. Only positive seeded ids (1..200) and small temp ids collide; keep
// the loop tight so the background IDB persists don't pile up and slow hydrate().
function clearKv() {
  for (let id = -20; id <= 60; id++) {
    kv.remove(DRAFT + id);
    kv.remove(CONTENT_CACHE + id);
  }
}

// Clear the persisted IDB "kv" store and report how many rows it held. clearKv()
// only touches the in-memory mirror + queues fire-and-forget deletes; a prior test's
// background kv.set() persist (FileReader/rAF/timer-driven, so it can fire after the
// test's awaits) lands at an unpredictable time, and the next App's hydrate() would
// resurrect that stale content (flaky, exposed by the slower --coverage scheduling).
function clearKvStore(): Promise<number> {
  return new Promise<number>((resolve) => {
    const req = indexedDB.open("nemo", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction("kv", "readwrite");
        const store = tx.objectStore("kv");
        const count = store.count();
        store.clear();
        tx.oncomplete = () => (db.close(), resolve(count.result));
        tx.onerror = () => (db.close(), resolve(0));
      } catch {
        db.close();
        resolve(0);
      }
    };
    req.onerror = () => resolve(0);
  });
}

// Deterministically empty the store: clear, let a macrotask drain any straggler
// persist from the just-finished test, and re-clear until a clear finds it already
// empty. Since the prior test has stopped scheduling writes, this converges fast.
async function wipeKvStore() {
  for (let i = 0; i < 12; i++) {
    const had = await clearKvStore();
    await new Promise((r) => setTimeout(r, 0));
    if (had === 0) return;
  }
}

beforeEach(async () => {
  localStorage.clear();
  location.hash = "";
  clearKv();
  // empty the persisted store deterministically, then reconcile the mirror, so the
  // next App's hydrate() starts from a guaranteed-clean slate (no resurrected cache)
  await wipeKvStore();
  await hydrate();
  server = makeServer();
  globalThis.fetch = server.fetchImpl as unknown as typeof fetch;

  // always install a clean matchMedia (some happy-dom versions lack
  // addEventListener; also resets any per-test override from a prior test)
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

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
  location.hash = "";
  // let any fire-and-forget kv.set() persists from this test flush their queued
  // IDB put (an open().then() microtask) before the next test wipes the store —
  // otherwise a late put lands after the wipe and resurrects stale content
  // (flaky under the slower --coverage scheduling).
  await new Promise((r) => setTimeout(r, 0));
});

function authedBoot() {
  localStorage.setItem("qm-authed", "1");
}

// ===========================================================================
// LOGIN
// ===========================================================================
describe("Login", () => {
  it("renders login when /memos returns 401 and not authed", async () => {
    server.opts.meStatus = 401;
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".login")).toBeTruthy());
    expect(container.querySelector("h1")?.textContent).toBe("nemo");
  });

  it("logs in successfully and lands in a new memo", async () => {
    server.opts.meStatus = 401;
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".login")).toBeTruthy());

    const inputs = container.querySelectorAll("input");
    fireEvent.input(inputs[0], { target: { value: "user" } });
    fireEvent.input(inputs[1], { target: { value: "pass" } });
    // server now accepts /memos
    server.opts.meStatus = 200;
    fireEvent.submit(container.querySelector("form.login")!);

    await waitFor(() => expect(container.querySelector(".app")).toBeTruthy());
  });

  it("shows invalid message on 401 login failure", async () => {
    server.opts.meStatus = 401;
    server.opts.loginStatus = 401;
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".login")).toBeTruthy());
    fireEvent.submit(container.querySelector("form.login")!);
    await waitFor(() =>
      expect(container.querySelector(".err")?.textContent).toContain("Invalid username or password")
    );
  });

  it("shows verification message on 403 login failure", async () => {
    server.opts.meStatus = 401;
    server.opts.loginStatus = 403;
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".login")).toBeTruthy());
    fireEvent.submit(container.querySelector("form.login")!);
    await waitFor(() =>
      expect(container.querySelector(".err")?.textContent).toContain("Verification failed")
    );
  });
});

// ===========================================================================
// AUTHED BOOT
// ===========================================================================
describe("authed boot", () => {
  it("hydrates the list and creates a new memo when no hash", async () => {
    authedBoot();
    server.seed({ title: "Alpha", content: "# Alpha" });
    server.seed({ title: "Beta", content: "# Beta" });
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelectorAll(".memo-list li").length).toBeGreaterThanOrEqual(2));
    // a new memo was POSTed → editor open with NEW_DOC
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());
    expect(container.querySelector(".memo-title")?.textContent).toBeTruthy();
  });

  it("deep-links to the hashed memo on boot", async () => {
    authedBoot();
    const row = server.seed({ title: "Target", content: "# Target\n\nbody" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("Target")
    );
  });
});

// ===========================================================================
// EDITING + SAVE
// ===========================================================================
describe("editing and save", () => {
  it("debounced save fires a PUT and shows Saved", async () => {
    vi.useFakeTimers();
    authedBoot();
    const row = server.seed({ title: "Edit", content: "# Edit" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await vi.waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());

    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.input(ta, { target: { value: "# Edit\n\nhello world" } });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    vi.useRealTimers();
    await waitFor(() => {
      const put = server.fetchImpl.mock.calls.find(
        (c) => String(c[0]).includes(`/memos/${row.id}`) && (c[1] as RequestInit)?.method === "PUT"
      );
      expect(put).toBeTruthy();
    });
    expect(row.content).toContain("hello world");
  });

  it("handles a 409 conflict — reload and overwrite", async () => {
    authedBoot();
    const row = server.seed({ title: "Conf", content: "# Conf" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());

    server.opts.putStatus = 409;
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "# Conf\n\nlocal edit" } });
    await waitFor(() => expect(container.querySelector(".conflict")).toBeTruthy());

    // Reload pulls server content
    server.opts.putStatus = 0;
    row.content = "# Conf\n\nserver wins";
    fireEvent.click(container.querySelector(".conflict button")!); // Reload
    await waitFor(() => expect(ta.value).toContain("server wins"));

    // trigger conflict again to test Overwrite
    server.opts.putStatus = 409;
    fireEvent.input(ta, { target: { value: "# Conf\n\nmine again" } });
    await waitFor(() => expect(container.querySelector(".conflict")).toBeTruthy());
    server.opts.putStatus = 0;
    const buttons = container.querySelectorAll(".conflict button");
    fireEvent.click(buttons[1]); // Overwrite
    await waitFor(() => expect(container.querySelector(".conflict")).toBeFalsy());
  });

  it("handles a 404 deleted-elsewhere — recoverAsNew", async () => {
    authedBoot();
    const row = server.seed({ title: "Del", content: "# Del" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());

    server.opts.putStatus = 404;
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "# Del\n\nrescue me" } });
    await waitFor(() => {
      const banner = container.querySelector(".conflict span");
      expect(banner?.textContent).toContain("다른 곳에서 삭제");
    });

    server.opts.putStatus = 0;
    // click "새 메모로 복구"
    const btns = container.querySelectorAll(".conflict button");
    fireEvent.click(btns[0]);
    await waitFor(() => expect(container.querySelector(".conflict")).toBeFalsy());
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("rescue")
    );
    // a new server memo holds the rescued content
    await waitFor(() => expect(server.memos.some((m) => m.content.includes("rescue me"))).toBe(true));
  });

  it("handles a 404 deleted-elsewhere — discardDeleted", async () => {
    authedBoot();
    const row = server.seed({ title: "Del2", content: "# Del2" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());

    server.opts.putStatus = 404;
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "# Del2\n\nbye" } });
    await waitFor(() => expect(container.querySelector(".conflict span")?.textContent).toContain("삭제"));

    const btns = container.querySelectorAll(".conflict button");
    fireEvent.click(btns[1]); // 버리기
    await waitFor(() => expect(container.querySelector(".center")).toBeTruthy());
  });
});

// ===========================================================================
// SIDEBAR / TOOLBAR
// ===========================================================================
describe("toolbar and sidebar", () => {
  it("+ New creates another memo (a fresh local temp, not a server row)", async () => {
    authedBoot();
    server.seed({ title: "Existing", content: "# Existing\n\nbody" });
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());
    const ta = () => container.querySelector("textarea.editor") as HTMLTextAreaElement;
    // give the boot memo content so it isn't dropped as a blank temp on leave
    fireEvent.input(ta(), { target: { value: "# First\n\nkeep me" } });
    await waitFor(() => expect(ta().value).toContain("keep me"));
    const before = container.querySelectorAll(".memo-list li").length;
    // an untouched new memo must NOT hit the server (issue #51)
    const posted = () =>
      server.fetchImpl.mock.calls.filter(
        ([u, i]) => String(u).endsWith("/memos") && (i?.method || "").toUpperCase() === "POST"
      ).length;
    const postsBefore = posted();
    fireEvent.click(container.querySelector(".new-memo")!);
    await waitFor(() => {
      expect(location.hash).toMatch(/^#-\d+$/); // the new memo is a local temp
      expect(ta().value).toBe("# "); // a fresh blank doc
      expect(container.querySelectorAll(".memo-list li").length).toBe(before + 1);
    });
    expect(posted()).toBe(postsBefore); // no POST /api/memos for the new (blank) memo
  });

  it("toggles the sidebar", async () => {
    authedBoot();
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".sidebar")).toBeTruthy());
    fireEvent.click(container.querySelector(".topbar .ghost")!);
    await waitFor(() => expect(container.querySelector(".sidebar")).toBeFalsy());
    fireEvent.click(container.querySelector(".topbar .ghost")!);
    await waitFor(() => expect(container.querySelector(".sidebar")).toBeTruthy());
  });

  it("cycles the theme light->dark->system", async () => {
    authedBoot();
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".theme-toggle")).toBeTruthy());
    const btn = container.querySelector(".theme-toggle")!;
    fireEvent.click(btn); // -> light
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
    expect(localStorage.getItem("qm-theme")).toBe("light");
    fireEvent.click(btn); // -> dark
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    fireEvent.click(btn); // -> system
    await waitFor(() => expect(localStorage.getItem("qm-theme")).toBe("system"));
  });

  it("links the GitHub icon to the repo's pull-requests page", async () => {
    authedBoot();
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".topbar")).toBeTruthy());
    const link = container.querySelector("a.github-link") as HTMLAnchorElement | null;
    expect(link).toBeTruthy();
    expect(link!.getAttribute("href")).toBe("https://github.com/roeniss/nemo/pulls");
    expect(link!.getAttribute("target")).toBe("_blank");
    // no reverse-tabnabbing / referrer leak through the new tab
    expect(link!.getAttribute("rel")).toContain("noopener");
    // rendered right next to the theme (colour) toggle, with an inline icon
    expect(link!.previousElementSibling).toBe(container.querySelector(".theme-toggle"));
    expect(link!.querySelector("svg")).toBeTruthy();
  });

  it("filters memos with the search box", async () => {
    authedBoot();
    server.seed({ title: "Apple", content: "# Apple" });
    server.seed({ title: "Banana", content: "# Banana" });
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelectorAll(".memo-list li").length).toBeGreaterThanOrEqual(2));
    fireEvent.input(container.querySelector(".search")!, { target: { value: "apple" } });
    await waitFor(() => {
      const titles = Array.from(container.querySelectorAll(".memo-title")).map((e) => e.textContent);
      expect(titles.some((t) => t === "Apple")).toBe(true);
      expect(titles.some((t) => t === "Banana")).toBe(false);
    });
    // no matches branch
    fireEvent.input(container.querySelector(".search")!, { target: { value: "zzz" } });
    await waitFor(() => expect(container.querySelector(".empty")?.textContent).toBe("No matches"));
  });

  it("matches the memo body (not just the title) via the server search", async () => {
    authedBoot();
    server.seed({ title: "Alpha", content: "# Alpha\njust the basics" });
    server.seed({ title: "Beta", content: "# Beta\nhides a pineapple in its body" });
    const { container } = render(<App />);
    await waitFor(() =>
      expect(container.querySelectorAll(".memo-list li").length).toBeGreaterThanOrEqual(2)
    );
    // "pineapple" is in no title — only the debounced server body search finds Beta
    fireEvent.input(container.querySelector(".search")!, { target: { value: "pineapple" } });
    await waitFor(() => {
      const titles = Array.from(container.querySelectorAll(".memo-title")).map((e) => e.textContent);
      expect(titles).toContain("Beta");
      expect(titles).not.toContain("Alpha");
    });
  });

  it("falls back to title-only matching when the body search request throws", async () => {
    authedBoot();
    server.opts.searchThrows = true; // /search is offline
    server.seed({ title: "Gamma", content: "# Gamma\ncontains a rare zebra" });
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelectorAll(".memo-list li").length).toBeGreaterThanOrEqual(1));
    // a body-only word: with the body search failing, nothing matches…
    fireEvent.input(container.querySelector(".search")!, { target: { value: "zebra" } });
    await waitFor(() =>
      expect(server.fetchImpl.mock.calls.some((c) => String(c[0]).includes("/search?q=zebra"))).toBe(true)
    );
    await waitFor(() => expect(container.querySelector(".empty")?.textContent).toBe("No matches"));
    // …but a title word still resolves locally, with no network
    fireEvent.input(container.querySelector(".search")!, { target: { value: "gamma" } });
    await waitFor(() => {
      const titles = Array.from(container.querySelectorAll(".memo-title")).map((e) => e.textContent);
      expect(titles).toContain("Gamma");
    });
  });

  it("ignores a non-ok body search response", async () => {
    authedBoot();
    server.opts.searchStatus = 500; // /search errors out
    server.seed({ title: "Delta", content: "# Delta\nguards a secret walrus" });
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelectorAll(".memo-list li").length).toBeGreaterThanOrEqual(1));
    fireEvent.input(container.querySelector(".search")!, { target: { value: "walrus" } });
    await waitFor(() =>
      expect(server.fetchImpl.mock.calls.some((c) => String(c[0]).includes("/search?q=walrus"))).toBe(true)
    );
    await waitFor(() => expect(container.querySelector(".empty")?.textContent).toBe("No matches"));
  });

  it("logs out", async () => {
    authedBoot();
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".side-head .ghost")).toBeTruthy());
    fireEvent.click(container.querySelector(".side-head .ghost")!);
    await waitFor(() => expect(container.querySelector(".login")).toBeTruthy());
    expect(localStorage.getItem("qm-authed")).toBeNull();
  });
});

// ===========================================================================
// TRASH
// ===========================================================================
describe("trash", () => {
  it("loads trash, restores and hides", async () => {
    authedBoot();
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".side-tabs")).toBeTruthy());

    // put a couple of memos in the trash via the server directly
    const a = server.seed({ title: "TrashA", content: "# A" });
    const b = server.seed({ title: "TrashB", content: "# B" });
    server.trash.push(...server.memos.splice(server.memos.indexOf(a), 1));
    server.trash.push(...server.memos.splice(server.memos.indexOf(b), 1));

    const tabs = container.querySelectorAll(".side-tabs button");
    fireEvent.click(tabs[1]); // Trash
    await waitFor(() => expect(container.querySelectorAll(".memo-list .restore").length).toBe(2));

    fireEvent.click(container.querySelector(".restore")!); // restore first
    await waitFor(() => expect(container.querySelectorAll(".memo-list .restore").length).toBe(1));

    fireEvent.click(container.querySelector(".del")!); // hide remaining
    await waitFor(() => expect(container.querySelector(".memo-list .empty")?.textContent).toBe("Trash is empty"));

    // back to memos
    fireEvent.click(container.querySelectorAll(".side-tabs button")[0]);
    await waitFor(() => expect(container.querySelector(".search")).toBeTruthy());
  });
});

// ===========================================================================
// DELETE + UNDO
// ===========================================================================
describe("delete and undo", () => {
  it("deletes a memo, shows toast, and undoes the delete", async () => {
    authedBoot();
    const row = server.seed({ title: "Doomed", content: "# Doomed" });
    const { container } = render(<App />);
    await waitFor(() => {
      const titles = Array.from(container.querySelectorAll(".memo-title")).map((e) => e.textContent);
      expect(titles).toContain("Doomed");
    });

    // click the × on the Doomed row
    const li = Array.from(container.querySelectorAll(".memo-list li")).find(
      (el) => el.querySelector(".memo-title")?.textContent === "Doomed"
    )!;
    fireEvent.click(li.querySelector(".del")!);
    await waitFor(() => expect(container.querySelector(".toast")).toBeTruthy());
    expect(container.querySelector(".toast")?.textContent).toContain("Doomed");

    fireEvent.click(container.querySelector(".toast button")!); // Undo
    await waitFor(() => {
      const titles = Array.from(container.querySelectorAll(".memo-title")).map((e) => e.textContent);
      expect(titles).toContain("Doomed");
    });
  });

  // seed A,B,C in order → later seeds sort higher (byRecent), so the visible list
  // is [C, B, A]. Deleting the open memo should advance to its neighbour.
  function openRow(container: HTMLElement, title: string) {
    const li = Array.from(container.querySelectorAll(".memo-list li")).find(
      (el) => el.querySelector(".memo-title")?.textContent === title
    ) as HTMLElement;
    return act(async () => {
      fireEvent.click(li);
    });
  }
  function delRow(container: HTMLElement, title: string) {
    const li = Array.from(container.querySelectorAll(".memo-list li")).find(
      (el) => el.querySelector(".memo-title")?.textContent === title
    ) as HTMLElement;
    return act(async () => {
      fireEvent.click(li.querySelector(".del")!);
    });
  }

  it("opens the memo right below when the open memo is deleted", async () => {
    authedBoot();
    server.seed({ title: "A", content: "# A\n\naaa" });
    server.seed({ title: "B", content: "# B\n\nbbb" });
    server.seed({ title: "C", content: "# C\n\nccc" });
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelectorAll(".memo-list li").length).toBe(3));

    // list is [C, B, A]; open the middle one and delete it → below = A
    await openRow(container as unknown as HTMLElement, "B");
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("bbb")
    );
    await delRow(container as unknown as HTMLElement, "B");
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("aaa")
    );
    expect(container.querySelector(".memo-list li.active .memo-title")?.textContent).toBe("A");
  });

  it("opens the memo above when the deleted open memo has none below it", async () => {
    authedBoot();
    server.seed({ title: "A", content: "# A\n\naaa" });
    server.seed({ title: "B", content: "# B\n\nbbb" });
    server.seed({ title: "C", content: "# C\n\nccc" });
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelectorAll(".memo-list li").length).toBe(3));

    // list is [C, B, A]; open the last one (no row below) and delete it → above = B
    await openRow(container as unknown as HTMLElement, "A");
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("aaa")
    );
    await delRow(container as unknown as HTMLElement, "A");
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("bbb")
    );
    expect(container.querySelector(".memo-list li.active .memo-title")?.textContent).toBe("B");
  });
});

// ===========================================================================
// KEYBOARD SHORTCUTS
// ===========================================================================
describe("keyboard shortcuts", () => {
  it("Cmd+S saves and Cmd+K creates a new memo", async () => {
    authedBoot();
    const row = server.seed({ title: "Keys", content: "# Keys" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());

    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "# Keys\n\nsaved by shortcut" } });
    fireEvent.keyDown(window, { key: "s", metaKey: true });
    await waitFor(() => expect(row.content).toContain("saved by shortcut"));

    fireEvent.keyDown(window, { key: "k", metaKey: true });
    // Cmd+K opens a fresh local temp (negative id, blank doc) — no server row
    await waitFor(() => {
      expect(location.hash).toMatch(/^#-\d+$/);
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement).value).toBe("# ");
    });
  });

  it("Alt+J / Alt+K navigate between memos", async () => {
    authedBoot();
    server.seed({ title: "One", content: "# One" });
    server.seed({ title: "Two", content: "# Two" });
    server.seed({ title: "Three", content: "# Three" });
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelectorAll(".memo-list li").length).toBeGreaterThanOrEqual(3));

    // open the first listed memo
    fireEvent.click(container.querySelector(".memo-list li")!);
    await waitFor(() => expect(container.querySelector(".memo-list li.active")).toBeTruthy());

    fireEvent.keyDown(window, { code: "KeyJ", altKey: true }); // next
    await waitFor(() => expect(container.querySelector(".memo-list li.active")).toBeTruthy());
    fireEvent.keyDown(window, { code: "KeyK", altKey: true }); // prev
    await waitFor(() => expect(container.querySelector(".memo-list li.active")).toBeTruthy());
  });
});

// ===========================================================================
// OFFLINE / TEMP FLOWS
// ===========================================================================
describe("offline temp flows", () => {
  it("keeps a new memo local until it has content, then materializes it", async () => {
    authedBoot();
    const { container } = render(<App />);
    // boot creates a fresh local temp (no network) — a temp row in localStorage…
    await waitFor(() => {
      expect(container.querySelector("textarea.editor")).toBeTruthy();
      expect(JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]").length).toBeGreaterThan(0);
    });
    // …and crucially nothing on the server yet (an untouched Untitled never uploads)
    expect(server.memos.length).toBe(0);

    // add content → still local-only (no eager upload); the temp's title updates
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.input(ta, { target: { value: "# Temp\n\nreal content" } });
    });
    await waitFor(
      () => expect(JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]")[0]?.title).toBe("Temp"),
      { timeout: 3000 }
    );
    expect(server.memos.length).toBe(0); // still nothing on the server until a sync runs

    // a focus-triggered sync()/recover()/materializeTemps() pushes it to the server
    await waitFor(
      async () => {
        await act(async () => {
          window.dispatchEvent(new Event("focus"));
        });
        expect(JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]").length).toBe(0);
      },
      { timeout: 5000, interval: 50 }
    );
    // a real memo with the content now exists
    await waitFor(() => expect(server.memos.some((m) => m.content.includes("real content"))).toBe(true));
  });
});

// ===========================================================================
// BACKGROUND SYNC (via focus)
// ===========================================================================
describe("background sync via focus", () => {
  it("reloads the open memo when changed elsewhere", async () => {
    authedBoot();
    const row = server.seed({ title: "Sync", content: "# Sync\n\noriginal" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("original")
    );

    // change the memo "elsewhere"
    row.content = "# Sync\n\nremote update";
    row.updated_at = server.now() + 100000;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("remote update")
    );
  });

  it("raises the deleted banner when the open memo 404s on probe", async () => {
    authedBoot();
    const row = server.seed({ title: "Gone", content: "# Gone" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());

    // remove it from the server entirely (drops from list + 404 on direct fetch)
    const i = server.memos.indexOf(row);
    server.memos.splice(i, 1);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(container.querySelector(".conflict span")?.textContent).toContain("삭제"));
  });
});

// ===========================================================================
// BEFOREUNLOAD
// ===========================================================================
describe("beforeunload", () => {
  it("drops an empty fresh temp from local storage on unload (no server call)", async () => {
    authedBoot();
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());
    // boot created a fresh blank temp
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]").length).toBeGreaterThan(0)
    );
    await act(async () => {
      window.dispatchEvent(new Event("beforeunload"));
    });
    // it's dropped locally — nothing was ever sent to the server, so no purge fetch
    await waitFor(() => expect(JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]").length).toBe(0));
    expect(server.fetchImpl.mock.calls.some((c) => String(c[0]).includes("purge=1"))).toBe(false);
  });

  it("does nothing on unload when no memo is open (id == null)", async () => {
    authedBoot();
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".side-head .ghost")).toBeTruthy());
    // logout clears the open memo → currentId becomes null
    fireEvent.click(container.querySelector(".side-head .ghost")!);
    await waitFor(() => expect(container.querySelector(".login")).toBeTruthy());
    const before = server.fetchImpl.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("beforeunload"));
    });
    // id == null → the handler returns immediately; no further fetch
    expect(server.fetchImpl.mock.calls.length).toBe(before);
  });

  it("warns and pushes when a save is in flight", async () => {
    vi.useFakeTimers();
    authedBoot();
    const row = server.seed({ title: "Unsaved", content: "# Unsaved" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await vi.waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.input(ta, { target: { value: "# Unsaved\n\npending edit" } });
    });
    // debounce hasn't fired yet → timer.current != null
    const evt = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    await act(async () => {
      window.dispatchEvent(evt);
    });
    vi.useRealTimers();
    expect(evt.defaultPrevented).toBe(true);
  });
});

// ===========================================================================
// IMPORT / DOWNLOAD / PASTE / DROP
// ===========================================================================
describe("import, download, paste, drop", () => {
  it("download button is enabled with an open memo and triggers a download", async () => {
    authedBoot();
    const row = server.seed({ title: "Dl", content: "# Dl\n\nbody" });
    location.hash = "#" + row.id;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    // happy-dom may lack createObjectURL
    if (!URL.createObjectURL) (URL as any).createObjectURL = () => "blob:x";
    if (!URL.revokeObjectURL) (URL as any).revokeObjectURL = () => {};
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:x");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());
    const dl = container.querySelector(".download") as HTMLButtonElement;
    expect(dl.disabled).toBe(false);
    fireEvent.click(dl);
    expect(clickSpy).toHaveBeenCalled();
  });

  it("imports files through the hidden file input", async () => {
    authedBoot();
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".file-input")).toBeTruthy());
    const input = container.querySelector(".file-input") as HTMLInputElement;
    const file = new File(["# hello\n\nfile body"], "note.md", { type: "text/markdown" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() =>
      expect(server.memos.some((m) => m.content.includes("file body"))).toBe(true)
    );

    // folder import path too (webkitRelativePath depth filter)
    const folder = container.querySelector(".folder-input") as HTMLInputElement;
    const ff = new File(["# fo\n\nfolder body"], "fo.md", { type: "text/markdown" });
    Object.defineProperty(ff, "webkitRelativePath", { value: "dir/fo.md" });
    const skip = new File(["# deep\n\ndeep body"], "deep.md", { type: "text/markdown" });
    Object.defineProperty(skip, "webkitRelativePath", { value: "dir/sub/deep.md" });
    Object.defineProperty(folder, "files", { value: [ff, skip], configurable: true });
    await act(async () => {
      folder.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => expect(server.memos.some((m) => m.content.includes("folder body"))).toBe(true));
    expect(server.memos.some((m) => m.content.includes("deep body"))).toBe(false);
  });

  it("clicking ⬆ Files opens the hidden input", async () => {
    authedBoot();
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".import")).toBeTruthy());
    const input = container.querySelector(".file-input") as HTMLInputElement;
    const spy = vi.spyOn(input, "click").mockImplementation(() => {});
    fireEvent.click(container.querySelector(".import")!);
    expect(spy).toHaveBeenCalled();
    // folder too
    const folder = container.querySelector(".folder-input") as HTMLInputElement;
    const fspy = vi.spyOn(folder, "click").mockImplementation(() => {});
    fireEvent.click(container.querySelector(".import-folder")!);
    expect(fspy).toHaveBeenCalled();
  });

  it("pastes an image and drops a file onto the editor", async () => {
    authedBoot();
    const row = server.seed({ title: "Pd", content: "# Pd" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;

    // paste an image
    const img = new File([new Uint8Array([1, 2, 3])], "pic.png", { type: "image/png" });
    const clip = {
      files: [img],
      items: [],
    } as unknown as DataTransfer;
    await act(async () => {
      fireEvent.paste(ta, { clipboardData: clip });
    });
    await waitFor(
      () => expect((container.querySelector("textarea.editor") as HTMLTextAreaElement).value).toContain("data:"),
      { timeout: 3000 }
    );

    // drop a text file
    const dropFile = new File(["# dropped\n\ndropped body"], "drop.md", { type: "text/markdown" });
    const dt = { files: [dropFile], types: ["Files"] } as unknown as DataTransfer;
    await act(async () => {
      fireEvent.dragOver(ta, { dataTransfer: dt });
      fireEvent.drop(ta, { dataTransfer: dt });
    });
    await waitFor(() => expect(server.memos.some((m) => m.content.includes("dropped body"))).toBe(true));
  });
});

// ===========================================================================
// OFFLINE BOOT (catch branch)
// ===========================================================================
describe("offline boot", () => {
  it("renders cached list when the boot fetch rejects", async () => {
    authedBoot();
    localStorage.setItem(
      LIST_CACHE,
      JSON.stringify([{ id: 5, title: "Cached", updated_at: 100 }])
    );
    kv.set(CONTENT_CACHE + 5, "# Cached\n\ncached body");
    // make the very first /memos GET throw
    let first = true;
    const orig = server.fetchImpl;
    globalThis.fetch = vi.fn(async (input: any, init: any) => {
      const url = String(input);
      if (first && url.includes("/memos") && (!init || (init.method || "GET") === "GET")) {
        first = false;
        throw new Error("offline boot");
      }
      return orig(input, init);
    }) as unknown as typeof fetch;

    location.hash = "#5";
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".status.offline")).toBeTruthy());
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("cached body")
    );
  });
});

// ===========================================================================
// EXTRA BRANCHES
// ===========================================================================
describe("extra branches", () => {
  it("boot 401 while optimistically authed drops auth and shows login", async () => {
    authedBoot(); // optimistic authed = true
    server.opts.meStatus = 401; // background /memos says 401
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".login")).toBeTruthy());
    expect(localStorage.getItem("qm-authed")).toBeNull();
  });

  it("deletes a temp memo locally without trash/undo", async () => {
    authedBoot();
    const { container } = render(<App />);
    // boot creates a local temp (negative id) — no network needed
    await waitFor(() => expect(container.querySelector(".memo-list li")).toBeTruthy());
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]").length).toBeGreaterThan(0)
    );

    // the open temp memo's × deletes it; currentId === id branch resets to center
    const li = container.querySelector(".memo-list li") as HTMLElement;
    fireEvent.click(li.querySelector(".del")!);
    await waitFor(() => expect(JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]").length).toBe(0));
    expect(container.querySelector(".toast")).toBeFalsy(); // no undo toast for temps
    // nothing was ever sent to the server for an unsynced temp
    expect(server.fetchImpl.mock.calls.some((c) => (c[1] as RequestInit)?.method === "DELETE")).toBe(false);
  });

  it("navigates via hashchange (back/forward)", async () => {
    authedBoot();
    const a = server.seed({ title: "Ha", content: "# Ha\n\nalpha body" });
    server.seed({ title: "Hb", content: "# Hb\n\nbeta body" });
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelectorAll(".memo-list li").length).toBeGreaterThanOrEqual(2));

    await act(async () => {
      location.hash = "#" + a.id;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("alpha body")
    );
  });

  it("recover runs on the window online event", async () => {
    authedBoot();
    const row = server.seed({ title: "On", content: "# On" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());
    // leave a draft so recover() pushes it
    kv.set(DRAFT + row.id, "# On\n\nrecovered via online");
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(row.content).toContain("recovered via online"));
  });

  it("reacts to an OS theme change while following system", async () => {
    authedBoot();
    let changeHandler: ((e: any) => void) | null = null;
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      addEventListener: (_: string, h: (e: any) => void) => {
        changeHandler = h;
      },
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;

    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".app")).toBeTruthy());
    // default pref is "system"; drive a dark OS change
    await act(async () => {
      changeHandler?.({ matches: true });
    });
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
  });

  it("rejects an oversized pasted image", async () => {
    authedBoot();
    const row = server.seed({ title: "Big", content: "# Big" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    const big = new File([new Uint8Array(2 * 1024 * 1024)], "huge.png", { type: "image/png" });
    const clip = { files: [big], items: [] } as unknown as DataTransfer;
    await act(async () => {
      fireEvent.paste(ta, { clipboardData: clip });
    });
    await waitFor(() => expect(container.querySelector(".toast")?.textContent).toContain("너무 커요"));
  });

  it("skips non-image paste (lets the browser handle it)", async () => {
    authedBoot();
    const row = server.seed({ title: "Txt", content: "# Txt" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    const before = ta.value;
    const clip = { files: [], items: [] } as unknown as DataTransfer;
    // pasteImage returns false (no image) so the handler does nothing — the
    // editor value is unchanged (the browser would handle the text paste natively)
    await act(async () => {
      fireEvent.paste(ta, { clipboardData: clip });
    });
    expect((container.querySelector("textarea.editor") as HTMLTextAreaElement).value).toBe(before);
  });

  it("clears the editor when the open memo is deleted from the list", async () => {
    authedBoot();
    const row = server.seed({ title: "Open", content: "# Open\n\nbody" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("body")
    );
    // delete the currently-open memo via its × — currentId === id, so the editor
    // resets to the center placeholder (App.tsx setCurrentId(null)/setContent(""))
    const li = Array.from(container.querySelectorAll(".memo-list li")).find((el) =>
      el.textContent?.includes("Open")
    ) as HTMLElement;
    await act(async () => {
      fireEvent.click(li.querySelector(".del")!);
    });
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeFalsy());
    expect(container.querySelector(".center")).toBeTruthy();
  });

  it("breaks out of materializeTemps when a temp's POST fails (still offline)", async () => {
    authedBoot();
    // a local temp with real content that should sync, but the server POST throws
    const tempId = -5;
    localStorage.setItem(
      TEMPS_KEY,
      JSON.stringify([{ id: tempId, title: "T", updated_at: 100 }])
    );
    kv.set(DRAFT + tempId, "# T\n\nunsynced body");
    server.opts.postThrows = true; // POST /api/memos fails → materializeTemps catch → break
    render(<App />);
    // materializeTemps must actually attempt the POST (so the catch/break runs)
    await waitFor(() =>
      expect(
        server.fetchImpl.mock.calls.some(
          ([u, i]) => String(u).includes("/api/memos") && (i?.method || "").toUpperCase() === "POST"
        )
      ).toBe(true)
    );
    // the temp is NOT removed (break before the writeList) — it stays for retry
    expect(JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]").some((t: { id: number }) => t.id === tempId)).toBe(true);
    expect(kv.get(DRAFT + tempId)).toContain("unsynced body");
  });

  it("clears a pending save timer when leaving a blank fresh memo", async () => {
    authedBoot();
    const { container } = render(<App />);
    // no hash → boot creates a fresh blank temp ("# ") tracked in freshIds
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    // an edit that stays blank arms the debounced save (timer.current set) without
    // marking the memo non-fresh
    await act(async () => {
      fireEvent.input(ta, { target: { value: "#   " } });
    });
    // leave via + New: leaveCurrent sees fresh + blank + a pending timer, clears it
    // (App.tsx clearTimeout/timer.current = null), then drops the temp locally
    await act(async () => {
      fireEvent.click(container.querySelector(".new-memo")!);
    });
    await waitFor(() => {
      // a fresh blank editor for the new temp; the abandoned one was dropped locally
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement).value).toBe("# ");
      expect(JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]").length).toBe(1);
    });
    // nothing was ever sent to the server for the abandoned blank memo
    expect(server.fetchImpl.mock.calls.some(([u]) => String(u).includes("purge=1"))).toBe(false);
  });
});

// ===========================================================================
// COVERAGE FILL — remaining branches/functions
// ===========================================================================
describe("theme preference init", () => {
  it("reads a saved light preference on boot", async () => {
    authedBoot();
    localStorage.setItem("qm-theme", "light");
    // a theme-color meta present + light theme exercises the "#ffffff" ternary arm
    const meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    meta.setAttribute("content", "#000000");
    document.head.appendChild(meta);
    try {
      const { container } = render(<App />);
      await waitFor(() => expect(container.querySelector(".app")).toBeTruthy());
      await waitFor(() => expect(document.documentElement.dataset.theme).toBe("light"));
      expect(meta.getAttribute("content")).toBe("#ffffff");
      // the toggle reflects the light preference (SVG icon, no text content)
      expect(container.querySelector(".theme-toggle svg")).toBeTruthy();
    } finally {
      meta.remove();
    }
  });

  it("reads a saved dark preference on boot and keeps the theme-color meta in sync", async () => {
    authedBoot();
    localStorage.setItem("qm-theme", "dark");
    // install a theme-color meta so the dark ternary arm (#1a1a1a) is exercised
    const meta = document.createElement("meta");
    meta.setAttribute("name", "theme-color");
    meta.setAttribute("content", "#ffffff");
    document.head.appendChild(meta);
    try {
      const { container } = render(<App />);
      await waitFor(() => expect(container.querySelector(".app")).toBeTruthy());
      await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
      expect(meta.getAttribute("content")).toBe("#1a1a1a");
      expect(container.querySelector(".theme-toggle svg")).toBeTruthy();
    } finally {
      meta.remove();
    }
  });
});

describe("flush with a pending timer", () => {
  it("flushes an armed debounced save when leaving a non-fresh memo", async () => {
    authedBoot();
    const a = server.seed({ title: "Aaa", content: "# Aaa\n\nalpha" });
    const b = server.seed({ title: "Bbb", content: "# Bbb\n\nbeta" });
    location.hash = "#" + a.id;
    const { container } = render(<App />);
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("alpha")
    );

    // type into the (non-fresh) opened memo to arm timer.current, but DON'T let the
    // debounce fire; then open another memo → leaveCurrent → flush() with timer set
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.input(ta, { target: { value: "# Aaa\n\nalpha edited inflight" } });
    });
    const li = Array.from(container.querySelectorAll(".memo-list li")).find(
      (el) => el.querySelector(".memo-title")?.textContent === "Bbb"
    )!;
    await act(async () => {
      fireEvent.click(li);
    });
    // flush() ran save(a.id, ...) synchronously on leave → server has the edit
    await waitFor(() => expect(server.memos.find((m) => m.id === a.id)?.content).toContain("alpha edited inflight"));
    expect(b).toBeTruthy();
  });
});

describe("openMemo temp + draft branches", () => {
  it("opens a temp memo (id<0) with a local DRAFT and returns early without a fetch", async () => {
    authedBoot();
    // keep the server unreachable for POSTs so materializeTemps can't push (and
    // remove) the content temp during boot — it must survive with its DRAFT.
    server.opts.postThrows = true;
    // a content temp (id<0, below the -20 clearKv floor so its DRAFT survives the
    // beforeEach wipe) that we then open via its sidebar row.
    localStorage.setItem(TEMPS_KEY, JSON.stringify([{ id: -33, title: "TempDraft", updated_at: 9_999_999 }]));
    kv.set(DRAFT + -33, "# TempDraft\n\ndraft-only body");
    location.hash = "";
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".status.offline")).toBeTruthy());
    await waitFor(() => {
      const titles = Array.from(container.querySelectorAll(".memo-title")).map((e) => e.textContent);
      expect(titles).toContain("TempDraft");
    });

    // count per-memo GETs so we can prove opening the temp issues NONE (id<0 return)
    const memoGets = () =>
      server.fetchImpl.mock.calls.filter(
        (c) => /\/memos\/-?\d+$/.test(String(c[0])) && (c[1]?.method || "GET") === "GET"
      ).length;
    const before = memoGets();
    const li = Array.from(container.querySelectorAll(".memo-list li")).find(
      (el) => el.querySelector(".memo-title")?.textContent === "TempDraft"
    )!;
    await act(async () => {
      fireEvent.click(li);
    });
    // draft beats cache → DRAFT shown instantly; id<0 → early return, no per-memo GET
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("draft-only body")
    );
    expect(memoGets()).toBe(before);
  });
});

describe("blank temp handling", () => {
  it("skips a blank temp on materialize (no POST) instead of uploading it", async () => {
    authedBoot();
    const { container } = render(<App />);
    // boot creates a blank temp ("# ")
    await waitFor(() => expect(JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]").length).toBe(1));
    // a focus-triggered materializeTemps sees the blank temp and skips it (the
    // isBlank `continue` arm) — no POST, nothing reaches the server
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]").length).toBe(1);
    expect(server.memos.length).toBe(0);
    expect(
      server.fetchImpl.mock.calls.some(
        ([u, i]) => String(u).endsWith("/memos") && (i?.method || "").toUpperCase() === "POST"
      )
    ).toBe(false);
  });

  it("skips a temp whose draft is missing on materialize (no POST)", async () => {
    authedBoot();
    const { container } = render(<App />);
    // wait for boot to FULLY settle (the boot temp is created AFTER the boot cleanup)
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]").length).toBeGreaterThan(0)
    );
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());
    // inject a no-draft temp alongside the boot temp, then materializeTemps via focus →
    // body = kv.get(DRAFT) (null) ?? "" → "" → isBlank → skipped (no POST)
    const cur = JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]");
    localStorage.setItem(TEMPS_KEY, JSON.stringify([...cur, { id: -77, title: "Ghost", updated_at: 9 }]));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(
      JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]").some((t: { id: number }) => t.id === -77)
    ).toBe(true); // still there, not materialized
    expect(
      server.fetchImpl.mock.calls.some(
        ([u, i]) => String(u).endsWith("/memos") && (i?.method || "").toUpperCase() === "POST"
      )
    ).toBe(false);
  });

  it("ignores a re-entrant materialize while one is already in flight", async () => {
    authedBoot();
    // a content temp that materializes; gate its POST so it stays in flight
    localStorage.setItem(TEMPS_KEY, JSON.stringify([{ id: -88, title: "Gate", updated_at: 1 }]));
    kv.set(DRAFT + -88, "# Gate\n\nbody");
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const orig = server.fetchImpl;
    let postCount = 0;
    globalThis.fetch = vi.fn(async (input: any, init: any) => {
      if (String(input).endsWith("/memos") && (init?.method || "").toUpperCase() === "POST") {
        postCount++;
        await gate; // hold the first materialize's POST in flight
      }
      return orig(input, init);
    }) as unknown as typeof fetch;

    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".app")).toBeTruthy());
    // boot's materializeTemps POSTs -88 and blocks on the gate (materializing.current = true)
    await waitFor(() => expect(postCount).toBe(1));
    // a focus while it's in flight → the re-entrant materializeTemps returns early (guard)
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(postCount).toBe(1); // only one POST — the re-entrant call was guarded out
  });

  it("drops never-typed leftover temps at boot, keeps ones with content", async () => {
    authedBoot();
    server.opts.postThrows = true; // keep the content temp from materializing away
    localStorage.setItem(
      TEMPS_KEY,
      JSON.stringify([
        { id: -10, title: "HasContent", updated_at: 9 },
        { id: -11, title: "Untitled", updated_at: 8 }, // never typed (blank draft)
      ])
    );
    kv.set(DRAFT + -10, "# HasContent\n\nbody");
    // -11 has NO draft at all → kv.get returns null → `?? ""` → blank → dropped
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".app")).toBeTruthy());
    await waitFor(() =>
      expect(
        JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]").some((t: { id: number }) => t.id === -11)
      ).toBe(false)
    ); // no-draft (blank) temp dropped at boot
    expect(
      JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]").some((t: { id: number }) => t.id === -10)
    ).toBe(true); // content temp kept
  });
});

describe("deleteMemo title fallback + repeated delete", () => {
  it("uses Untitled for an empty title and clears a prior undo timer on a second delete", async () => {
    authedBoot();
    // seed two real memos, one with an EMPTY title so the `m?.title || \"Untitled\"` arm runs
    const blank = server.seed({ title: "", content: "x" }); // content non-blank, title empty
    const other = server.seed({ title: "Other", content: "# Other\n\nbody" });
    location.hash = "#" + other.id; // open a real memo so boot doesn't add an Untitled temp
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelectorAll(".memo-list li").length).toBeGreaterThanOrEqual(2));

    // first delete → sets undoTimer
    const blankLi = Array.from(container.querySelectorAll(".memo-list li")).find(
      (el) => el.querySelector(".memo-title")?.textContent === "Untitled"
    )!;
    await act(async () => {
      fireEvent.click(blankLi.querySelector(".del")!);
    });
    await waitFor(() => expect(container.querySelector(".toast")?.textContent).toContain('Deleted "Untitled"'));

    // second delete WITHOUT undoing → undoTimer.current already set → clearTimeout arm
    const otherLi = Array.from(container.querySelectorAll(".memo-list li")).find(
      (el) => el.querySelector(".memo-title")?.textContent === "Other"
    )!;
    await act(async () => {
      fireEvent.click(otherLi.querySelector(".del")!);
    });
    await waitFor(() => expect(container.querySelector(".toast")?.textContent).toContain('Deleted "Other"'));
    expect(blank).toBeTruthy();
    expect(other).toBeTruthy();
  });
});

describe("empty-title rendering", () => {
  it("renders Untitled for an empty-title memo in the sidebar and trash", async () => {
    authedBoot();
    server.seed({ title: "", content: "y" }); // empty-title live memo → sidebar Untitled
    const { container } = render(<App />);
    await waitFor(() => {
      const titles = Array.from(container.querySelectorAll(".memo-title")).map((e) => e.textContent);
      expect(titles).toContain("Untitled");
    });

    // now put an empty-title row in the trash and open the Trash tab (838 arm)
    const t = server.seed({ title: "", content: "z" });
    server.trash.push(...server.memos.splice(server.memos.indexOf(t), 1));
    const tabs = container.querySelectorAll(".side-tabs button");
    await act(async () => {
      fireEvent.click(tabs[1]); // Trash
    });
    await waitFor(() => {
      const tt = Array.from(container.querySelectorAll(".memo-list .memo-title")).map((e) => e.textContent);
      expect(tt).toContain("Untitled");
    });
  });
});

describe("save serialization on a temp with siblings", () => {
  it("saves a temp memo and leaves sibling rows untouched (false arm of the title map)", async () => {
    authedBoot();
    // keep POSTs failing so boot's materializeTemps can't push the temps away —
    // both must persist so the save() .map hits the `: t` arm. Both have content
    // so the boot cleanup (which drops blank temps) keeps them.
    server.opts.postThrows = true;
    // two temps so save()'s .map over temps/memos hits the `: t` / `: x` false arm
    localStorage.setItem(
      TEMPS_KEY,
      JSON.stringify([
        { id: -55, title: "Temp", updated_at: 3 },
        { id: -56, title: "Sibling", updated_at: 2 },
      ])
    );
    kv.set(DRAFT + -55, "# Temp\n\nstart");
    kv.set(DRAFT + -56, "# Sibling\n\nsibling body");
    location.hash = "#-55";
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());
    await waitFor(() => {
      const titles = Array.from(container.querySelectorAll(".memo-title")).map((e) => e.textContent);
      expect(titles).toContain("Sibling");
    });

    // type into the open temp (-55) → save() updates ONLY -55, mapping past -56
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.input(ta, { target: { value: "# Renamed temp\n\nbody" } });
    });
    await waitFor(() => {
      const temps = JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]");
      const me = temps.find((t: { id: number }) => t.id === -55);
      const sib = temps.find((t: { id: number }) => t.id === -56);
      expect(me?.title).toBe("Renamed temp");
      expect(sib?.title).toBe("Sibling"); // sibling untouched
    });
  });
});

describe("onEdit guard while a banner is up", () => {
  it("does not re-arm a save while the conflict banner is showing", async () => {
    authedBoot();
    const row = server.seed({ title: "Guard", content: "# Guard" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());

    server.opts.putStatus = 409;
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.input(ta, { target: { value: "# Guard\n\nmine" } });
    });
    await waitFor(() => expect(container.querySelector(".conflict")).toBeTruthy());
    // let any debounced PUT from the first edit fully settle so the count is stable
    await new Promise((r) => setTimeout(r, 50));

    // keep PUT at 409; type again while the banner is up → onEdit persists the draft
    // (kv.set) but returns at the conflict guard, arming no new debounced save.
    const puts = () =>
      server.fetchImpl.mock.calls.filter(
        (c) => String(c[0]).includes(`/memos/${row.id}`) && (c[1] as RequestInit)?.method === "PUT"
      ).length;
    const before = puts();
    await act(async () => {
      fireEvent.input(ta, { target: { value: "# Guard\n\nmine more typing" } });
    });
    await new Promise((r) => setTimeout(r, 100));
    // no additional PUT was issued by the guarded edit; the banner is still up
    expect(puts()).toBe(before);
    expect(container.querySelector(".conflict")).toBeTruthy();
    // the draft is still persisted locally (kv.set runs before the guard returns)
    expect(kv.get(DRAFT + row.id)).toContain("mine more typing");
  });
});

describe("overwrite success", () => {
  it("overwrite forces a PUT and clears the conflict", async () => {
    authedBoot();
    const row = server.seed({ title: "Ow", content: "# Ow\n\nbase" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("base")
    );
    server.opts.putStatus = 409;
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.input(ta, { target: { value: "# Ow\n\nlocal" } });
    });
    await waitFor(() => expect(container.querySelector(".conflict")).toBeTruthy());
    server.opts.putStatus = 0;
    const buttons = container.querySelectorAll(".conflict button");
    await act(async () => {
      fireEvent.click(buttons[1]); // Overwrite (id != null branch)
    });
    await waitFor(() => expect(container.querySelector(".conflict")).toBeFalsy());
    await waitFor(() => expect(server.memos.find((m) => m.id === row.id)?.content).toContain("local"));
  });
});

describe("conflict/deleted resolvers with a null current id", () => {
  // Deleting the open memo from the sidebar nulls currentId WITHOUT clearing the
  // conflict/deleted banner (deleteMemo touches neither flag), so the banner's
  // resolver buttons can be clicked while currentIdRef.current === null — that's
  // the `if (id == null) return` guard in reloadCurrent / overwrite / recoverAsNew.

  async function raiseConflictThenDeleteOpen(container: HTMLElement, row: { id: number }) {
    server.opts.putStatus = 409;
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.input(ta, { target: { value: "# X\n\nmine" } });
    });
    await waitFor(() => expect(container.querySelector(".conflict")).toBeTruthy());
    server.opts.putStatus = 0;
    // delete the (still-listed) open memo via its × → currentId becomes null,
    // but the conflict banner stays mounted
    const li = Array.from(container.querySelectorAll(".memo-list li")).find(
      (el) => el.className.includes("active")
    ) as HTMLElement | undefined;
    const target =
      li ?? (Array.from(container.querySelectorAll(".memo-list li")).find((el) =>
        el.querySelector(".memo-title")
      ) as HTMLElement);
    await act(async () => {
      fireEvent.click(target.querySelector(".del")!);
    });
    await waitFor(() => expect(container.querySelector(".center")).toBeTruthy()); // editor gone (id null)
    expect(container.querySelector(".conflict")).toBeTruthy(); // banner still up
  }

  it("reloadCurrent and overwrite return early when current id is null", async () => {
    authedBoot();
    const row = server.seed({ title: "X", content: "# X\n\nv1" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("v1")
    );
    await raiseConflictThenDeleteOpen(container as unknown as HTMLElement, row);

    const buttons = container.querySelectorAll(".conflict button");
    // Reload → reloadCurrent: id == null → return (no crash, banner unchanged)
    await act(async () => {
      fireEvent.click(buttons[0]);
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(container.querySelector(".conflict")).toBeTruthy();
    // Overwrite → overwrite: id == null → return
    await act(async () => {
      fireEvent.click(container.querySelectorAll(".conflict button")[1]);
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(container.querySelector(".app")).toBeTruthy();
  });

  it("recoverAsNew returns early when current id is null", async () => {
    authedBoot();
    const row = server.seed({ title: "Y", content: "# Y\n\nv1" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("v1")
    );

    // raise the DELETED banner (404 PUT), then delete the open memo from the sidebar
    server.opts.putStatus = 404;
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.input(ta, { target: { value: "# Y\n\nbye" } });
    });
    await waitFor(() => expect(container.querySelector(".conflict span")?.textContent).toContain("삭제"));
    server.opts.putStatus = 0;

    const activeLi = Array.from(container.querySelectorAll(".memo-list li")).find((el) =>
      el.className.includes("active")
    ) as HTMLElement | undefined;
    const target =
      activeLi ?? (container.querySelector(".memo-list li") as HTMLElement);
    await act(async () => {
      fireEvent.click(target.querySelector(".del")!);
    });
    await waitFor(() => expect(container.querySelector(".center")).toBeTruthy());
    expect(container.querySelector(".conflict")).toBeTruthy(); // deleted banner still up

    const before = server.memos.length;
    // 새 메모로 복구 → recoverAsNew: id == null → return (no new memo created)
    await act(async () => {
      fireEvent.click(container.querySelectorAll(".conflict button")[0]);
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(server.memos.length).toBe(before);
    expect(container.querySelector(".app")).toBeTruthy();
  });
});

describe("recoverAsNew success path", () => {
  it("creates a brand-new memo holding the rescued content and drops the old row", async () => {
    authedBoot();
    const gone = server.seed({ title: "RescueMe", content: "# RescueMe\n\norig" });
    const keep = server.seed({ title: "Keep", content: "# Keep\n\nkeep body" });
    location.hash = "#" + gone.id;
    const { container } = render(<App />);
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("orig")
    );

    server.opts.putStatus = 404; // deleted-elsewhere banner
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.input(ta, { target: { value: "# RescueMe\n\nrescued for real" } });
    });
    await waitFor(() => expect(container.querySelector(".conflict span")?.textContent).toContain("삭제"));

    server.opts.putStatus = 0; // recoverAsNew's POST+PUT succeed now
    const btns = container.querySelectorAll(".conflict button");
    await act(async () => {
      fireEvent.click(btns[0]); // 새 메모로 복구
    });
    await waitFor(() => expect(container.querySelector(".conflict")).toBeFalsy());
    // a NEW server memo holds the rescued content; the old row was filtered out
    await waitFor(() => expect(server.memos.some((m) => m.content.includes("rescued for real"))).toBe(true));
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("rescued for real")
    );
    expect(keep).toBeTruthy();
  });
});

describe("background sync edge branches", () => {
  it("skips sync entirely when the document is hidden", async () => {
    authedBoot();
    const row = server.seed({ title: "Hid", content: "# Hid\n\nv1" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("v1")
    );

    // change elsewhere, but hide the tab → sync() returns at document.hidden
    row.content = "# Hid\n\nv2 remote";
    row.updated_at = server.now() + 100000;
    const hiddenSpy = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const memosBefore = server.fetchImpl.mock.calls.filter(
      (c) => String(c[0]).endsWith("/memos") && (c[1]?.method || "GET") === "GET"
    ).length;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await new Promise((r) => setTimeout(r, 30));
    const memosAfter = server.fetchImpl.mock.calls.filter(
      (c) => String(c[0]).endsWith("/memos") && (c[1]?.method || "GET") === "GET"
    ).length;
    expect(memosAfter).toBe(memosBefore); // no list fetch happened
    // editor still shows the old content (no reload)
    expect((container.querySelector("textarea.editor") as HTMLTextAreaElement).value).toContain("v1");
    hiddenSpy.mockRestore();
  });

  it("returns early when the sync list fetch is not ok", async () => {
    authedBoot();
    const row = server.seed({ title: "NotOk", content: "# NotOk\n\nv1" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("v1")
    );

    // make the next GET /memos return a non-ok status → sync's `!r.ok` early return
    const orig = server.fetchImpl;
    let blocked = true;
    globalThis.fetch = vi.fn(async (input: any, init: any) => {
      const url = String(input);
      if (blocked && url.endsWith("/memos") && (init?.method || "GET") === "GET") {
        return new Response("", { status: 500 });
      }
      return orig(input, init);
    }) as unknown as typeof fetch;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await new Promise((r) => setTimeout(r, 30));
    blocked = false;
    // still rendered, content unchanged (sync bailed at !r.ok)
    expect((container.querySelector("textarea.editor") as HTMLTextAreaElement).value).toContain("v1");
  });

  it("returns null and bails when the sync list fetch rejects", async () => {
    authedBoot();
    const row = server.seed({ title: "Rej", content: "# Rej\n\nv1" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("v1")
    );
    // make the sync list GET reject → the `.catch(() => null)` arm → `!r` early return.
    const orig = server.fetchImpl;
    let blocked = true;
    globalThis.fetch = vi.fn(async (input: any, init: any) => {
      const url = String(input);
      if (blocked && url.endsWith("/memos") && (init?.method || "GET") === "GET") {
        throw new Error("offline");
      }
      return orig(input, init);
    }) as unknown as typeof fetch;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await new Promise((r) => setTimeout(r, 30));
    blocked = false;
    expect(container.querySelector(".app")).toBeTruthy();
  });

  it("skips the per-memo reload during sync while a conflict banner is up", async () => {
    authedBoot();
    const row = server.seed({ title: "ConflictSync", content: "# ConflictSync\n\nv1" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("v1")
    );

    // raise a conflict so conflictRef.current is true (a synchronous ref) — the sync
    // guard's `conflictRef.current` arm then makes the per-memo reload `return`.
    server.opts.putStatus = 409;
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.input(ta, { target: { value: "# ConflictSync\n\nmine" } });
    });
    await waitFor(() => expect(container.querySelector(".conflict")).toBeTruthy());

    // change the memo remotely; a focus sync runs the list but the guard returns at
    // conflictRef before adopting remote content (so the editor is untouched).
    server.opts.putStatus = 0;
    row.content = "# ConflictSync\n\nv2 remote";
    row.updated_at = 9_999_999;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await new Promise((r) => setTimeout(r, 40));
    // still showing the local edit, banner still up — no remote adoption happened
    expect((container.querySelector("textarea.editor") as HTMLTextAreaElement).value).toContain("mine");
    expect(container.querySelector(".conflict")).toBeTruthy();
  });

  it("skips the per-memo reload during sync while an unsynced draft is pending", async () => {
    authedBoot();
    const row = server.seed({ title: "DraftPend", content: "# DraftPend\n\nv1" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("v1")
    );
    await waitFor(() => expect(kv.get(DRAFT + row.id)).toBeNull());

    // Put an unsynced DRAFT in place WITHOUT typing (so timer.current stays null and
    // the 623 guard falls through), and gate PUTs so recover()'s push to clear that
    // draft stays in flight while sync reaches the `kv.get(DRAFT+id) != null` guard.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const orig = server.fetchImpl;
    globalThis.fetch = vi.fn(async (input: any, init: any) => {
      if ((init?.method || "GET") === "PUT" && String(input).includes(`/memos/${row.id}`)) {
        await gate; // hold recover()'s save in flight → DRAFT not yet removed
      }
      return orig(input, init);
    }) as unknown as typeof fetch;
    kv.set(DRAFT + row.id, "# DraftPend\n\nunsynced local");

    // a newer remote version exists; the draft guard must prevent adopting it
    row.content = "# DraftPend\n\nv2 remote";
    row.updated_at = 9_999_999;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await new Promise((r) => setTimeout(r, 40));
    // sync hit `if (kv.get(DRAFT+id) != null) return` → no remote adoption
    expect((container.querySelector("textarea.editor") as HTMLTextAreaElement).value).not.toContain("v2 remote");
    release();
    await new Promise((r) => setTimeout(r, 10));
  });

  it("skips sync reload for a temp memo (id < 0)", async () => {
    authedBoot();
    const { container } = render(<App />);
    // boot creates a fresh temp (id<0) and opens it
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());
    await waitFor(() => expect(location.hash).toMatch(/^#-\d+$/));
    // the focus sync runs the list, then the per-memo guard's `id < 0` arm returns
    // before any reload (a blank temp is also skipped by materializeTemps)
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await new Promise((r) => setTimeout(r, 30));
    // still the open temp, no per-memo reload happened
    expect(container.querySelector("textarea.editor")).toBeTruthy();
    expect(location.hash).toMatch(/^#-\d+$/);
  });

});

describe("beforeunload temp + in-flight branches", () => {
  it("does nothing on unload for a temp memo with content (id < 0)", async () => {
    authedBoot();
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());
    // give the boot temp content so it's no longer a fresh-blank temp
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.input(ta, { target: { value: "# Has content\n\nbody" } });
    });
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]")[0]?.title).toBe("Has content")
    );

    const before = server.fetchImpl.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("beforeunload"));
    });
    // id < 0 with content → handler returns; no purge/PUT, and the temp is kept
    const after = server.fetchImpl.mock.calls
      .slice(before)
      .find((c) => String(c[0]).includes("purge=1") || (c[1] as RequestInit)?.method === "PUT");
    expect(after).toBeFalsy();
    expect(JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]").length).toBe(1);
  });

  it("warns on unload when a save is in flight (inFlight arm)", async () => {
    authedBoot();
    const row = server.seed({ title: "Inflight", content: "# Inflight\n\nv1" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());

    // gate the PUT so a save stays in flight while we fire beforeunload
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const orig = server.fetchImpl;
    globalThis.fetch = vi.fn(async (input: any, init: any) => {
      if ((init?.method || "GET") === "PUT" && String(input).includes(`/memos/${row.id}`)) {
        await gate;
      }
      return orig(input, init);
    }) as unknown as typeof fetch;

    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.input(ta, { target: { value: "# Inflight\n\nnow editing" } });
      fireEvent.keyDown(window, { key: "s", metaKey: true }); // force save → inFlight true
    });
    // memo has content → not fresh-blank, so the in-flight warn branch is reached;
    // fire unload while the PUT is gated (timer cleared by Cmd+S, but inFlight true)
    const evt = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    await act(async () => {
      window.dispatchEvent(evt);
    });
    expect(evt.defaultPrevented).toBe(true);
    release();
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe("Alt nav guard branches", () => {
  it("ignores Alt with a non-J/K key", async () => {
    authedBoot();
    server.seed({ title: "N1", content: "# N1" });
    server.seed({ title: "N2", content: "# N2" });
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelectorAll(".memo-list li").length).toBeGreaterThanOrEqual(2));
    await act(async () => {
      fireEvent.click(container.querySelector(".memo-list li")!);
    });
    await waitFor(() => expect(container.querySelector(".memo-list li.active")).toBeTruthy());
    const activeBefore = container.querySelector(".memo-list li.active")?.textContent;
    // Alt + a different physical key → the `code !== KeyK && code !== KeyJ` guard
    await act(async () => {
      fireEvent.keyDown(window, { code: "KeyL", altKey: true });
    });
    expect(container.querySelector(".memo-list li.active")?.textContent).toBe(activeBefore);
  });

  it("does nothing on Alt+J when the visible list is empty", async () => {
    authedBoot();
    server.seed({ title: "Solo", content: "# Solo" });
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelectorAll(".memo-list li").length).toBeGreaterThanOrEqual(1));
    // filter so the visible list is empty
    await act(async () => {
      fireEvent.input(container.querySelector(".search")!, { target: { value: "zzz-no-match" } });
    });
    await waitFor(() => expect(container.querySelector(".empty")?.textContent).toBe("No matches"));
    // Alt+J with an empty list → `if (!list.length) return`
    await act(async () => {
      fireEvent.keyDown(window, { code: "KeyJ", altKey: true });
    });
    expect(container.querySelector(".empty")?.textContent).toBe("No matches");
  });

  it("wraps to the first when the current id is not in the visible list (Alt+J)", async () => {
    authedBoot();
    server.seed({ title: "Wone", content: "# Wone" });
    server.seed({ title: "Wtwo", content: "# Wtwo" });
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelectorAll(".memo-list li").length).toBeGreaterThanOrEqual(2));
    // boot opened a fresh memo whose id is NOT in this seeded list (idx === -1).
    // Alt+J → idx -1 → down → index 0 (first visible).
    await act(async () => {
      fireEvent.keyDown(window, { code: "KeyJ", altKey: true }); // -> first
    });
    await waitFor(() => expect(container.querySelector(".memo-list li.active")).toBeTruthy());
    expect(container.querySelector(".memo-list li.active")?.textContent).toBeTruthy();
  });

  it("wraps to the last when the current id is not in the list and going up (Alt+K)", async () => {
    authedBoot();
    server.seed({ title: "Kone", content: "# Kone" });
    server.seed({ title: "Ktwo", content: "# Ktwo" });
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelectorAll(".memo-list li").length).toBeGreaterThanOrEqual(2));
    // boot's fresh memo isn't in the seeded list → idx -1 → up → length-1 (last)
    await act(async () => {
      fireEvent.keyDown(window, { code: "KeyK", altKey: true });
    });
    await waitFor(() => expect(container.querySelector(".memo-list li.active")).toBeTruthy());
  });

  it("clamps at the ends (Alt+J on the last, Alt+K on the first)", async () => {
    authedBoot();
    server.seed({ title: "Cone", content: "# Cone" });
    server.seed({ title: "Ctwo", content: "# Ctwo" });
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelectorAll(".memo-list li").length).toBeGreaterThanOrEqual(2));

    const lis = () => Array.from(container.querySelectorAll(".memo-list li"));
    // First open a seeded memo to flush the boot's fresh-blank "Untitled" memo out of
    // the list (leaveCurrent purges it), so the list is the stable {Cone, Ctwo}.
    await act(async () => {
      fireEvent.click(
        Array.from(lis()).find((el) => el.querySelector(".memo-title")?.textContent === "Cone")!
      );
    });
    await waitFor(() => {
      const titles = Array.from(container.querySelectorAll(".memo-title")).map((e) => e.textContent);
      expect(titles).not.toContain("Untitled");
      expect(titles).toContain("Cone");
      expect(titles).toContain("Ctwo");
    });

    // open the LAST visible memo
    await act(async () => {
      fireEvent.click(lis()[lis().length - 1]);
    });
    await waitFor(() => expect(container.querySelector(".memo-list li.active")).toBeTruthy());
    const lastTitle = container.querySelector(".memo-list li.active")?.textContent;
    // Alt+J at the bottom → next >= length → clamp (no change)
    await act(async () => {
      fireEvent.keyDown(window, { code: "KeyJ", altKey: true });
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(container.querySelector(".memo-list li.active")?.textContent).toBe(lastTitle);

    // open the FIRST visible memo, Alt+K at the top → next < 0 → clamp
    await act(async () => {
      fireEvent.click(lis()[0]);
    });
    await waitFor(() => expect(container.querySelector(".memo-list li.active")).toBeTruthy());
    const firstTitle = container.querySelector(".memo-list li.active")?.textContent;
    await act(async () => {
      fireEvent.keyDown(window, { code: "KeyK", altKey: true });
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(container.querySelector(".memo-list li.active")?.textContent).toBe(firstTitle);
  });
});

describe("onDrop no-files branch", () => {
  it("does nothing when a drop carries no files", async () => {
    authedBoot();
    const row = server.seed({ title: "Drp", content: "# Drp\n\nbody" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("body")
    );
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    const before = ta.value;
    const memosBefore = server.memos.length;
    // a drop event with an empty files list → `if (files && files.length)` false arm
    const dt = { files: [], types: [] } as unknown as DataTransfer;
    await act(async () => {
      fireEvent.drop(ta, { dataTransfer: dt });
    });
    await new Promise((r) => setTimeout(r, 10));
    expect((container.querySelector("textarea.editor") as HTMLTextAreaElement).value).toBe(before);
    expect(server.memos.length).toBe(memosBefore);
  });
});

describe("discardDeleted removes the open real memo from the list", () => {
  it("filters the trashed-elsewhere memo out of the sidebar", async () => {
    authedBoot();
    const row = server.seed({ title: "Discardable", content: "# Discardable\n\nbody" });
    const keep = server.seed({ title: "Stay", content: "# Stay\n\nstay body" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("body")
    );

    // raise the deleted-elsewhere banner via a 404 PUT, then discard
    server.opts.putStatus = 404;
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.input(ta, { target: { value: "# Discardable\n\nbye now" } });
    });
    await waitFor(() => expect(container.querySelector(".conflict span")?.textContent).toContain("삭제"));

    const btns = container.querySelectorAll(".conflict button");
    await act(async () => {
      fireEvent.click(btns[1]); // 버리기 → discardDeleted (id != null → setMemos filter)
    });
    await waitFor(() => expect(container.querySelector(".center")).toBeTruthy());
    // the discarded memo is gone from the sidebar; the other memo stays
    await waitFor(() => {
      const titles = Array.from(container.querySelectorAll(".memo-title")).map((e) => e.textContent);
      expect(titles).not.toContain("Discardable");
      expect(titles).toContain("Stay");
    });
    expect(keep).toBeTruthy();
  });
});

describe("background sync probe rejection", () => {
  it("does not raise the deleted banner when the 404-probe fetch rejects", async () => {
    authedBoot();
    const row = server.seed({ title: "Probe", content: "# Probe\n\nv1" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("v1")
    );

    // remove the memo from the list (so `!cur`), but make the per-memo probe GET
    // REJECT → the `.catch(() => null)` arm → probe is null → no banner raised.
    const orig = server.fetchImpl;
    globalThis.fetch = vi.fn(async (input: any, init: any) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      if (url.endsWith("/memos") && method === "GET") {
        // report a list WITHOUT this row so sync takes the `!cur` path
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET" && new RegExp(`/memos/${row.id}$`).test(url)) {
        throw new Error("probe offline"); // probe rejects → caught → null
      }
      return orig(input, init);
    }) as unknown as typeof fetch;

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await new Promise((r) => setTimeout(r, 40));
    // probe rejected → null → the deleted banner is NOT shown
    expect(container.querySelector(".conflict")).toBeFalsy();
    expect(container.querySelector(".app")).toBeTruthy();
  });
});

// ===========================================================================
// COVERAGE FILL — remaining implicit-else / false-condition arms
// ===========================================================================
describe("deleteMemo a non-current temp (currentId !== id)", () => {
  it("drops a temp that is not the open memo without clearing the editor", async () => {
    authedBoot();
    // two content temps; keep POSTs failing so neither materializes
    server.opts.postThrows = true;
    localStorage.setItem(
      TEMPS_KEY,
      JSON.stringify([
        { id: -71, title: "OpenTemp", updated_at: 9_999_999 },
        { id: -72, title: "OtherTemp", updated_at: 9_999_998 },
      ])
    );
    kv.set(DRAFT + -71, "# OpenTemp\n\nopen body");
    kv.set(DRAFT + -72, "# OtherTemp\n\nother body");
    location.hash = "";
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".status.offline")).toBeTruthy());
    await waitFor(() => {
      const titles = Array.from(container.querySelectorAll(".memo-title")).map((e) => e.textContent);
      expect(titles).toContain("OpenTemp");
      expect(titles).toContain("OtherTemp");
    });
    // open -71 so it's the current memo
    const openLi = Array.from(container.querySelectorAll(".memo-list li")).find(
      (el) => el.querySelector(".memo-title")?.textContent === "OpenTemp"
    )!;
    await act(async () => {
      fireEvent.click(openLi);
    });
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("open body")
    );
    // delete the OTHER temp (-72) → deleteMemo's `currentId === id` is FALSE (else arm),
    // so the editor stays on -71
    const otherLi = Array.from(container.querySelectorAll(".memo-list li")).find(
      (el) => el.querySelector(".memo-title")?.textContent === "OtherTemp"
    )!;
    await act(async () => {
      fireEvent.click(otherLi.querySelector(".del")!);
    });
    await waitFor(() => {
      const titles = Array.from(container.querySelectorAll(".memo-title")).map((e) => e.textContent);
      expect(titles).not.toContain("OtherTemp");
    });
    // editor still shows the open temp (currentId untouched)
    expect((container.querySelector("textarea.editor") as HTMLTextAreaElement).value).toContain("open body");
  });
});

describe("save with a blank value (false arm of !isBlank)", () => {
  it("does not un-freshen a memo when the saved value is blank", async () => {
    authedBoot();
    const row = server.seed({ title: "Blanky", content: "# Blanky\n\nstart" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("start")
    );
    // type a BLANK value ("# " only) then Cmd+S → save() with isBlank(value) true →
    // the `if (!isBlank(value))` guard takes its else arm (no freshIds.delete)
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.input(ta, { target: { value: "#   " } });
    });
    // separate act so the content state propagates before Cmd+S reads it
    await act(async () => {
      fireEvent.keyDown(window, { key: "s", metaKey: true });
    });
    await waitFor(() => expect(server.memos.find((m) => m.id === row.id)?.content).toBe("#   "));
  });
});

describe("discardDeleted with a null current id (id == null else)", () => {
  it("clears the deleted banner even when the open memo was already removed", async () => {
    authedBoot();
    const row = server.seed({ title: "Zd", content: "# Zd\n\nv1" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("v1")
    );
    // raise the deleted banner, then delete the open memo from the sidebar → currentId
    // becomes null while the banner stays up
    server.opts.putStatus = 404;
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.input(ta, { target: { value: "# Zd\n\nbye" } });
    });
    await waitFor(() => expect(container.querySelector(".conflict span")?.textContent).toContain("삭제"));
    server.opts.putStatus = 0;
    const target = container.querySelector(".memo-list li") as HTMLElement;
    await act(async () => {
      fireEvent.click(target.querySelector(".del")!);
    });
    await waitFor(() => expect(container.querySelector(".center")).toBeTruthy());
    expect(container.querySelector(".conflict")).toBeTruthy();
    // 버리기 → discardDeleted: id == null → the `if (id != null)` else arm; banner clears
    await act(async () => {
      fireEvent.click(container.querySelectorAll(".conflict button")[1]);
    });
    await waitFor(() => expect(container.querySelector(".conflict")).toBeFalsy());
  });
});

describe("Cmd/Ctrl key handler false arms", () => {
  it("Cmd+S with no pending timer still saves (timer.current else arm)", async () => {
    authedBoot();
    const row = server.seed({ title: "NoTimer", content: "# NoTimer\n\nv1" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("v1")
    );
    await waitFor(() => expect(kv.get(DRAFT + row.id)).toBeNull()); // settled, no timer
    // Cmd+S with no debounce pending → `if (timer.current)` else arm, save still runs
    await act(async () => {
      fireEvent.keyDown(window, { key: "s", metaKey: true });
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector(".app")).toBeTruthy();
  });

  it("Cmd + an unrelated key is ignored (k === 'k' else)", async () => {
    authedBoot();
    const row = server.seed({ title: "OtherKey", content: "# OtherKey\n\nv1" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());
    const before = server.memos.length;
    // Cmd+P (not s, not k) → k === "s" false, k === "k" false (else of the else-if)
    await act(async () => {
      fireEvent.keyDown(window, { key: "p", metaKey: true });
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(server.memos.length).toBe(before); // no new memo, no crash
  });
});

describe("beforeunload nothing-pending else arm", () => {
  it("does not warn on unload when no save is pending for a non-fresh memo", async () => {
    authedBoot();
    const row = server.seed({ title: "Clean", content: "# Clean\n\nv1" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("v1")
    );
    // make sure the memo is non-fresh + has no pending save (open + settled, never edited)
    await waitFor(() => expect(kv.get(DRAFT + row.id)).toBeNull());
    const evt = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    await act(async () => {
      window.dispatchEvent(evt);
    });
    // nothing pending → the `timer||inFlight||pending` guard is false → no preventDefault
    expect(evt.defaultPrevented).toBe(false);
  });
});

describe("onDragOver without a Files payload (else arm)", () => {
  it("does not preventDefault when the drag has no Files type", async () => {
    authedBoot();
    const row = server.seed({ title: "Dg", content: "# Dg\n\nbody" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("body")
    );
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    // dragOver with types lacking "Files" → `types?.includes("Files")` false → no preventDefault.
    // Use the testing-library helper so preact's synthetic onDragOver handler runs, and
    // assert via a spy on preventDefault (defaultPrevented isn't reliably mirrored).
    const dt = { types: ["text/plain"] } as unknown as DataTransfer;
    let prevented = false;
    await act(async () => {
      fireEvent.dragOver(ta, {
        dataTransfer: dt,
        preventDefault: () => {
          prevented = true;
        },
      });
    });
    expect(prevented).toBe(false);
  });
});

// ===========================================================================
// TRASH VIEW DOCUMENT (read-only inspect, then restore / hide from the banner)
// ===========================================================================
// helper: open the Trash tab with one trashed memo, returning its container
async function openTrashWith(container: HTMLElement, ...seeded: { id: number }[]) {
  // move the seeded rows into the trash
  for (const s of seeded) {
    const idx = server.memos.findIndex((m) => m.id === s.id);
    if (idx !== -1) server.trash.push(...server.memos.splice(idx, 1));
  }
  const tabs = container.querySelectorAll(".side-tabs button");
  await act(async () => {
    fireEvent.click(tabs[1]); // Trash
  });
  await waitFor(() =>
    expect(container.querySelectorAll(".memo-list .restore").length).toBe(seeded.length)
  );
}

describe("trash view document", () => {
  it("opens a trashed memo read-only, then restores it from the banner", async () => {
    authedBoot();
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".side-tabs")).toBeTruthy());
    const a = server.seed({ title: "ViewA", content: "# ViewA\n\nlook at me" });
    await openTrashWith(container as unknown as HTMLElement, a);

    // click the trashed row body (not the action buttons) → viewTrash(id)
    const row = Array.from(container.querySelectorAll(".memo-list li")).find(
      (el) => el.querySelector(".memo-title")?.textContent === "ViewA"
    )!;
    await act(async () => {
      fireEvent.click(row);
    });
    // read-only editor shows the trashed content + the trash banner appears
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("look at me")
    );
    expect((container.querySelector("textarea.editor") as HTMLTextAreaElement).readOnly).toBe(true);
    expect(container.querySelector(".conflict span")?.textContent).toContain("휴지통");
    // the open trashed row is marked active (m.id === viewing?.id true arm, line 921)
    expect(container.querySelector(".memo-list li.active")).toBeTruthy();

    // 복구 button (line 1054) → restoreMemo: viewing.id === id → setViewing(null)
    const btns = container.querySelectorAll(".conflict button");
    await act(async () => {
      fireEvent.click(btns[0]); // 복구
    });
    // banner clears (viewing nulled), the row left the trash list
    await waitFor(() => expect(container.querySelector(".conflict")).toBeFalsy());
    expect(server.memos.some((m) => m.id === a.id)).toBe(true);
  });

  it("opens a trashed memo read-only, then hides it from the banner", async () => {
    authedBoot();
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".side-tabs")).toBeTruthy());
    const b = server.seed({ title: "ViewB", content: "# ViewB\n\nhide me" });
    await openTrashWith(container as unknown as HTMLElement, b);

    const row = Array.from(container.querySelectorAll(".memo-list li")).find(
      (el) => el.querySelector(".memo-title")?.textContent === "ViewB"
    )!;
    await act(async () => {
      fireEvent.click(row);
    });
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("hide me")
    );

    // 숨기기 button (line 1055) → hideTrash: viewing.id === id → setViewing(null)
    const btns = container.querySelectorAll(".conflict button");
    await act(async () => {
      fireEvent.click(btns[1]); // 숨기기
    });
    await waitFor(() => expect(container.querySelector(".conflict")).toBeFalsy());
    // hidden → gone from the trash list
    await waitFor(() =>
      expect(container.querySelector(".memo-list .empty")?.textContent).toBe("Trash is empty")
    );
  });

  it("refreshes the trash list when the trashed memo was already gone (viewTrash !ok)", async () => {
    authedBoot();
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".side-tabs")).toBeTruthy());
    const c = server.seed({ title: "ViewGone", content: "# ViewGone\n\nbody" });
    await openTrashWith(container as unknown as HTMLElement, c);

    // remove it from the trash server-side so GET /trash/:id 404s (restored/hidden elsewhere)
    const ti = server.trash.findIndex((m) => m.id === c.id);
    server.trash.splice(ti, 1);

    const row = Array.from(container.querySelectorAll(".memo-list li")).find(
      (el) => el.querySelector(".memo-title")?.textContent === "ViewGone"
    )!;
    await act(async () => {
      fireEvent.click(row); // viewTrash → !r.ok → setViewing(v?.id===id?null:v) + loadTrash()
    });
    // no read-only trash banner appeared (the 404 path never set `viewing`), and the
    // list refreshed to empty (loadTrash re-fetched the now-empty trash)
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector(".conflict")).toBeFalsy();
    await waitFor(() =>
      expect(container.querySelector(".memo-list .empty")?.textContent).toBe("Trash is empty")
    );
  });

  it("clears the open read-only view when re-opening a row that 404s (viewTrash !ok, v?.id === id true)", async () => {
    authedBoot();
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".side-tabs")).toBeTruthy());
    const a = server.seed({ title: "Vanish", content: "# Vanish\n\nbody" });
    await openTrashWith(container as unknown as HTMLElement, a);

    // open it read-only → viewing.id === a.id
    const row = container.querySelector(".memo-list li") as HTMLElement;
    await act(async () => {
      fireEvent.click(row);
    });
    await waitFor(() => expect(container.querySelector(".conflict")).toBeTruthy());

    // now it disappears from the trash server-side; re-clicking the SAME (still-listed)
    // row → viewTrash 404s → setViewing(v => v?.id === id ? null : v) TRUE arm → null
    const ti = server.trash.findIndex((m) => m.id === a.id);
    server.trash.splice(ti, 1);
    await act(async () => {
      fireEvent.click(container.querySelector(".memo-list li") as HTMLElement);
    });
    // the read-only view closed (viewing nulled by the true arm)
    await waitFor(() => expect(container.querySelector(".conflict")).toBeFalsy());
  });

  it("restores via the sidebar ↩ while NOT viewing that memo (v?.id === id false arm)", async () => {
    authedBoot();
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".side-tabs")).toBeTruthy());
    const a = server.seed({ title: "Ra", content: "# Ra" });
    const b = server.seed({ title: "Rb", content: "# Rb\n\nviewing this one" });
    await openTrashWith(container as unknown as HTMLElement, a, b);

    // open Rb in the read-only view, so viewing.id === b.id
    const rbRow = Array.from(container.querySelectorAll(".memo-list li")).find(
      (el) => el.querySelector(".memo-title")?.textContent === "Rb"
    )!;
    await act(async () => {
      fireEvent.click(rbRow);
    });
    await waitFor(() => expect(container.querySelector(".conflict")).toBeTruthy());

    // restore Ra via its sidebar ↩ button → restoreMemo(a.id): viewing.id (b) !== a.id
    // → the `v?.id === id ? null : v` FALSE arm keeps the Rb view open
    const raRow = Array.from(container.querySelectorAll(".memo-list li")).find(
      (el) => el.querySelector(".memo-title")?.textContent === "Ra"
    )!;
    await act(async () => {
      fireEvent.click(raRow.querySelector(".restore")!);
    });
    // Rb's view is still up (viewing not cleared)
    await waitFor(() => expect(server.memos.some((m) => m.id === a.id)).toBe(true));
    expect(container.querySelector(".conflict span")?.textContent).toContain("휴지통");
  });

  it("hides via the sidebar × while NOT viewing that memo (v?.id === id false arm)", async () => {
    authedBoot();
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".side-tabs")).toBeTruthy());
    const a = server.seed({ title: "Ha", content: "# Ha" });
    const b = server.seed({ title: "Hb", content: "# Hb\n\nstill viewing" });
    await openTrashWith(container as unknown as HTMLElement, a, b);

    const hbRow = Array.from(container.querySelectorAll(".memo-list li")).find(
      (el) => el.querySelector(".memo-title")?.textContent === "Hb"
    )!;
    await act(async () => {
      fireEvent.click(hbRow);
    });
    await waitFor(() => expect(container.querySelector(".conflict")).toBeTruthy());

    // hide Ha via its sidebar × → hideTrash(a.id): viewing (b) !== a.id → keep the Hb view
    const haRow = Array.from(container.querySelectorAll(".memo-list li")).find(
      (el) => el.querySelector(".memo-title")?.textContent === "Ha"
    )!;
    await act(async () => {
      fireEvent.click(haRow.querySelector(".del")!);
    });
    await waitFor(() =>
      expect(
        Array.from(container.querySelectorAll(".memo-title")).map((e) => e.textContent)
      ).not.toContain("Ha")
    );
    // Hb's read-only view remains open
    expect(container.querySelector(".conflict span")?.textContent).toContain("휴지통");
  });

  it("clears the read-only view when switching back to the Memos tab", async () => {
    authedBoot();
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".side-tabs")).toBeTruthy());
    const a = server.seed({ title: "Switch", content: "# Switch\n\nbody" });
    await openTrashWith(container as unknown as HTMLElement, a);
    const row = container.querySelector(".memo-list li") as HTMLElement;
    await act(async () => {
      fireEvent.click(row);
    });
    await waitFor(() => expect(container.querySelector(".conflict")).toBeTruthy());
    // Memos tab → setViewing(null), the read-only banner/view goes away
    const tabs = container.querySelectorAll(".side-tabs button");
    await act(async () => {
      fireEvent.click(tabs[0]);
    });
    await waitFor(() => expect(container.querySelector(".search")).toBeTruthy());
    expect(container.querySelector(".conflict")).toBeFalsy();
  });
});

// ===========================================================================
// leaveCurrent: a never-used new memo is always a local temp — opening another
// memo drops the blank temp on the way out (nothing was ever sent to the server)
// ===========================================================================
describe("leaveCurrent drops a blank temp on navigation", () => {
  it("drops the blank current temp when opening another memo", async () => {
    authedBoot();
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());
    // give the boot temp content so it survives, then create a second (blank) temp
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.input(ta, { target: { value: "# Kept\n\nreal" } });
    });
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]")[0]?.title).toBe("Kept")
    );
    // + New → a fresh blank temp becomes current; the "Kept" temp stays in the list
    await act(async () => {
      fireEvent.click(container.querySelector(".new-memo")!);
    });
    await waitFor(() => expect(container.querySelectorAll(".memo-list li").length).toBeGreaterThanOrEqual(2));
    // open "Kept" → leaveCurrent drops the blank fresh temp on leave (no server call)
    const keptLi = Array.from(container.querySelectorAll(".memo-list li")).find(
      (el) => el.querySelector(".memo-title")?.textContent === "Kept"
    )!;
    await act(async () => {
      fireEvent.click(keptLi);
    });
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("real")
    );
    // only the "Kept" temp remains; the abandoned blank one is gone
    expect(JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]").length).toBe(1);
    expect(server.fetchImpl.mock.calls.some(([u]) => String(u).includes("purge=1"))).toBe(false);
  });
});

// ===========================================================================
// save() un-acked retry path (lines 523-535, anon@526/527)
// ===========================================================================
describe("save un-acked 409 retry", () => {
  it("re-bases and retries when a 409 is our own un-acked keepalive write", async () => {
    authedBoot();
    const row = server.seed({ title: "Unacked", content: "# Unacked\n\nv1" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("v1")
    );
    await waitFor(() => expect(kv.get(DRAFT + row.id)).toBeNull());

    // Phase 1: a save whose response is "lost" (PUT rejects) → unacked.current set.
    // The server still commits the write so its content matches the un-acked value.
    const orig = server.fetchImpl;
    const unackedValue = "# Unacked\n\nkeepalive write";
    let phase: "lose" | "conflict" | "normal" = "lose";
    globalThis.fetch = vi.fn(async (input: any, init: any) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      if (method === "PUT" && url.includes(`/memos/${row.id}`)) {
        const body = init?.body ? JSON.parse(init.body) : {};
        if (phase === "lose") {
          // commit on the server but reject the response → unacked recorded
          row.content = unackedValue;
          row.updated_at = server.now() + 50;
          throw new Error("response lost");
        }
        if (phase === "conflict") {
          // first PUT of the next save 409s (stale base); after we re-base, succeed
          if (body.base !== row.updated_at) {
            return new Response("", { status: 409 });
          }
          row.content = body.content ?? "";
          row.updated_at = server.now() + 50;
          phase = "normal";
          return new Response(
            JSON.stringify({ title: "Unacked", updated_at: row.updated_at }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
      }
      return orig(input, init);
    }) as unknown as typeof fetch;

    // Phase 1 edit → the debounced save's PUT rejects → unacked.current = { id, value }
    // (input then a separate Cmd+S act so the content state propagates before save reads it)
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.input(ta, { target: { value: unackedValue } });
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "s", metaKey: true });
    });
    await waitFor(() => expect(container.querySelector(".status.offline")).toBeTruthy());

    // Phase 2: a new edit. The first PUT 409s (loadedAt is stale). save() sees the
    // un-acked pending matches the server content → re-bases (anon@526/527 GET +
    // json) and retries with the fresh base, which succeeds.
    phase = "conflict";
    const finalValue = "# Unacked\n\nresumed editing";
    await act(async () => {
      fireEvent.input(ta, { target: { value: finalValue } });
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "s", metaKey: true });
    });
    await waitFor(() => expect(row.content).toBe(finalValue));
    // the conflict banner was NOT raised — the 409 was recognised as our own write
    expect(container.querySelector(".conflict")).toBeFalsy();
  });

  it("falls through to a real conflict when the re-base probe GET is not ok (x.ok ? : null false arm)", async () => {
    authedBoot();
    const row = server.seed({ title: "Unacked2", content: "# Unacked2\n\nv1" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("v1")
    );
    await waitFor(() => expect(kv.get(DRAFT + row.id)).toBeNull());

    const orig = server.fetchImpl;
    const unackedValue = "# Unacked2\n\nkeepalive write";
    let phase: "lose" | "conflict" = "lose";
    globalThis.fetch = vi.fn(async (input: any, init: any) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      if (method === "PUT" && url.includes(`/memos/${row.id}`)) {
        if (phase === "lose") {
          row.content = unackedValue;
          row.updated_at = server.now() + 50;
          throw new Error("response lost");
        }
        // every PUT 409s in the conflict phase (stale base, and the re-base never lands)
        return new Response("", { status: 409 });
      }
      if (phase === "conflict" && method === "GET" && new RegExp(`/memos/${row.id}$`).test(url)) {
        // the re-base probe GET returns NOT ok → `x.ok ? x.json() : null` → null →
        // srv is null → no retry → the genuine conflict banner is raised
        return new Response("", { status: 500 });
      }
      return orig(input, init);
    }) as unknown as typeof fetch;

    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.input(ta, { target: { value: unackedValue } });
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "s", metaKey: true });
    });
    await waitFor(() => expect(container.querySelector(".status.offline")).toBeTruthy());

    phase = "conflict";
    await act(async () => {
      fireEvent.input(ta, { target: { value: "# Unacked2\n\nmore edits" } });
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "s", metaKey: true });
    });
    // probe GET not ok → srv null → falls through to the real conflict banner
    await waitFor(() => expect(container.querySelector(".conflict")).toBeTruthy());
  });

  it("falls through to a real conflict when the re-base probe GET rejects (.catch(() => null))", async () => {
    authedBoot();
    const row = server.seed({ title: "Unacked3", content: "# Unacked3\n\nv1" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("v1")
    );
    await waitFor(() => expect(kv.get(DRAFT + row.id)).toBeNull());

    const orig = server.fetchImpl;
    const unackedValue = "# Unacked3\n\nkeepalive write";
    let phase: "lose" | "conflict" = "lose";
    globalThis.fetch = vi.fn(async (input: any, init: any) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      if (method === "PUT" && url.includes(`/memos/${row.id}`)) {
        if (phase === "lose") {
          row.content = unackedValue;
          row.updated_at = server.now() + 50;
          throw new Error("response lost");
        }
        return new Response("", { status: 409 });
      }
      if (phase === "conflict" && method === "GET" && new RegExp(`/memos/${row.id}$`).test(url)) {
        // the re-base probe GET REJECTS → `.catch(() => null)` arm → srv null → no retry
        throw new Error("probe offline");
      }
      return orig(input, init);
    }) as unknown as typeof fetch;

    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.input(ta, { target: { value: unackedValue } });
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "s", metaKey: true });
    });
    await waitFor(() => expect(container.querySelector(".status.offline")).toBeTruthy());

    phase = "conflict";
    await act(async () => {
      fireEvent.input(ta, { target: { value: "# Unacked3\n\nmore edits" } });
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "s", metaKey: true });
    });
    // probe GET rejected → caught → srv null → falls through to the real conflict banner
    await waitFor(() => expect(container.querySelector(".conflict")).toBeTruthy());
  });
});

// ===========================================================================
// COVERAGE FILL — remaining false-condition arms (implicit else)
// ===========================================================================

// line 176: the nav effect's INNER `if (location.hash)` false arm — currentId
// transitions to null while location.hash is ALREADY empty (so no replaceState).
describe("nav effect clears currentId with an already-empty hash (176 false arm)", () => {
  it("discardDeleted nulls currentId after the hash was cleared — inner if is false", async () => {
    authedBoot();
    const row = server.seed({ title: "NavNull", content: "# NavNull\n\nbody" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("body")
    );
    // the open memo set the hash to its id (nav effect already ran once)
    await waitFor(() => expect(location.hash).toBe("#" + row.id));

    // raise the deleted-elsewhere banner via a 404 PUT
    server.opts.putStatus = 404;
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.input(ta, { target: { value: "# NavNull\n\nbye now" } });
    });
    await waitFor(() => expect(container.querySelector(".conflict span")?.textContent).toContain("삭제"));

    // clear the hash WITHOUT a hashchange (onHash no-ops on an empty hash anyway).
    // discardDeleted is synchronous: setCurrentId(null) runs immediately, so the nav
    // effect runs with location.hash === "" → the inner `if (location.hash)` is FALSE
    // (no replaceState), exercising the implicit-else arm of line 176.
    location.hash = "";
    await act(async () => {
      fireEvent.click(container.querySelectorAll(".conflict button")[1]); // 버리기 → discardDeleted
    });
    await waitFor(() => expect(container.querySelector(".center")).toBeTruthy());
    expect(container.querySelector(".conflict")).toBeFalsy();
    expect(location.hash).toBe("");
  });
});

// deleteMemo's temp branch `if (currentId === id && timer.current)` false arm —
// delete a blank temp that has NO armed save timer.
describe("deleteMemo a blank temp with no pending timer", () => {
  it("drops the boot's fresh blank temp locally when no debounce is armed", async () => {
    authedBoot();
    const { container } = render(<App />);
    // boot creates a fresh blank temp and opens it, but NOTHING has been typed →
    // timer.current is null (no debounced save armed).
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]").length).toBeGreaterThan(0)
    );

    // delete the open temp via its × → deleteMemo id<0 branch, but
    // `currentId === id && timer.current` is FALSE (timer.current === null) →
    // the clearTimeout block is skipped; the temp is just dropped locally.
    const li = container.querySelector(".memo-list li") as HTMLElement;
    await act(async () => {
      fireEvent.click(li.querySelector(".del")!);
    });
    await waitFor(() => expect(container.querySelector(".center")).toBeTruthy());
    expect(JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]").length).toBe(0);
    // a local-only temp → no server call, and no undo toast
    expect(server.fetchImpl.mock.calls.some((c) => (c[1] as RequestInit)?.method === "DELETE")).toBe(false);
    expect(container.querySelector(".toast")).toBeFalsy();
  });
});

// line 567: save() success `if (id === currentIdRef.current)` false arm — a PUT
// resolves for a memo that is no longer the open one (the user switched memos
// before the PUT landed).
describe("save resolves for a no-longer-current memo (567 false arm)", () => {
  it("a gated PUT for memo A completes after switching to memo B", async () => {
    authedBoot();
    const a = server.seed({ title: "Aaa567", content: "# Aaa567\n\nalpha" });
    const b = server.seed({ title: "Bbb567", content: "# Bbb567\n\nbeta" });
    location.hash = "#" + a.id;
    const { container } = render(<App />);
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("alpha")
    );
    await waitFor(() => expect(kv.get(DRAFT + a.id)).toBeNull());

    // gate A's PUT so it stays in flight while we switch to B
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const orig = server.fetchImpl;
    globalThis.fetch = vi.fn(async (input: any, init: any) => {
      const url = String(input);
      if ((init?.method || "GET").toUpperCase() === "PUT" && url.includes(`/memos/${a.id}`)) {
        await gate; // hold A's save in flight
      }
      return orig(input, init);
    }) as unknown as typeof fetch;

    // edit A and force the save (Cmd+S) → A's PUT is now gated/in flight
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.input(ta, { target: { value: "# Aaa567\n\nalpha edited" } });
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "s", metaKey: true });
    });

    // switch to B BEFORE A's PUT resolves → currentIdRef.current becomes B
    const bLi = Array.from(container.querySelectorAll(".memo-list li")).find(
      (el) => el.querySelector(".memo-title")?.textContent === "Bbb567"
    )!;
    await act(async () => {
      fireEvent.click(bLi);
    });
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("beta")
    );

    // release A's PUT → save() success runs with id === a.id but currentIdRef === b.id
    // → `if (id === currentIdRef.current)` is FALSE (loadedAt/lastSaveAt for A skipped)
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 20));
    });
    // A's edit still landed on the server; the editor stayed on B
    await waitFor(() => expect(server.memos.find((m) => m.id === a.id)?.content).toContain("alpha edited"));
    expect((container.querySelector("textarea.editor") as HTMLTextAreaElement).value).toContain("beta");
  });
});

// line 711: background-sync reload `if (timer.current == null && currentIdRef.current === id)`
// false arm — the user types DURING the per-memo reload GET so timer.current != null
// when it resolves → the remote content is NOT adopted.
describe("background sync reload aborts when the user types mid-fetch (711 false arm)", () => {
  it("does not adopt remote content if a save timer is armed when the reload GET resolves", async () => {
    authedBoot();
    const row = server.seed({ title: "Sync711", content: "# Sync711\n\nv1" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("v1")
    );
    // settle: no pending draft, so the sync guard reaches the reload block
    await waitFor(() => expect(kv.get(DRAFT + row.id)).toBeNull());

    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;

    // gate the per-memo reload GET (/api/memos/:id). While it's gated, we type into
    // the editor so onEdit arms timer.current; then release the GET so the
    // `timer.current == null` check is FALSE → remote content is NOT setContent'd.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let gateArmed = true;
    const orig = server.fetchImpl;
    globalThis.fetch = vi.fn(async (input: any, init: any) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      if (gateArmed && method === "GET" && new RegExp(`/memos/${row.id}$`).test(url)) {
        gateArmed = false; // only gate the first reload GET
        await gate;
      }
      return orig(input, init);
    }) as unknown as typeof fetch;

    // the memo changed elsewhere (newer updated_at) so sync's `cur.updated_at > loadedAt`
    // is true and it issues the (now-gated) per-memo reload GET
    row.content = "# Sync711\n\nv2 remote";
    row.updated_at = server.now() + 100000;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    // give sync time to reach the gated reload GET
    await new Promise((r) => setTimeout(r, 20));

    // type while the reload GET is gated → onEdit arms timer.current (no debounce
    // fires within this window: SAVE_DEBOUNCE is 300ms, we release immediately)
    await act(async () => {
      fireEvent.input(ta, { target: { value: "# Sync711\n\nmy local edit" } });
    });

    // release the reload GET → it resolves with timer.current != null → 711 FALSE arm
    await act(async () => {
      release();
      await new Promise((r) => setTimeout(r, 10));
    });

    // the remote "v2 remote" was NOT adopted — the user's in-progress edit stands
    expect((container.querySelector("textarea.editor") as HTMLTextAreaElement).value).toContain("my local edit");
    expect((container.querySelector("textarea.editor") as HTMLTextAreaElement).value).not.toContain("v2 remote");
    // clean up the armed save timer so it doesn't bleed into the next test
    await waitFor(() => expect(kv.get(DRAFT + row.id)).toBeNull(), { timeout: 3000 });
  });
});

// ===========================================================================
// PREVIEW CARET CENTERING (desktop): the rendered block under the editor caret
// is scrolled to the vertical middle of the preview, so the preview follows
// wherever you're typing. happy-dom doesn't lay out, so we fake the rects.
// ===========================================================================
describe("preview caret centering", () => {
  const mkRect = (top: number, height: number) =>
    ({ top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: 0, toJSON() {} });
  // happy-dom doesn't lay out. Model a viewport whose top is at screen 0, and a
  // block whose on-screen top shifts with scrollTop (as real rects do) — so the
  // centering converges to `docOffset - (viewportH - blockH) / 2` in one step,
  // regardless of how many times the handler runs.
  function viewport(pv: HTMLElement, h: number) {
    Object.defineProperty(pv, "clientHeight", { value: h, configurable: true });
    Object.defineProperty(pv, "getBoundingClientRect", { configurable: true, value: () => mkRect(0, h) });
  }
  function place(el: HTMLElement, pv: HTMLElement, docOffset: number, blockH: number) {
    Object.defineProperty(el, "clientHeight", { value: blockH, configurable: true });
    Object.defineProperty(el, "getBoundingClientRect", {
      configurable: true,
      value: () => mkRect(docOffset - pv.scrollTop, blockH),
    });
  }

  async function openEditor(content: string) {
    authedBoot();
    const row = server.seed({ title: "C", content });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toBe(content)
    );
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    const pv = container.querySelector(".preview") as HTMLDivElement;
    // the preview is debounced — wait until it has rendered the content (all the
    // sample docs end in "body") before tests read its data-source-line blocks.
    await waitFor(() => expect(pv.textContent).toContain("body"));
    return { ta, pv };
  }

  function caret(ta: HTMLTextAreaElement, pos: number) {
    ta.selectionStart = ta.selectionEnd = pos;
  }

  // NB: happy-dom's DOMPurify drops the *first* block's tag (a test-env quirk —
  // real browsers keep it, covered by e2e), so these assert on later blocks.
  // "intro\n\n# Scroll\n\nbody" → p@0 (first, dropped), h1@2, p@4.
  const DOC = "intro\n\n# Scroll\n\nbody";

  it("centers the block at the caret line in the preview", async () => {
    const { ta, pv } = await openEditor(DOC);
    const block = pv.querySelector('[data-source-line="4"]') as HTMLElement; // the <p>body
    expect(block).toBeTruthy();
    viewport(pv, 200);
    place(block, pv, 300, 40); // block sits 300px down, 40px tall
    caret(ta, DOC.length); // caret on "body" (line 4)
    await act(async () => {
      fireEvent.select(ta);
    });
    expect(pv.scrollTop).toBe(300 - (200 - 40) / 2); // centered: 220
  });

  it("uses the last block at or before the caret line (stops past it)", async () => {
    const { ta, pv } = await openEditor(DOC);
    const h1 = pv.querySelector('[data-source-line="2"]') as HTMLElement; // # Scroll
    viewport(pv, 200);
    place(h1, pv, 400, 30);
    caret(ta, 16); // on the blank line 3 → newest block at/<= line3 is the h1@2
    await act(async () => {
      fireEvent.select(ta);
    });
    expect(pv.scrollTop).toBe(400 - (200 - 30) / 2); // centered on the h1 (315), p@4 skipped
  });

  it("does nothing when no block precedes the caret line", async () => {
    const { ta, pv } = await openEditor("intro\n\nbody"); // p@0 (dropped), p@2
    viewport(pv, 200);
    pv.scrollTop = 5;
    caret(ta, 0); // line 0, before the only surviving block (p@2)
    await act(async () => {
      fireEvent.select(ta);
    });
    expect(pv.scrollTop).toBe(5); // untouched
  });
});

describe("settings view", () => {
  it("opens the Settings page from the sidebar and returns to the memos view", async () => {
    authedBoot();
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".side-tabs")).toBeTruthy());

    // the sidebar header button (replacing the old "+ New") opens Settings
    const settingsBtn = Array.from(container.querySelectorAll(".side-head button")).find((b) =>
      b.textContent?.includes("Settings")
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(settingsBtn);
    });

    // Settings page renders in the main pane; the sidebar memo/trash list is hidden
    await waitFor(() => expect(container.querySelector(".settings")).toBeTruthy());
    expect(settingsBtn.className).toContain("active");
    expect(container.querySelector(".memo-list")).toBeFalsy();
    // GET /api/tokens 404s in this harness → the component shows its empty state
    await waitFor(() => expect(container.textContent).toContain("No tokens yet"));

    // the Memos tab leaves Settings
    await act(async () => {
      fireEvent.click(container.querySelectorAll(".side-tabs button")[0]);
    });
    await waitFor(() => expect(container.querySelector(".settings")).toBeFalsy());
  });
});

