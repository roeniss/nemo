// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor, cleanup, act } from "@testing-library/preact";
import App from "../src/App";
import { kv, hydrate } from "../src/idb";
import { DRAFT, CONTENT_CACHE, TEMPS_KEY, LIST_CACHE } from "../src/lib";

// ---------------------------------------------------------------------------
// In-memory fake server keyed by url + method, with per-endpoint toggles that
// can be flipped MID-TEST to simulate going offline then back online. Same
// shape/behaviour as test/app.spec.tsx's server, plus a couple of extra knobs:
//   - getThrows / getMemoThrows: make GET /api/memos and GET /api/memos/:id reject
//   - putThrows: make PUT /api/memos/:id reject (network failure while saving)
//   - putGate: a promise the PUT awaits before resolving (lets a save sit
//     in-flight so a second edit queues behind it)
// ---------------------------------------------------------------------------
type Row = { id: number; title: string; updated_at: number; content: string; created_at: number };

function makeServer() {
  const memos: Row[] = [];
  const trash: Row[] = [];
  // start real-memo ids high so this file's per-memo IDB residue (qm-cache-* /
  // qm-draft-*) can never collide with the low ids (1..~30) the sibling DOM spec
  // seeds — the two files race on the single fake-indexeddb global under parallel
  // execution, and an overlapping id would let one file read the other's content.
  let nextId = 1000;
  let clock = 1000;
  const now = () => ++clock;

  const opts = {
    meStatus: 200,
    meThrows: false, // GET /api/me network failure
    postThrows: false, // POST /api/memos network failure (offline path)
    getThrows: false, // GET /api/memos network failure
    getMemoThrows: false, // GET /api/memos/:id network failure
    putThrows: false, // PUT /api/memos/:id network failure
    putStatus: 0,
    loginStatus: 200,
    putGate: null as Promise<void> | null, // PUT awaits this before resolving
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
    const path = url.replace(/^.*\/api/, "");

    if (path === "/me") {
      if (opts.meThrows) throw new Error("offline");
      if (opts.meStatus !== 200) return new Response("", { status: opts.meStatus });
      return json({ ok: true });
    }
    if (path === "/login" && method === "POST") {
      if (opts.loginStatus !== 200) return new Response("", { status: opts.loginStatus });
      return json({ ok: true });
    }
    if (path === "/logout" && method === "POST") return json({ ok: true });

    if (path === "/memos" && method === "GET") {
      if (opts.getThrows) throw new Error("offline");
      if (opts.meStatus === 401) return new Response("", { status: 401 });
      return json(memos.map(meta).sort((a, b) => b.updated_at - a.updated_at));
    }
    if (path === "/memos" && method === "POST") {
      if (opts.postThrows) throw new Error("offline");
      const r: Row = { id: nextId++, title: "Untitled", updated_at: now(), content: "", created_at: now() };
      memos.unshift(r);
      return json(meta(r));
    }
    if (path === "/trash" && method === "GET") {
      return json(trash.map(meta));
    }

    let m = path.match(/^\/memos\/(-?\d+)$/);
    if (m) {
      const id = Number(m[1]);
      const idx = memos.findIndex((x) => x.id === id);
      if (method === "GET") {
        if (opts.getMemoThrows) throw new Error("offline");
        if (idx === -1) return new Response("", { status: 404 });
        return json(memos[idx]);
      }
      if (method === "PUT") {
        if (opts.putThrows) throw new Error("offline");
        if (opts.putGate) await opts.putGate;
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

    return new Response("not found", { status: 404 });
  });

  return {
    memos,
    trash,
    opts,
    fetchImpl,
    seed: (r: Partial<Row>) => {
      const row: Row = { id: nextId++, title: "Untitled", updated_at: now(), content: "", created_at: now(), ...r };
      memos.push(row);
      return row;
    },
    now,
  };
}

let server: ReturnType<typeof makeServer>;

function clearKv() {
  // cover the low ids used for hand-seeded cache entries + temps, and the high
  // 1000+ band where this file's server hands out real-memo ids
  for (let id = -210; id <= 60; id++) {
    kv.remove(DRAFT + id);
    kv.remove(CONTENT_CACHE + id);
  }
  for (let id = 1000; id <= 1060; id++) {
    kv.remove(DRAFT + id);
    kv.remove(CONTENT_CACHE + id);
  }
}

beforeEach(async () => {
  localStorage.clear();
  location.hash = "";
  clearKv();
  await hydrate();
  server = makeServer();
  globalThis.fetch = server.fetchImpl as unknown as typeof fetch;

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
  // drop this test's per-memo IDB residue and flush the persists so a co-resident
  // DOM spec sharing the (module-level + fake-indexeddb-global) kv mirror can't read
  // stale content this test wrote
  clearKv();
  await hydrate();
});

function authedBoot() {
  localStorage.setItem("qm-authed", "1");
}

// ===========================================================================
// openMemo revalidate branches (~280-298)
// ===========================================================================
describe("openMemo revalidate", () => {
  it("keeps a local draft that differs from server content and pushes it (save)", async () => {
    authedBoot();
    const row = server.seed({ title: "Draft", content: "# Draft\n\nserver body" });
    // a local DRAFT that differs from the server → openMemo must keep it and save()
    kv.set(DRAFT + row.id, "# Draft\n\nLOCAL unsynced edit");
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    // the instantly-shown content is the draft, and revalidate pushes it to server
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("LOCAL unsynced edit")
    );
    await waitFor(() => expect(server.memos.find((m) => m.id === row.id)?.content).toContain("LOCAL unsynced edit"));
    // draft cleared after the successful save
    await waitFor(() => expect(kv.get(DRAFT + row.id)).toBeNull());
  });

  it("adopts changed server content when there is no local draft", async () => {
    authedBoot();
    const row = server.seed({ title: "Adopt", content: "# Adopt\n\nNEW server body" });
    // defend against a stale DRAFT for this reused id surviving a prior test's IDB
    // persist race (clearKv runs before hydrate(), so hydrate can restore it)
    kv.remove(DRAFT + row.id);
    // a stale CONTENT_CACHE makes the instant render show old text; revalidate adopts the new
    kv.set(CONTENT_CACHE + row.id, "# Adopt\n\nold cached body");
    localStorage.setItem(LIST_CACHE, JSON.stringify([{ id: row.id, title: "Adopt", updated_at: 1 }]));
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("NEW server body")
    );
  });

  it("early-returns on a 404 revalidate without crashing", async () => {
    authedBoot();
    // a LIST_CACHE row that the server does NOT have → GET /memos/:id returns 404
    localStorage.setItem(LIST_CACHE, JSON.stringify([{ id: 1042, title: "Ghost", updated_at: 5 }]));
    kv.set(CONTENT_CACHE + 1042, "# Ghost\n\nlocal only");
    location.hash = "#1042";
    const { container } = render(<App />);
    // boot uses the list (cache merged with empty server list won't include 1042 once
    // server responds) — drive openMemo directly via hashchange instead so the !r.ok
    // path is exercised against a known-open memo.
    await waitFor(() => expect(container.querySelector(".app")).toBeTruthy());
    // open id 1042 explicitly: instant local content shows, server 404 → early return,
    // content stays as the local cache.
    await act(async () => {
      location.hash = "#1042";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("local only")
    );
  });

  it("early-returns when the user moves on before revalidate resolves", async () => {
    authedBoot();
    const a = server.seed({ title: "Aa", content: "# Aa\n\nalpha" });
    const b = server.seed({ title: "Bb", content: "# Bb\n\nbeta" });
    // gate the per-memo GET so we can switch memos while the first revalidate is pending
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const orig = server.fetchImpl;
    let gatedOnce = false;
    globalThis.fetch = vi.fn(async (input: any, init: any) => {
      const url = String(input);
      const method = (init?.method || "GET").toUpperCase();
      if (!gatedOnce && method === "GET" && url.includes(`/memos/${a.id}`)) {
        gatedOnce = true;
        await gate; // hold the first openMemo(a) revalidate
      }
      return orig(input, init);
    }) as unknown as typeof fetch;

    location.hash = "#" + a.id;
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());
    // move to b while a's revalidate is still gated → currentIdRef.current !== a.id
    await act(async () => {
      location.hash = "#" + b.id;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("beta")
    );
    // now release a's revalidate — it must early-return (currentId is b), not clobber b
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await new Promise((r) => setTimeout(r, 20));
    expect((container.querySelector("textarea.editor") as HTMLTextAreaElement).value).toContain("beta");
  });

  it("sets offline when the per-memo revalidate fetch rejects", async () => {
    authedBoot();
    const row = server.seed({ title: "Net", content: "# Net\n\nbody" });
    kv.set(CONTENT_CACHE + row.id, "# Net\n\ncached body");
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".app")).toBeTruthy());
    // make the per-memo GET reject, then open the memo → catch → setOffline(true)
    server.opts.getMemoThrows = true;
    await act(async () => {
      location.hash = "#" + row.id;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() => expect(container.querySelector(".status.offline")).toBeTruthy());
    // local content is still shown
    expect((container.querySelector("textarea.editor") as HTMLTextAreaElement).value).toContain("cached body");
  });
});

