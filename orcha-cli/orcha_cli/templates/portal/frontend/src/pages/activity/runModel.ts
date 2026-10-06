/**
 * Pure run model for the Activity view and the agent Runs tab (Agent E).
 *
 * Worker-run statuses come from the backend verbatim (worker_runs.status):
 *   running | exited | killed | rate_limited | failed | orphaned
 * plus `exit_code` and a JSON `kill_reason` whose `cause` explains a kill
 * (human_stop, stalled, hard_cap, sandbox_oom, …). Nothing here invents a
 * status: every outcome keeps the exact backend status in its label, and a
 * human stop is never shown as a failure nor a clean exit as "verified" —
 * a run exiting is not task completion (brief §3).
 */
import type { Run } from "../../types";

/** The /runs row as the backend serializes it (worker_run_support.run_row). */
export type WorkerRun = Run & {
  task_id?: string | null;
  wake_event?: string | null;
  lane?: string | null;
  runtime?: string | null;
  branch?: string | null;
  conversation_id?: string | null;
  /** host checkout the run works in (its isolated worktree / the base checkout) */
  worktree?: string | null;
  base_cwd?: string | null;
};

export type RunBucket = "running" | "finished" | "failed";
export type RunStateFilter = RunBucket | "all";
export const RUN_STATE_FILTERS: { key: RunStateFilter; label: string; hint: string }[] = [
  { key: "all", label: "All", hint: "Every loaded run" },
  { key: "running", label: "Running", hint: "Worker runs still in progress" },
  { key: "finished", label: "Finished", hint: "Exited cleanly (exit 0 or no exit code)" },
  { key: "failed", label: "Failed / stopped", hint: "Killed, stopped, rate-limited, orphaned, failed, or a non-zero exit" },
];

export function parseStateFilter(v: string | null | undefined): RunStateFilter {
  return v === "running" || v === "finished" || v === "failed" || v === "all" ? v : "all";
}

export function runId(r: Pick<Run, "run_id" | "id">): string {
  return String(r.run_id || r.id || "");
}

export function killCause(kr: string | null | undefined): string {
  if (!kr) return "";
  try {
    const v = JSON.parse(kr) as { cause?: unknown } | null;
    return v && typeof v.cause === "string" ? v.cause : "";
  } catch {
    return "";
  }
}

const CAUSE_TEXT: Record<string, string> = {
  human_stop: "stopped by a human",
  stalled: "watchdog: stalled (no output)",
  hard_cap: "watchdog: hit the runtime cap",
  sandbox_oom: "sandbox ran out of memory",
  sandbox_container_vanished: "sandbox container disappeared",
  host_process_missing_after_notifier_restart: "worker process lost after a notifier restart",
};
export function causeText(cause: string): string {
  return CAUSE_TEXT[cause] || cause.replace(/_/g, " ");
}

export interface RunOutcome {
  bucket: RunBucket;
  /** exact, human-readable status (always includes the backend status meaning) */
  label: string;
  /** status key fed to <StatusDot> for its glyph shape + tone */
  dot: string;
  /** why it failed / was stopped, when known */
  reason: string | null;
}

export function runOutcome(r: Pick<Run, "status" | "exit_code" | "kill_reason">): RunOutcome {
  const st = r.status || "unknown";
  const exit = r.exit_code;
  const cause = killCause(r.kill_reason);
  switch (st) {
    case "running":
      return { bucket: "running", label: "Running", dot: "working", reason: null };
    case "exited":
      if (exit != null && exit !== 0) return { bucket: "failed", label: "Exited · exit " + exit, dot: "failed", reason: "non-zero exit code " + exit };
      return { bucket: "finished", label: exit != null ? "Exited · exit " + exit : "Exited", dot: "completed", reason: null };
    case "killed":
      if (cause === "human_stop") return { bucket: "failed", label: "Stopped", dot: "cancelled", reason: causeText(cause) };
      return { bucket: "failed", label: "Killed", dot: "failed", reason: cause ? causeText(cause) : "killed (no reason recorded)" };
    case "rate_limited":
      return { bucket: "failed", label: "Rate limited", dot: "blocked", reason: "the model provider rate-limited this run" };
    case "orphaned":
      return { bucket: "failed", label: "Orphaned", dot: "terminated", reason: cause ? causeText(cause) : "the worker process was lost" };
    case "failed":
      return { bucket: "failed", label: "Failed", dot: "failed", reason: cause ? causeText(cause) : exit != null ? "exit " + exit : null };
    default:
      // forward-compat: an unknown status is shown verbatim, never as success
      return { bucket: "failed", label: st, dot: st, reason: null };
  }
}

