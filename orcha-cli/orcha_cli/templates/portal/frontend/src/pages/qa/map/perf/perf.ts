/**
 * Screen performance: the shapes the Slowest screens page and the Map's speed overlay read, and
 * the pure maths behind them. The samples come from `GET C/perf`, read from the steps a session
 * recorded (`qa_perf.py`).
 */

import type { PerfSettings } from "./perf-settings";

export const PERF_METRICS = ["appear", "launch", "settle", "ttfb", "dcl", "load", "lcp", "long_tasks", "api", "heap", "cpu", "memory"] as const;
export type PerfMetric = (typeof PERF_METRICS)[number];

export type PerfNoise = "first_after_install" | "cold_start" | "under_load";

export interface PerfSampleRow {
  run_id: string;
  screen_key: string;
  screen_label: string | null;
  platform: string;
  device: string | null;
  device_class: string;
  metric: PerfMetric;
  value: number;
  step_seq: number | null;
  noise: PerfNoise | null;
  detail?: Record<string, unknown> | null;
  created_at: string;
}

export const METRIC_LABEL: Record<PerfMetric, string> = {
  appear: "Time to appear",
  launch: "Launch to first screen",
  settle: "Interaction to settle",
  ttfb: "Time to first byte",
  dcl: "DOMContentLoaded",
  load: "Load",
  lcp: "Largest contentful paint",
  long_tasks: "Long tasks",
  api: "Slowest API call",
  heap: "JS heap",
  cpu: "CPU peak",
  memory: "Memory peak",
};

/** A column head short enough for the run page's narrow pane; the full label is its title. */
export const METRIC_SHORT: Record<PerfMetric, string> = {
  appear: "Appears",
  launch: "Launch",
  settle: "Settles",
  ttfb: "First byte",
  dcl: "DOM ready",
  load: "Load",
  lcp: "Main content",
  long_tasks: "Long tasks",
  api: "Slowest call",
  heap: "Heap",
  cpu: "CPU",
  memory: "Memory",
};

/** "+150%", "20% faster": a delta short enough for a table cell. */
export function deltaShort(delta: number | null): string | null {
  if (delta === null || !Number.isFinite(delta)) return null;
  const pct = Math.round(delta * 100);
  if (pct === 0) return null;
  return pct > 0 ? `+${pct}%` : `${-pct}% faster`;
}

export const NOISE_LABEL: Record<PerfNoise, string> = {
  first_after_install: "first run after an install",
  cold_start: "cold start",
  under_load: "machine under load",
};

/** The columns each table shows, in order. Time metrics first, then the rest. */
export const RUN_COLUMNS: Record<string, PerfMetric[]> = {
  web: ["lcp", "settle", "ttfb", "api", "long_tasks", "heap"],
  ios: ["appear", "launch", "settle", "api", "cpu", "memory"],
  android: ["appear", "launch", "settle", "api", "cpu", "memory"],
  desktop: ["appear", "settle", "api"],
};

/** The metric a platform's screens are ranked and filed on. */
export function headlineMetric(platform: string, has: (m: PerfMetric) => boolean = () => true): PerfMetric {
  if (platform === "web") return has("lcp") ? "lcp" : "settle";
  return "appear";
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Nearest-rank percentile: an observed value, an observed value. */
export function percentile(values: readonly number[], q: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((q / 100) * s.length));
  return s[Math.min(rank, s.length) - 1];
}

export interface Baseline {
  median: number;
  p90: number;
  n: number;
}

export function baselineOf(newestFirst: readonly number[], lastN: number): Baseline | null {
  const w = newestFirst.slice(0, Math.max(1, lastN));
  const m = median(w);
  const p = percentile(w, 90);
  return m === null || p === null ? null : { median: m, p90: p, n: w.length };
}

/** "3.4 s", "0.8 s"; MB and % for the size metrics. */
export function fmtMetric(metric: PerfMetric, value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "–";
  if (metric === "heap" || metric === "memory") return `${value.toFixed(value >= 100 ? 0 : 1)} MB`;
  if (metric === "cpu") return `${Math.round(value)}%`;
  return fmtSeconds(value);
}

export function fmtSeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

export function isTimeMetric(metric: PerfMetric): boolean {
  return metric !== "heap" && metric !== "memory" && metric !== "cpu";
}

