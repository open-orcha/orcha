/**
 * "Check needs fixing" (#191, `orcha.verdicts.checks.propose_fix`): a criterion the agent judged pass
 * whose `Check:` line the frames show is wrong (it held earlier and faded, it names a role the
 * tree does not report, or an internal id the screen lacks). The result carries the corrected
 * line as `criteria[].check_fix`; a person accepts it into the scenario (a new version) or
 * dismisses it (`check_fix_dismissals`, migration 078).
 *
 * A run also repairs, for itself, a line the criterion's own words say checks the wrong moment
 * (`checks.repair_check`, #226): a label the criterion says is gone, the control the criterion
 * acts with or the screen it leaves, a transient state, words of the criterion read as a label
 * (`text "with"`). Those come as `criteria[].check_repairs` (`applied`): the run
 * already judged the repaired line, and a person keeps it (saved as a new version) or undoes it
 * (a dismissal: later runs run the line as written).
 */
import type { ScenarioChecks } from "./adapt";
import { parseCheck } from "./checks";

export type CheckFixKind = "transient" | "role" | "internal_id" | "late" | "contradiction" | "negated" | "action" | "origin" | "prose" | "unheld";

export interface CheckFix {
  expression: string;
  kind: CheckFixKind;
  reason: string;
  /** The corrected line; null: none derivable (or, for a repair, the line is dropped). */
  proposed: string | null;
  evidence_step: number | null;
  /** A repair this run already applied (`check_repairs`), not a proposal. */
  applied?: boolean;
}

export interface PendingCheckFix extends CheckFix {
  criterion_index: number;
  /** The newest run that proposed it. */
  run_id: string;
  /** How many of the scanned runs proposed it. */
  seen: number;
}

export interface CheckFixDismissal {
  criterion_index: number;
  expression: string;
  proposed: string;
}

export const CHECK_FIX_KIND_LABEL: Record<CheckFixKind, string> = {
  transient: "Shown briefly",
  role: "Different role",
  internal_id: "Internal id",
  late: "Reported late",
  contradiction: "Contradictory checks",
  negated: "Criterion says it is gone",
  action: "Control the step uses",
  origin: "Screen the step leaves",
  prose: "Criterion wording, not a label",
  unheld: "Never held on its screens",
};

const KINDS = new Set<string>(["transient", "role", "internal_id", "late", "contradiction", "negated", "action", "origin", "prose", "unheld"]);

/** One `criteria[].check_fix` value, or null when it is not one. */
export function parseCheckFix(value: unknown): CheckFix | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.expression !== "string" || !o.expression.trim() || typeof o.kind !== "string" || !KINDS.has(o.kind)) return null;
  return {
    expression: o.expression,
    kind: o.kind as CheckFixKind,
    reason: typeof o.reason === "string" ? o.reason : "",
    proposed: typeof o.proposed === "string" && o.proposed.trim() ? o.proposed : null,
    evidence_step: typeof o.evidence_step === "number" ? o.evidence_step : null,
  };
}

/** `criteria[].check_repairs`: the repairs a run applied to this criterion's lines. */
export function parseCheckRepairs(value: unknown): CheckFix[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    const fix = parseCheckFix(v);
    return fix ? [{ ...fix, applied: true }] : [];
  });
}

/** A fix worth offering in the scenario: one that changes a line (a late report changes nothing). */
function offerable(fix: CheckFix): boolean {
  return fix.kind !== "late" && (fix.proposed !== null || fix.applied === true);
}

function normalised(line: string): string {
  const r = parseCheck(line);
  return r.ok ? r.normalised : line.trim();
}

/**
 * The fixes still worth offering for a scenario, newest first: proposed (or applied, as a repair)
 * by one of `rows` (its latest results, newest first), for a line the scenario still has, not
 * already applied and not dismissed. One line gets one offer, the newest run's: an older run's
 * different correction of the same line is outdated (#165). The count says how many runs agreed.
 */
export function pendingCheckFixes(
  rows: ReadonlyArray<{ run_id: string; criteria: unknown }>,
  checks: ScenarioChecks,
  dismissed: ReadonlyArray<CheckFixDismissal> = [],
): PendingCheckFix[] {
  const gone = new Set(dismissed.map((d) => `${d.criterion_index}\u0000${normalised(d.expression)}\u0000${d.proposed ?? ""}`));
  const out = new Map<string, PendingCheckFix>();
  for (const row of rows) {
    const criteria = Array.isArray(row.criteria) ? row.criteria : [];
    criteria.forEach((c, i) => {
      if (typeof c !== "object" || c === null) return;
      const item = c as Record<string, unknown>;
      const fixes = [parseCheckFix(item.check_fix), ...parseCheckRepairs(item.check_repairs)];
      for (const fix of fixes) {
        if (!fix || !offerable(fix)) continue;
        const expr = normalised(fix.expression);
        const have = (checks.criteria[String(i)] ?? []).map(normalised);
        if (gone.has(`${i}\u0000${expr}\u0000${fix.proposed ?? ""}`) || !have.includes(expr)) continue;
        if (fix.proposed && have.includes(normalised(fix.proposed))) continue;
        const line = `${i}\u0000${expr}`;
        const newest = out.get(line);
        if (!newest) out.set(line, { ...fix, expression: expr, criterion_index: i, run_id: row.run_id, seen: 1 });
        else if ((newest.proposed ?? "") === (fix.proposed ?? "") && newest.run_id !== row.run_id) newest.seen += 1;
      }
    });
  }
  return [...out.values()];
}

export type ReplaceResult = { ok: true; checks: ScenarioChecks } | { ok: false; error: string };

/**
 * `checks` with criterion `index`'s `expression` line replaced by `proposed` (normalised), in
 * place, so the order of the criterion's checks is kept. A missing line appends the proposal.
 */
export function replaceCheckLine(checks: ScenarioChecks, index: number, expression: string, proposed: string): ReplaceResult {
  if (!proposed.trim()) {
    // A repair that drops the line: another line of the criterion already says it.
    const key = String(index);
    const lines = (checks.criteria[key] ?? []).filter((l) => normalised(l) !== normalised(expression));
    return { ok: true, checks: { ...checks, criteria: { ...checks.criteria, [key]: lines } } };
  }
  const parsed = parseCheck(proposed);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const key = String(index);
  const lines = [...(checks.criteria[key] ?? [])];
  const at = lines.map(normalised).indexOf(normalised(expression));
  const next = at >= 0 ? [...lines.slice(0, at), parsed.normalised, ...lines.slice(at + 1)] : [...lines, parsed.normalised];
  const deduped = next.filter((l, i) => next.indexOf(l) === i);
  return { ok: true, checks: { ...checks, criteria: { ...checks.criteria, [key]: deduped } } };
}

/** The textarea text of one criterion's checks with the line replaced (the scenario panel). */
export function replaceInText(text: string, expression: string, proposed: string): string {
  const lines = text.split("\n");
  const want = normalised(expression);
  if (!proposed.trim()) return lines.filter((l) => !(l.trim() && normalised(l) === want)).join("\n");
  const at = lines.findIndex((l) => l.trim() && normalised(l) === want);
  if (at < 0) return text.trim() ? `${text.replace(/\n+$/, "")}\n${proposed}` : proposed;
  lines[at] = proposed;
  return lines.join("\n");
}
