/**
 * Coverage per feature area, worked out from what is stored: the map's features and screens, the
 * scenarios, which screens each one walks or names (`screen:<key>` tags), and the newest verdicts.
 * Depth, states and the headline follow one rule set: see `depth`, `areaState`, `headline`.
 */
import type { QaFeature, QaNode } from "../../qaApi";
import type { Scenario } from "../adapt";
import type { CoverageLink } from "../api";
import { countsForCoverage, effectiveStatus } from "../scenario-status";
import { PLATFORM_LABEL, type AreaScenario, type Coverage, type CoverageArea, type CoverageState, type Depth, type LastResult, type LinkSource, type PlatformKey, type PlatformRollup } from "./types";

const COVERED_DEPTH = 3;
const STRONG_DEPTH = 6;
const MAP_DEPTH = 3;
const FAILING_DAYS = 7;
const RECENT_DAYS = 30;
const GLOW_HOURS = 24;
const WEAKEST_MAX_RATIO = 2 / 3;
const WEAKEST_MIN_GAP = 2;
const DAY = 86_400_000;

/** Edge cases a scenario's text can name, each a family of words. */
const EDGE_KINDS: Record<string, RegExp> = {
  error: /\b(errors?|fails?|failure|crash\w*|5\d\d|went wrong|retry)\b/i,
  empty: /\b(empty|no results?|nothing (?:to|yet)|zero (?:items|results))\b/i,
  offline: /\b(offline|no (?:network|connection|internet)|airplane|connection (?:lost|drops?))\b/i,
  permission: /\b(permissions?|denied|den(?:y|ies)|not allowed|unauthori[sz]ed|forbidden|40[13])\b/i,
  invalid: /\b(invalid|validation|malformed|incorrect|wrong (?:password|code)|required field|422)\b/i,
  timeout: /\b(time ?outs?|timed out|slow)\b/i,
  limit: /\b(limits?|maximum|minimum|too (?:many|long|short)|quota|boundary|overflow)\b/i,
  paywall: /\b(paywall|premium|subscri\w+|upgrade|purchase|trial)\b/i,
  expired: /\b(expired?|session|signs? out|signed out|log ?out)\b/i,
};

const EDGE_LABELS: Record<string, string> = {
  error: "Errors", empty: "Empty states", offline: "Offline", permission: "Permissions", invalid: "Invalid input",
  timeout: "Timeouts", limit: "Limits", paywall: "Paywall", expired: "Expired session",
};

export function edgeKinds(s: Pick<Scenario, "name" | "description" | "criteria">): string[] {
  const text = [s.name, s.description ?? "", ...s.criteria].join(" ");
  return Object.keys(EDGE_KINDS).filter((k) => EDGE_KINDS[k].test(text));
}

/** How deep a set of scenarios tests an area, 0..10, with the facts behind the score. */
export function depth(scenarios: readonly Scenario[], screens: { total: number; hit: number } | null = null): Depth {
  const crit = scenarios.reduce((n, s) => n + s.criteria.length, 0);
  const edges = new Set(scenarios.flatMap(edgeKinds));
  const accounts = new Set(scenarios.flatMap((s) => (s.persona?.trim() ? [s.persona.trim()] : [])));
  const raw = Math.min(scenarios.length, 3) + Math.min(crit, 12) / 4 + Math.min(edges.size, 4) * 1.25 + (accounts.size >= 2 ? 1 : 0);
  const round = (x: number) => Math.round(x * 10) / 10;
  const out: Depth = {
    score: round((raw * 10) / 13),
    scenarios: scenarios.length,
    criteria: crit,
    edge_kinds: [...edges].sort(),
    happy_only: scenarios.length > 0 && edges.size === 0,
    accounts: [...accounts].sort(),
    examples: 0,
  };
  if (screens && screens.total > 0) {
    out.score = round(((raw + (MAP_DEPTH * Math.min(screens.hit, screens.total)) / screens.total) * 10) / (13 + MAP_DEPTH));
    out.screens = screens.total;
    out.screens_covered = screens.hit;
  }
  return out;
}

/** The state and depth of an area for `scenarios`, already narrowed to a platform. */
export function areaState(scenarios: readonly Scenario[], now: number, screens: { total: number; hit: number } | null = null): { state: CoverageState; depth: Depth } {
  const d = depth(scenarios, screens);
  if (scenarios.length === 0) return { state: "untested", depth: d };
  let failing = false;
  let passing = false;
  for (const s of scenarios) {
    const at = s.checked_at ? Date.parse(s.checked_at) : NaN;
    if (!Number.isFinite(at)) continue;
    if (s.outcome === "fail" && at >= now - FAILING_DAYS * DAY) failing = true;
    else if (s.outcome === "pass" && at >= now - RECENT_DAYS * DAY) passing = true;
  }
  if (failing) return { state: "failing", depth: d };
  if (d.score >= STRONG_DEPTH && passing) return { state: "strong", depth: d };
  return { state: d.score >= COVERED_DEPTH ? "covered" : "thin", depth: d };
}