/** The budget that applies to a platform's metric. */
export function budgetFor(platform: string, metric: PerfMetric, settings: PerfSettings): number | null {
  if (platform === "web" && metric === "lcp") return settings.budgets.web_lcp_ms;
  if (platform !== "web" && metric === "appear") return settings.budgets.appear_ms;
  if ((platform === "ios" || platform === "android") && metric === "launch") return settings.budgets.launch_ms;
  return null;
}

// ---------- the run page ----------

export interface PerfFindingSummary {
  seq: number;
  title: string;
  severity: string;
  screen_key: string | null;
  metric: PerfMetric | null;
  reason: "regression" | "budget" | null;
  confidence: string | null;
  issue_id?: string | null;
}

export interface RunPerfCell {
  metric: PerfMetric;
  value: number;
  n: number;
  baseline: Baseline | null;
  /** This run against its baseline: 0.5 is 50% slower. Null without a baseline. */
  delta: number | null;
  budget: number | null;
  over: boolean;
}

/** One of the slowest calls while a screen loaded. `start_ms`: when it was sent, from the
 * action (runs synced before it was kept have none: they are listed, not placed on a timeline). */
export interface PerfCall {
  method?: string;
  url?: string;
  ms: number;
  status?: number | null;
  start_ms?: number;
}

export interface RunPerfScreen {
  key: string;
  label: string;
  cells: Partial<Record<PerfMetric, RunPerfCell>>;
  noise: PerfNoise[];
  finding: PerfFindingSummary | null;
  slowCalls: PerfCall[];
  /** The screen as Orcha last saw it (its app map frame), when there is one. */
  frame?: string | null;
}

/** A timing row of a live run (`<run>/timings.jsonl`), with the screen it led to when known. */
export interface LiveTiming {
  seq: number;
  kind: string;
  at_ms: number;
  appear_ms: number | null;
  settle_ms: number;
  settled: string | null;
  screen: string | null;
  /** The slowest calls the action set off (`<run>/api-requests.jsonl`), `start_ms` from the action. */
  calls?: PerfCall[];
  /** Where the settle's time went: waiting for the screen to react, then to hold still,
   * the tree reads it made, and what told it the screen moved. */
  settle_phase1_ms?: number;
  settle_phase2_ms?: number;
  tree_reads?: number;
  tree_read_ms?: number;
  source?: string;
}

/** "reacted in 120 ms, still after 200 ms more, 1 tree read, watching events" for a live row. */
export function settleBreakdownText(r: LiveTiming): string | null {
  const parts: string[] = [];
  if (r.settle_phase1_ms != null) parts.push(r.appear_ms === null ? `nothing moved in ${r.settle_phase1_ms} ms` : `reacted in ${r.settle_phase1_ms} ms`);
  if (r.settle_phase2_ms) parts.push(`still after ${r.settle_phase2_ms} ms more`);
  if (r.tree_reads != null) parts.push(`${r.tree_reads} tree read${r.tree_reads === 1 ? "" : "s"}`);
  if (r.source) parts.push(`watching ${r.source}`);
  return parts.length ? parts.join(", ") : null;
}

export interface RunPerfResponse {
  state: "live" | "done" | "none";
  platform: string | null;
  device: string | null;
  screens: RunPerfScreen[];
  findings: PerfFindingSummary[];
  live: LiveTiming[];
  noise: Partial<Record<PerfNoise, number>>;
  settings: PerfSettings;
}

/** One run's samples per screen, each metric's median against the screen's baseline from
 * `history` (its other runs' clean samples, newest first). Slowest headline first. */
