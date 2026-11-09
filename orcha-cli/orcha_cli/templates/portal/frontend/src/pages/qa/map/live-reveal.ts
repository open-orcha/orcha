/**
 * Map the app, live: while a map session runs, the map is read again every few seconds and the
 * page shows what changed. Pure: the hook (`use-map-crawl.ts`) fetches, this decides what changed.
 *
 * `applyMapChanges` takes the changes known (none from a poll) and the fresh map (when the read
 * worked) and answers the map to show, the screens the crawl just revealed (newly on the map, or
 * newly seen) and the newest of them, which the camera may follow.
 */
import type { AppMap, AppMapNode } from "./types";

/** One change to a map row. */
export interface MapChange {
  table: string;
  op: "INSERT" | "UPDATE" | "DELETE";
  row_id: string;
}

export interface MapReveal {
  map: AppMap;
  /** Screen node ids that are new on the map or newly seen, in the fresh map's order. */
  revealed: string[];
  /** The revealed screen seen last (by `last_seen_at`), else the last revealed; null for none. */
  newest: string | null;
}

/** Drop the deleted rows: nodes by their row id, edges by theirs and with any node they touch. */
function withoutDeleted(map: AppMap, changes: readonly MapChange[]): AppMap {
  const nodes = new Set(changes.filter((c) => c.op === "DELETE" && c.table === "app_map_nodes").map((c) => c.row_id));
  const edges = new Set(changes.filter((c) => c.op === "DELETE" && c.table === "app_map_edges").map((c) => c.row_id));
  if (nodes.size === 0 && edges.size === 0) return map;
  const dropped = new Set(map.nodes.filter((n) => n.row_id && nodes.has(n.row_id)).map((n) => n.id));
  if (dropped.size === 0 && !map.edges.some((e) => edges.has(e.id))) return map;
  return {
    ...map,
    nodes: map.nodes.filter((n) => !dropped.has(n.id)),
    edges: map.edges.filter((e) => !edges.has(e.id) && !dropped.has(e.from) && !dropped.has(e.to)),
  };
}

/** Screens of `next` that `prev` did not have, or had but not as seen. */
export function revealedScreens(prev: AppMap, next: AppMap): AppMapNode[] {
  const before = new Map(prev.nodes.map((n) => [n.id, n]));
  return next.nodes.filter((n) => {
    if (n.kind !== "screen") return false;
    const old = before.get(n.id);
    return !old || (n.state === "seen" && old.state !== "seen");
  });
}

/**
 * The map after a batch of changes. With `fresh` (the map read after them) the fresh
 * map is what is shown and the reveals are measured against `prev`; without it (the read failed)
 * only the deletes can be applied, and nothing is revealed.
 */
export function applyMapChanges(prev: AppMap, changes: readonly MapChange[], fresh: AppMap | null): MapReveal {
  if (!fresh) return { map: withoutDeleted(prev, changes), revealed: [], newest: null };
  const shown = revealedScreens(prev, fresh);
  let newest: AppMapNode | null = null;
  for (const n of shown) {
    const at = n.evidence.live?.last_seen_at ?? "";
    if (!newest || at >= (newest.evidence.live?.last_seen_at ?? "")) newest = n;
  }
  return { map: fresh, revealed: shown.map((n) => n.id), newest: newest?.id ?? null };
}

/** How many screens the crawl's run has seen (the ones it saw last). */
export function screensSeenIn(map: AppMap, runId: string | null | undefined): number {
  if (!runId) return 0;
  return map.nodes.filter((n) => n.kind === "screen" && n.state === "seen" && n.evidence.live?.last_run_id === runId).length;
}

