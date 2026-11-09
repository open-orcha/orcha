/**
 * What the coverage map's side panel and list show for an area, derived from the report. Pure.
 */
import { PLATFORM_LABEL, SOURCE_LABEL, STATE_LABEL, type AreaScenario, type Coverage, type CoverageArea, type CoverageState, type PlatformKey } from "./types";

/** The edge cases a deep area tests, in the order the panel lists them. */
export const EDGE_ORDER = ["error", "empty", "invalid", "offline", "permission", "timeout", "limit", "expired", "paywall", "stubs"] as const;

export interface PlatformRow {
  platform: string;
  label: string;
  outcome: "pass" | "fail" | "none";
  at: string | null;
  text: string;
}

export interface ScenarioRow {
  id: string;
  name: string;
  draft: boolean;
  /** Paused (keeps its coverage, marked paused), with why. */
  paused: string | null;
  source: string;
  confidence: string;
  platforms: { platform: string; outcome: "pass" | "fail" }[];
}

export interface AreaPanel {
  key: string;
  name: string;
  state: CoverageState;
  stateLabel: string;
  sentence: string;
  platforms: PlatformRow[];
  linked: ScenarioRow[];
  suggestions: ScenarioRow[];
  depth: { score: number; facts: string[]; edges: { key: string; label: string; tested: boolean }[] };
  explored: { at: string | null; screens: string[] };
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "2h ago", "3 days ago", "just now". */
export function ago(at: string | null, now: number): string {
  if (!at) return "";
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return "";
  const mins = Math.max(0, Math.round((now - t) / 60_000));
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${plural(days, "day")} ago`;
}

/** The state of `area` on `platform` ("all" = every platform). */
export function stateOn(area: CoverageArea, platform: PlatformKey): CoverageState {
  return area.states[platform] ?? area.state;
}

/**
 * Whether the area's scenarios have a result on this platform ("all": on any). A scenario that
 * applies to every platform covers each one on paper; the List's platform dots and Coverage's
 * platform bars say where one actually ran.
 */
export function ranOn(area: CoverageArea, platform: PlatformKey): boolean {
  return platform === "all" ? Object.keys(area.last).length > 0 : !!area.last[platform];
}

/** The state's words in the List and the panel: "Covered", "Seen, not tested", "Covered, not run yet". */
export function stateWords(area: CoverageArea, platform: PlatformKey): string {
  const state = stateOn(area, platform);
  if (state === "untested") return area.seen ? "Seen, not tested" : STATE_LABEL.untested;
  return ranOn(area, platform) ? STATE_LABEL[state] : `${STATE_LABEL[state]}, not run yet`;
}

/** Whether a scenario counts in more than one area (the List's Scenarios column then adds up to more than the validated total). */
export function sharedScenarios(report: Pick<Coverage, "areas" | "totals">): boolean {
  return report.areas.reduce((n, a) => n + a.depth.scenarios, 0) > report.totals.scenarios;
}

/** One short sentence about the area on this platform. */
export function areaSentence(area: CoverageArea, platform: PlatformKey): string {
  const state = stateOn(area, platform);
  const on = platform === "all" ? "" : ` on ${PLATFORM_LABEL[platform] ?? platform}`;
  if (state === "untested") {
    if (area.suggestions > 0) return `No scenario tests this yet${on}. ${plural(area.suggestions, "scenario")} might. Confirm below.`;
    if (area.seen) return `Explored, but no scenario tests it${on}.`;
    return `Nothing has tested this area${on} yet.`;
  }
  const d = area.depths[platform] ?? area.depth;
  const n = plural(d.scenarios, "scenario");
  const notRun = ranOn(area, platform) ? "" : ` None has run${on} yet.`;
  if (state === "failing") return `${n} cover it${on}, and the latest run failed.`;
  if (state === "thin") return (d.happy_only ? `${n}${on}, happy path only.` : `${n}${on}. A few more checks would make it solid.`) + notRun;
  if (state === "strong") return `${n}${on}, edge cases included, passing.`;
  return `${n}${on}, with ${plural(d.edge_kinds.length, "edge case")}.${notRun}`;
}

function scenarioRow(s: AreaScenario, platforms: readonly string[]): ScenarioRow {
  return {
    id: s.id,
    name: s.name || "Untitled scenario",
    draft: s.status === "draft",
    paused: s.status === "paused" ? (s.status_reason || "paused") : null,
    // A run trace below the link threshold: its runs passed through on the way elsewhere (#236).
    source: s.source === "run_trace" && s.suggestion ? "Runs pass through it" : SOURCE_LABEL[s.source],
    confidence: s.confirmed === 1 ? "Confirmed" : `${Math.round(s.confidence * 100)}%`,
    platforms: platforms.flatMap((p) => (s.last[p] ? [{ platform: p, outcome: s.last[p].outcome }] : [])),
  };
}

export function areaPanel(area: CoverageArea, report: Pick<Coverage, "platforms" | "edge_labels">, platform: PlatformKey, now: number): AreaPanel {
  const d = area.depths[platform] ?? area.depth;
  const state = stateOn(area, platform);
  const facts = [plural(d.scenarios, "scenario"), plural(d.criteria, "criterion", "criteria")];
  if (d.accounts.length > 0) facts.push(plural(d.accounts.length, "persona"));
  return {
    key: area.key,
    name: area.name,
    state,
    stateLabel: stateWords(area, platform),
    sentence: areaSentence(area, platform),
    platforms: report.platforms.map((p) => {
      const r = area.last[p];
      const label = PLATFORM_LABEL[p] ?? p;
      if (!r) return { platform: p, label, outcome: "none", at: null, text: area.states[p] === "untested" ? "No scenario" : "Not run yet" };
      return { platform: p, label, outcome: r.outcome, at: r.at, text: `${r.outcome === "pass" ? "Passed" : "Failed"} ${ago(r.at, now)}`.trim() };
    }),
    linked: area.scenarios.filter((s) => s.linked).map((s) => scenarioRow(s, report.platforms)),
    suggestions: area.scenarios.filter((s) => s.suggestion).map((s) => scenarioRow(s, report.platforms)),
    depth: {
      score: d.score,
      facts,
      edges: EDGE_ORDER.map((k) => ({ key: k, label: report.edge_labels[k] ?? k, tested: d.edge_kinds.includes(k) })),
    },
    explored: area.explored,
  };
}

/** Areas in risk order for the list view (the report's own ranking, recomputed for a platform). */
export function riskSorted(areas: readonly CoverageArea[], platform: PlatformKey): CoverageArea[] {
  const base: Record<CoverageState, number> = { failing: 4, thin: 2, covered: 1, strong: 0, untested: 2.5 };
  const score = (a: CoverageArea) => {
    const s = stateOn(a, platform);
    return s === "untested" ? (a.seen ? 3 : 2.5) : base[s];
  };
  return [...areas].sort((a, b) => score(b) - score(a) || b.importance - a.importance || a.name.localeCompare(b.name));
}

/** Counts per state on a platform, for the legend. */
export function stateCounts(areas: readonly CoverageArea[], platform: PlatformKey): Record<CoverageState, number> & { seen: number } {
  const out = { untested: 0, thin: 0, covered: 0, strong: 0, failing: 0, seen: 0 };
  for (const a of areas) {
    const s = stateOn(a, platform);
    out[s]++;
    if (s === "untested" && a.seen) out.seen++;
  }
  return out;
}

/** The headline split into text and numbers, so the numbers can be set apart. */
export function headlineParts(headline: string): { text: string; number: boolean }[] {
  return headline.split(/(\d+)/).filter(Boolean).map((text) => ({ text, number: /^\d+$/.test(text) }));
}
