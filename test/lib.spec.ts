// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  api,
  byRecent,
  caretLine,
  centerDelta,
  hashId,
  isBlank,
  readList,
  titleFrom,
  writeList,
  type MemoMeta,
} from "../src/lib";

afterEach(() => {
  localStorage.clear();
  location.hash = "";
  vi.restoreAllMocks();
});

describe("titleFrom", () => {
  it("uses the first non-blank line", () => {
    expect(titleFrom("hello world")).toBe("hello world");
  });

  it("strips leading hashes and spaces", () => {
    expect(titleFrom("#   My Title")).toBe("My Title");
    expect(titleFrom("### Heading")).toBe("Heading");
  });

  it("trims surrounding whitespace", () => {
    expect(titleFrom("   padded   ")).toBe("padded");
  });

  it("skips leading blank lines and finds the first real line", () => {
    expect(titleFrom("\n\n   \n# Real Title\nbody")).toBe("Real Title");
  });

  it("returns Untitled for empty content", () => {
    expect(titleFrom("")).toBe("Untitled");
  });

  it("returns Untitled when only blank lines exist", () => {
    expect(titleFrom("\n   \n\t\n")).toBe("Untitled");
  });

  it("returns Untitled for a heading-only memo", () => {
    expect(titleFrom("# ")).toBe("Untitled");
    expect(titleFrom("###   ")).toBe("Untitled");
  });

  it("slices to 120 characters", () => {
    const long = "a".repeat(200);
    expect(titleFrom(long)).toBe("a".repeat(120));
    expect(titleFrom(long)).toHaveLength(120);
  });
});

describe("isBlank", () => {
  it("treats a bare heading marker as blank", () => {
    expect(isBlank("# ")).toBe(true);
  });

  it("treats heading marker with trailing whitespace/newlines as blank", () => {
    expect(isBlank("#  \n  ")).toBe(true);
  });

  it("returns false for real content", () => {
    expect(isBlank("# Title")).toBe(false);
    expect(isBlank("hello")).toBe(false);
  });
});

describe("caretLine", () => {
  it("is 0 at the very start", () => {
    expect(caretLine("abc\ndef", 0)).toBe(0);
  });
  it("counts the newlines before the caret", () => {
    const text = "# H\n\npara";
    expect(caretLine(text, text.length)).toBe(2); // on "para"
    expect(caretLine(text, 4)).toBe(1); // on the blank line
  });
});

describe("centerDelta", () => {
  it("returns the delta that centers the block in the viewport", () => {
    // block top at 200 within a 200px viewport, block 40px tall → 200 - 80 = 120
    expect(centerDelta(200, 40, 200)).toBe(120);
  });
  it("is negative when the block sits above center", () => {
    expect(centerDelta(0, 40, 200)).toBe(-80);
  });
});

describe("hashId", () => {
  it("returns null when no hash is present", () => {
    location.hash = "";
    expect(hashId()).toBeNull();
  });

  it("parses a positive integer hash", () => {
    location.hash = "#123";
    expect(hashId()).toBe(123);
  });

  it("parses a negative integer hash (temps)", () => {
    location.hash = "#-123";
    expect(hashId()).toBe(-123);
  });

  it("returns null for #0", () => {
    location.hash = "#0";
    expect(hashId()).toBeNull();
  });

  it("returns null for a non-numeric hash", () => {
    location.hash = "#abc";
    expect(hashId()).toBeNull();
  });

  it("returns null for a non-integer hash", () => {
    location.hash = "#1.5";
    expect(hashId()).toBeNull();
  });
});

describe("readList", () => {
  it("returns [] for a missing key", () => {
    expect(readList("nope")).toEqual([]);
  });

  it("parses a valid JSON array", () => {
    const list: MemoMeta[] = [{ id: 1, title: "a", updated_at: 5 }];
    localStorage.setItem("k", JSON.stringify(list));
    expect(readList("k")).toEqual(list);
  });

  it("returns [] for malformed JSON", () => {
    localStorage.setItem("bad", "{not json");
    expect(readList("bad")).toEqual([]);
  });
});

describe("writeList", () => {
  it("persists the list as JSON", () => {
    const list: MemoMeta[] = [{ id: 2, title: "b", updated_at: 9 }];
    writeList("wk", list);
    expect(JSON.parse(localStorage.getItem("wk")!)).toEqual(list);
    expect(readList("wk")).toEqual(list);
  });

  it("swallows errors when setItem throws", () => {
    const spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    expect(() => writeList("x", [{ id: 1, title: "t", updated_at: 1 }])).not.toThrow();
    expect(spy).toHaveBeenCalled();
  });
});

describe("byRecent", () => {
  it("sorts by updated_at descending", () => {
    const list: MemoMeta[] = [
      { id: 1, title: "old", updated_at: 1 },
      { id: 2, title: "new", updated_at: 3 },
      { id: 3, title: "mid", updated_at: 2 },
    ];
    expect([...list].sort(byRecent).map((m) => m.id)).toEqual([2, 3, 1]);
  });

  it("returns a positive/negative/zero comparator result", () => {
    const a: MemoMeta = { id: 1, title: "a", updated_at: 10 };
    const b: MemoMeta = { id: 2, title: "b", updated_at: 5 };
    expect(byRecent(a, b)).toBeLessThan(0);
    expect(byRecent(b, a)).toBeGreaterThan(0);
    expect(byRecent(a, { ...a, id: 3 })).toBe(0);
  });
});

describe("api", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefixes /api and sets the content-type header (no init)", async () => {
    await api("/memos");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/memos");
    expect(opts.headers).toEqual({ "content-type": "application/json" });
    expect(opts.method).toBeUndefined();
  });

  it("merges init.method and init.headers", async () => {
    await api("/memos/1", {
      method: "POST",
      headers: { "x-custom": "1" },
      body: "{}",
    });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/memos/1");
    expect(opts.method).toBe("POST");
    expect(opts.body).toBe("{}");
    expect(opts.headers).toEqual({
      "content-type": "application/json",
      "x-custom": "1",
    });
  });

  it("lets init.headers override content-type", async () => {
    await api("/x", { headers: { "content-type": "text/plain" } });
    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers["content-type"]).toBe("text/plain");
  });

  it("returns the fetch Response", async () => {
    const res = await api("/memos");
    expect(res).toBeInstanceOf(Response);
    expect(await res.json()).toEqual({ ok: true });
  });
});
