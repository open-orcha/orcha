/**
 * Coverage growth (#413): what `python -m orcha.coverage_growth report` prints
 * (`orcha.coverage_growth.report`). The baseline, coverage now per screen and per area with the
 * honesty rules applied (`measure`), the growth since the baseline and what Orcha added
 * (`compare`), the chart's points, and the data variations waiting for approval. Pure: safe in
 * client components.
 */

export type ScreenState = "both" | "orcha" | "your_tests" | "at_risk" | "unknown" | "none";
export type Evidence = "known" | "partial" | "unknown";
export type Technique = "partition" | "boundary" | "invalid" | "empty" | "locale";

export const SCREEN_STATES: readonly ScreenState[] = ["both", "orcha", "your_tests", "at_risk", "unknown", "none"];

export const STATE_WORDS: Record<ScreenState, string> = {
  both: "Your tests and Embodent",
  orcha: "Embodent",
  your_tests: "Your tests",
  at_risk: "At risk",
  unknown: "Unknown",
  none: "Not covered",
};

export const TECHNIQUE_WORDS: Record<Technique | "seeded", string> = {
  partition: "Ordinary values",
  boundary: "Boundaries",
  invalid: "Invalid input",
  empty: "Empty fields",
  locale: "Other locales",
  seeded: "Seeded records",
};

export interface Rollup {
  screens: number;
  covered: number;
  pct: number | null;
  both: number;
  orcha: number;
  your_tests: number;
  at_risk: number;
  unknown: number;
  none: number;
  by_your_tests: number;
  by_orcha: number;
  flows: { your_tests: number; orcha: number };
  variations: number;
  variations_added: number;
  evidence: Evidence;
}

export interface MeasuredScreen {
  id: string;
  name: string;
  area: string;
  source: string;
  live: boolean;
  state: ScreenState;
  reason: string | null;
  tests: string[];
  orcha: string[];
  yours: string[];
}

export interface MeasuredArea extends Rollup {
  key: string;
  name: string;
}

export interface Flow {
  id: string;
  name: string;
  origin: "yours" | "orcha";
  evidence: string;
  depth: { partitions: number; kinds: string[]; rows: number; orcha_rows: number };
  areas: string[];
}

export interface Measurement {
  evidence_version: number;
  measured_at: string;
  fresh_days: number;
  screens: MeasuredScreen[];
  areas: MeasuredArea[];
  flows: Flow[];
  /** `platforms`: how many of the screens are each platform's own (#467); empty before it. */
  totals: Rollup & { live_screens: number; platforms: Record<string, number> };
}

export interface Added {
  scenarios: number;
  variations: number;
  screens_reached: number;
  scenario_ids: string[];
  screens: string[];
}

export interface Side {
  pct: number | null;
  screens: number;
  covered: number;
  by_your_tests: number;
  by_orcha: number;
  variations: number;
  evidence: Evidence;
  at_risk?: number;
  unknown?: number;
}

export interface GrowthArea {
  key: string;
  name: string;
  before: Side;
  now: Side;
  points: number | null;
  added: Added;
  new: boolean;
}

export interface Growth {
  since: string;
  overall: GrowthArea;
  areas: GrowthArea[];
  headline: string;
  lines: string[];
}

export interface Baseline {
  id: string;
  day: string;
  taken_at: string;
  trigger: "onboarding" | "first_mapping" | "rebaseline" | "manual";
  reason: string | null;
  app_build: string | null;
  evidence_version: number;
  same_rules: boolean;
  superseded_at: string | null;
}

export interface SeriesPoint {
  day: string;
  kind: "baseline" | "point" | "now";
  pct: number | null;
  areas: Record<string, number | null>;
  /** Counted under an older screen rule and not recounted (#467): the chart marks where the count changed. */
  oldCount?: boolean;
}

/** How the screen count changed under the figures (#467): `day` the first day of today's count,
 * `recounted` the snapshots counted again on it, `oldCount` the days that could not be. */
export interface CountChange {
  day: string;
  recounted: number;
  oldCount: string[];
}

export interface VariationRow {
  id: string;
  scenario_id: string;
  technique: Technique;
  label: string;
  values: Record<string, string>;
  status: "suggested" | "applied" | "dismissed";
}

export interface VariationCandidate {
  scenario_id: string;
  name: string;
  origin: "yours" | "orcha";
  partitions: number;
  kinds: string[];
  missing: string[];
  waiting: boolean;
}

export interface Variations {
  pending: { scenario_id: string; name: string; rows: VariationRow[] }[];
  applied: number;
  candidates: VariationCandidate[];
}

/**
 * `report().payoff` (`coverage_growth.PAYOFF_KEYS`): the few lines project Home, the weekly
 * summary and Release health (#412) show. A stable contract: keys are added, never renamed.
 */