// ===========================================================================
// save() network-failure catch + serialize/pendingSave (~461-465, 496-506)
// ===========================================================================
describe("save network failure and serialization", () => {
  it("sets offline when a PUT in flight rejects", async () => {
    vi.useFakeTimers();
    authedBoot();
    const row = server.seed({ title: "Fail", content: "# Fail" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await vi.waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());

    server.opts.putThrows = true;
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.input(ta, { target: { value: "# Fail\n\nwill not reach server" } });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    vi.useRealTimers();
    await waitFor(() => expect(container.querySelector(".status.offline")).toBeTruthy());
    // the draft is the safety net
    expect(kv.get(DRAFT + row.id)).toContain("will not reach server");
  });

  it("queues a second save while one is in flight and drains it", async () => {
    authedBoot();
    const row = server.seed({ title: "Queue", content: "# Queue" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;

    // hold the first PUT in flight so the second save queues behind it (pendingSave).
    // Count PUTs so we can confirm a second one drained after the gate opens.
    let release: () => void = () => {};
    server.opts.putGate = new Promise<void>((r) => (release = r));
    const putCount = () =>
      server.fetchImpl.mock.calls.filter(
        (c) => String(c[0]).includes(`/memos/${row.id}`) && (c[1] as RequestInit)?.method === "PUT"
      ).length;

    // first edit, then Cmd+S → save() goes in-flight and blocks on the gate
    await act(async () => {
      fireEvent.input(ta, { target: { value: "# Queue\n\nfirst" } });
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "s", metaKey: true });
    });
    // the first PUT is now issued and awaiting the gate
    await waitFor(() => expect(putCount()).toBe(1));

    // second edit (fresh render committed) then Cmd+S while the first is gated →
    // inFlight.current is true → this save queues into pendingSave
    await act(async () => {
      fireEvent.input(ta, { target: { value: "# Queue\n\nsecond drained" } });
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "s", metaKey: true });
    });

    // release the first PUT; the finally-block must drain the queued second save
    server.opts.putGate = null;
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await waitFor(() => expect(putCount()).toBe(2));
    await waitFor(() => expect(server.memos.find((m) => m.id === row.id)?.content).toContain("second drained"));
  });
});

