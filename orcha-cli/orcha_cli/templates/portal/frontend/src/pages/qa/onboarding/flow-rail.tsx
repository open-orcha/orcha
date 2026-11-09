import { StatusGlyph } from "./ui";
import { cn } from "./ui";
import { FLOW_LABELS, FLOW_STEPS, stepIndex, type FlowStep } from "./flow";

/**
 * The six steps as a quiet rail: done steps carry the pass glyph and go back to themselves,
 * the current one is a raised pill, the rest stay muted. Once the project exists, Connect and
 * We found are done for good (their rows are inserted) and stay put. Below `sm` only the
 * current step keeps its label.
 */
export function FlowRail({ current, reached, onGo, locked }: { current: FlowStep; reached: FlowStep; onGo: (step: FlowStep) => void; locked: boolean }) {
  const at = stepIndex(current);
  const far = stepIndex(reached);
  return (
    <nav aria-label="Onboarding steps">
      <ol className="flex flex-wrap items-center gap-x-0.5 gap-y-2">
        {FLOW_STEPS.map((step, i) => {
          const active = i === at;
          const done = i < far || (i < at);
          const reachable = i <= far && !active && !(locked && i < stepIndex("map"));
          const body = (
            <>
              {done && !active ? (
                <StatusGlyph status="pass" label="Done" size={14} />
              ) : (
                <span
                  aria-hidden
                  className={cn(
                    "flex size-3.5 items-center justify-center rounded-full border text-[9px] font-semibold leading-none tabular-nums",
                    active ? "border-fg text-fg" : "border-border-strong text-muted",
                  )}
                >
                  {i + 1}
                </span>
              )}
              <span className={cn(active ? "inline" : "hidden sm:inline")}>{FLOW_LABELS[step]}</span>
            </>
          );
          const cls = cn("flex h-7 items-center gap-1.5 rounded-full px-2 text-xs", active ? "border border-border bg-raised font-medium text-fg shadow-sm" : "text-muted");
          return (
            <li key={step} className="flex items-center">
              {i > 0 ? <span className="mx-0.5 hidden h-px w-3 bg-border sm:block" aria-hidden /> : null}
              {reachable ? (
                <button type="button" className={cn(cls, "hover:bg-hover hover:text-fg")} onClick={() => onGo(step)} data-flow-step={step}>
                  {body}
                </button>
              ) : (
                <span className={cls} aria-current={active ? "step" : undefined} data-flow-step={step}>
                  {body}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
