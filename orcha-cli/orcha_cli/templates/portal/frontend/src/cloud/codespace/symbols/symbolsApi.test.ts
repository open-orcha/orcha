import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOutline, fetchSymbolSearch } from "./symbolsApi";

function stubJson(data: unknown, status = 200) {
  global.fetch = vi.fn(async () => ({ ok: status < 400, status, json: async () => data }) as unknown as Response) as unknown as typeof fetch;
}

describe("fetchSymbolSearch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("builds the query string and returns available results", async () => {
    stubJson({ available: true, ref: "HEAD", results: [{ name: "foo", kind: "function", path: "a.ts", line: 3 }] });
    const res = await fetchSymbolSearch("c1", { ref: "main", q: "foo" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.results).toHaveLength(1);
    const calledUrl = String((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(calledUrl).toBe("/api/containers/c1/code/symbols?ref=main&q=foo");
  });

  it("omits empty q/ref from the query string", async () => {
    stubJson({ available: true, ref: "HEAD", results: [] });
    await fetchSymbolSearch("c1", {});
    const calledUrl = String((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(calledUrl).toBe("/api/containers/c1/code/symbols");
  });

  it("maps available:false repo_not_connected to a not_connected GhError (still HTTP 200)", async () => {
    stubJson({ available: false, reason: "repo_not_connected", detail: "no repo" });
    const res = await fetchSymbolSearch("c1", {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("not_connected");
  });

  it("maps available:false rate_limited to a rate_limited GhError", async () => {
    stubJson({ available: false, reason: "rate_limited", detail: "backing off" });
    const res = await fetchSymbolSearch("c1", {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("rate_limited");
  });

  it("classifies a non-2xx transport failure through the shared GhError ladder", async () => {
    stubJson({ detail: "boom" }, 500);
    const res = await fetchSymbolSearch("c1", {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("error");
  });

  it("classifies a thrown network error", async () => {
    global.fetch = vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const res = await fetchSymbolSearch("c1", {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.detail).toBe("offline");
  });
});

describe("fetchOutline", () => {
  afterEach(() => vi.restoreAllMocks());

  it("requires path and includes ref when given", async () => {
    stubJson({ available: true, ref: "HEAD", path: "a.ts", language: "typescript", symbols: [] });
    await fetchOutline("c1", { ref: "main", path: "a.ts" });
    const calledUrl = String((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    expect(calledUrl).toBe("/api/containers/c1/code/outline?path=a.ts&ref=main");
  });

  it("returns an honest empty outline (language:null) as a normal success", async () => {
    stubJson({ available: true, ref: "HEAD", path: "a.bin", language: null, symbols: [] });
    const res = await fetchOutline("c1", { path: "a.bin" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.language).toBeNull();
      expect(res.data.symbols).toEqual([]);
    }
  });

  it("maps available:false to a GhError", async () => {
    stubJson({ available: false, reason: "unreachable", detail: "could not reach GitHub" });
    const res = await fetchOutline("c1", { path: "a.ts" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe("error");
  });
});