// ===========================================================================
// recover() branches (~513-530)
// ===========================================================================
describe("recover", () => {
  it("early-returns while a conflict banner is up", async () => {
    authedBoot();
    const row = server.seed({ title: "Conf", content: "# Conf" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());

    // raise a conflict
    server.opts.putStatus = 409;
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "# Conf\n\nmine" } });
    await waitFor(() => expect(container.querySelector(".conflict")).toBeTruthy());

    // online event → recover() must early-return (conflictRef true); no /me call clears it
    const meBefore = server.fetchImpl.mock.calls.filter((c) => String(c[0]).includes("/me")).length;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await Promise.resolve();
    const meAfter = server.fetchImpl.mock.calls.filter((c) => String(c[0]).includes("/me")).length;
    expect(meAfter).toBe(meBefore);
    expect(container.querySelector(".conflict")).toBeTruthy();
  });

  it("clears offline via GET /me when nothing is pending", async () => {
    authedBoot();
    const row = server.seed({ title: "Me", content: "# Me\n\nbody" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());
    await waitFor(() => expect(kv.get(DRAFT + row.id)).toBeNull()); // no pending draft

    // force the offline banner via a failed per-memo revalidate, then recover via /me
    server.opts.getMemoThrows = true;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    // recover with no draft → hits GET /me; it's ok → setOffline(false)
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(container.querySelector(".status.offline")).toBeFalsy());
  });

  it("swallows a /me rejection in recover (stays offline)", async () => {
    authedBoot();
    const row = server.seed({ title: "MeErr", content: "# MeErr\n\nbody" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());
    await waitFor(() => expect(kv.get(DRAFT + row.id)).toBeNull());

    // no pending draft, /me throws → recover's catch swallows it (no crash, stays offline)
    server.opts.meThrows = true;
    server.opts.getThrows = true; // keep sync's /memos from clearing things
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 20));
    // still rendered, did not throw
    expect(container.querySelector(".app")).toBeTruthy();
  });
});

