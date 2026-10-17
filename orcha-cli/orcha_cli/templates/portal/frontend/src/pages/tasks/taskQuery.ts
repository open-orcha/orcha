/**
 * Tasks list query model (pure; unit-tested in taskQuery.test.ts).
 *
 * URL contract (docs/orcha-v2-architecture.md §2.1), all optional — absent =
 * pre-V2 behaviour:
 *   task=<id>                    selected task (replace)
 *   q=<text>                     search: title / description / id prefix / `#shortid` / assignee / reviewer
 *   status=<csv>                 exact backend statuses (+ "other" = any status outside the known groups)
 *   assignee=<alias>|none        one assignee, or unassigned
 *   sort=time-desc|time-asc|priority-asc|priority-desc   (absent = the persisted orcha:sort:tasks choice)
 *   group=status|assignee|none   (default status)
 *   view=list|board              (default list; board = the read-only "tasks by status" view)
 *   tab=overview|activity|runs   (detail tab; default overview)
 *   full=1                       selected task as a full view (list hidden)
 *   new=1                        open the New task composer (palette "New task")
 * Unknown values are ignored, never thrown.
 */
import type { Task } from "../../types";
import { sortState, type SortState } from "../../lib/sort";

export const GROUP_ORDER: { k: string; label: string }[] = [
  { k: "needs_verification", label: "Needs verification" },
  { k: "in_progress", label: "In progress" },
  { k: "ready", label: "Ready" },
  { k: "pending", label: "Pending" },
  { k: "blocked", label: "Blocked" },
  { k: "failed", label: "Failed" },
  { k: "completed", label: "Completed" },
  { k: "cancelled", label: "Cancelled" },
];
export const KNOWN_STATUSES = GROUP_ORDER.map((g) => g.k);

// ISS-37 / ISS-331 status bucket (outer sort key when grouped by status)
const BUCKET: Record<string, number> = {
  needs_verification: 0, in_progress: 1, ready: 2, blocked: 3, failed: 3, pending: 4, completed: 5, cancelled: 6,
};
export const taskBucket = (t: Task) => BUCKET[t.status] ?? 9;
export const taskTime = (t: Task) => Date.parse(t.created_at || "") || 0;
export const taskPrio = (t: Task) => {
  const n = Number(t.priority ?? 100);
  return Number.isFinite(n) ? n : 100;
};

/* ---- priority buckets ------------------------------------------------------
   The backend priority is a free integer (lower = higher, default 100). The UI
   speaks in four buckets; the create form maps a bucket back to its canonical
   value. The exact number stays visible in the detail and row tooltips. */
export type PriorityKey = "urgent" | "high" | "normal" | "low";
export const PRIORITY_BUCKETS: { k: PriorityKey; label: string; value: number; max: number }[] = [
  { k: "urgent", label: "Urgent", value: 1, max: 5 },
  { k: "high", label: "High", value: 10, max: 20 },
  { k: "normal", label: "Normal", value: 100, max: 100 },
  { k: "low", label: "Low", value: 200, max: Number.POSITIVE_INFINITY },
];
export const DEFAULT_PRIORITY = 100;
export function priorityBucket(p: string | number | null | undefined): (typeof PRIORITY_BUCKETS)[number] {
  const n = Number(p ?? DEFAULT_PRIORITY);
  const v = Number.isFinite(n) ? n : DEFAULT_PRIORITY;
  return PRIORITY_BUCKETS.find((b) => v <= b.max) || PRIORITY_BUCKETS[PRIORITY_BUCKETS.length - 1];
}
export const priorityValue = (k: string): number => (PRIORITY_BUCKETS.find((b) => b.k === k) || PRIORITY_BUCKETS[2]).value;

/** Open = still actionable (not completed / cancelled). */
export const isOpenTask = (t: Task) => t.status !== "completed" && t.status !== "cancelled";

/** Header context: "15 open · 20 total" (+ "of N" when the snapshot is truncated). */
export function taskCountLabel(tasks: Task[], total?: number | null, openTotal?: number | null): string {
  // `openTotal` = the shared open-work count (sectionCounts / the Tasks tab),
  // so the header and the tab never disagree
  const open = openTotal ?? tasks.filter(isOpenTask).length;
  const all = total != null && total > tasks.length ? total : tasks.length;
  return `${open} open · ${all} total`;
}

/** Status-filter options: every known bucket that has tasks (or is selected); "Other" only when used. */
export function statusFilterOptions(counts: Record<string, number>, selected: string[]): { k: string; label: string }[] {
  return [...GROUP_ORDER, { k: "other", label: "Other" }].filter((o) => (counts[o.k] ?? 0) > 0 || selected.includes(o.k));
}

