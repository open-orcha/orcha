import type { ReactNode } from "react";
import { Check } from "../../map/kit/icons";
import { cn } from "../../map/kit";
import { PHASE_HINT, phaseStates, type WorkPhase } from "./words";
import styles from "./work.module.css";

/**
 * The one phase bar of every job: Read, Explore, Draft, Review, Run, showing only the
 * phases the job has. Finished phases get a check and a full segment, the current one breathes
 * and carries a slow light along its segment, and its caption (a clock, "starts with the
 * device") sits at its right. `current` null: not started yet; "finished": all done.
 */
export function WorkPhaseBar({
  phases,
  current,
  caption,
  fraction,
  label = "Phases",
  className,
  exploreWord,
}: {
  phases: readonly WorkPhase[];
  current: WorkPhase | null | "finished";
  /** A map or a check walks the app too, but it is not exploring. */
  exploreWord?: string;
  /** Shown beside the current phase: its clock against its cap, or a note. */
  caption?: ReactNode;
  /** How far the current phase is (0..1), when it has a cap; else the segment shows a glide. */
  fraction?: number | null;
  label?: string;
  className?: string;
}) {
  const states = phaseStates(phases, current).map((p) => (p.key === "explore" && exploreWord ? { ...p, label: exploreWord } : p));
  const active = states.find((p) => p.state === "active");
  return (
    <ol
      className={cn("grid gap-1.5", className)}
      style={{ gridTemplateColumns: `repeat(${phases.length}, minmax(0, 1fr))` }}
      aria-label={label}
      data-work-phases={phases.join(" ")}
      data-work-phase={current ?? "none"}
    >
      {states.map((p, i) => {
        const on = p.state === "active";
        return (
          <li
            key={p.key}
            className="flex min-w-0 flex-col gap-1.5"
            data-phase={p.key}
            data-phase-state={p.state}
            aria-current={on ? "step" : undefined}
            title={PHASE_HINT[p.key]}
          >
            <div className="relative h-1 overflow-hidden rounded-full bg-border">
              <span
                aria-hidden
                suppressHydrationWarning
                className={cn("absolute inset-0 rounded-full", p.state === "done" ? "bg-fg-2" : "bg-primary", styles.fill)}
                style={{ transform: `scaleX(${p.state === "done" ? 1 : on ? Math.max(0.06, fraction ?? 0.35) : 0})` }}
              />
              {on && fraction == null ? <span aria-hidden className={styles.glide} /> : null}
            </div>
            <div className="flex min-w-0 items-center gap-1.5 text-xs">
              <span
                aria-hidden
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold tabular",
                  p.state === "done" && "border-transparent bg-fg-2 text-bg",
                  on && cn("border-primary bg-primary text-primary-fg", styles.breathe),
                  p.state === "todo" && "border-border text-muted",
                )}
              >
                {p.state === "done" ? <Check className="size-2.5" strokeWidth={3} /> : i + 1}
              </span>
              <span className={cn("truncate font-medium", p.state === "todo" ? "text-muted" : "text-fg")}>
                {p.label}
                <span className="sr-only">{p.state === "done" ? " (done)" : on ? " (current)" : ""}</span>
              </span>
              {on && caption ? (
                <span className="ml-auto hidden shrink-0 font-mono text-2xs tabular text-muted sm:inline" data-phase-clock suppressHydrationWarning>
                  {caption}
                </span>
              ) : null}
            </div>
          </li>
        );
      })}
      <li className="sr-only" aria-live="polite">
        {active ? active.label : current === "finished" ? "Finished" : "Waiting to start"}
      </li>
    </ol>
  );
}