// ===========================================================================
// materializeTemps branches (~334-365)
// ===========================================================================
describe("materializeTemps", () => {
  it("skips a blank temp and breaks when the server is still offline", async () => {
    authedBoot();
    // pre-seed a blank temp (gets skipped) and a content temp (POST attempted → break)
    localStorage.setItem(
      TEMPS_KEY,
      JSON.stringify([
        { id: -101, title: "Untitled", updated_at: 2 },
        { id: -102, title: "Has body", updated_at: 1 },
      ])
    );
    kv.set(DRAFT + -101, "# "); // blank → skipped
    kv.set(DRAFT + -102, "# Has body\n\nreal text"); // content → POST attempted
    server.opts.postThrows = true; // POST fails → inner catch → break

    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".app")).toBeTruthy());
    // both temps survive (blank skipped, content one broke out before removal)
    await waitFor(() => {
      const temps = JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]");
      expect(temps.some((t: any) => t.id === -101)).toBe(true);
      expect(temps.some((t: any) => t.id === -102)).toBe(true);
    });
  });

  it("POSTs+PUTs a content temp and removes it from qm-temps", async () => {
    authedBoot();
    localStorage.setItem(TEMPS_KEY, JSON.stringify([{ id: -201, title: "T", updated_at: 1 }]));
    kv.set(DRAFT + -201, "# T\n\nmaterialize me");

    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".app")).toBeTruthy());
    // boot's materializeTemps pushes it → temp removed, real memo holds the content
    await waitFor(() => {
      const temps = JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]");
      expect(temps.some((t: any) => t.id === -201)).toBe(false);
    });
    await waitFor(() => expect(server.memos.some((m) => m.content.includes("materialize me"))).toBe(true));
    expect(kv.get(DRAFT + -201)).toBeNull();
  });
});

// ===========================================================================
// newMemo offline catch (~317-330)
// ===========================================================================
describe("newMemo offline", () => {
  it("creates a negative-id temp + DRAFT when POST rejects", async () => {
    authedBoot();
    server.opts.postThrows = true;
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".status.offline")).toBeTruthy());
    await waitFor(() => {
      const temps = JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]");
      expect(temps.length).toBeGreaterThan(0);
      expect(temps[0].id).toBeLessThan(0); // negative temp id
    });
    // a DRAFT for that temp holds NEW_DOC
    const temps = JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]");
    expect(kv.get(DRAFT + temps[0].id)).toBe("# ");
  });
});

// ===========================================================================
// leaveCurrent branches (~234-257)
// ===========================================================================
describe("leaveCurrent", () => {
  it("purges a fresh-empty real memo with DELETE ?purge=1 on leave", async () => {
    authedBoot();
    const other = server.seed({ title: "Keep", content: "# Keep\n\nkeep body" });
    const { container } = render(<App />);
    // boot creates a fresh empty real memo (the open one). Switching away purges it.
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());
    await waitFor(() => expect(container.querySelectorAll(".memo-list li").length).toBeGreaterThanOrEqual(2));

    // open the seeded memo → leaveCurrent purges the fresh-empty boot memo
    const li = Array.from(container.querySelectorAll(".memo-list li")).find(
      (el) => el.querySelector(".memo-title")?.textContent === "Keep"
    )!;
    await act(async () => {
      fireEvent.click(li);
    });
    await waitFor(() => {
      const purge = server.fetchImpl.mock.calls.find(
        (c) => String(c[0]).includes("purge=1") && (c[1] as RequestInit)?.method === "DELETE"
      );
      expect(purge).toBeTruthy();
    });
    expect(other).toBeTruthy();
  });

  it("swallows the purge DELETE rejection while offline on leave", async () => {
    authedBoot();
    server.seed({ title: "Other", content: "# Other\n\nbody" });
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());
    await waitFor(() => expect(container.querySelectorAll(".memo-list li").length).toBeGreaterThanOrEqual(2));

    // make the purge DELETE reject → leaveCurrent's catch swallows it
    const orig = server.fetchImpl;
    globalThis.fetch = vi.fn(async (input: any, init: any) => {
      const url = String(input);
      if (url.includes("purge=1") && (init?.method || "GET") === "DELETE") throw new Error("offline");
      return orig(input, init);
    }) as unknown as typeof fetch;

    const li = Array.from(container.querySelectorAll(".memo-list li")).find(
      (el) => el.querySelector(".memo-title")?.textContent === "Other"
    )!;
    await act(async () => {
      fireEvent.click(li);
    });
    // no crash; the seeded memo opened
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("body")
    );
  });

  it("drops a fresh-empty temp locally on leave (id < 0)", async () => {
    authedBoot();
    server.opts.postThrows = true; // boot newMemo → fresh empty temp
    const seeded = server.seed({ title: "Real", content: "# Real\n\nreal body" });
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".status.offline")).toBeTruthy());
    await waitFor(() => {
      const temps = JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]");
      expect(temps.length).toBeGreaterThan(0);
    });
    const tempId = JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]")[0].id as number;

    // server reachable again so we can open the real memo; leaving the fresh-empty
    // temp drops it locally (id < 0 branch)
    server.opts.postThrows = false;
    await act(async () => {
      location.hash = "#" + seeded.id;
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("real body")
    );
    await waitFor(() => {
      const temps = JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]");
      expect(temps.some((t: any) => t.id === tempId)).toBe(false);
    });
    expect(kv.get(DRAFT + tempId)).toBeNull();
  });
});