export function headline(total: number, tested: number, untested: number, failing: number, weakest: string | null): string {
  if (total === 0) return "No feature areas mapped yet.";
  const parts = [`${tested} of ${total} area${total === 1 ? "" : "s"} tested.`];
  if (untested) parts.push(`${untested} never tested.`);
  if (failing) parts.push(`${failing} failing.`);
  if (weakest) parts.push(`${PLATFORM_LABEL[weakest] ?? weakest} is the weakest platform.`);
  return parts.join(" ");
}

/** The platform that covers clearly fewer areas than every other one, else null. */
export function weakestPlatform(rollup: Record<string, PlatformRollup>): string | null {
  const ranked = Object.entries(rollup).sort((a, b) => a[1].covered - b[1].covered);
  if (ranked.length < 2) return null;
  const lo = ranked[0][1].covered;
  const next = ranked[1][1].covered;
  return next - lo < WEAKEST_MIN_GAP || lo > next * WEAKEST_MAX_RATIO ? null : ranked[0][0];
}

/** Which scenarios a screen has, as the server works it out (tagged `screen:<key>`, or walked). */
export interface ScreenLink {
  /** `screen:<platform>:<key>` */
  id: string;
  scenarios: { id: string; origin?: string }[];
}

export interface CoverageInputs {
  features: readonly QaFeature[];
  nodes: readonly QaNode[];
  scenarios: readonly Scenario[];
  screens: readonly ScreenLink[];
  /** A person's decisions about which scenario tests which area. */
  links?: readonly CoverageLink[];
  now: number;
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
const SOURCE_CONFIDENCE: Record<LinkSource, number> = { manual: 1, draft: 0.95, migration: 0.9, run_trace: 0.85, text: 0.45 };

/** The links of one feature: the category that names it, then the screens a scenario walks. */
function linksOf(f: QaFeature, nodes: readonly QaNode[], inputs: CoverageInputs): Map<string, LinkSource> {
  const out = new Map<string, LinkSource>();
  for (const s of inputs.scenarios) {
    if (s.category && (norm(s.category) === norm(f.name) || norm(s.category) === norm(f.key))) out.set(s.id, "draft");
    const tagged = nodes.some((n) => (!s.target_kind || s.target_kind === n.platform) && s.tags.includes(`screen:${n.key}`));
    if (tagged && !out.has(s.id)) out.set(s.id, "draft");
  }
  const ids = new Set(nodes.map((n) => `screen:${n.platform}:${n.key}`));
  for (const row of inputs.screens) {
    if (!ids.has(row.id)) continue;
    for (const c of row.scenarios) if (!out.has(c.id)) out.set(c.id, c.origin === "traced" ? "run_trace" : "draft");
  }
  // A person's decisions survive every recompute.
  for (const l of inputs.links ?? []) {
    if (l.feature_key !== f.key) continue;
    if (l.state === "rejected") out.delete(l.scenario_id);
    else out.set(l.scenario_id, "manual");
  }
  return out;
}

/** Scenarios no link ties to this area that name it in their own words: for a person to say yes
 * or no. One already rejected is not asked about again. */
function suggestionsOf(f: QaFeature, links: ReadonlyMap<string, LinkSource>, inputs: CoverageInputs): Scenario[] {
  const words = [f.name, f.key].map(norm).filter((w) => w.length >= 3);
  const rejected = new Set((inputs.links ?? []).filter((l) => l.feature_key === f.key && l.state === "rejected").map((l) => l.scenario_id));
  return inputs.scenarios.filter((s) => {
    if (links.has(s.id) || rejected.has(s.id) || effectiveStatus(s) === "retired") return false;
    const text = norm([s.name, s.description, ...s.criteria].join(" "));
    return words.some((w) => text.includes(w));
  });
}

function lastOf(s: Scenario): Record<string, LastResult> {
  if (!s.checked_at || (s.outcome !== "pass" && s.outcome !== "fail")) return {};
  return { [s.target_kind ?? s.platform]: { outcome: s.outcome, at: s.checked_at, scenario_id: s.id } };
}

function importance(paths: number, linked: number): number {
  return Math.round((1 + Math.min(paths, 6) * 0.4 + Math.min(linked, 6) * 0.25) * 100) / 100;
}

export function computeCoverage(inputs: CoverageInputs): Coverage {
  const { features, nodes, scenarios, now } = inputs;
  const byId = new Map(scenarios.map((s) => [s.id, s]));
  const screens = nodes.filter((n) => n.kind === "screen");
  const order = ["ios", "android", "web"];
  const platforms = order.filter((p) => screens.some((n) => n.platform === p) || scenarios.some((s) => s.target_kind === p));
  const covered = new Set(inputs.screens.filter((r) => r.scenarios.length > 0).map((r) => r.id));

  const areas: CoverageArea[] = features.map((f) => {
    const mine = screens.filter((n) => n.feature_key === f.key);
    const links = linksOf(f, mine, inputs);
    const linkedRows = [...links.keys()].flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    const tested = linkedRows.filter(countsForCoverage);
    const seen = !!f.last_explored_at || mine.some((n) => n.state === "seen");
    const covers = (n: QaNode) => covered.has(`screen:${n.platform}:${n.key}`);
    const states: Record<PlatformKey, CoverageState> = {};
    const depths: Record<PlatformKey, Depth> = {};
    for (const plat of [null, ...platforms]) {
      const on = plat ? mine.filter((n) => n.platform === plat) : mine;
      const counts = on.length ? { total: on.length, hit: on.filter(covers).length } : null;
      const r = areaState(plat ? tested.filter((s) => s.target_kind === plat) : tested, now, counts);
      states[plat ?? "all"] = r.state;
      depths[plat ?? "all"] = r.depth;
    }
    const last: Record<string, LastResult> = {};
    let lastAt = "";
    for (const s of tested) {
      for (const [p, r] of Object.entries(lastOf(s))) {
        if (!last[p] || r.at > last[p].at) last[p] = r;
        if (r.at > lastAt) lastAt = r.at;
      }
    }
    const rows: AreaScenario[] = linkedRows
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({
        id: s.id,
        name: s.name,
        status: effectiveStatus(s),
        status_reason: s.status_reason,
        target_kind: s.target_kind,
        source: links.get(s.id) ?? "text",
        confidence: SOURCE_CONFIDENCE[links.get(s.id) ?? "text"],
        confirmed: links.get(s.id) === "manual" ? 1 : 0,
        linked: true,
        suggestion: false,
        last: lastOf(s),
      }));
    for (const s of suggestionsOf(f, links, inputs)) {
      rows.push({ id: s.id, name: s.name, status: effectiveStatus(s), status_reason: s.status_reason, target_kind: s.target_kind, source: "text", confidence: SOURCE_CONFIDENCE.text, confirmed: 0, linked: false, suggestion: true, last: lastOf(s) });
    }
    const uncovered = mine.filter((n) => !covers(n)).map((n) => n.label || n.key);
    const paths = f.paths ?? [];
    const state = states.all;
    return {
      key: f.key,
      name: f.name || f.key,
      summary: f.summary,
      entry: f.entry,
      paths,
      source: f.source ?? "code",
      state,
      states,
      depth: depths.all,
      depths,
      seen,
      visits: 0,
      recent: !!lastAt && Date.parse(lastAt) >= now - GLOW_HOURS * 3_600_000,
      explored: { at: f.last_explored_at, screens: mine.filter((n) => n.state === "seen").map((n) => n.label || n.key).slice(0, 8) },
      last,
      last_result_at: lastAt || null,
      scenarios: rows,
      linked: tested.length,
      drafts: linkedRows.filter((s) => s.status === "draft").length,
      suggestions: 0,
      importance: importance(paths.length, tested.length),
      risk: 0,
      rank: 0,
      map: mine.length ? { screens: mine.length, covered: mine.filter(covers).length, uncovered: uncovered.slice(0, 8) } : null,
    };
  });

