import { describe, expect, it } from "vitest";
import type { Task } from "../../types";
import {
  filterTasks, groupTasks, latestActivity, matchesQuery, parseTaskQuery, patchSearch, priorityBucket, priorityValue, shortAgo,
  statusFilterOptions, taskComparator, taskCountLabel,
} from "./taskQuery";

const T = (id: string, status: string, priority: number, extra: Partial<Task> = {}): Task =>
  ({
    id, title: "Task " + id, status, priority, assignees: [], assignee: null, description: "", definition_of_done: "",
    protocol: null, result: null, plan_decision: null, runs: [], runs_summary: null, is_root: false, created_by: "human",
    created_at: "2026-08-01T00:00:00Z", started_at: null, completed_at: null, message_summary: { count: 0, last: null },
    plan_message: null, thread: [], ...extra,
  }) as Task;

describe("parseTaskQuery", () => {
  it("defaults to today's behaviour when params are absent", () => {
    expect(parseTaskQuery("")).toEqual({ q: "", status: [], assignee: null, sort: null, group: "status", view: "list", tab: "overview", full: false });
  });
  it("ignores unknown values instead of throwing", () => {
    const q = parseTaskQuery("?status=bogus,ready&sort=sideways&group=x&view=grid&tab=nope&full=yes");
    expect(q.status).toEqual(["ready"]);
    expect(q.sort).toBeNull();
    expect(q.group).toBe("status");
    expect(q.view).toBe("list");
    expect(q.tab).toBe("overview");
    expect(q.full).toBe(false);
  });
});

describe("patchSearch", () => {
  it("sets/removes keys and drops defaults", () => {
    expect(patchSearch("?task=a&cid=c1", { q: "x", group: "status", tab: "overview" })).toBe("?task=a&cid=c1&q=x");
    expect(patchSearch("?q=x&cid=c1", { q: null })).toBe("?cid=c1");
  });
});

describe("filter / search", () => {
  const tasks = [
    T("abc123", "ready", 10, { title: "Build login", assignees: ["forge"], assignee: "forge" }),
    T("def456", "weird_status", 20, { description: "migrate the DB" }),
  ];
  it("matches title, description, #id prefix and assignee", () => {
    expect(matchesQuery(tasks[0], "login")).toBe(true);
    expect(matchesQuery(tasks[1], "migrate")).toBe(true);
    expect(matchesQuery(tasks[1], "#def4")).toBe(true);
    expect(matchesQuery(tasks[0], "#def4")).toBe(false);
    expect(matchesQuery(tasks[0], "forge")).toBe(true);
  });
  it("status 'other' catches statuses outside the known groups; assignee none = unassigned", () => {
    expect(filterTasks(tasks, parseTaskQuery("?status=other")).map((t) => t.id)).toEqual(["def456"]);
    expect(filterTasks(tasks, parseTaskQuery("?assignee=none")).map((t) => t.id)).toEqual(["def456"]);
  });
});

describe("groupTasks", () => {
  it("keeps GRP order and never drops an unexpected status", () => {
    const g = groupTasks([T("a", "completed", 1), T("b", "needs_verification", 1), T("c", "mystery", 1), T("d", "failed", 1)], "status");
    expect(g.map((x) => x.label)).toEqual(["Needs verification", "Failed", "Completed", "Other"]);
  });
});

describe("taskComparator", () => {
  it("bucket outer key when grouped by status; priority asc within", () => {
    const list = [T("a", "ready", 50), T("b", "needs_verification", 90), T("c", "ready", 10)];
    expect(list.sort(taskComparator({ key: "priority", dir: "asc" }, true)).map((t) => t.id)).toEqual(["b", "c", "a"]);
  });
});