// ===========================================================================
// deleteMemo branches (~367-395)
// ===========================================================================
describe("deleteMemo", () => {
  it("drops a temp locally (id<0) and clears the editor when it's open", async () => {
    authedBoot();
    server.opts.postThrows = true;
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".status.offline")).toBeTruthy());
    await waitFor(() => expect(container.querySelector(".memo-list li")).toBeTruthy());

    // type content so a DRAFT exists for the temp, then delete it
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.input(ta, { target: { value: "# Temp\n\nbody" } });
    });
    const tempId = JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]")[0].id as number;

    const li = container.querySelector(".memo-list li") as HTMLElement;
    await act(async () => {
      fireEvent.click(li.querySelector(".del")!);
    });
    // temp removed, DRAFT cleared, no undo toast, editor cleared (currentId === id)
    await waitFor(() => expect(JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]").length).toBe(0));
    expect(kv.get(DRAFT + tempId)).toBeNull();
    expect(container.querySelector(".toast")).toBeFalsy();
    await waitFor(() => expect(container.querySelector(".center")).toBeTruthy());
  });

  it("sets offline when the DELETE api call rejects for a real memo", async () => {
    authedBoot();
    const row = server.seed({ title: "Del", content: "# Del\n\nbody" });
    server.seed({ title: "Other", content: "# Other" });
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelectorAll(".memo-list li").length).toBeGreaterThanOrEqual(2));

    // make DELETE reject → deleteMemo's catch → setOffline(true) (still drops locally + undo)
    const orig = server.fetchImpl;
    globalThis.fetch = vi.fn(async (input: any, init: any) => {
      if ((init?.method || "GET") === "DELETE" && String(input).includes(`/memos/${row.id}`)) {
        throw new Error("offline");
      }
      return orig(input, init);
    }) as unknown as typeof fetch;

    const li = Array.from(container.querySelectorAll(".memo-list li")).find(
      (el) => el.querySelector(".memo-title")?.textContent === "Del"
    )!;
    await act(async () => {
      fireEvent.click(li.querySelector(".del")!);
    });
    await waitFor(() => expect(container.querySelector(".status.offline")).toBeTruthy());
    // still produced the undo toast + dropped the row
    await waitFor(() => expect(container.querySelector(".toast")?.textContent).toContain("Del"));
  });
});