export interface Payoff {
  /** One sentence, always there. */
  headline: string;
  /** Up to 3 lines for the areas that grew most, best first ([] before a baseline). */
  areas: string[];
  /** This week's line, or null (no point 7 to 13 days old yet). */
  weekly: string | null;
  /** Coverage now, % of the screens known (null while evidence is unknown). */
  pct: number | null;
  screens: number;
  /** Since the baseline; all null before one. */
  points: number | null;
  since: string | null;
  added: { scenarios: number; variations: number; screens_reached: number } | null;
}

export interface CoverageGrowth {
  project_id: string;
  /** When these figures were measured. */
  computed_at: string;
  /** `stored`: today's stored point, served while a measurement runs; `measured`: just measured. */
  source: "stored" | "measured";
  /** A measurement is running behind these figures: ask again shortly for the new ones. */
  refreshing: boolean;
  fresh_days: number;
  baseline: Baseline | null;
  history: Baseline[];
  now: Measurement;
  growth: Growth | null;
  series: SeriesPoint[];
  /** Null when the screen count did not change under these figures. */
  count: CountChange | null;
  weekly: string | null;
  payoff: Payoff;
  variations: Variations;
}

export const TRIGGER_WORDS: Record<Baseline["trigger"], string> = {
  onboarding: "when your tests were brought in",
  first_mapping: "at the first map of the app",
  rebaseline: "re-baselined",
  manual: "taken by hand",
};

// ---------- parsing (the shape is Python's; a missing piece never breaks the page) ----------

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const pct = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === "string");
const evidence = (v: unknown): Evidence => (v === "known" || v === "partial" ? v : "unknown");

function rollupOf(v: unknown): Rollup {
  const o = obj(v);
  const flows = obj(o.flows);
  return {
    screens: num(o.screens),
    covered: num(o.covered),
    pct: pct(o.pct),
    both: num(o.both),
    orcha: num(o.orcha),
    your_tests: num(o.your_tests),
    at_risk: num(o.at_risk),
    unknown: num(o.unknown),
    none: num(o.none),
    by_your_tests: num(o.by_your_tests),
    by_orcha: num(o.by_orcha),
    flows: { your_tests: num(flows.your_tests), orcha: num(flows.orcha) },
    variations: num(o.variations),
    variations_added: num(o.variations_added),
    evidence: evidence(o.evidence),
  };
}

export function parseMeasurement(v: unknown): Measurement {
  const m = obj(v);
  return {
    evidence_version: num(m.evidence_version),
    measured_at: String(m.measured_at ?? ""),
    fresh_days: num(m.fresh_days),
    screens: arr(m.screens).flatMap((s): MeasuredScreen[] => {
      const o = obj(s);
      if (typeof o.id !== "string") return [];
      const state = (SCREEN_STATES as readonly string[]).includes(o.state as string) ? (o.state as ScreenState) : "none";
      return [{ id: o.id, name: String(o.name ?? o.id), area: String(o.area ?? ""), source: String(o.source ?? "code"), live: o.live === true, state,
        reason: str(o.reason), tests: strs(o.tests), orcha: strs(o.orcha), yours: strs(o.yours) }];
    }),
    areas: arr(m.areas).flatMap((a): MeasuredArea[] => {
      const o = obj(a);
      return typeof o.key === "string" ? [{ key: o.key, name: String(o.name ?? o.key), ...rollupOf(o) }] : [];
    }),
    flows: arr(m.flows).flatMap((f): Flow[] => {
      const o = obj(f);
      const d = obj(o.depth);
      if (typeof o.id !== "string") return [];
      return [{ id: o.id, name: String(o.name ?? ""), origin: o.origin === "yours" ? "yours" : "orcha", evidence: String(o.evidence ?? ""),
        depth: { partitions: num(d.partitions), kinds: strs(d.kinds), rows: num(d.rows), orcha_rows: num(d.orcha_rows) }, areas: strs(o.areas) }];
    }),
    totals: { ...rollupOf(m.totals), live_screens: num(obj(m.totals).live_screens), platforms: countsOf(obj(m.totals).platforms) },
  };
}

function countsOf(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(obj(v))) if (typeof n === "number" && Number.isFinite(n) && n > 0) out[k] = n;
  return out;
}

function sideOf(v: unknown): Side {
  const o = obj(v);
  return { pct: pct(o.pct), screens: num(o.screens), covered: num(o.covered), by_your_tests: num(o.by_your_tests), by_orcha: num(o.by_orcha),
    variations: num(o.variations), evidence: evidence(o.evidence), at_risk: num(o.at_risk), unknown: num(o.unknown) };
}

