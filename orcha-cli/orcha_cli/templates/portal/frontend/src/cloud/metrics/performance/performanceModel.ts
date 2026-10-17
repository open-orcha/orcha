/**
 * Agent performance (evals-lite) — payload types, fetchers and pure formatters shared by
 * Metrics → Performance and the agent Configuration tab's Performance card.
 *
 * Server: portal_backend/agent_performance*.py
 *   GET /api/containers/{cid}/metrics/performance?range=7d|30d|90d|all
 *   GET /api/containers/{cid}/metrics/performance/agents/{aid}?range=…
 *
 * Truthful-data rules (brief §3), enforced HERE so both surfaces agree:
 *  - counts (verified, rework, escalations) are real counts — 0 is a real zero;
 *  - a rate / median / cost the server marks `enough: false` reads "Not enough data"
 *    (with the sample size in the tooltip), never a number;
 *  - cost per verified task covers METERED tasks only; with none it reads "Not metered",
 *    never $0.
 */

export type PerfRange = "7d" | "30d" | "90d" | "all";
export const PERF_RANGES: PerfRange[] = ["7d", "30d", "90d", "all"];
export const PERF_RANGE_LABEL: Record<PerfRange, string> = {
  "7d": "7 days", "30d": "30 days", "90d": "90 days", all: "All time",
};
export const PERF_REFRESH_MS = 60_000;

export interface PerfRate { value: number | null; numerator: number; denominator: number; enough: boolean }
export interface PerfPlanRate extends PerfRate { approved: number; rejected: number }
export interface PerfMedian { value: number | null; n: number; enough: boolean }
export interface PerfCost {
  value: number | null; metered_tasks: number; unmetered_tasks: number;
  total_metered_usd: number | null; enough: boolean;
}
export interface PerfMetrics {
  tasks_verified: number;
  first_pass_rate: PerfRate;
  rework: { total: number; human_rejections: number; manager_send_backs: number };
  median_time_to_verified_seconds: PerfMedian;
  cost_per_verified_task_usd: PerfCost;
  plan_approval_rate: PerfPlanRate;
  escalations: number;
}
export interface PerfBucket { start: string; end: string; verified: number; rework: number }
export interface PerfAgentRow {
  agent_id: string; alias: string; model: string | null; role: string | null; retired: boolean;
  metrics: PerfMetrics; series: PerfBucket[];
}
interface PerfEnvelope {
  range: PerfRange; since: string | null; bucket_days: number; min_sample: number; generated_at: string;
}
export interface PerformancePayload extends PerfEnvelope {
  project: { container_id: string; name: string | null; metrics: PerfMetrics; series: PerfBucket[] };
  agents: PerfAgentRow[];
}
export interface AgentPerformancePayload extends PerfEnvelope { agent: PerfAgentRow }

/* ---- fetch ------------------------------------------------------------------ */

async function readJSON<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let detail = "";
    try {
      const body = (await r.json()) as { detail?: unknown };
      detail = typeof body?.detail === "string" ? body.detail : "";
    } catch {
      /* non-JSON error body */
    }
    const e = new Error(detail || "HTTP " + r.status) as Error & { status?: number };
    e.status = r.status;
    throw e;
  }
  // A 200 that isn't JSON (a proxy / login HTML page) must not leak the parser's
  // "Unexpected token '<'…" text into the UI (AP-29).
  try {
    return (await r.json()) as T;
  } catch {
    throw new Error(UNEXPECTED_RESPONSE);
  }
}

export const UNEXPECTED_RESPONSE = "Unexpected response from the server. Reload the page, or check that Embodent is reachable.";

/** 401/403: the page itself already explains access (e.g. "not a member") — a performance
 * surface hides rather than repeat that with a Retry that cannot help (AP-30). */
export function isAccessDenied(e: { status?: number } | null | undefined): boolean {
  return e?.status === 401 || e?.status === 403;
}

export function fetchPerformance(cid: string, range: PerfRange, signal?: AbortSignal): Promise<PerformancePayload> {
  return fetch(
    "/api/containers/" + encodeURIComponent(cid) + "/metrics/performance?range=" + range,
    signal ? { signal } : undefined,
  ).then((r) => readJSON<PerformancePayload>(r));
}

export function fetchAgentPerformance(cid: string, aid: string, range: PerfRange, signal?: AbortSignal): Promise<AgentPerformancePayload> {
  return fetch(
    "/api/containers/" + encodeURIComponent(cid) + "/metrics/performance/agents/" + encodeURIComponent(aid) + "?range=" + range,
    signal ? { signal } : undefined,
  ).then((r) => readJSON<AgentPerformancePayload>(r));
}

/** Shape guard: an older server (no such route) or a proxy page must not render as data. */
export function isMetrics(m: unknown): m is PerfMetrics {
  const x = m as PerfMetrics | null;
  return !!x && typeof x.tasks_verified === "number" && !!x.first_pass_rate && !!x.cost_per_verified_task_usd;
}

export function parseRange(raw: string | null | undefined): PerfRange | null {
  return raw && (PERF_RANGES as string[]).includes(raw) ? (raw as PerfRange) : null;
}

/* ---- formatting (pure, tested) --------------------------------------------- */

export const NOT_ENOUGH = "Not enough data";
export const NOT_METERED = "Not metered";

export function fmtPct(v: number): string {
  return Math.round(v * 100) + "%";
}