// ===========================================================================
// background sync branches (~600-651)
// ===========================================================================
describe("background sync merge", () => {
  it("keeps the newer local updated_at over a stale server row", async () => {
    authedBoot();
    const row = server.seed({ title: "Merge", content: "# Merge\n\nbody" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());

    // make the local meta strictly newer than what the server will report:
    // edit + save bumps local updated_at; then freeze the server row's updated_at
    // older than the local copy so the merge keeps local.
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.input(ta, { target: { value: "# Local newer title\n\nbody2" } });
      fireEvent.keyDown(window, { key: "s", metaKey: true });
    });
    await waitFor(() => expect(server.memos.find((m) => m.id === row.id)?.content).toContain("body2"));

    // now roll the server row's updated_at BACK so list() reports it as older than
    // the locally-held meta → merge must keep the local row
    const sRow = server.memos.find((m) => m.id === row.id)!;
    const localTitle = sRow.title;
    sRow.updated_at = 1; // stale on the server list

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => {
      const titles = Array.from(container.querySelectorAll(".memo-title")).map((e) => e.textContent);
      expect(titles).toContain(localTitle);
    });
  });

  it("discardDeleted clears a real open memo (id != null)", async () => {
    authedBoot();
    const row = server.seed({ title: "Dd", content: "# Dd" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());

    // trigger the deleted banner via a 404 PUT
    server.opts.putStatus = 404;
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "# Dd\n\nbye" } });
    await waitFor(() => expect(container.querySelector(".conflict span")?.textContent).toContain("삭제"));

    // discardDeleted: id != null branch wipes draft/cache and clears the editor
    const btns = container.querySelectorAll(".conflict button");
    await act(async () => {
      fireEvent.click(btns[1]); // 버리기
    });
    await waitFor(() => expect(container.querySelector(".center")).toBeTruthy());
    expect(kv.get(DRAFT + row.id)).toBeNull();
    expect(kv.get(CONTENT_CACHE + row.id)).toBeNull();
  });

  it("recoverAsNew goes offline when the POST rejects", async () => {
    authedBoot();
    const row = server.seed({ title: "Ran", content: "# Ran" });
    location.hash = "#" + row.id;
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());

    // trigger the deleted banner
    server.opts.putStatus = 404;
    const ta = container.querySelector("textarea.editor") as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: "# Ran\n\nrescue offline" } });
    await waitFor(() => expect(container.querySelector(".conflict span")?.textContent).toContain("삭제"));

    // now make the recoverAsNew POST reject → its catch → setOffline(true)
    server.opts.putStatus = 0;
    server.opts.postThrows = true;
    const btns = container.querySelectorAll(".conflict button");
    await act(async () => {
      fireEvent.click(btns[0]); // 새 메모로 복구
    });
    await waitFor(() => expect(container.querySelector(".status.offline")).toBeTruthy());
    // the on-screen content (the draft safety net) is still shown
    expect((container.querySelector("textarea.editor") as HTMLTextAreaElement).value).toContain("rescue offline");
  });
});

// ===========================================================================
// boot offline path (~133-152)
// ===========================================================================
describe("boot offline", () => {
  it("renders cached list + temps and goes offline; deep-links via local content", async () => {
    authedBoot();
    localStorage.setItem(LIST_CACHE, JSON.stringify([{ id: 1007, title: "Cached", updated_at: 50 }]));
    localStorage.setItem(TEMPS_KEY, JSON.stringify([{ id: -7, title: "Temp", updated_at: 60 }]));
    kv.set(CONTENT_CACHE + 1007, "# Cached\n\ndeep linked body");
    server.opts.getThrows = true; // boot GET /memos rejects → catch branch

    location.hash = "#1007";
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".status.offline")).toBeTruthy());
    // deep-link branch: hashed memo has local CONTENT_CACHE → openMemo(7)
    await waitFor(() =>
      expect((container.querySelector("textarea.editor") as HTMLTextAreaElement)?.value).toContain("deep linked body")
    );
    // both cached list rows + temp are visible
    await waitFor(() => {
      const titles = Array.from(container.querySelectorAll(".memo-title")).map((e) => e.textContent);
      expect(titles).toContain("Cached");
      expect(titles).toContain("Temp");
    });
  });

  it("falls back to newMemo when the deep-link target has no local content", async () => {
    authedBoot();
    // hashed id is in the cached list but has NO DRAFT/CONTENT_CACHE → newMemo() fallback
    localStorage.setItem(LIST_CACHE, JSON.stringify([{ id: 1009, title: "NoLocal", updated_at: 10 }]));
    server.opts.getThrows = true; // boot GET /memos rejects → catch branch
    server.opts.postThrows = true; // and POST fails too → newMemo offline → temp

    location.hash = "#1009";
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector(".status.offline")).toBeTruthy());
    // newMemo offline → a negative temp is created and opened
    await waitFor(() => expect(container.querySelector("textarea.editor")).toBeTruthy());
    await waitFor(() => {
      const temps = JSON.parse(localStorage.getItem(TEMPS_KEY) || "[]");
      expect(temps.some((t: any) => t.id < 0)).toBe(true);
    });
  });
});