  const total = areas.length;
  const rollup: Record<string, PlatformRollup> = {};
  for (const p of platforms) {
    const cov = areas.filter((a) => a.states[p] !== "untested").length;
    rollup[p] = {
      covered: cov,
      total,
      failing: areas.filter((a) => a.states[p] === "failing").length,
      passing: areas.filter((a) => a.last[p]?.outcome === "pass").length,
      ran: areas.filter((a) => a.states[p] !== "untested" && !!a.last[p]).length,
      share: total ? cov / total : 0,
    };
  }
  const weakest = weakestPlatform(rollup);
  const count = (s: CoverageState) => areas.filter((a) => a.state === s).length;
  const tested = total - count("untested");
  return {
    project_id: "",
    computed_at: new Date(now).toISOString(),
    headline: headline(total, tested, count("untested"), count("failing"), weakest),
    platforms,
    weakest,
    totals: {
      untested: count("untested"),
      thin: count("thin"),
      covered: count("covered"),
      strong: count("strong"),
      failing: count("failing"),
      areas: total,
      tested,
      seen: areas.filter((a) => a.state === "untested" && a.seen).length,
      scenarios: scenarios.filter(countsForCoverage).length,
      suggestions: 0,
    },
    rollup,
    areas,
    unmapped_screens: screens.filter((n) => !n.feature_key).map((n) => ({ label: n.label || n.key, visits: 0 })),
    edge_labels: EDGE_LABELS,
  };
}
