import { cn } from "../../map/kit";
import { MiniChip } from "../parts/mini-chip";
import type { CriterionJudge, ScenarioResult } from "../types";

export type ScenarioResultRow = ScenarioResult & {
  scenarios: { id: string; name: string; category: string | null } | null;
};

/** TypeSafe "second opinion" cross-check on one criterion (contract 2026-09-18, judge design
 * task): a criterion item carries this when `judge.uses.verdict_check` was on for the run.
 * `criterion_met` is the judge's own 0..1 confidence that the criterion is satisfied;
 * `agrees` is whether that confidence lines up with the agent's own outcome; the judge never
 * changes the outcome itself either way — see the chip's tooltip below. */

export function CriterionJudgeChip({ judge, className }: { judge: CriterionJudge; className?: string }) {
  const baseTitle =
    "A second, cheaper model's cross-check on this criterion. It never changes the outcome above. It only flags when its own read disagrees.";
  const title = judge.change_kind
    ? `${baseTitle} Baseline compare: ${judge.change_kind.replace(/_/g, " ")}.`
    : baseTitle;
  return (
    <MiniChip
      dot={judge.agrees ? "bg-muted" : "bg-sev-major"}
      className={cn(judge.agrees ? undefined : "text-fg-2", className)}
      data-judge-chip={judge.agrees ? "agrees" : "disagrees"}
      title={title}
    >
      {judge.agrees ? "2nd opinion agrees" : `2nd opinion disagrees · ${judge.confidence.toFixed(2)}`}
    </MiniChip>
  );
}