/** Compact duration: 45s · 12m · 3.4h · 2.1d (Linear-style, one token). */
export function fmtSpan(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return "—";
  if (secs < 60) return Math.round(secs) + "s";
  if (secs < 3600) return Math.round(secs / 60) + "m";
  if (secs < 86400) return trim1(secs / 3600) + "h";
  return trim1(secs / 86400) + "d";
}
function trim1(n: number): string {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

export function fmtCost(v: number): string {
  if (v >= 100) return "$" + Math.round(v);
  if (v >= 1) return "$" + v.toFixed(2);
  return "$" + v.toFixed(v >= 0.01 ? 2 : 3);
}

export interface Figure {
  /** the figure's text: a number, or NOT_ENOUGH / NOT_METERED */
  text: string;
  /** false when the value is withheld (below threshold / nothing metered) */
  known: boolean;
  /** one-line sample caption, e.g. "3 of 4 verified" */
  sub: string;
  /** full explanation for the tooltip */
  tip: string;
}

const plural = (n: number, one: string, many = one + "s") => n + " " + (n === 1 ? one : many);

export function firstPassFigure(m: PerfMetrics, min: number): Figure {
  const r = m.first_pass_rate;
  const sub = `${r.numerator} of ${plural(r.denominator, "verified task")}`;
  if (!r.enough || r.value == null) {
    return { text: NOT_ENOUGH, known: false, sub, tip: `Needs at least ${min} verified tasks in this range (has ${r.denominator}).` };
  }
  return { text: fmtPct(r.value), known: true, sub, tip: `${sub} were accepted without a rejection or a manager send-back.` };
}

export function medianFigure(m: PerfMetrics, min: number): Figure {
  const d = m.median_time_to_verified_seconds;
  const sub = plural(d.n, "task");
  if (!d.enough || d.value == null) {
    return { text: NOT_ENOUGH, known: false, sub, tip: `Needs at least ${min} verified tasks with a start time (has ${d.n}).` };
  }
  return { text: fmtSpan(d.value), known: true, sub, tip: `Median time from the task starting to a human verifying it, over ${sub}.` };
}

export function costFigure(m: PerfMetrics, min: number): Figure {
  const c = m.cost_per_verified_task_usd;
  const unmet = c.unmetered_tasks ? ` · ${c.unmetered_tasks} not metered` : "";
  const sub = `${plural(c.metered_tasks, "metered task")}${unmet}`;
  const why = "Only tasks whose runs all reported a dollar cost are counted; subscription or unpriced runs are excluded, never counted as $0.";
  if (c.metered_tasks === 0 && c.unmetered_tasks === 0) {
    // nothing verified → nothing to price: a sample problem, not a metering one
    return { text: NOT_ENOUGH, known: false, sub, tip: `No verified tasks in this range. ${why}` };
  }
  if (c.metered_tasks === 0) {
    return { text: NOT_METERED, known: false, sub, tip: `None of the verified tasks reported a dollar cost. ${why}` };
  }
  if (!c.enough || c.value == null) {
    return { text: NOT_ENOUGH, known: false, sub, tip: `Needs at least ${min} metered verified tasks (has ${c.metered_tasks}). ${why}` };
  }
  return { text: fmtCost(c.value), known: true, sub, tip: `Average dollar cost of this range's metered verified tasks. ${why}` };
}

export function planFigure(m: PerfMetrics, min: number): Figure {
  const p = m.plan_approval_rate;
  const sub = `${p.approved} of ${plural(p.denominator, "plan")}`;
  if (!p.enough || p.value == null) {
    return { text: NOT_ENOUGH, known: false, sub, tip: `Needs at least ${min} plan decisions in this range (has ${p.denominator}).` };
  }
  return { text: fmtPct(p.value), known: true, sub, tip: `${p.approved} approved, ${p.rejected} sent back for changes.` };
}

export function reworkTip(m: PerfMetrics): string {
  const r = m.rework;
  return `${plural(r.human_rejections, "rejection")} by a human reviewer · ${plural(r.manager_send_backs, "send-back")} by an AI manager's pre-review`;
}

/** Tone for the first-pass figure — only when there is enough data (never a default "good"). */
export function firstPassTone(m: PerfMetrics): "good" | "warn" | "bad" | null {
  const r = m.first_pass_rate;
  if (!r.enough || r.value == null) return null;
  if (r.value >= 0.8) return "good";
  if (r.value >= 0.5) return "warn";
  return "bad";
}

export const DEFINITIONS: { k: string; d: string }[] = [
  { k: "Verified", d: "Tasks a human verified in this range. Auto-completed (full autonomy) tasks are not verifications." },
  { k: "First pass", d: "Share of verified tasks accepted with no rejection and no manager send-back." },
  { k: "Rework", d: "Human rejections plus AI-manager pre-review send-backs in this range." },
  { k: "Time to verified", d: "Median time from the task starting to its verification." },
  { k: "Cost / verified", d: "Average dollar cost of metered verified tasks. Unmetered tasks are excluded, never $0." },
  { k: "Plan approval", d: "Approved plans out of all plan decisions in this range." },
  { k: "Escalations", d: "Asks this agent raised that went to a human (escalated by the agent or after expiring)." },
];

/** Sparkline input: the verified count per bucket. */
export function sparkValues(series: PerfBucket[] | null | undefined): number[] {
  return (series || []).map((b) => b.verified);
}

export function bucketLabel(b: PerfBucket, bucketDays: number): string {
  const s = new Date(b.start);
  const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  if (bucketDays <= 1) return fmt(s);
  const e = new Date(new Date(b.end).getTime() - 86400_000);
  return fmt(s) + " – " + fmt(e);
}
