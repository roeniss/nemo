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
  it("+ New creates another memo", async () => {
    authedBoot();
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".new-memo")).toBeTruthy());
    const before = server.memos.length;
    fireEvent.click(container.querySelector(".new-memo")!);
    await waitFor(() => expect(server.memos.length).toBeGreaterThan(before));
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

    const before = server.memos.length;
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await waitFor(() => expect(server.memos.length).toBeGreaterThan(before));
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
  it("creates a local temp memo when POST fails, then materializes on focus", async () => {
    authedBoot();
    server.opts.postThrows = true;
    const { container } = render(<App />);
    // boot's newMemo() goes offline -> temp memo (negative id). Wait for the temp
    // to be the OPEN memo (editor present + a list row) before editing, so onEdit
    // doesn't no-op on a null currentId.
    await waitFor(() => expect(container.querySelector(".status.offline")).toBeTruthy());
    await waitFor(() => {
      expect(container.querySelector("textarea.editor")).toBeTruthy();
      expect(JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]").length).toBeGreaterThan(0);
    });

    // type content into the temp so it's not blank (so it materializes)
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.input(ta, { target: { value: "# Temp\n\nreal content" } });
    });
    await waitFor(
      () => expect(JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]")[0]?.title).toBe("Temp"),
      { timeout: 3000 }
    );

    // server reachable now → focus triggers sync()/recover()/materializeTemps().
    // Re-dispatch inside the poll so a single missed cycle (the materialize guard
    // or an in-flight recover) doesn't make this flaky.
    server.opts.postThrows = false;
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
  it("purges an empty fresh memo on unload", async () => {
    authedBoot();
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());
    // boot created a fresh empty memo → unload should DELETE?purge=1
    await act(async () => {
      window.dispatchEvent(new Event("beforeunload"));
    });
    await waitFor(() => {
      const purge = server.fetchImpl.mock.calls.find(
        (c) => String(c[0]).includes("purge=1") && (c[1] as RequestInit)?.method === "DELETE"
      );
      expect(purge).toBeTruthy();
    });
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
    server.opts.postThrows = true; // boot newMemo -> temp memo
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".status.offline")).toBeTruthy());
    await waitFor(() => expect(container.querySelector(".memo-list li")).toBeTruthy());

    // the open temp memo's × deletes it; currentId === id branch resets to center
    const li = container.querySelector(".memo-list li") as HTMLElement;
    fireEvent.click(li.querySelector(".del")!);
    await waitFor(() => expect(JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]").length).toBe(0));
    expect(container.querySelector(".toast")).toBeFalsy(); // no undo toast for temps
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
    // no hash → boot creates a fresh blank memo ("# ") tracked in freshIds
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    // an edit that stays blank arms the debounced save (timer.current set) without
    // marking the memo non-fresh
    await act(async () => {
      fireEvent.input(ta, { target: { value: "#   " } });
    });
    // leave immediately via + New: leaveCurrent sees fresh + blank + a pending
    // timer and clears it (App.tsx clearTimeout/timer.current = null), then purges
    await act(async () => {
      fireEvent.click(container.querySelector(".new-memo")!);
    });
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());
    // the purge DELETE ?purge=1 was issued for the abandoned blank memo
    await waitFor(() =>
      expect(
        server.fetchImpl.mock.calls.some(
          ([u, i]) => String(u).includes("purge=1") && (i?.method || "").toUpperCase() === "DELETE"
        )
      ).toBe(true)
    );
  });
});
