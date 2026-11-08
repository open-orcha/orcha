import type { CSSProperties } from "react";
import { Ban, Check, X } from "../../map/kit/icons";
import { cn } from "../../map/kit";
import type { JourneyPath, JourneyStepState } from "./model";
import styles from "./detail.module.css";

const OUTCOME: Record<JourneyPath["outcome"], { label: string; tone: string }> = {
  passed: { label: "Passed", tone: "text-success" },
  failed: { label: "Failed", tone: "text-danger" },
  blocked: { label: "Blocked", tone: "text-warning" },
  not_run: { label: "Not run", tone: "text-muted" },
};

const NODE: Record<JourneyStepState, string> = {
  passed: "border-success bg-success text-bg",
  failed: "border-danger bg-danger text-bg",
  blocked: "border-warning bg-warning text-bg",
  not_reached: "border-border bg-panel text-muted",
  todo: "border-border bg-panel text-muted",
};

const STATE_LABEL: Record<JourneyStepState, string> = {
  passed: "passed",
  failed: "broke here",
  blocked: "blocked here",
  not_reached: "not reached",
  todo: "not run",
};

/**
 * Each journey drawn as a path of steps: segments grow left to right in order and each node
 * pops in after its segment, green up to where it broke, red (or amber when blocked) where it
 * broke, hollow after. At phone width the path runs top to bottom instead.
 */
export function JourneyPaths({ journeys }: { journeys: readonly JourneyPath[] }) {
  return (
    <ul className="flex flex-col gap-3" data-journeys>
      {journeys.map((j, ji) => (
        <li key={j.id} className="flex flex-col gap-2.5 rounded-lg border border-border bg-panel p-3" data-journey={j.id} data-journey-outcome={j.outcome}>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-sm font-medium text-fg">{j.name}</span>
            {j.persona ? <span className="text-xs text-muted">{j.persona}</span> : null}
            <span className={cn("ml-auto text-xs font-medium", OUTCOME[j.outcome].tone)}>{OUTCOME[j.outcome].label}</span>
          </div>
          <ol className="flex flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:items-start sm:gap-y-3" aria-label={`${j.name}: ${OUTCOME[j.outcome].label}`}>
            {j.steps.map((s, i) => {
              const delay = { "--i": i, "--d": `${ji * 300}ms` } as CSSProperties;
              return (
                <li key={`${i}-${s.label}`} className="flex min-w-0 items-start" data-journey-step={s.state}>
                  {i > 0 ? (
                    <span
                      aria-hidden
                      className={cn(
                        "mt-[9px] hidden h-0.5 w-10 shrink-0 sm:block",
                        s.state === "passed" || s.state === "failed" || s.state === "blocked" ? "bg-fg-2" : "bg-border",
                        styles.segment,
                      )}
                      style={delay}
                    />
                  ) : null}
                  <span className="flex items-center gap-2 sm:w-[104px] sm:flex-col sm:gap-1 sm:text-center">
                    <span
                      className={cn("flex size-5 shrink-0 items-center justify-center rounded-full border", NODE[s.state], styles.node)}
                      style={delay}
                      aria-hidden
                    >
                      {s.state === "passed" ? (
                        <Check className="size-3" strokeWidth={3} />
                      ) : s.state === "failed" ? (
                        <X className="size-3" strokeWidth={3} />
                      ) : s.state === "blocked" ? (
                        <Ban className="size-3" strokeWidth={2.5} />
                      ) : null}
                    </span>
                    <span className={cn("line-clamp-2 text-xs leading-4", s.state === "failed" || s.state === "blocked" ? "font-medium text-fg" : "text-fg-2")}>
                      {s.label}
                    </span>
                    <span className="sr-only">{STATE_LABEL[s.state]}</span>
                  </span>
                </li>
              );
            })}
          </ol>
          {j.brokeNote ? (
            <p className="text-xs text-muted">
              <span className="font-medium text-fg-2">Where it broke:</span> {j.brokeNote}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
