/**
 * A project's performance thresholds and budgets (`qa_perf_settings`). The same defaults, ranges
 * and rules as `qa_perf.py`.
 */

export interface PerfBudgets {
  web_lcp_ms: number;
  appear_ms: number;
  launch_ms: number;
}

export interface PerfSettings {
  enabled: boolean;
  regression_pct: number;
  regression_min_ms: number;
  confirm_runs: number;
  baseline_runs: number;
  budgets: PerfBudgets;
  load_limit: number;
  pr_note: boolean;
  pr_gate: boolean;
}

export const PERF_DEFAULTS: PerfSettings = {
  enabled: true,
  regression_pct: 50,
  regression_min_ms: 300,
  confirm_runs: 2,
  baseline_runs: 20,
  budgets: { web_lcp_ms: 2500, appear_ms: 1500, launch_ms: 3000 },
  load_limit: 1.5,
  pr_note: false,
  pr_gate: false,
};

type NumberKey = "regression_pct" | "regression_min_ms" | "confirm_runs" | "baseline_runs" | "load_limit" | keyof PerfBudgets;

/** [min, max] of each number, inclusive. */
export const PERF_RANGES: Record<NumberKey, [number, number]> = {
  regression_pct: [5, 1000],
  regression_min_ms: [0, 60000],
  confirm_runs: [1, 10],
  baseline_runs: [3, 200],
  load_limit: [0.5, 10],
  web_lcp_ms: [100, 60000],
  appear_ms: [100, 60000],
  launch_ms: [100, 120000],
};

const BOOLS = ["enabled", "pr_note", "pr_gate"] as const;
const NUMBERS = ["regression_pct", "regression_min_ms", "confirm_runs", "baseline_runs", "load_limit"] as const;
const BUDGETS = ["web_lcp_ms", "appear_ms", "launch_ms"] as const;
const INTEGERS = new Set<string>(["confirm_runs", "baseline_runs"]);

function inRange(key: NumberKey, v: unknown): v is number {
  if (typeof v !== "number" || !Number.isFinite(v)) return false;
  const [lo, hi] = PERF_RANGES[key];
  return v >= lo && v <= hi;
}

/** The stored value laid over the defaults; anything malformed is the default. */
export function normalisePerfSettings(raw: unknown): PerfSettings {
  const out: PerfSettings = { ...PERF_DEFAULTS, budgets: { ...PERF_DEFAULTS.budgets } };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  for (const k of BOOLS) if (typeof r[k] === "boolean") out[k] = r[k] as boolean;
  for (const k of NUMBERS) if (inRange(k, r[k])) out[k] = INTEGERS.has(k) ? Math.trunc(r[k] as number) : (r[k] as number);
  const b = r.budgets;
  if (b && typeof b === "object" && !Array.isArray(b)) {
    for (const k of BUDGETS) if (inRange(k, (b as Record<string, unknown>)[k])) out.budgets[k] = (b as Record<string, number>)[k];
  }
  return out;
}

export type PerfChange = Partial<Omit<PerfSettings, "budgets">> & { budgets?: Partial<PerfBudgets> };

/** A change from the form or Ask: the validated change, or why not (the Python `validate`'s words). */
export function validatePerfChange(body: unknown): { ok: true; value: PerfChange } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length === 0) {
    return { ok: false, error: "Send at least one setting." };
  }
  const r = body as Record<string, unknown>;
  const known = new Set<string>([...BOOLS, ...NUMBERS, "budgets"]);
  const unknown = Object.keys(r).filter((k) => !known.has(k)).sort();
  if (unknown.length) return { ok: false, error: `Unknown setting: ${unknown.join(", ")}.` };
  const out: PerfChange = {};
  for (const [k, v] of Object.entries(r)) {
    if ((BOOLS as readonly string[]).includes(k)) {
      if (typeof v !== "boolean") return { ok: false, error: `${k} must be true or false.` };
      (out as Record<string, unknown>)[k] = v;
    } else if (k === "budgets") {
      if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some((b) => !(BUDGETS as readonly string[]).includes(b))) {
        return { ok: false, error: "budgets takes web_lcp_ms, appear_ms and launch_ms." };
      }
      for (const [b, bv] of Object.entries(v as Record<string, unknown>)) {
        if (!inRange(b as NumberKey, bv)) {
          const [lo, hi] = PERF_RANGES[b as NumberKey];
          return { ok: false, error: `${b} must be a number from ${lo} to ${hi}.` };
        }
      }
      out.budgets = { ...(v as Partial<PerfBudgets>) };
    } else {
      if (!inRange(k as NumberKey, v)) {
        const [lo, hi] = PERF_RANGES[k as NumberKey];
        return { ok: false, error: `${k} must be a number from ${lo} to ${hi}.` };
      }
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return { ok: true, value: out };
}

/** The stored value after a change: budgets merge key by key. */
export function mergePerfSettings(current: unknown, change: PerfChange): Record<string, unknown> {
  const base: Record<string, unknown> = current && typeof current === "object" && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(change)) {
    if (k === "budgets") {
      const prev = base.budgets && typeof base.budgets === "object" ? (base.budgets as Record<string, unknown>) : {};
      base.budgets = { ...prev, ...(v as Record<string, unknown>) };
    } else {
      base[k] = v;
    }
  }
  return base;
}
