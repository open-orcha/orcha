import type { Severity } from "./types";

export type SeverityCounts = Partial<Record<Severity, number>>;

export const sevOrder: readonly Severity[] = [
  "blocker",
  "major",
  "minor",
  "cosmetic",
  "info",
];

/** Rank for sorting: blocker=0 … info=4. */
export function sevRank(sev: Severity): number {
  const i = sevOrder.indexOf(sev);
  return i === -1 ? sevOrder.length : i;
}

/**
 * A run's findings per severity, counted from the finding rows its Findings tab lists. Every
 * surface that summarises a run's findings (header chips, list rows) counts these, never
 * `runs.counts` alone: the sync lifts `cosmetic` from the report's summary line (D91), which an
 * agent fills by hand, so a run read "1 cosmetic" over a Findings tab that listed none.
 */
export function countFindings(findings: readonly { severity: string | null }[]): SeverityCounts {
  const counts: SeverityCounts = { blocker: 0, major: 0, minor: 0, cosmetic: 0 };
  for (const f of findings) {
    const sev = f.severity as keyof SeverityCounts | null;
    if (sev && sev in counts) counts[sev] = (counts[sev] ?? 0) + 1;
  }
  return counts;
}

/** `{blocker:0, major:3, minor:5, cosmetic:3}` → [["major",3],["minor",5],["cosmetic",3]] */
export function nonZeroCounts(
  counts: Partial<SeverityCounts> | null | undefined,
): Array<[Exclude<Severity, "info">, number]> {
  if (!counts) return [];
  const out: Array<[Exclude<Severity, "info">, number]> = [];
  for (const sev of ["blocker", "major", "minor", "cosmetic"] as const) {
    const n = counts[sev] ?? 0;
    if (n > 0) out.push([sev, n]);
  }
  return out;
}

/** Seconds → "5m 18s", "42s", "1h 02m". */
export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(r).padStart(2, "0")}s`;
  return `${r}s`;
}

/** Milliseconds → "m:ss" (or "h:mm:ss" past an hour). Used for step timestamps. */
export function fmtMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "–:––";
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

/** ISO timestamp → "just now", "3m ago", "2h ago", "yesterday", "Sep 13". */
export function fmtRelative(
  iso: string | null | undefined,
  now: Date = new Date(),
): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = now.getTime() - t;
  const future = diff < 0;
  const abs = Math.abs(diff);
  const sec = Math.round(abs / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);
  const suffix = future ? "from now" : "ago";
  if (sec < 45) return "just now";
  if (min < 60) return `${min}m ${suffix}`;
  if (hr < 24) return `${hr}h ${suffix}`;
  if (day === 1) return future ? "tomorrow" : "yesterday";
  if (day < 7) return `${day}d ${suffix}`;
  return fmtDate(iso, { time: false });
}

/** ISO timestamp → "Sep 13, 16:57" (local time). */
export function fmtDate(
  iso: string | null | undefined,
  opts: { time?: boolean; year?: boolean } = {},
): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const { time = true, year = false } = opts;
  const date = d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(year ? { year: "numeric" } : {}),
  });
  if (!time) return date;
  const hhmm = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${date}, ${hhmm}`;
}

/** "4da2efd0c1…" → "4da2efd". */
export function shortCommit(commit: string | null | undefined): string {
  if (!commit) return "";
  return commit.slice(0, 7);
}

/** Pluralise: plural(3, "step") → "3 steps". */
/**
 * A run's mode as the run lists show it. A conversation run is a triage (or discussion) turn
 * driving the app to settle a report (D79): it reads "triage", never "exploratory".
 */
export function runModeLabel(mode: string): string {
  return mode === "conversation" ? "triage" : mode;
}

export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

