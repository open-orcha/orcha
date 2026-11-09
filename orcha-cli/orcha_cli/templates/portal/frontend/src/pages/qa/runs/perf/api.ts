/**
 * The run page's Performance tab as it reads a session: `GET /api/qa/sessions/{id}/perf` answers
 * the samples of its timed steps, the same screens' earlier samples, and its actions and calls;
 * the comparison is `buildRunScreens`, the same one the Speed views use.
 */
import { getJSON } from "../../../../api/client";
import { buildRunScreens, countNoise, headlineMetric, type LiveTiming, type PerfCall, type PerfFindingSummary, type PerfSampleRow, type RunPerfResponse, type RunPerfScreen } from "../../map/perf/perf";
import { normalisePerfSettings, type PerfSettings } from "../../map/perf/perf-settings";

interface PerfStep {
  seq: number;
  kind: string;
  duration_ms: number | null;
  timing: { appear_ms?: number | null; settle_ms?: number | null; settled?: string | null } | null;
  screen_key: string | null;
  at: string | null;
}

interface PerfRequest {
  at_ms: number;
  method: string;
  url: string;
  status: number | null;
  duration_ms: number | null;
}

export interface RunPerfRead {
  session: { status: string; platform: string; device_name: string | null; started_at: string | null };
  samples: PerfSampleRow[];
  history: PerfSampleRow[];
  frames: Record<string, string>;
  steps: PerfStep[];
  requests: PerfRequest[];
  settings: unknown;
}

/** A call longer than this is a poll or a stream, not something the screen waited on. */
const LONG_CALL_MS = 30000;
/** How many of an action's calls the waterfall draws. */
const CALLS_SHOWN = 3;
/** How long after the action a call still belongs to it. */
const QUIET_MS = 800;

/** The slowest calls an action set off, `start_ms` from the action. */
export function callsOfAction(calls: readonly PerfRequest[], sentMs: number, heldMs: number, untilMs: number): PerfCall[] {
  let quiet = heldMs;
  const mine: PerfRequest[] = [];
  for (const c of calls) {
    if (c.at_ms < sentMs) continue;
    if (c.at_ms >= untilMs || c.at_ms > quiet + QUIET_MS) break;
    const ms = c.duration_ms;
    if (ms == null || ms >= LONG_CALL_MS) continue;
    mine.push(c);
    quiet = Math.max(quiet, c.at_ms + ms);
  }
  return mine
    .sort((a, b) => (b.duration_ms ?? 0) - (a.duration_ms ?? 0))
    .slice(0, CALLS_SHOWN)
    .map((c) => ({ method: c.method, url: c.url, status: c.status, ms: Math.round(c.duration_ms ?? 0), start_ms: Math.round(c.at_ms - sentMs) }));
}

/** Each timed action as a row, the screen it led to and the calls it set off. */
export function timingsOf(read: Pick<RunPerfRead, "session" | "steps" | "requests">): LiveTiming[] {
  const start = read.session.started_at ? Date.parse(read.session.started_at) : NaN;
  const calls = [...read.requests].sort((a, b) => a.at_ms - b.at_ms);
  const rows: LiveTiming[] = [];
  read.steps.forEach((s, i) => {
    if (s.kind === "screen" || s.duration_ms == null) return;
    const endMs = s.at && Number.isFinite(start) ? Math.max(0, Date.parse(s.at) - start) : 0;
    const sentMs = Math.max(0, endMs - s.duration_ms);
    const after = read.steps[i + 1];
    rows.push({
      seq: s.seq,
      kind: s.kind,
      at_ms: sentMs,
      appear_ms: s.timing?.appear_ms ?? null,
      settle_ms: s.timing?.settle_ms ?? s.duration_ms,
      settled: s.timing?.settled ?? null,
      screen: after?.kind === "screen" ? after.screen_key : null,
      calls: callsOfAction(calls, sentMs, endMs, sentMs + s.duration_ms + QUIET_MS),
    });
  });
  return rows;
}

/** The calls each timed action set off, as the `api` samples `buildRunScreens` reads. */
export function apiSamples(samples: readonly PerfSampleRow[], rows: readonly LiveTiming[]): PerfSampleRow[] {
  const out: PerfSampleRow[] = [];
  for (const r of rows) {
    const calls = r.calls ?? [];
    const of = samples.find((s) => s.step_seq === r.seq);
    if (!calls.length || !of) continue;
    out.push({ ...of, metric: "api", value: Math.max(...calls.map((c) => c.ms)), detail: { calls } });
  }
  return out;
}

/**
 * The screens this run timed slower than usual or over budget, by the project's own rules. A
 * session files no performance finding, so these are read from the numbers: one run's slowdown
 * says what to look at, which is why they carry no confidence and link to no finding.
 */
export function slowScreens(screens: readonly RunPerfScreen[], platform: string, settings: PerfSettings): PerfFindingSummary[] {
  const out: PerfFindingSummary[] = [];
  screens.forEach((s) => {
    const metric = platform !== "web" && !s.cells.appear && s.cells.launch ? "launch" : headlineMetric(platform, (m) => Boolean(s.cells[m]));
    const cell = s.cells[metric];
    if (!cell) return;
    const slower = cell.baseline ? cell.value - cell.baseline.median : 0;
    const regressed = cell.delta != null && cell.delta * 100 >= settings.regression_pct && slower >= settings.regression_min_ms;
    if (!regressed && !cell.over) return;
    out.push({
      seq: out.length + 1,
      title: `${s.label} ${regressed ? "was slower than usual" : "went over its budget"}`,
      severity: regressed && cell.over ? "major" : "minor",
      screen_key: s.key,
      metric,
      reason: regressed ? "regression" : "budget",
      confidence: null,
    });
  });
  return out;
}

/** The read as the panel's document. */
export function runPerfOf(read: RunPerfRead): RunPerfResponse {
  const settings = normalisePerfSettings(read.settings);
  const platform = read.session.platform;
  const live = read.session.status === "running";
  const timed = timingsOf(read);
  const samples = [...read.samples, ...apiSamples(read.samples, timed)];
  const screens = buildRunScreens(samples, read.history, [], settings);
  const findings = slowScreens(screens, platform, settings);
  for (const s of screens) {
    s.frame = read.frames[s.key] ?? null;
    s.finding = findings.find((f) => f.screen_key === s.key) ?? null;
  }
  return {
    state: live ? "live" : read.samples.length ? "done" : "none",
    platform,
    device: read.session.device_name,
    screens,
    findings,
    live: live || read.samples.length === 0 ? timed : [],
    noise: countNoise(read.samples),
    settings,
  };
}

export const loadRunPerf = async (sid: string, signal?: AbortSignal): Promise<RunPerfResponse> =>
  runPerfOf(await getJSON<RunPerfRead>(`/api/qa/sessions/${encodeURIComponent(sid)}/perf`, signal));