function growthAreaOf(v: unknown): GrowthArea {
  const o = obj(v);
  const a = obj(o.added);
  return {
    key: String(o.key ?? ""), name: String(o.name ?? ""), before: sideOf(o.before), now: sideOf(o.now), points: pct(o.points), new: o.new === true,
    added: { scenarios: num(a.scenarios), variations: num(a.variations), screens_reached: num(a.screens_reached), scenario_ids: strs(a.scenario_ids), screens: strs(a.screens) },
  };
}

function baselineOf(v: unknown): Baseline | null {
  const o = obj(v);
  if (typeof o.id !== "string") return null;
  const trigger = (["onboarding", "first_mapping", "rebaseline", "manual"].includes(o.trigger as string) ? o.trigger : "manual") as Baseline["trigger"];
  return { id: o.id, day: String(o.day ?? ""), taken_at: String(o.taken_at ?? ""), trigger, reason: str(o.reason), app_build: str(o.app_build),
    evidence_version: num(o.evidence_version), same_rules: o.same_rules !== false, superseded_at: str(o.superseded_at) };
}

const TECHNIQUES: readonly Technique[] = ["partition", "boundary", "invalid", "empty", "locale"];

export function parseVariationRow(v: unknown): VariationRow | null {
  const o = obj(v);
  if (typeof o.id !== "string") return null;
  const values = Object.fromEntries(Object.entries(obj(o.values)).map(([k, x]) => [k, String(x ?? "")]));
  return { id: o.id, scenario_id: String(o.scenario_id ?? ""), technique: (TECHNIQUES.includes(o.technique as Technique) ? o.technique : "partition") as Technique,
    label: String(o.label ?? ""), values, status: o.status === "applied" || o.status === "dismissed" ? o.status : "suggested" };
}

export function parseGrowth(v: unknown): CoverageGrowth {
  const r = obj(v);
  const g = r.growth ? obj(r.growth) : null;
  const pay = obj(r.payoff);
  const vars = obj(r.variations);
  return {
    project_id: String(r.project_id ?? ""),
    computed_at: String(r.computed_at ?? ""),
    source: r.source === "stored" ? "stored" : "measured",
    refreshing: r.refreshing === true,
    fresh_days: num(r.fresh_days) || 30,
    baseline: baselineOf(r.baseline),
    history: arr(r.history).map(baselineOf).filter((b): b is Baseline => b !== null),
    now: parseMeasurement(r.now),
    growth: g
      ? { since: String(g.since ?? ""), overall: growthAreaOf(g.overall), areas: arr(g.areas).map(growthAreaOf), headline: String(g.headline ?? ""), lines: strs(g.lines) }
      : null,
    series: arr(r.series).flatMap((p): SeriesPoint[] => {
      const o = obj(p);
      if (typeof o.day !== "string") return [];
      const kind = o.kind === "baseline" || o.kind === "now" ? o.kind : "point";
      return [{ day: o.day, kind, pct: pct(o.pct), areas: Object.fromEntries(Object.entries(obj(o.areas)).map(([k, x]) => [k, pct(x)])), oldCount: o.old_count === true || o.oldCount === true }];
    }),
    // The server parses the report once and the page again: either spelling.
    count: r.count && typeof r.count === "object" && typeof obj(r.count).day === "string"
      ? { day: String(obj(r.count).day), recounted: num(obj(r.count).recounted), oldCount: strs(obj(r.count).old_count ?? obj(r.count).oldCount) }
      : null,
    weekly: str(r.weekly),
    payoff: {
      headline: String(pay.headline ?? ""),
      areas: strs(pay.areas),
      weekly: str(pay.weekly),
      pct: pct(pay.pct),
      screens: num(pay.screens),
      points: pct(pay.points),
      since: str(pay.since),
      added: pay.added && typeof pay.added === "object"
        ? { scenarios: num(obj(pay.added).scenarios), variations: num(obj(pay.added).variations), screens_reached: num(obj(pay.added).screens_reached) }
        : null,
    },
    variations: {
      pending: arr(vars.pending).flatMap((p) => {
        const o = obj(p);
        if (typeof o.scenario_id !== "string") return [];
        return [{ scenario_id: o.scenario_id, name: String(o.name ?? "Scenario"), rows: arr(o.rows).map(parseVariationRow).filter((x): x is VariationRow => x !== null) }];
      }),
      applied: num(vars.applied),
      candidates: arr(vars.candidates).flatMap((c): VariationCandidate[] => {
        const o = obj(c);
        if (typeof o.scenario_id !== "string") return [];
        return [{ scenario_id: o.scenario_id, name: String(o.name ?? ""), origin: o.origin === "yours" ? "yours" : "orcha", partitions: num(o.partitions),
          kinds: strs(o.kinds), missing: strs(o.missing), waiting: o.waiting === true }];
      }),
    },
  };
}
