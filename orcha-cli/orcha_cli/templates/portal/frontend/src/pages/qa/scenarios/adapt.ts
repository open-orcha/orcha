/**
 * The QA API's scenario rows in the shape the scenario screens take. `depends_on` may name a
 * scenario by id or by name; `checks` is stored as [{criterion_index, line}]; the latest verdict
 * per criterion rolls up into one outcome; a position on the map is this browser's.
 */
import { cleanConditions, type Conditions } from "../conditions/conditions";
import type { Platform, QaScenario, QaVerdict, ScenarioStatus } from "../qaApi";
import type { TargetKind } from "../map/kit";

export type ScenarioOutcome = "pass" | "fail" | "blocked" | "inconclusive";

export interface ScenarioChecks {
  /** Check lines per 0-based criterion index. */
  criteria: Record<string, string[]>;
  /** Lines about the whole scenario. */
  scenario: string[];
}

export interface Scenario {
  id: string;
  name: string;
  category: string | null;
  persona: string | null;
  description: string | null;
  criteria: string[];
  status: ScenarioStatus;
  status_reason: string | null;
  depends_on: string[];
  position: { x: number; y: number } | null;
  tags: string[];
  /** The platform it is pinned to; null: shared, it runs on every platform of the project. */
  target_kind: TargetKind | null;
  /** The platform it was written on (the record's `platform`, also for a shared one). */
  platform: Platform;
  data: Record<string, unknown>;
  needs: string[];
  checks: ScenarioChecks;
  source: QaScenario["source"];
  walk_id: string | null;
  session_id: string | null;
  task_id: string | null;
  validated_by_agent_id: string | null;
  validated_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  /** The newest verdicts rolled up; null = never checked. */
  outcome: ScenarioOutcome | null;
  /** When the newest verdict was given. */
  checked_at: string | null;
  /** Open suggested changes waiting for a person. */
  pending: number;
  status_until: string | null;
  status_issue: string | null;
  replaced_by: string | null;
  quarantined_at: string | null;
  quarantine_reason: string | null;
  quarantine_clean_runs: number;
  /** flaky, failing or healthy from its recent checks; null until it was checked. */
  health: "flaky" | "failing" | "healthy" | null;
  fresh: boolean | null;
  conditions: Conditions | null;
  permissions: "ask" | null;
  session: string | null;
  examples: unknown;
  seed: string[];
  cleanup: string[];
  events: string[];
  /** The newest result per platform it ran on. */
  by_platform: Partial<Record<TargetKind, PlatformResult>>;
}

export interface PlatformResult {
  outcome: ScenarioOutcome | null;
  at: string | null;
  reason: string | null;
}

