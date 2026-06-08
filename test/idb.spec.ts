// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type IdbModule = typeof import("../src/idb");

// Each `freshImport` (vi.resetModules) abandons the previous module's open
// IDBDatabase connection without closing it. fake-indexeddb then fires `blocked`
// (not `success`) on deleteDatabase while any connection is open, so deleting the
// DB between tests would hang. Instead we clear the object store's contents via a
// fresh connection that we close again — leaving every test a clean persisted store.
function clearStore(): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.open("nemo", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onerror = () => resolve(undefined);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").clear();
        tx.oncomplete = () => {
          db.close();
          resolve(undefined);
        };
        tx.onerror = () => {
          db.close();
          resolve(undefined);
        };
      } catch {
        db.close();
        resolve(undefined);
      }
    };
  });
}

async function freshImport(): Promise<IdbModule> {
  vi.resetModules();
  return import("../src/idb");
}

// Poll a fresh hydrated module until the expected key/value shows up (or give up).
// This makes persistence timing robust without a single fixed sleep.
async function waitPersisted(key: string, value: string, tries = 30): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const mod = await freshImport();
    await mod.hydrate();
    if (mod.kv.get(key) === value) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

beforeEach(async () => {
  await clearStore();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  localStorage.clear();
});

describe("kv mirror operations", () => {
  it("set then get returns the value synchronously (mirror hit)", async () => {
    const { kv } = await freshImport();
    kv.set("a", "hello");
    expect(kv.get("a")).toBe("hello");
  });

  it("get of a missing key returns null", async () => {
    const { kv } = await freshImport();
    expect(kv.get("nope")).toBeNull();
  });

  it("remove deletes from mirror so get returns null after", async () => {
    const { kv } = await freshImport();
    kv.set("b", "world");
    expect(kv.get("b")).toBe("world");
    kv.remove("b");
    expect(kv.get("b")).toBeNull();
  });

  it("set overwrites an existing mirror value", async () => {
    const { kv } = await freshImport();
    kv.set("c", "one");
    kv.set("c", "two");
    expect(kv.get("c")).toBe("two");
  });
});

describe("persistence + hydrate", () => {
  it("persisted values survive a fresh module instance via hydrate (cursor path)", async () => {
    // Write via one module instance.
    const first = await freshImport();
    first.kv.set("k1", "v1");
    first.kv.set("k2", "v2");

    // Let the background IDB writes settle by polling fresh imports.
    expect(await waitPersisted("k1", "v1")).toBe(true);

    // A brand new module instance has an empty mirror -> null before hydrate.
    const fresh = await freshImport();
    expect(fresh.kv.get("k1")).toBeNull();
    expect(fresh.kv.get("k2")).toBeNull();

    await fresh.hydrate();
    expect(fresh.kv.get("k1")).toBe("v1");
    expect(fresh.kv.get("k2")).toBe("v2");
  });

  it("remove is persisted across instances", async () => {
    const first = await freshImport();
    first.kv.set("r1", "keep-then-drop");
    expect(await waitPersisted("r1", "keep-then-drop")).toBe(true);

    const second = await freshImport();
    second.kv.remove("r1");

    // Poll until a fresh hydrate no longer sees r1.
    let gone = false;
    for (let i = 0; i < 30; i++) {
      const m = await freshImport();
      await m.hydrate();
      if (m.kv.get("r1") === null) {
        gone = true;
        break;
      }
      await new Promise((res) => setTimeout(res, 5));
    }
    expect(gone).toBe(true);
  });

  it("hydrate on an empty store resolves without error", async () => {
    const mod = await freshImport();
    await expect(mod.hydrate()).resolves.toBeUndefined();
    expect(mod.kv.get("anything")).toBeNull();
  });

  it("hydrate is idempotent / open() promise is cached across hydrate + persist", async () => {
    const mod = await freshImport();
    mod.kv.set("dup", "1");
    await mod.hydrate(); // exercises open() cache reuse after a set
    expect(mod.kv.get("dup")).toBe("1");
    await expect(mod.hydrate()).resolves.toBeUndefined();
  });
});

describe("degradation paths", () => {
  it("hydrate resolves when indexedDB.open throws (try/catch)", async () => {
    const mod = await freshImport();
    const spy = vi.spyOn(indexedDB, "open").mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(mod.hydrate()).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it("hydrate resolves when open() rejects (onerror)", async () => {
    const mod = await freshImport();
    const spy = vi.spyOn(indexedDB, "open").mockImplementation(() => {
      const req: any = {
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        error: new Error("open failed"),
      };
      // fire error asynchronously so handlers are attached first
      setTimeout(() => req.onerror && req.onerror(), 0);
      return req;
    });
    await expect(mod.hydrate()).resolves.toBeUndefined();
    spy.mockRestore();
  });

  it("set does not throw when IDB is broken (persist .catch path)", async () => {
    const mod = await freshImport();
    const spy = vi.spyOn(indexedDB, "open").mockImplementation(() => {
      throw new Error("broken");
    });
    // mirror still works; background persist swallows the failure.
    expect(() => mod.kv.set("x", "y")).not.toThrow();
    expect(mod.kv.get("x")).toBe("y");
    expect(() => mod.kv.remove("x")).not.toThrow();
    // give any rejected promise a tick to be swallowed by .catch
    await new Promise((r) => setTimeout(r, 0));
    spy.mockRestore();
  });

  it("persist .catch swallows a rejected open()", async () => {
    const mod = await freshImport();
    const spy = vi.spyOn(indexedDB, "open").mockImplementation(() => {
      const req: any = {
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        error: new Error("nope"),
      };
      setTimeout(() => req.onerror && req.onerror(), 0);
      return req;
    });
    expect(() => mod.kv.set("p", "q")).not.toThrow();
    await new Promise((r) => setTimeout(r, 5));
    spy.mockRestore();
  });
});