export function buildRunScreens(
  samples: readonly PerfSampleRow[],
  history: readonly PerfSampleRow[],
  findings: readonly PerfFindingSummary[],
  settings: PerfSettings,
): RunPerfScreen[] {
  const byScreen = new Map<string, PerfSampleRow[]>();
  for (const s of samples) {
    const list = byScreen.get(s.screen_key) ?? [];
    list.push(s);
    byScreen.set(s.screen_key, list);
  }
  const out: RunPerfScreen[] = [];
  for (const [key, rows] of byScreen) {
    const platform = rows[0].platform;
    const cells: Partial<Record<PerfMetric, RunPerfCell>> = {};
    for (const metric of PERF_METRICS) {
      const mine = rows.filter((r) => r.metric === metric);
      if (!mine.length) continue;
      const clean = mine.filter((r) => r.noise === null);
      const value = median((clean.length ? clean : mine).map((r) => r.value));
      if (value === null) continue;
      const past = history
        .filter((h) => h.screen_key === key && h.metric === metric && h.noise === null && h.device_class === rows[0].device_class)
        .map((h) => h.value);
      const baseline = past.length >= 3 ? baselineOf(past, settings.baseline_runs) : null;
      const budget = budgetFor(platform, metric, settings);
      cells[metric] = {
        metric,
        value,
        n: mine.length,
        baseline,
        delta: baseline && baseline.median > 0 ? value / baseline.median - 1 : null,
        budget,
        over: budget !== null && value > budget,
      };
    }
    const calls = rows
      .flatMap((r) => (r.metric === "api" && Array.isArray(r.detail?.calls) ? (r.detail?.calls as PerfCall[]) : []))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 3);
    out.push({
      key,
      label: rows.find((r) => r.screen_label)?.screen_label ?? key,
      cells,
      noise: [...new Set(rows.map((r) => r.noise).filter((n): n is PerfNoise => n !== null))],
      finding: findings.find((f) => f.screen_key === key) ?? null,
      slowCalls: calls,
    });
  }
  const head = (s: RunPerfScreen) => {
    const platform = samples[0]?.platform ?? "web";
    return s.cells[headlineMetric(platform, (m) => Boolean(s.cells[m]))]?.value ?? -1;
  };
  return out.sort((a, b) => Number(Boolean(b.finding)) - Number(Boolean(a.finding)) || head(b) - head(a));
}

// ---------- Slowest screens and the Map overlay ----------

export type HeatLevel = "slow" | "warm" | "ok";

export interface SlowScreen {
  key: string;
  label: string;
  platform: string;
  device_class: string;
  device: string | null;
  metric: PerfMetric;
  /** The newest run's median. */
  latest: number;
  latest_run_id: string;
  latest_at: string;
  baseline: Baseline | null;
  delta: number | null;
  budget: number | null;
  /** One point per run, oldest first: the run's median. */
  trend: number[];
  runs: number;
  heat: HeatLevel;
  issue: { id: string; title: string; status: string } | null;
  /** The screen as Orcha last saw it (its app map frame), when there is one. */
  frame?: string | null;
  /** Its node on the map, when the map has it. */
  node?: string | null;
}

/** A run of the project that is timing screens right now (Slowest screens' live strip). */
export interface RunningTimings {
  run_id: string;
  platform: string | null;
  device: string | null;
  started_at: string | null;
  /** Actions timed so far. */
  timed: number;
  /** The newest few, newest last. */
  latest: LiveTiming[];
}

export interface SlowestResponse {
  screens: SlowScreen[];
  platforms: string[];
  days: number;
  settings: PerfSettings;
  /** Samples left out as noise in the window, by why. */
  noise: Partial<Record<PerfNoise, number>>;
  total_samples: number;
  /** The project's runs in progress, with what they timed so far (their samples come when they sync). */
  running?: RunningTimings[];
}

export const TREND_POINTS = 12;

/** The heat of a screen: slow when over budget or over the project's regression line; warm when two thirds of the way there; else ok. */
export function heatOf(s: Pick<SlowScreen, "latest" | "budget" | "delta" | "issue">, settings: PerfSettings): HeatLevel {
  const ref = s.budget ?? settings.budgets.appear_ms;
  const pct = settings.regression_pct / 100;
  if (s.issue && s.issue.status !== "resolved" && s.issue.status !== "not_a_bug" && s.issue.status !== "archived") return "slow";
  // The regression line is both: this much slower, and by at least this long (a fast screen doubling is noise).
  const slower = s.delta !== null ? s.latest - s.latest / (1 + s.delta) : 0;
  const regressed = (share: number) => s.delta !== null && s.delta >= pct * share && slower >= settings.regression_min_ms * share;
  if (s.latest > ref || regressed(1)) return "slow";
  if (s.latest > ref * (2 / 3) || regressed(0.5)) return "warm";
  return "ok";
}

/** The project's screens ranked slowest first, from the window's samples (oldest first or any
 * order) and its perf issues (`dedupe_key perf:<platform>:<screen>`). */
