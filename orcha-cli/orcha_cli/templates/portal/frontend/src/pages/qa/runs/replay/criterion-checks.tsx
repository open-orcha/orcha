import { useState } from "react";
import { Button } from "../../map/kit";
import { StatusGlyph } from "../../map/kit";
import { MiniChip } from "../parts/mini-chip";
import type { CriterionCheckResult, CriterionProof, CriterionReadback } from "../types";
import { humanizeCheckText, humanizeLocator } from "../lib/humanize-locator";

/**
 * Deterministic checks on one criterion (`Check:` lines,): how the verdict was
 * proven, each check's result, a disagreement with the agent, and checks the harness proposes
 * after a judged pass ("Promote to check" writes the line into the scenario).
 */

const PROOF_LABEL: Record<CriterionProof, string> = {
  "checked+judged": "checked and judged",
  checked: "checked",
  judged: "judged",
};

const PROOF_TITLE: Record<CriterionProof, string> = {
  "checked+judged": "Deterministic checks passed and the agent judged it passed: the strongest proof.",
  checked: "Decided by deterministic checks evaluated by the harness, not by the agent.",
  judged: "Decided by the agent's judgment alone; no deterministic check covers it.",
};

export function ProofChip({ proof, className }: { proof: CriterionProof; className?: string }) {
  return (
    <MiniChip
      dot={proof === "judged" ? "bg-chart-1" : "bg-chart-5"}
      className={className}
      data-proof={proof}
      title={PROOF_TITLE[proof]}
    >
      {PROOF_LABEL[proof]}
    </MiniChip>
  );
}

