/**
 * Pure rules behind the Health board (#188): grouping the audit by flag, the selection keys
 * bulk actions use, and the name Rename suggests for an agent task. No React.
 */
import { suspiciousReasons } from "../scenario-health";
import { FLAG_ORDER, type HealthAudit, type HealthFlag, type HealthFlagKind, type HealthScenario } from "./types";

export interface BoardRow {
  /** `<scenario id>:<flag kind>`: one row per flag, so a scenario can sit in two groups. */
  key: string;
  scenario: HealthScenario;
  flag: HealthFlag;
}

export interface BoardGroup {
  kind: HealthFlagKind;
  rows: BoardRow[];
}

export function rowKey(scenarioId: string, kind: HealthFlagKind): string {
  return `${scenarioId}:${kind}`;
}

/** Open flags grouped in `FLAG_ORDER` (empty groups left out), and the dismissed ones apart. */
export function groupAudit(audit: HealthAudit | null): { groups: BoardGroup[]; kept: BoardRow[]; open: number } {
  const by = new Map<HealthFlagKind, BoardRow[]>();
  const kept: BoardRow[] = [];
  for (const scenario of audit?.scenarios ?? []) {
    for (const flag of scenario.flags) {
      const row = { key: rowKey(scenario.id, flag.kind), scenario, flag };
      if (flag.dismissed_at) kept.push(row);
      else by.set(flag.kind, [...(by.get(flag.kind) ?? []), row]);
    }
  }
  const byName = (a: BoardRow, b: BoardRow) => a.scenario.name.localeCompare(b.scenario.name);
  const groups = FLAG_ORDER.filter((k) => by.has(k)).map((kind) => ({ kind, rows: by.get(kind)!.sort(byName) }));
  return { groups, kept: kept.sort(byName), open: groups.reduce((n, g) => n + g.rows.length, 0) };
}

/** How many distinct scenarios have at least one open flag. */
export function scenariosNeedingALook(audit: HealthAudit | null): number {
  return (audit?.scenarios ?? []).filter((s) => s.flags.some((f) => !f.dismissed_at)).length;
}

/** The rows behind a selection of row keys. */
export function selectedRows(groups: BoardGroup[], selected: ReadonlySet<string>): BoardRow[] {
  return groups.flatMap((g) => g.rows).filter((r) => selected.has(r.key));
}

const LEADING_WORK = /^(?:(?:please\s+)?(?:build|fix|implement|refactor|investigate|rework|clean\s*up|wire\s+up|add|create|update)\s+)(?:the\s+|a\s+|an\s+)?/i;
const TASK_PREFIX = /^\s*[A-Za-z][\w.-]{1,24}\s+[0-9a-f]{6,40}\s*[·•:|–—-]\s*/i;

/**
 * A plain name for an agent task, for Rename to start from: the task id, the parenthetical
 * notes and the work-order verbs taken out, keeping the part that names a screen or feature.
 * "Orcha 3c96e42c · Build the Questions board (website only, local branch)" becomes
 * "Questions board". The original name when nothing better is left.
 */
export function suggestedName(name: string): string {
  // A name that already reads like a user outcome ("Create an account") is left as it is.
  if (suspiciousReasons(name).length === 0) return name;
  let rest = name.replace(TASK_PREFIX, "").replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ");
  rest = rest.replace(/\s+/g, " ").trim();
  const parts = rest
    .split(/[·•:|–—]/)
    .map((p) => p.trim().replace(LEADING_WORK, "").trim())
    .filter(Boolean);
  const clean = parts.find((p) => suspiciousReasons(p).length === 0);
  if (!clean) return name;
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}