export type SortKey = "time-desc" | "time-asc" | "priority-asc" | "priority-desc";
export const SORT_KEYS: { k: SortKey; label: string }[] = [
  { k: "time-desc", label: "Newest first" },
  { k: "time-asc", label: "Oldest first" },
  { k: "priority-asc", label: "Priority · highest first" },
  { k: "priority-desc", label: "Priority · lowest first" },
];
export type GroupKey = "status" | "assignee" | "none";
export type ViewKey = "list" | "board";
export type TabKey = "overview" | "activity" | "runs";

export interface TaskQuery {
  q: string;
  status: string[];
  assignee: string | null;
  sort: SortKey | null; // null = persisted local choice
  group: GroupKey;
  view: ViewKey;
  tab: TabKey;
  full: boolean;
}

const oneOf = <T extends string>(v: string | null, allowed: readonly T[], dflt: T): T =>
  v != null && (allowed as readonly string[]).includes(v) ? (v as T) : dflt;

export function parseTaskQuery(search: string): TaskQuery {
  const p = new URLSearchParams(search);
  const sortRaw = p.get("sort");
  const sort = SORT_KEYS.some((s) => s.k === sortRaw) ? (sortRaw as SortKey) : null;
  const status = (p.get("status") || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && (KNOWN_STATUSES.includes(s) || s === "other"));
  return {
    q: p.get("q") || "",
    status: Array.from(new Set(status)),
    assignee: p.get("assignee") || null,
    sort,
    group: oneOf(p.get("group"), ["status", "assignee", "none"] as const, "status"),
    view: oneOf(p.get("view"), ["list", "board"] as const, "list"),
    tab: oneOf(p.get("tab"), ["overview", "activity", "runs"] as const, "overview"),
    full: p.get("full") === "1",
  };
}

/** Apply a patch to the current search string (drops defaults so URLs stay short). */
export function patchSearch(search: string, patch: Record<string, string | null | undefined>): string {
  const p = new URLSearchParams(search);
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === "") p.delete(k);
    else p.set(k, v);
  }
  // defaults are implicit
  if (p.get("group") === "status") p.delete("group");
  if (p.get("view") === "list") p.delete("view");
  if (p.get("tab") === "overview") p.delete("tab");
  const s = p.toString();
  return s ? "?" + s : "";
}

export function sortFromKey(k: SortKey | null): SortState {
  if (!k) return sortState("tasks");
  const [key, dir] = k.split("-") as ["time" | "priority", "asc" | "desc"];
  return { key, dir };
}
export function keyFromSort(st: SortState): SortKey {
  return `${st.key}-${st.dir}` as SortKey;
}

/** Mirrors lib/sort sortComparator (server _sort_clause); bucket is optional. */
export function taskComparator(st: SortState, useBucket: boolean): (a: Task, b: Task) => number {
  const sign = st.dir === "asc" ? 1 : -1;
  return (a, b) => {
    if (useBucket) {
      const bk = taskBucket(a) - taskBucket(b);
      if (bk) return bk;
    }
    if (st.key === "priority") {
      const d = taskPrio(a) - taskPrio(b);
      if (d) return sign * d;
      return taskTime(b) - taskTime(a);
    }
    const d = taskTime(a) - taskTime(b);
    if (d) return sign * d;
    return taskPrio(a) - taskPrio(b);
  };
}

function reviewerText(t: Task): string {
  const r = t.reviewer;
  if (!r) return "";
  if (typeof r === "string") return r;
  return [r.alias, r.github_login].filter(Boolean).join(" ");
}

export function matchesQuery(t: Task, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  const id = String(t.id).toLowerCase();
  return s.split(/\s+/).every((tok) => {
    if (tok.startsWith("#") && tok.length > 1) return id.startsWith(tok.slice(1));
    if (id.startsWith(tok)) return true;
    const hay = [t.title, t.description, (t.assignees || []).join(" "), reviewerText(t)].join("\n").toLowerCase();
    return hay.includes(tok);
  });
}

export function filterTasks(tasks: Task[], q: TaskQuery): Task[] {
  return tasks.filter((t) => {
    if (q.status.length) {
      const inKnown = KNOWN_STATUSES.includes(t.status);
      if (!(q.status.includes(t.status) || (!inKnown && q.status.includes("other")))) return false;
    }
    if (q.assignee) {
      if (q.assignee === "none") {
        if ((t.assignees || []).length || t.assignee) return false;
      } else if (!(t.assignees || []).includes(q.assignee) && t.assignee !== q.assignee) return false;
    }
    return matchesQuery(t, q.q);
  });
}

export interface TaskGroup { k: string; label: string; items: Task[] }

/** Group an already-sorted list. Status grouping keeps the GRP order and an
 *  "Other" catch-all so a task with an unexpected status is never dropped. */
