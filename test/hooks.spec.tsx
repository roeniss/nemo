// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/preact";
import { useToast, usePreview } from "../src/hooks";
import { PREVIEW_DEBOUNCE, PREVIEW_MAX } from "../src/lib";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useToast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("starts with no notice", () => {
    const { result } = renderHook(() => useToast());
    expect(result.current.notice).toBeNull();
  });

  it("flash sets notice and clears it after 3000ms", () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      result.current.flash("saved");
    });
    expect(result.current.notice).toBe("saved");

    act(() => {
      vi.advanceTimersByTime(2999);
    });
    expect(result.current.notice).toBe("saved");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.notice).toBeNull();
  });

  it("calling flash twice resets the timer (first timeout cleared)", () => {
    const { result } = renderHook(() => useToast());

    act(() => {
      result.current.flash("first");
    });
    expect(result.current.notice).toBe("first");

    // advance partway, then flash again
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    act(() => {
      result.current.flash("second");
    });
    expect(result.current.notice).toBe("second");

    // the original 3000ms boundary would have hit here (2000+1000),
    // but the timer was reset so notice should remain
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.notice).toBe("second");

    // full new window completes
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.notice).toBeNull();
  });
});

describe("usePreview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("uses initial content as the initial src and renders sanitized html", () => {
    const { result } = renderHook(() => usePreview("**bold**"));
    // src initialized to content immediately
    expect(result.current.tooBig).toBe(false);
    expect(result.current.size).toBe("**bold**".length);
    // marked + DOMPurify pipeline runs: markdown emphasis becomes <strong>
    expect(result.current.html).toContain("<strong>bold</strong>");
  });

  it("debounces src updates by PREVIEW_DEBOUNCE", () => {
    const { result, rerender } = renderHook(
      ({ content }) => usePreview(content),
      { initialProps: { content: "**one**" } }
    );
    expect(result.current.html).toContain("<strong>one</strong>");

    act(() => {
      rerender({ content: "*two*" });
    });

    // before debounce fires, src (and thus html/size) reflect old content
    act(() => {
      vi.advanceTimersByTime(PREVIEW_DEBOUNCE - 1);
    });
    expect(result.current.size).toBe("**one**".length);
    expect(result.current.html).toContain("<strong>one</strong>");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.size).toBe("*two*".length);
    expect(result.current.html).toContain("<em>two</em>");
  });

  it("sets tooBig and empty html when content exceeds PREVIEW_MAX", () => {
    const big = "a".repeat(PREVIEW_MAX + 1);
    const { result } = renderHook(() => usePreview(big));
    expect(result.current.tooBig).toBe(true);
    expect(result.current.html).toBe("");
    expect(result.current.size).toBe(big.length);
  });

  it("transitions from normal to tooBig after debounce", () => {
    const big = "a".repeat(PREVIEW_MAX + 1);
    const { result, rerender } = renderHook(
      ({ content }) => usePreview(content),
      { initialProps: { content: "small" } }
    );
    expect(result.current.tooBig).toBe(false);

    act(() => {
      rerender({ content: big });
    });
    act(() => {
      vi.advanceTimersByTime(PREVIEW_DEBOUNCE);
    });
    expect(result.current.tooBig).toBe(true);
    expect(result.current.html).toBe("");
  });

  it("cleanup on unmount before the timer fires does not throw", () => {
    const { rerender, unmount } = renderHook(
      ({ content }) => usePreview(content),
      { initialProps: { content: "a" } }
    );
    // schedule a pending debounce
    act(() => {
      rerender({ content: "b" });
    });
    expect(() => unmount()).not.toThrow();
    // advancing afterwards must not throw / set state on unmounted hook
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(PREVIEW_DEBOUNCE);
      });
    }).not.toThrow();
  });
});
