import { StatusGlyph } from "../../map/kit";
import type { ScenarioOutcome } from "../types";
import type { ScenarioVerdict } from "../lib/verdict";
import { cn } from "../../map/kit";

/** Linear status glyph for one criterion's raw outcome (see `StatusGlyph` for the shape set). */
export function CriterionStateIcon({
  outcome,
  className,
}: {
  outcome: ScenarioOutcome | null;
  className?: string;
}) {
  const cls = cn("size-3.5 shrink-0", className);
  switch (outcome) {
    case "running":
      return <StatusGlyph status="running" label="running" className={cls} />;
    case "pass":
      return <StatusGlyph status="pass" label="passed" className={cls} />;
    case "fail":
      return <StatusGlyph status="fail" label="failed" className={cls} />;
    case "warning":
      return <StatusGlyph status="warning" label="warning" className={cls} />;
    case "inconclusive":
      return <StatusGlyph status="inconclusive" label="inconclusive" className={cls} />;
    case "blocked":
      return <StatusGlyph status="blocked" label="blocked" className={cls} />;
    case "unprocessable":
      return <StatusGlyph status="unprocessable" label="unprocessable" className={cls} />;
    case "needs_setup":
      return <StatusGlyph status="needs_setup" label="needs setup" className={cls} />;
    default:
      return <StatusGlyph status="queued" label="not started" className={cls} />;
  }
}

/** Linear status glyph for a scenario's rolled-up verdict (left rail rows, header). */
export function VerdictIcon({ verdict, className }: { verdict: ScenarioVerdict; className?: string }) {
  const cls = cn("size-3.5 shrink-0", className);
  switch (verdict) {
    case "running":
      return <StatusGlyph status="running" label="running" className={cls} />;
    case "passed":
      return <StatusGlyph status="pass" label="passed" className={cls} />;
    case "failed":
      return <StatusGlyph status="fail" label="failed" className={cls} />;
    case "warning":
      return <StatusGlyph status="warning" label="warning" className={cls} />;
    case "inconclusive":
      return <StatusGlyph status="inconclusive" label="inconclusive" className={cls} />;
    case "unprocessable":
      return <StatusGlyph status="unprocessable" label="unprocessable" className={cls} />;
    case "needs_setup":
      return <StatusGlyph status="needs_setup" label="needs setup" className={cls} />;
  }
}

/** Dot colour classes matching `VerdictIcon`'s palette, for the stacked bar / small dots. */
export const verdictDot: Record<ScenarioVerdict, string> = {
  passed: "bg-success",
  warning: "bg-sev-minor",
  failed: "bg-danger",
  inconclusive: "bg-sev-minor/60",
  unprocessable: "bg-muted",
  needs_setup: "bg-info",
  running: "bg-progress",
};

export const verdictLabel: Record<ScenarioVerdict, string> = {
  passed: "Passed",
  warning: "Warning",
  failed: "Failed",
  inconclusive: "Inconclusive",
  unprocessable: "Unprocessable",
  needs_setup: "Needs setup",
  running: "Running",
};
