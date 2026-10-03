/** Project list store (arch §4): single-flight fetch, local pin/order, stale-response guard. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetProjectsForTests,
  getProjectsState,
  moveProject,
  orderProjects,
  pinnedProjects,
  refreshProjects,
  togglePinned,
  type ProjectRow,
} from "./projects";

const rows: ProjectRow[] = [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }, { id: "d", name: "D" }];
const ids = (r: ProjectRow[]) => r.map((x) => x.id);

beforeEach(() => { localStorage.clear(); _resetProjectsForTests(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("orderProjects", () => {
  it("server order by default", () => {
    expect(ids(orderProjects(rows))).toEqual(["a", "b", "c", "d"]);
  });
  it("pinned first (in pin order), then local order, then server order", () => {
    togglePinned("c");
    togglePinned("a");
    expect(pinnedProjects()).toEqual(["c", "a"]);
    expect(ids(orderProjects(rows))).toEqual(["c", "a", "b", "d"]);
    moveProject(rows, "d", -1);
    expect(ids(orderProjects(rows))).toEqual(["c", "a", "d", "b"]);
    moveProject(rows, "a", -1); // within the pinned group
    expect(ids(orderProjects(rows))).toEqual(["a", "c", "d", "b"]);
    togglePinned("a"); // unpin → back to the unpinned group, after locally ordered rows
    expect(ids(orderProjects(rows))).toEqual(["c", "d", "b", "a"]);
  });
  it("moving past either end is a no-op; unknown/removed ids are ignored", () => {
    moveProject(rows, "a", -1);
    expect(ids(orderProjects(rows))).toEqual(["a", "b", "c", "d"]);
    localStorage.setItem("orcha:v2:projectOrder", JSON.stringify(["zzz", "d"]));
    expect(ids(orderProjects(rows))).toEqual(["d", "a", "b", "c"]);
  });
  it("corrupt stored prefs are tolerated", () => {
    localStorage.setItem("orcha:v2:pinnedProjects", "{not json");
    expect(ids(orderProjects(rows))).toEqual(["a", "b", "c", "d"]);
  });
});

describe("refreshProjects", () => {
  it("single-flights concurrent refreshes and accepts both list shapes", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ containers: [{ id: 1, name: "One", needs_you: 2 }] }) }) as unknown as Response);
    global.fetch = fetchMock as unknown as typeof fetch;
    await Promise.all([refreshProjects(), refreshProjects()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getProjectsState().list).toEqual([{ id: "1", name: "One", needs_you: 2 }]);
    expect(getProjectsState().fetchedAt).not.toBeNull();
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => [{ id: "x" }] }) as unknown as Response) as unknown as typeof fetch;
    await refreshProjects();
    expect(getProjectsState().list).toEqual([{ id: "x" }]);
  });
  it("failure keeps the last list and reports the error", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ containers: [{ id: "a" }] }) }) as unknown as Response) as unknown as typeof fetch;
    await refreshProjects();
    global.fetch = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    await refreshProjects();
    expect(getProjectsState().list).toEqual([{ id: "a" }]);
    expect(getProjectsState().error).toMatch(/503/);
  });
});
