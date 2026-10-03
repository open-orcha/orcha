/** V2 QA pure helpers: host navigate scope, route search cid, project move bounds. */
import { beforeEach, describe, expect, it } from "vitest";
import { hostPathNeedsFullLoad, routeSearchWithCid } from "./chrome";
import { moveBounds, togglePinned, _resetProjectsForTests, type ProjectRow } from "../state/projects";

describe("hostPathNeedsFullLoad", () => {
  it("SPA-navigates within the resolved container", () => {
    expect(hostPathNeedsFullLoad("/tasks?cid=c1&task=t", "c1")).toBe(false);
    expect(hostPathNeedsFullLoad("/tasks?task=t", "c1")).toBe(false);
  });
  it("full-loads a path scoped to another container", () => {
    expect(hostPathNeedsFullLoad("/tasks?cid=c2", "c1")).toBe(true);
  });
  it("before the cid resolves, compares against the page's pinned ?cid=", () => {
    // same container the page is resolving → SPA navigate
    expect(hostPathNeedsFullLoad("/tasks?cid=c1", null, "?cid=c1")).toBe(false);
    // a different container than the one in flight → full load
    expect(hostPathNeedsFullLoad("/tasks?cid=c2", null, "?cid=c1")).toBe(true);
    // nothing pinned yet (resolution may pick another container) → full load
    expect(hostPathNeedsFullLoad("/tasks?cid=c2", null, "")).toBe(true);
    // unscoped paths never force a reload
    expect(hostPathNeedsFullLoad("/tasks?task=t", null, "")).toBe(false);
  });
});

describe("routeSearchWithCid", () => {
  it("adds the resolved cid on multi-container stacks", () => {
    expect(routeSearchWithCid("", "c1", true)).toBe("?cid=c1");
    expect(routeSearchWithCid("?task=t", "c1", true)).toBe("?task=t&cid=c1");
    expect(routeSearchWithCid("?cid=c1&x=1", "c1", true)).toBe("?cid=c1&x=1");
  });
  it("leaves single-container / unresolved searches alone", () => {
    expect(routeSearchWithCid("?task=t", "c1", false)).toBe("?task=t");
    expect(routeSearchWithCid("?task=t", null, true)).toBe("?task=t");
  });
});

describe("moveBounds (sidebar Move up / Move down never dead)", () => {
  const rows: ProjectRow[] = [{ id: "a" }, { id: "b" }, { id: "c" }] as ProjectRow[];
  beforeEach(() => { localStorage.clear(); _resetProjectsForTests(); });
  it("first can't move up, last can't move down", () => {
    expect(moveBounds(rows, "a")).toEqual({ up: false, down: true });
    expect(moveBounds(rows, "b")).toEqual({ up: true, down: true });
    expect(moveBounds(rows, "c")).toEqual({ up: true, down: false });
  });
  it("a single project can move nowhere", () => {
    expect(moveBounds([{ id: "a" }] as ProjectRow[], "a")).toEqual({ up: false, down: false });
  });
  it("bounds are per group (pinned vs unpinned)", () => {
    togglePinned("c");
    expect(moveBounds(rows, "c")).toEqual({ up: false, down: false }); // only pinned project
    expect(moveBounds(rows, "a")).toEqual({ up: false, down: true });
    expect(moveBounds(rows, "b")).toEqual({ up: true, down: false });
  });
});