export function buildSlowest(
  samples: readonly PerfSampleRow[],
  issues: readonly { id: string; title: string; status: string; dedupe_key: string }[],
  settings: PerfSettings,
): SlowScreen[] {
  const groups = new Map<string, PerfSampleRow[]>();
  for (const s of samples) {
    if (s.noise !== null) continue;
    const g = `${s.platform}\u0000${s.device_class}\u0000${s.screen_key}`;
    const list = groups.get(g) ?? [];
    list.push(s);
    groups.set(g, list);
  }
  const out: SlowScreen[] = [];
  for (const rows of groups.values()) {
    const { platform, device_class, screen_key } = rows[0];
    const metric = headlineMetric(platform, (m) => rows.some((r) => r.metric === m));
    const mine = rows.filter((r) => r.metric === metric).sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (!mine.length) continue;
    const runs: { id: string; at: string; values: number[] }[] = [];
    for (const r of mine) {
      const last = runs[runs.length - 1];
      if (last && last.id === r.run_id) last.values.push(r.value);
      else runs.push({ id: r.run_id, at: r.created_at, values: [r.value] });
    }
    const newest = runs[runs.length - 1];
    const latest = median(newest.values) ?? 0;
    const older = runs.slice(0, -1).reverse().flatMap((r) => [...r.values].reverse());
    const baseline = older.length >= 3 ? baselineOf(older, settings.baseline_runs) : null;
    const delta = baseline && baseline.median > 0 ? latest / baseline.median - 1 : null;
    const budget = budgetFor(platform, metric, settings);
    const issueRow = issues.find((i) => i.dedupe_key === `perf:${platform}:${screen_key}`) ?? null;
    const issue = issueRow ? { id: issueRow.id, title: issueRow.title, status: issueRow.status } : null;
    const entry: SlowScreen = {
      key: screen_key,
      label: rows.find((r) => r.screen_label)?.screen_label ?? screen_key,
      platform,
      device_class,
      device: [...rows].reverse().find((r) => r.device)?.device ?? null,
      metric,
      latest,
      latest_run_id: newest.id,
      latest_at: newest.at,
      baseline,
      delta,
      budget,
      trend: runs.slice(-TREND_POINTS).map((r) => median(r.values) ?? 0),
      runs: runs.length,
      heat: "ok",
      issue,
    };
    entry.heat = heatOf(entry, settings);
    out.push(entry);
  }
  const rank: Record<HeatLevel, number> = { slow: 0, warm: 1, ok: 2 };
  return out.sort((a, b) => rank[a.heat] - rank[b.heat] || b.latest - a.latest);
}

/** The Map overlay: each screen key's heat on one platform (the slowest device class wins). */
export function heatByScreen(screens: readonly SlowScreen[], platform: string | null): Map<string, SlowScreen> {
  const out = new Map<string, SlowScreen>();
  const rank: Record<HeatLevel, number> = { slow: 0, warm: 1, ok: 2 };
  for (const s of screens) {
    if (platform && s.platform !== platform) continue;
    const had = out.get(s.key);
    if (!had || rank[s.heat] < rank[had.heat] || (rank[s.heat] === rank[had.heat] && s.latest > had.latest)) out.set(s.key, s);
  }
  return out;
}

export const HEAT_LABEL: Record<HeatLevel, string> = { slow: "Slow", warm: "Getting slow", ok: "Fast enough" };

/** "+183% vs usual", "12% faster", or null without a baseline. */
export function deltaText(delta: number | null): string | null {
  if (delta === null || !Number.isFinite(delta)) return null;
  const pct = Math.round(delta * 100);
  if (pct === 0) return "as usual";
  return pct > 0 ? `+${pct}% vs usual` : `${-pct}% faster than usual`;
}

export function platformName(platform: string, deviceClass?: string): string {
  if (platform === "web") return deviceClass === "mobile" ? "Mobile web" : "Web";
  return platform === "ios" ? "iOS" : platform === "android" ? "Android" : platform === "desktop" ? "Desktop" : platform;
}

export function countNoise(rows: readonly Pick<PerfSampleRow, "noise">[]): Partial<Record<PerfNoise, number>> {
  const out: Partial<Record<PerfNoise, number>> = {};
  for (const r of rows) if (r.noise) out[r.noise] = (out[r.noise] ?? 0) + 1;
  return out;
}
