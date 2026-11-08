import type { CSSProperties } from "react";
import { Bug, CircleCheck, CircleDashed, CircleSlash } from "../../map/kit/icons";
import { severityTag } from "../../map/kit";
import type { FeatureOutcome } from "../explorations";
import { cn } from "../../map/kit";
import styles from "./detail.module.css";

const WALK_DOT: Readonly<Record<NonNullable<FeatureOutcome["walked"]>[number]["status"], string>> = {
  passed: "bg-success",
  failed: "bg-danger",
  unreachable: "bg-warning",
};

const OUTCOME: Readonly<Record<FeatureOutcome["outcome"], { label: string; tone: string; Icon: typeof CircleCheck }>> = {
  explored: { label: "Explored", tone: "text-success", Icon: CircleCheck },
  partly: { label: "Partly explored", tone: "text-warning", Icon: CircleDashed },
  not_reached: { label: "Not reached", tone: "text-muted", Icon: CircleSlash },
};

/** "2 of 3 features explored", for the section's count. */
export function featureOutcomeCount(features: readonly FeatureOutcome[]): string {
  const done = features.filter((f) => f.outcome === "explored").length;
  return `${done} of ${features.length} explored`;
}

/** "What it produced"'s line for the features: "Library, partly explored" for one, "3 features" for
 * more (a count of features in scope titled "explored" read as a contradiction beside "0 of 1"). */
export function featureOutcomeTitle(features: readonly FeatureOutcome[]): string {
  if (features.length === 1) return `${features[0].name}, ${OUTCOME[features[0].outcome].label.toLowerCase()}`;
  return `${features.length} features`;
}

/** "5 flows walked there: 3 passed, 2 failed" (a workflow-paired exploration), or null. */
export function walkedThere(f: Pick<FeatureOutcome, "walked">): string | null {
  const walked = f.walked ?? [];
  if (walked.length === 0) return null;
  const outcomes = (["passed", "failed", "unreachable"] as const)
    .map((s) => [s, walked.filter((w) => w.status === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`);
  return `${walked.length} ${walked.length === 1 ? "flow" : "flows"} walked there: ${outcomes.join(", ")}`;
}

/** Under it: what was checked in the one, or how far the run got in each ("2 explored · 1 not reached"). */
export function featureOutcomeDetail(features: readonly FeatureOutcome[]): string {
  if (features.length === 1) {
    const n = features[0].checked.length;
    const walked = walkedThere(features[0]);
    const checked = n ? `${n} ${n === 1 ? "thing" : "things"} checked there` : null;
    return [walked, checked].filter(Boolean).join(" · ") || "Nothing checked there";
  }
  return (["explored", "partly", "not_reached"] as const)
    .map((o) => [o, features.filter((f) => f.outcome === o).length] as const)
    .filter(([, n]) => n > 0)
    .map(([o, n]) => `${n} ${OUTCOME[o].label.toLowerCase()}`)
    .join(" · ");
}

/**
 * The report's per-feature part (`result.features`): one card per target feature, in the order
 * picked, with how far the run got (explored, partly, not reached and why), what it checked
 * there and the issues it found. A Deep dive of three features reads as three dives.
 */
export function FeatureOutcomes({ features }: { features: readonly FeatureOutcome[] }) {
  return (
    <ul className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3" data-feature-outcomes>
      {features.map((f, i) => {
        const o = OUTCOME[f.outcome];
        return (
          <li
            key={f.key}
            className={cn("flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-panel p-3", styles.cascade)}
            style={{ "--i": i } as CSSProperties}
            data-feature-outcome={f.outcome}
            data-feature={f.key}
          >
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{f.name}</span>
              <span className={cn("inline-flex shrink-0 items-center gap-1 text-xs font-medium", o.tone)}>
                <o.Icon aria-hidden className="size-3.5 self-center" strokeWidth={2} />
                {o.label}
              </span>
            </div>
            {f.walked?.length ? (
              <div className="flex flex-col gap-1 text-xs text-fg-2" data-feature-walked={f.walked.length}>
                <span className="text-muted">Walked</span>
                <ul className="flex flex-col gap-0.5">
                  {f.walked.map((w, wi) => (
                    <li key={`${w.name}-${wi}`} className="flex min-w-0 items-center gap-1.5" data-feature-walk={w.status}>
                      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", WALK_DOT[w.status])} />
                      <span className="sr-only">{w.status}: </span>
                      <span className="min-w-0 truncate" title={w.name}>
                        {w.name}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {f.checked.length > 0 ? (
              <p className="text-xs text-fg-2">
                <span className="text-muted">Checked: </span>
                {f.checked.join(", ")}
              </p>
            ) : null}
            {f.outcome !== "explored" && f.left.length > 0 ? (
              <p className="text-xs text-fg-2">
                <span className="text-muted">Left: </span>
                {f.left.join(", ")}
              </p>
            ) : null}
            {f.flows_left ? (
              <p className="text-xs text-muted">
                {f.flows_left} more {f.flows_left === 1 ? "flow" : "flows"} still queued for the next run.
              </p>
            ) : null}
            {f.note ? <p className="text-xs text-fg-2">{f.note}</p> : null}
            {f.outcome === "not_reached" && !f.note && f.left.length === 0 && !f.walked?.length ? (
              <p className="text-xs text-muted">No mission or finding of this run names it.</p>
            ) : null}
            <span className="mt-auto pt-1 text-xs text-muted">
              {f.findings > 0 && f.worst ? (
                <span className={cn("inline-flex items-center gap-1 rounded-full px-1.5 font-medium leading-5", severityTag[f.worst])} data-feature-findings={f.findings}>
                  <Bug aria-hidden className="size-3" strokeWidth={2.25} />
                  {f.findings} {f.findings === 1 ? "issue" : "issues"}
                </span>
              ) : (
                "No issues found here"
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
