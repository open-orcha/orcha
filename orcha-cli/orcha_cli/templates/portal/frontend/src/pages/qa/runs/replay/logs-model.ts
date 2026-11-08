import type { RunLog, RunLogLevel, RunLogSource } from "../types";

/** Level display order, most severe first (matches severity conventions elsewhere). */
export const LOG_LEVEL_ORDER: readonly RunLogLevel[] = ["error", "warn", "info", "debug"];

export function logLevelRank(level: RunLogLevel): number {
  const i = LOG_LEVEL_ORDER.indexOf(level);
  return i === -1 ? LOG_LEVEL_ORDER.length : i;
}

/** Short source label for the chip, e.g. "console", "network", "device", "crash". */
export function sourceLabel(source: RunLogSource): string {
  return source;
}

export interface LogFilters {
  level: RunLogLevel | "";
  source: RunLogSource | "";
  query: string;
}

export const EMPTY_LOG_FILTERS: LogFilters = { level: "", source: "", query: "" };

/** Applies level/source/text filters (case-insensitive substring on `text`). */
export function filterLogs(logs: readonly RunLog[], f: LogFilters): RunLog[] {
  const q = f.query.trim().toLowerCase();
  return logs.filter((l) => {
    if (f.level && l.level !== f.level) return false;
    if (f.source && l.source !== f.source) return false;
    if (q && !l.text.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** Count of error-level entries, for the tab badge and the "errors only by default" rule. */
export function errorCount(logs: readonly RunLog[]): number {
  return logs.reduce((n, l) => n + (l.level === "error" ? 1 : 0), 0);
}

/** Per-step error counts (Steps tab red badge): `step_seq -> count of level=error logs`. */
export function errorCountsByStep(logs: readonly RunLog[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const l of logs) {
    if (l.level !== "error" || l.step_seq == null) continue;
    out.set(l.step_seq, (out.get(l.step_seq) ?? 0) + 1);
  }
  return out;
}

/** One-line detail suffix, e.g. " · 500" for a network entry, " ×12" for a deduped repeat. */
export function detailSuffix(log: RunLog): string {
  const d = log.detail;
  if (!d || typeof d !== "object" || Array.isArray(d)) return "";
  const rec = d as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof rec.status === "number") parts.push(String(rec.status));
  if (typeof rec.count === "number" && rec.count > 1) parts.push(`×${rec.count}`);
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

/**
 * When a log row happened, in ms from session start (#171): its own `at_ms`, or, for a row
 * written before the log writer stamped times (every row said 0), the time of the step it
 * landed in. Null when neither is known, so the row shows a dash instead of a false 0:00.
 */
export function logTimeMs(log: Pick<RunLog, "at_ms" | "step_seq">, stepAtMs?: ReadonlyMap<number, number>): number | null {
  if (log.at_ms > 0) return log.at_ms;
  const step = log.step_seq != null ? stepAtMs?.get(log.step_seq) : undefined;
  if (step != null && step > 0) return step;
  return null;
}

/** Plain-text lines for the fix-prompt/report: `[0:42] source/level: text`. */
export function logLine(log: RunLog, fmtMs: (ms: number) => string): string {
  return `[${fmtMs(log.at_ms)}] ${log.source}/${log.level}: ${log.text}${detailSuffix(log)}`;
}

/** Logs whose `step_seq` falls within `[from, to]` (inclusive; a null bound is open-ended),
 * newest-appearance order preserved from input. Used on a finding's card (its repro step
 * range) and for `Copy fix prompt`. */
export function logsInStepRange(
  logs: readonly RunLog[],
  from: number | null | undefined,
  to: number | null | undefined,
): RunLog[] {
  if (from == null && to == null) return [];
  const lo = from ?? to ?? 0;
  const hi = to ?? from ?? Number.MAX_SAFE_INTEGER;
  return logs.filter((l) => l.step_seq != null && l.step_seq >= lo && l.step_seq <= hi);
}

/**
 * The filters a log list opens with: errors only when the run has any (the one thing to read
 * first in a finished run), but everything while the run is live, where the tail is the point.
 */
export function initialLogFilters(logs: readonly RunLog[], live: boolean): LogFilters {
  return { ...EMPTY_LOG_FILTERS, level: !live && errorCount(logs) > 0 ? "error" : "" };
}

/** Display order: a live tail reads top to bottom, oldest first, newest arriving at the foot;
 * a finished run reads like a devtools console, newest first. */
export function orderLogs(logs: readonly RunLog[], live: boolean): RunLog[] {
  return [...logs].sort((a, b) => (live ? a.seq - b.seq : b.seq - a.seq));
}

/** Rows streamed in while live, merged into the rows read at load (deduped by `seq`, the newer
 * copy wins), in `seq` order. Returns `base` itself when nothing new arrived. */
export function mergeLogs(base: readonly RunLog[], incoming: readonly RunLog[]): readonly RunLog[] {
  if (incoming.length === 0) return base;
  const bySeq = new Map(base.map((l) => [l.seq, l]));
  for (const l of incoming) bySeq.set(l.seq, l);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