export function matchesState(r: Pick<Run, "status" | "exit_code" | "kill_reason">, f: RunStateFilter): boolean {
  return f === "all" || runOutcome(r).bucket === f;
}

export function runStarted(r: Run): string | null {
  return r.started_at || r.started || null;
}
export function runEnded(r: Run): string | null {
  return r.ended_at || r.ended || null;
}

/** "42s", "3m 10s", "1h 5m"; null for unknown/negative. */
export function fmtDuration(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m" + (s % 60 ? " " + (s % 60) + "s" : "");
  const h = Math.floor(m / 60);
  return h + "h" + (m % 60 ? " " + (m % 60) + "m" : "");
}

/** Runtime of a run: ended − started, or now − started while running. */
export function runDuration(r: Run, now: number): string | null {
  const s = Date.parse(runStarted(r) || "");
  if (!s) return null;
  const e = Date.parse(runEnded(r) || "");
  if (e) return fmtDuration(e - s);
  if (r.status === "running") return fmtDuration(now - s);
  return null; // finished without an end stamp: unknown, not zero
}

/**
 * Coarse live elapsed time of a RUNNING run ("<1m", "8m", "1h 12m") — the
 * row's one time fact while it runs (never "8m ago · 8m 41s", D12). Null for
 * a finished run or one without a start stamp.
 */
export function runElapsed(r: Run, now: number): string | null {
  if (r.status !== "running") return null;
  const s = Date.parse(runStarted(r) || "");
  if (!s) return null;
  const m = Math.floor(Math.max(0, now - s) / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  return h + "h" + (m % 60 ? " " + (m % 60) + "m" : "");
}

/** What woke the worker (wake_event, else wake_kind), humanized verbatim. */
export function wakeLabel(r: WorkerRun): string {
  const ev = r.wake_event || "";
  if (ev) return ev.charAt(0).toUpperCase() + ev.slice(1).replace(/_/g, " ");
  if (r.wake_kind === "tmux") return "live tab";
  return r.wake_kind || "";
}

/** Newest first, de-duplicated by run id (a run may come back from two agent feeds). */
export function mergeRuns(lists: WorkerRun[][]): WorkerRun[] {
  const seen = new Map<string, WorkerRun>();
  for (const list of lists) for (const r of list) {
    const id = runId(r);
    if (id && !seen.has(id)) seen.set(id, r);
  }
  return Array.from(seen.values()).sort((a, b) => (Date.parse(runStarted(b) || "") || 0) - (Date.parse(runStarted(a) || "") || 0));
}

/**
 * Tone for a run's reason line: a human stop is a deliberate act (muted), a
 * rate limit is transient (warn); only genuine failures read as danger.
 */
export function reasonTone(r: Pick<Run, "status" | "kill_reason">): "muted" | "warn" | "danger" {
  if (r.status === "killed" && killCause(r.kill_reason) === "human_stop") return "muted";
  if (r.status === "rate_limited") return "warn";
  return "danger";
}

/** True when the backend status adds information the outcome label doesn't already say. */
export function rawStatusDiffers(r: Pick<Run, "status" | "exit_code" | "kill_reason">): boolean {
  const st = (r.status || "").replace(/_/g, " ").toLowerCase();
  if (!st) return false;
  return !runOutcome(r).label.toLowerCase().startsWith(st);
}

/** "Claude · conversation" — capitalised runtime, the lane without the "lane" jargon. */
export function runtimeLabel(runtime: string | null | undefined, lane: string | null | undefined): string {
  const rt = runtime ? runtime.charAt(0).toUpperCase() + runtime.slice(1) : null;
  const ln = lane ? lane.replace(/[_-]+/g, " ").replace(/\s*lane$/i, "") : null;
  return [rt, ln].filter(Boolean).join(" · ");
}