describe("latestActivity", () => {
  it("picks the newest of last message / latest run / lifecycle", () => {
    const t = T("a", "in_progress", 1, {
      started_at: "2026-08-02T00:00:00Z",
      message_summary: { count: 1, last: { body: "pushed the fix", author_alias: "forge", at: "2026-08-03T00:00:00Z" } },
      runs_summary: { count: 1, latest: { status: "failed", exit_code: 1, started_at: "2026-08-02T01:00:00Z" } as never },
    });
    expect(latestActivity(t).text).toBe("forge: pushed the fix");
  });
});

describe("priority buckets", () => {
  it("maps the free integer (lower = higher) to Urgent/High/Normal/Low", () => {
    expect(priorityBucket(1).k).toBe("urgent");
    expect(priorityBucket(5).k).toBe("urgent");
    expect(priorityBucket(10).k).toBe("high");
    expect(priorityBucket(20).k).toBe("high");
    expect(priorityBucket(50).k).toBe("normal");
    expect(priorityBucket(100).k).toBe("normal");
    expect(priorityBucket(null).k).toBe("normal"); // default
    expect(priorityBucket("junk").k).toBe("normal");
    expect(priorityBucket(200).k).toBe("low");
  });
  it("round-trips a bucket to its canonical value", () => {
    expect(priorityValue("urgent")).toBe(1);
    expect(priorityValue("high")).toBe(10);
    expect(priorityValue("normal")).toBe(100);
    expect(priorityValue("low")).toBe(200);
    expect(priorityValue("nope")).toBe(100);
    for (const k of ["urgent", "high", "normal", "low"]) expect(priorityBucket(priorityValue(k)).k).toBe(k);
  });
});

describe("counts + status filter options", () => {
  it("labels open vs total (truncated snapshots use the server total)", () => {
    const ts = [T("a", "ready", 1), T("b", "completed", 1), T("c", "cancelled", 1), T("d", "in_progress", 1)];
    expect(taskCountLabel(ts)).toBe("2 open · 4 total");
    expect(taskCountLabel(ts, 1500)).toBe("2 open · 1500 total");
  });
  it("hides empty buckets (and Other) unless selected", () => {
    const opts = statusFilterOptions({ ready: 2, completed: 1 }, ["failed"]).map((o) => o.k);
    expect(opts).toEqual(["ready", "failed", "completed"]);
    expect(statusFilterOptions({ other: 1 }, []).map((o) => o.label)).toEqual(["Other"]);
  });
});

describe("scope pills (SCOPES / scopeOf / scopeCount)", () => {
  it("maps exact status sets to a scope and anything else to null", async () => {
    const { scopeOf } = await import("./taskQuery");
    expect(scopeOf([])).toBe("all");
    expect(scopeOf(["pending", "ready"])).toBe("backlog");
    expect(scopeOf(["completed", "cancelled"])).toBe("done");
    expect(scopeOf(["in_progress", "needs_verification", "failed", "blocked"])).toBe("active");
    expect(scopeOf(["ready"])).toBeNull();
    expect(scopeOf(["completed"])).toBeNull();
  });
  it("counts per scope; 'all' includes unknown statuses", async () => {
    const { scopeCount } = await import("./taskQuery");
    const c = { in_progress: 2, needs_verification: 1, ready: 3, completed: 4, other: 1 };
    expect(scopeCount(c, "all")).toBe(11);
    expect(scopeCount(c, "active")).toBe(3);
    expect(scopeCount(c, "backlog")).toBe(3);
    expect(scopeCount(c, "done")).toBe(4);
  });
  it("shortAgo trims relTime output and hides unknown", async () => {
    const { shortAgo } = await import("./taskQuery");
    expect(shortAgo("5m ago")).toBe("5m");
    expect(shortAgo("—")).toBe("");
    expect(shortAgo("just now")).toBe("now") // r2: fits the 34 px time column;
  });
});

describe("shortAgo (row time column)", () => {
  it("never renders the wide 'just now' in the 34 px column (r2 e2e clip)", () => {
    expect(shortAgo("just now")).toBe("now");
    expect(shortAgo("5m ago")).toBe("5m");
    expect(shortAgo("—")).toBe("");
  });
});
