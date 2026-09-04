/**
 * recentFiles.ts — localStorage read/write helpers for recently-viewed files,
 * namespaced per project (cid). Pure-ish (touches localStorage only), no DOM.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRecentFiles, recordFileView } from "./recentFiles";

describe("recentFiles", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { localStorage.clear(); });

  it("loadRecentFiles returns [] when nothing has been recorded", () => {
    expect(loadRecentFiles("c1")).toEqual([]);
  });

  it("loadRecentFiles returns [] for an empty cid", () => {
    expect(loadRecentFiles("")).toEqual([]);
  });

  it("recordFileView records a path with a timestamp", () => {
    const result = recordFileView("c1", "a.ts");
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("a.ts");
    expect(typeof result[0].viewedAt).toBe("string");
    expect(loadRecentFiles("c1")[0].path).toBe("a.ts");
  });

  it("recordFileView moves an already-seen path to the front instead of duplicating it", () => {
    recordFileView("c1", "a.ts");
    recordFileView("c1", "b.ts");
    const result = recordFileView("c1", "a.ts");
    expect(result.map((e) => e.path)).toEqual(["a.ts", "b.ts"]);
  });

  it("recordFileView is a no-op (returns the current list) for an empty cid or path", () => {
    expect(recordFileView("", "a.ts")).toEqual([]);
    expect(recordFileView("c1", "")).toEqual([]);
  });

  it("namespaces entries per project (cid) — c1 and c2 don't see each other's history", () => {
    recordFileView("c1", "a.ts");
    recordFileView("c2", "b.ts");
    expect(loadRecentFiles("c1").map((e) => e.path)).toEqual(["a.ts"]);
    expect(loadRecentFiles("c2").map((e) => e.path)).toEqual(["b.ts"]);
  });

  it("caps the list at 20 entries, dropping the oldest", () => {
    for (let i = 0; i < 25; i++) recordFileView("c1", `file${i}.ts`);
    const result = loadRecentFiles("c1");
    expect(result).toHaveLength(20);
    expect(result[0].path).toBe("file24.ts");
    expect(result.some((e) => e.path === "file0.ts")).toBe(false);
  });

  it("loadRecentFiles degrades to [] on corrupt JSON rather than throwing", () => {
    localStorage.setItem("orcha:cs:recentFiles:c1", "{not json");
    expect(loadRecentFiles("c1")).toEqual([]);
  });

  it("loadRecentFiles degrades to [] when the stored value isn't an array", () => {
    localStorage.setItem("orcha:cs:recentFiles:c1", JSON.stringify({ oops: true }));
    expect(loadRecentFiles("c1")).toEqual([]);
  });

  it("loadRecentFiles filters out malformed entries within an otherwise-valid array", () => {
    localStorage.setItem(
      "orcha:cs:recentFiles:c1",
      JSON.stringify([{ path: "ok.ts", viewedAt: "now" }, { path: 5, viewedAt: "now" }, { oops: true }]),
    );
    expect(loadRecentFiles("c1")).toEqual([{ path: "ok.ts", viewedAt: "now" }]);
  });
});