/** The crawl's time left as "6:12" (never below "0:00"), or null before its clock started. */
export function timeLeft(minutes: number | null | undefined, clockStartedAt: string | null | undefined, now: number): string | null {
  if (!minutes || !clockStartedAt) return null;
  const started = Date.parse(clockStartedAt);
  if (Number.isNaN(started)) return null;
  const left = Math.max(0, Math.round((started + minutes * 60_000 - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

// ---------- the planned crawl's queue  ----------

/**
 * A planned crawl works through a queue of unreached screens, each with a way in and a time
 * budget, with its live state on the session. The Map outlines the next targets, pulses the current one with a
 * ring that counts its budget down, and the chip says how far the queue has got.
 */
export type CrawlTargetStatus = "queued" | "current" | "reached" | "explored" | "blocked" | "skipped";
export type CrawlWayInKind = "route" | "deep_link" | "intent" | "path" | "none";

export interface CrawlWayIn {
  kind: CrawlWayInKind;
  url: string | null;
  hops: number | null;
  note: string | null;
}

export interface CrawlTarget {
  key: string;
  label: string;
  feature: string | null;
  status: CrawlTargetStatus;
  /** The phase the current target is in; null for every other target. */
  phase: "reach" | "explore" | null;
  way_in: CrawlWayIn;
  budget_s: number | null;
  phase_started_at: string | null;
  deadline_at: string | null;
  used_s: number | null;
  overruns: number;
  reason: string | null;
  origin: "map" | "discovered";
  score: number | null;
  why: string[];
}

export interface CrawlQueue {
  version: number;
  mode: "enforced" | "guide";
  platform: string | null;
  total: number;
  /** Targets finished: reached, explored, blocked or skipped. */
  done: number;
  reached: number;
  index: number | null;
  current: string | null;
  updated_at: string | null;
  budgets: { reach_s: number; explore_s: number; grace_s: number } | null;
  targets: CrawlTarget[];
}

const STATUSES: readonly CrawlTargetStatus[] = ["queued", "current", "reached", "explored", "blocked", "skipped"];
const WAY_IN_KINDS: readonly CrawlWayInKind[] = ["route", "deep_link", "intent", "path", "none"];
/** Finished targets: what the chip counts as done when the queue does not say. */
const FINISHED: ReadonlySet<CrawlTargetStatus> = new Set(["reached", "explored", "blocked", "skipped"]);

const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const count = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.max(0, Math.round(n));
};

function parseWayIn(raw: unknown): CrawlWayIn {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const kind = WAY_IN_KINDS.includes(o.kind as CrawlWayInKind) ? (o.kind as CrawlWayInKind) : "none";
  return { kind, url: text(o.url), hops: count(o.hops), note: text(o.note) };
}

function parseTarget(raw: unknown): CrawlTarget | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const key = text(o.key);
  if (!key) return null;
  const status = STATUSES.includes(o.status as CrawlTargetStatus) ? (o.status as CrawlTargetStatus) : "queued";
  return {
    key,
    label: text(o.label) ?? key,
    feature: text(o.feature),
    status,
    phase: status === "current" && (o.phase === "reach" || o.phase === "explore") ? o.phase : null,
    way_in: parseWayIn(o.way_in),
    budget_s: num(o.budget_s),
    phase_started_at: text(o.phase_started_at),
    deadline_at: text(o.deadline_at),
    used_s: num(o.used_s),
    overruns: count(o.overruns) ?? 0,
    reason: text(o.reason),
    origin: o.origin === "discovered" ? "discovered" : "map",
    score: num(o.score),
    why: Array.isArray(o.why) ? o.why.filter((w): w is string => typeof w === "string" && w.length > 0) : [],
  };
}

/** The run's `crawl_queue` (decoded or as JSON text), or null when it is missing or not a queue. */
export function parseCrawlQueue(raw: unknown): CrawlQueue | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (!Array.isArray(o.targets)) return null;
  const targets = o.targets.map(parseTarget).filter((t): t is CrawlTarget => t !== null);
  const b = o.budgets && typeof o.budgets === "object" ? (o.budgets as Record<string, unknown>) : null;
  const reach = num(b?.reach_s);
  const explore = num(b?.explore_s);
  return {
    version: count(o.version) ?? 1,
    mode: o.mode === "guide" ? "guide" : "enforced",
    platform: text(o.platform),
    total: count(o.total) ?? targets.length,
    done: count(o.done) ?? targets.filter((t) => FINISHED.has(t.status)).length,
    reached: count(o.reached) ?? targets.filter((t) => t.status === "reached" || t.status === "explored").length,
    index: count(o.index),
    current: text(o.current),
    updated_at: text(o.updated_at),
    budgets: reach !== null && explore !== null ? { reach_s: reach, explore_s: explore, grace_s: num(b?.grace_s) ?? 0 } : null,
    targets,
  };
}

/** The target the crawl is on: the one marked current, else the one the queue names. */
export function currentTarget(queue: CrawlQueue | null | undefined): CrawlTarget | null {
  if (!queue) return null;
  return queue.targets.find((t) => t.status === "current") ?? (queue.current ? (queue.targets.find((t) => t.key === queue.current && !FINISHED.has(t.status)) ?? null) : null);
}

/** How a screen card shows its place in the queue: the target the crawl is on, or one of the next. */
export type QueueMark = { role: "current"; target: CrawlTarget } | { role: "next"; order: number; target: CrawlTarget };

/** How many of the next targets the Map outlines. */
export const NEXT_TARGETS = 5;

/**
 * The queue's marks by screen key: the current target, then the next `next` queued targets in
 * queue order (1-based `order`). Finished targets carry no mark: the map's own state says what
 * became of them.
 */
export function queueMarks(queue: CrawlQueue | null | undefined, next = NEXT_TARGETS): ReadonlyMap<string, QueueMark> {
  const marks = new Map<string, QueueMark>();
  if (!queue) return marks;
  const now = currentTarget(queue);
  if (now) marks.set(now.key, { role: "current", target: now });
  let order = 0;
  for (const t of queue.targets) {
    if (order >= next) break;
    if (t.status !== "queued" || marks.has(t.key)) continue;
    marks.set(t.key, { role: "next", order: ++order, target: t });
  }
  return marks;
}

/**
 * The current target's budget left at `now` (ms): seconds and the share of its phase budget
 * (1 at the start, 0 when it ran out), from `deadline_at`, else `phase_started_at + budget_s`.
 * Null when the target has no budget or no start.
 */
export function budgetLeft(target: CrawlTarget | null | undefined, now: number): { left_s: number; fraction: number } | null {
  if (!target || !target.budget_s || target.budget_s <= 0) return null;
  const started = target.phase_started_at ? Date.parse(target.phase_started_at) : Number.NaN;
  const deadline = target.deadline_at ? Date.parse(target.deadline_at) : Number.isNaN(started) ? Number.NaN : started + target.budget_s * 1000;
  if (Number.isNaN(deadline)) return null;
  const left = Math.max(0, Math.min(target.budget_s, (deadline - now) / 1000));
  return { left_s: Math.round(left), fraction: Math.max(0, Math.min(1, left / target.budget_s)) };
}

/** Seconds as "0:18", "6:12". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The queue's progress for the chip: "14 of 40 targets". */
export function queueProgress(queue: CrawlQueue): string {
  return `${queue.done} of ${queue.total} ${queue.total === 1 ? "target" : "targets"}`;
}

/**
 * Where Follow keeps the camera: whichever moved last, the newest screen the crawl revealed or
 * the target it moved on to. `prev` is the last decision; it is kept while neither changes.
 */
export function nextFollow(
  prev: { newest: string | null; current: string | null; id: string | null },
  newest: string | null,
  current: string | null,
): { newest: string | null; current: string | null; id: string | null } {
  if (newest === prev.newest && current === prev.current) return prev;
  const id = current !== prev.current && current ? current : newest !== prev.newest && newest ? newest : prev.id;
  return { newest, current, id };
}