export function CriterionChecks({
  checks,
  agentDisagreed,
  judgment,
  suggested,
  scenarioId,
  criterionIndex,
  readbacks = [],
}: {
  checks: CriterionCheckResult[];
  agentDisagreed: boolean;
  judgment: string | null;
  suggested: string[];
  scenarioId: string | null;
  criterionIndex: number;
  /** "Check needs fixing" (#191): the corrected line to accept or dismiss. */
  /** Lines this run repaired before judging them (#226): keep or undo each. */
  /** `Saved:` read-backs (#266, #285): shown with their source and values, not as raw lines. */
  readbacks?: CriterionReadback[];
}) {
  // A read-back is evaluated as a check line (`saved …`) too; show it once, in "Saved data".
  if (readbacks.length > 0) checks = checks.filter((c) => !/^saved\b/i.test(c.expression.trim()));
  if (checks.length === 0 && suggested.length === 0 && !agentDisagreed && readbacks.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5" data-criterion-checks>
      {agentDisagreed ? (
        <p className="flex items-center gap-1.5 text-sm text-fg" data-agent-disagreed>
          <StatusGlyph status="fail" decorative className="size-3.5" />
          Agent said {judgment ?? "pass"}; a check failed.
        </p>
      ) : null}
      {checks.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {checks.map((c, i) => (
            <li key={i} className="flex items-start gap-2 font-mono text-xs leading-5" data-check-outcome={c.outcome}>
              <StatusGlyph status={c.outcome === "not_run" ? "pending" : c.outcome} label={c.outcome === "not_run" ? "not run" : c.outcome} className="mt-[3px] size-3.5" />
              <span className="min-w-0 select-text break-words">
                <span className="text-fg" title={c.expression}>{humanizeLocator(c.expression)}</span>
                {c.outcome !== "pass" && c.actual ? <span className="text-muted">: {humanizeCheckText(c.actual)}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {readbacks.length > 0 ? <SavedData readbacks={readbacks} /> : null}
      {suggested.length > 0 && scenarioId ? (
        <SuggestedChecks lines={suggested} scenarioId={scenarioId} criterionIndex={criterionIndex} />
      ) : null}
    </div>
  );
}

const READBACK_GLYPH: Record<CriterionReadback["outcome"], "pass" | "fail" | "warning"> = {
  pass: "pass",
  fail: "fail",
  warning: "warning",
  inconclusive: "warning",
  needs_setup: "warning",
};

/** What a `Saved:` line read back: the source, the stored fields and, when it fails, what was
 * expected instead (#285). */
function SavedData({ readbacks }: { readbacks: CriterionReadback[] }) {
  return (
    <div className="flex flex-col gap-1" data-saved-data>
      <div className="text-xs text-muted">Saved data</div>
      <ul className="flex flex-col gap-1.5">
        {readbacks.map((r, i) => {
          const fields = Object.entries(r.fields ?? {});
          const actual = r.actual.replace(/\s*\(read from [^)]*\)\)?$/, "").trim();
          return (
            <li key={i} className="flex items-start gap-2 text-xs leading-5" data-readback-outcome={r.outcome}>
              <StatusGlyph status={READBACK_GLYPH[r.outcome]} label={r.outcome} className="mt-[3px] size-3.5" />
              <span className="flex min-w-0 select-text flex-col gap-0.5">
                <span className="text-fg">{actual.charAt(0).toUpperCase() + actual.slice(1)}</span>
                {r.source ? <span className="text-muted">Read from {r.source.replace(/^the /, "")}</span> : null}
                {fields.length > 0 ? (
                  <span className="flex flex-wrap gap-1 font-mono">
                    {fields.map(([k, v]) => (
                      <span key={k} className="rounded-sm border border-border bg-panel-2 px-1.5 text-[11px] text-fg">
                        {k} = {v === null || v === undefined || v === "" ? "empty" : String(v)}
                      </span>
                    ))}
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SuggestedChecks({
  lines,
  scenarioId,
  criterionIndex,
}: {
  lines: string[];
  scenarioId: string;
  criterionIndex: number;
}) {
  const [state, setState] = useState<Record<string, "saving" | "added" | string>>({});
  async function promote(line: string) {
    setState((s) => ({ ...s, [line]: "saving" }));
    try {
      const res = await fetch(`/api/scenarios/${scenarioId}/checks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ criterion_index: criterionIndex, line }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      setState((s) => ({ ...s, [line]: res.ok ? "added" : json.error ?? "failed" }));
    } catch (err) {
      setState((s) => ({ ...s, [line]: err instanceof Error ? err.message : "failed" }));
    }
  }
  return (
    <div className="flex flex-col gap-1" data-suggested-checks>
      <div className="text-xs text-muted">Suggested checks</div>
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
        {lines.map((line) => {
          const st = state[line];
          return (
            <li key={line} className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1 font-mono text-xs">
              <span className="min-w-0 flex-1 truncate text-fg" title={line}>
                Check: {line}
              </span>
              {st === "added" ? (
                <span className="inline-flex shrink-0 items-center gap-1 font-sans text-muted">
                  <StatusGlyph status="pass" decorative className="size-3" />
                  added
                </span>
              ) : (
                <Button
                  size="sm"
                  className="font-sans"
                  disabled={st === "saving"}
                  onClick={() => void promote(line)}
                >
                  {st === "saving" ? "Adding…" : "Promote to check"}
                </Button>
              )}
              {st && st !== "added" && st !== "saving" ? (
                <span className="inline-flex shrink-0 items-center gap-1 font-sans text-muted">
                  <StatusGlyph status="fail" decorative className="size-3" />
                  {st}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Parse the check fields of one `scenario_results.criteria` item. */
export function parseCheckFields(c: Record<string, unknown>): {
  checks: CriterionCheckResult[];
  proof: CriterionProof | null;
  agentDisagreed: boolean;
  judgment: string | null;
  suggested: string[];
} {
  const checks: CriterionCheckResult[] = Array.isArray(c.checks)
    ? (c.checks as unknown[]).flatMap((r) => {
        if (typeof r !== "object" || r === null || Array.isArray(r)) return [];
        const o = r as Record<string, unknown>;
        const outcome = o.outcome === "pass" || o.outcome === "fail" || o.outcome === "warning" ? o.outcome : "fail";
        return [{ expression: String(o.expression ?? ""), outcome, actual: typeof o.actual === "string" ? o.actual : "" }];
      })
    : [];
  const proof = c.proof === "checked" || c.proof === "judged" || c.proof === "checked+judged" ? c.proof : null;
  const suggested = Array.isArray(c.suggested_checks)
    ? (c.suggested_checks as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  return {
    checks,
    proof,
    agentDisagreed: c.agent_disagreed === true,
    judgment: typeof c.judgment === "string" ? c.judgment : null,
    suggested,
  };
}