/** The fields the API sends beyond `QaScenario`. */
interface RawExtras {
  depends_on?: unknown;
  checks?: unknown;
  data?: unknown;
  needs?: unknown;
  shared?: unknown;
  status_until?: string | null;
  status_issue?: string | null;
  replaced_by?: string | null;
  quarantined_at?: string | null;
  quarantine_reason?: string | null;
  quarantine_clean_runs?: number | null;
  health?: Scenario["health"];
  fresh?: boolean | null;
  conditions?: Conditions | null;
  permissions?: string | null;
  session?: string | null;
  examples?: unknown;
  seed?: unknown;
  cleanup?: unknown;
  events?: unknown;
  by_platform?: unknown;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** `[{criterion_index, line}]` by criterion, unreadable rows dropped. */
export function toChecks(raw: unknown): ScenarioChecks {
  const out: ScenarioChecks = { criteria: {}, scenario: [] };
  for (const row of Array.isArray(raw) ? raw : []) {
    const r = row as { criterion_index?: unknown; line?: unknown } | null;
    const line = typeof r?.line === "string" ? r.line.trim() : "";
    if (!line) continue;
    if (typeof r?.criterion_index === "number") (out.criteria[String(r.criterion_index)] ??= []).push(line);
    else out.scenario.push(line);
  }
  return out;
}

/** What `checks` is stored as: the scenario's lines first, then each criterion's in order. */
export function fromChecks(c: ScenarioChecks): { criterion_index: number | null; line: string }[] {
  const perCriterion = Object.keys(c.criteria)
    .map(Number)
    .sort((a, b) => a - b)
    .flatMap((i) => (c.criteria[String(i)] ?? []).map((line) => ({ criterion_index: i as number | null, line })));
  return [...c.scenario.map((line) => ({ criterion_index: null, line })), ...perCriterion];
}

/** One word for a scenario from its newest verdict per criterion: any failure wins, then blocked,
 * then inconclusive; it passed only when every criterion passed. */
export function rollupOutcome(criteria: number, verdicts: readonly Pick<QaVerdict, "criterion_index" | "verdict">[]): ScenarioOutcome | null {
  if (verdicts.length === 0) return null;
  const has = (v: string) => verdicts.some((x) => x.verdict === v);
  if (has("fail")) return "fail";
  if (has("blocked")) return "blocked";
  if (has("inconclusive")) return "inconclusive";
  return new Set(verdicts.map((v) => v.criterion_index)).size >= criteria ? "pass" : "inconclusive";
}

/** Ids for `depends_on`, which may say ids or names; what matches nothing is kept as written. */
export function dependencyIds(raw: unknown, rows: readonly Pick<QaScenario, "id" | "name">[]): string[] {
  const ids = new Set(rows.map((r) => r.id));
  const byName = new Map(rows.map((r) => [r.name.trim().toLowerCase(), r.id]));
  return [...new Set(strings(raw).map((d) => (ids.has(d) ? d : (byName.get(d.trim().toLowerCase()) ?? d))))];
}

export function adaptScenario(
  q: QaScenario,
  all: readonly Pick<QaScenario, "id" | "name">[],
  extra: { positions?: Readonly<Record<string, { x: number; y: number }>>; pending?: ReadonlyMap<string, number> } = {},
): Scenario {
  const raw = q as QaScenario & RawExtras;
  return {
    id: q.id,
    name: q.name,
    category: q.category ?? null,
    persona: q.persona ?? null,
    description: q.description ?? null,
    criteria: q.criteria,
    status: q.status,
    status_reason: q.status_reason ?? null,
    depends_on: dependencyIds(raw.depends_on, all),
    position: extra.positions?.[q.id] ?? null,
    tags: q.tags ?? [],
    target_kind: raw.shared ? null : q.platform,
    platform: q.platform,
    data: raw.data && typeof raw.data === "object" && !Array.isArray(raw.data) ? (raw.data as Record<string, unknown>) : {},
    needs: strings(raw.needs),
    checks: toChecks(raw.checks),
    source: q.source ?? null,
    walk_id: q.walk_id ?? null,
    session_id: q.session_id ?? null,
    task_id: q.task_id ?? null,
    validated_by_agent_id: q.validated_by_agent_id ?? null,
    validated_at: q.validated_at ?? null,
    created_at: q.created_at ?? null,
    updated_at: q.updated_at ?? null,
    outcome: rollupOutcome(q.criteria.length, q.verdicts ?? []),
    checked_at: (q.verdicts ?? []).reduce<string | null>((at, v) => (at && at >= v.created_at ? at : v.created_at), null),
    pending: extra.pending?.get(q.id) ?? 0,
    status_until: raw.status_until ?? null,
    status_issue: raw.status_issue ?? null,
    replaced_by: raw.replaced_by ?? null,
    quarantined_at: raw.quarantined_at ?? null,
    quarantine_reason: raw.quarantine_reason ?? null,
    quarantine_clean_runs: raw.quarantine_clean_runs ?? 0,
    health: raw.health ?? null,
    fresh: raw.fresh ?? null,
    conditions: cleanConditions(raw.conditions),
    permissions: raw.permissions === "ask" ? "ask" : null,
    session: raw.session ?? null,
    examples: raw.examples ?? null,
    seed: strings(raw.seed),
    cleanup: strings(raw.cleanup),
    events: strings(raw.events),
    by_platform: raw.by_platform && typeof raw.by_platform === "object" ? (raw.by_platform as Scenario["by_platform"]) : {},
  };
}

/** Open suggested changes per scenario. */
export function pendingBy(suggestions: readonly { scenario_id: string; status: string }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of suggestions) if (s.status === "proposal") m.set(s.scenario_id, (m.get(s.scenario_id) ?? 0) + 1);
  return m;
}

const POSITIONS_KEY = (cid: string) => `orcha.qa.scenarios.positions.${cid}`;

/** The map positions saved in this browser. */
export function readPositions(cid: string): Record<string, { x: number; y: number }> {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(POSITIONS_KEY(cid)) ?? "{}");
    return raw && typeof raw === "object" ? (raw as Record<string, { x: number; y: number }>) : {};
  } catch {
    return {};
  }
}

export function writePositions(cid: string, positions: Readonly<Record<string, { x: number; y: number }>>): void {
  try {
    window.localStorage.setItem(POSITIONS_KEY(cid), JSON.stringify(positions));
  } catch {
    /* storage is a convenience */
  }
}
