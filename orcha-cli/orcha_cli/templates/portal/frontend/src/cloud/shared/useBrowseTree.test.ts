/**
 * useBrowseTree — folder-expand failure caching regression (docs/orcha-*
 * user report: a transient dir-load failure, e.g. a GitHub rate-limit blip,
 * got cached forever by the lazy tree, so collapsing/re-expanding the same
 * folder never retried and it showed "Couldn't load this folder." for good.
 * Fix: only SUCCESSFUL dir loads are cached — a dir whose cached state
 * carries an `error` is treated as never-loaded, so re-expanding (or an
 * explicit retry) always re-fetches.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBrowseTree } from "./useBrowseTree";

function jsonResponse(data: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => data } as unknown as Response;
}

describe("useBrowseTree — transient dir-load failure retry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-expanding a dir after a failed load retries instead of staying cached with the error", async () => {
    let call = 0;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/browse/tree") && url.includes("path=src")) {
        call++;
        if (call === 1) return jsonResponse({ detail: "slow down" }, 403); // transient rate-limit blip
        return jsonResponse({ ref: "HEAD", path: "src", entries: [{ name: "index.ts", path: "src/index.ts", type: "file" }] });
      }
      return jsonResponse({ ref: "HEAD", path: "", entries: [{ name: "src", path: "src", type: "dir" }] });
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useBrowseTree("c1", "HEAD", ""));

    await waitFor(() => expect(result.current.dirCache[""]?.entries).not.toBeNull());

    // first expand: fails
    act(() => result.current.toggleDir("src"));
    await waitFor(() => expect(result.current.dirCache["src"]?.error).toBeTruthy());
    expect(result.current.dirCache["src"]?.loading).toBe(false);

    // collapse
    act(() => result.current.toggleDir("src"));
    expect(result.current.expanded.has("src")).toBe(false);

    // re-expand: must retry (NOT reuse the cached error) and succeed this time
    act(() => result.current.toggleDir("src"));
    await waitFor(() => expect(result.current.dirCache["src"]?.entries).not.toBeNull());
    expect(result.current.dirCache["src"]?.error).toBeNull();
    expect(call).toBe(2);
  });

  it("a successful dir load stays cached — collapsing/re-expanding does NOT refetch", async () => {
    let call = 0;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/browse/tree") && url.includes("path=src")) {
        call++;
        return jsonResponse({ ref: "HEAD", path: "src", entries: [{ name: "index.ts", path: "src/index.ts", type: "file" }] });
      }
      return jsonResponse({ ref: "HEAD", path: "", entries: [{ name: "src", path: "src", type: "dir" }] });
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useBrowseTree("c1", "HEAD", ""));
    await waitFor(() => expect(result.current.dirCache[""]?.entries).not.toBeNull());

    act(() => result.current.toggleDir("src"));
    await waitFor(() => expect(result.current.dirCache["src"]?.entries).not.toBeNull());
    expect(call).toBe(1);

    act(() => result.current.toggleDir("src")); // collapse
    act(() => result.current.toggleDir("src")); // re-expand
    await waitFor(() => expect(result.current.expanded.has("src")).toBe(true));
    expect(call).toBe(1); // still cached — no refetch
  });

  it("retryDir re-fetches a failed dir WITHOUT toggling collapsed/expanded state", async () => {
    let call = 0;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/browse/tree") && url.includes("path=src")) {
        call++;
        if (call === 1) return jsonResponse({ detail: "slow down" }, 403);
        return jsonResponse({ ref: "HEAD", path: "src", entries: [{ name: "index.ts", path: "src/index.ts", type: "file" }] });
      }
      return jsonResponse({ ref: "HEAD", path: "", entries: [{ name: "src", path: "src", type: "dir" }] });
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useBrowseTree("c1", "HEAD", ""));
    await waitFor(() => expect(result.current.dirCache[""]?.entries).not.toBeNull());

    act(() => result.current.toggleDir("src"));
    await waitFor(() => expect(result.current.dirCache["src"]?.error).toBeTruthy());
    expect(result.current.expanded.has("src")).toBe(true);

    act(() => result.current.retryDir("src"));
    // in-flight retry shows loading
    expect(result.current.dirCache["src"]?.loading).toBe(true);
    await waitFor(() => expect(result.current.dirCache["src"]?.entries).not.toBeNull());
    expect(result.current.expanded.has("src")).toBe(true); // still expanded, never collapsed
    expect(call).toBe(2);
  });
});
