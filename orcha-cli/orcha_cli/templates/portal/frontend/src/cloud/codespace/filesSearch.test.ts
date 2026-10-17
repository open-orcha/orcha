/**
 * Cmd/Ctrl+K "Files" provider (parity C-03): real repo file names for the
 * CURRENT project, debounced + abortable, honest error vs no-repo states.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchProviders } from "../../shell/search/providers";
import { FILES_DEBOUNCE_MS, pathMatches, searchFiles } from "./filesSearch";

function stubSearch(body: unknown, status = 200) {
  const calls: string[] = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return { ok: status < 400, status, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

describe("Files search provider", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("registers once as the Files group with a 2-char minimum", () => {
    const p = searchProviders().filter((x) => x.id === "files");
    expect(p).toHaveLength(1);
    expect(p[0].group).toBe("Files");
    expect(p[0].minQuery).toBe(2);
  });

  it("returns file hits from the names search, scoped to the project, opening in Code Space", async () => {
    const calls = stubSearch({ results: [
      { path: "src/app/main.ts", type: "file" },
      { path: "src/app", type: "dir" },
      { path: "README.md", type: "file" },
    ] });
    const r = await searchFiles("main", { cid: "c1", signal: new AbortController().signal });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/api/containers/c1/github/browse/search?");
    expect(calls[0]).toContain("mode=names");
    expect(calls[0]).toContain("ref=HEAD");
    // README.md doesn't contain "main" anywhere in its path — dropped by the relevance guard
    expect(r.map((x) => x.label)).toEqual(["main.ts"]);
    expect(r[0].detail).toBe("src/app");
    expect(r[0].href).toBe("/code?path=" + encodeURIComponent("src/app/main.ts"));
  });

  it("does nothing without a project or with a 1-char query", async () => {
    const calls = stubSearch({ results: [] });
    expect(await searchFiles("ab", { cid: null, signal: new AbortController().signal })).toEqual([]);
    expect(await searchFiles("a", { cid: "c1", signal: new AbortController().signal })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("an abort during the debounce window never fires the request", async () => {
    vi.useFakeTimers();
    const calls = stubSearch({ results: [] });
    const ac = new AbortController();
    const pending = searchFiles("main", { cid: "c1", signal: ac.signal });
    ac.abort();
    vi.advanceTimersByTime(FILES_DEBOUNCE_MS + 10);
    expect(await pending).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("no repo connected -> no Files group (empty), not an error", async () => {
    stubSearch({ available: false, reason: "repo_not_connected", detail: "no GitHub repo is connected to this project" });
    expect(await searchFiles("main", { cid: "c1", signal: new AbortController().signal })).toEqual([]);
  });

  it("rate limit / GitHub error throws so the palette shows 'Files search unavailable: …'", async () => {
    stubSearch({ available: false, reason: "rate_limited", detail: "403" });
    await expect(searchFiles("main", { cid: "c1", signal: new AbortController().signal })).rejects.toThrow(/rate limit/);
    stubSearch({ available: false, reason: "unreachable", detail: "could not reach GitHub" });
    await expect(searchFiles("main", { cid: "c1", signal: new AbortController().signal })).rejects.toThrow("could not reach GitHub");
  });
});

describe("pathMatches (relevance guard)", () => {
  it("keeps only paths containing every query token", () => {
    expect(pathMatches("src/shell/Shell.tsx", "front")).toBe(false);
    expect(pathMatches("src/frontend/app.ts", "front")).toBe(true);
    expect(pathMatches("src/frontend/app.ts", "FRONT app")).toBe(true);
    expect(pathMatches("src/frontend/app.ts", "front main")).toBe(false);
  });
});