export function groupTasks(sorted: Task[], group: GroupKey): TaskGroup[] {
  if (group === "none") return sorted.length ? [{ k: "all", label: "All tasks", items: sorted }] : [];
  if (group === "assignee") {
    // A task with several assignees is listed under EACH of them (never only
    // the first) — its row still shows every assignee's avatar.
    const by = new Map<string, Task[]>();
    for (const t of sorted) {
      const all = (t.assignees || []).length ? Array.from(new Set(t.assignees)) : t.assignee ? [t.assignee] : [""];
      for (const k of all) {
        if (!by.has(k)) by.set(k, []);
        by.get(k)!.push(t);
      }
    }
    return Array.from(by.keys())
      .sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
      .map((k) => ({ k: k || "__none", label: k || "Unassigned", items: by.get(k)! }));
  }
  const grouped = new Set<string>();
  const groups = GROUP_ORDER.map((g) => {
    const items = sorted.filter((x) => x.status === g.k);
    items.forEach((x) => grouped.add(x.id));
    return { ...g, items };
  }).filter((g) => g.items.length);
  const other = sorted.filter((x) => !grouped.has(x.id)); // never silently drop a task
  if (other.length) groups.push({ k: "other", label: "Other", items: other });
  return groups;
}

export function activeFilterCount(q: TaskQuery): number {
  return (q.q.trim() ? 1 : 0) + (q.status.length ? 1 : 0) + (q.assignee ? 1 : 0);
}

/** Latest meaningful activity for a row: newest of last message / latest run / lifecycle stamp. */
export function latestActivity(t: Task): { text: string; at: string | null } {
  const cands: { text: string; at: string | null }[] = [];
  const last = t.message_summary?.last as
    | { body?: string; author_alias?: string; at?: string; created_at?: string; is_human?: boolean }
    | null
    | undefined;
  if (last && (last.body || last.author_alias)) {
    const who = last.author_alias || (last.is_human ? "human" : "system");
    cands.push({ text: who + ": " + String(last.body || "").replace(/\s+/g, " ").trim(), at: last.at || last.created_at || null });
  }
  const run = t.runs_summary?.latest as { status?: string; exit_code?: number | null; started_at?: string; ended_at?: string } | undefined;
  if (run && run.status) {
    const exit = run.exit_code != null && run.status !== "running" ? " · exit " + run.exit_code : "";
    cands.push({ text: "run " + run.status + exit, at: run.ended_at || run.started_at || null });
  }
  if (t.completed_at) cands.push({ text: "finished", at: t.completed_at });
  else if (t.started_at) cands.push({ text: "started", at: t.started_at });
  cands.push({ text: "created", at: t.created_at || null });
  const ts = (c: { at: string | null }) => (c.at ? Date.parse(c.at) || 0 : 0);
  return cands.reduce((best, c) => (ts(c) > ts(best) ? c : best), cands[0]);
}

/* ---- scope pills (Linear "All tasks · Active · Backlog") -------------------
   A scope is a named preset of the exact `status=` filter — nothing new is
   stored; the URL keeps the real statuses, so a custom status selection simply
   leaves no pill selected. Failed/blocked stay under Active (open work that
   needs attention), completed and cancelled stay distinct statuses inside Done. */
export type ScopeKey = "all" | "active" | "backlog" | "done";
export const SCOPES: { k: ScopeKey; label: string; statuses: string[]; hint: string }[] = [
  { k: "all", label: "All tasks", statuses: [], hint: "Every task in this project" },
  { k: "active", label: "Active", statuses: ["needs_verification", "in_progress", "blocked", "failed"], hint: "Needs verification, in progress, blocked or failed" },
  { k: "backlog", label: "Backlog", statuses: ["ready", "pending"], hint: "Ready or pending (not started)" },
  { k: "done", label: "Done", statuses: ["completed", "cancelled"], hint: "Completed or cancelled" },
];

/** The scope whose status set equals the current filter exactly, else null (custom filter). */
export function scopeOf(status: string[]): ScopeKey | null {
  const set = new Set(status);
  const hit = SCOPES.find((s) => s.statuses.length === set.size && s.statuses.every((x) => set.has(x)));
  return hit ? hit.k : null;
}

/** Task count for a scope from per-status counts (the "all" scope counts every task, "other" included). */
export function scopeCount(counts: Record<string, number>, k: ScopeKey): number {
  const s = SCOPES.find((x) => x.k === k);
  if (!s) return 0;
  if (!s.statuses.length) return Object.values(counts).reduce((a, b) => a + b, 0);
  return s.statuses.reduce((a, st) => a + (counts[st] || 0), 0);
}

/** Compact relative time for list rows / cards: "5m", "3h", "2d" (never "—" noise → ""). */
export function shortAgo(rel: string): string {
  if (!rel || rel === "—") return "";
  // "just now" is wider than the 34 px time column and was clipped at the
  // list's right edge beside an open inspector (r2 e2e) — Linear's "now"
  if (rel === "just now") return "now";
  return rel.replace(/ ago$/, "");
}
