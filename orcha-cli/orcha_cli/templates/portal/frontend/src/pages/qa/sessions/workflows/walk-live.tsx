import { Check, Flag, UserRound, X } from "../../map/kit/icons";
import { FindingShot } from "../detail/finding-shot";
import { useNow } from "../detail/phase-timeline";
import { fmtClock } from "../detail/model";
import type { TargetKind } from "../explorations";
import {
  dataPairs,
  personaName,
  railSteps,
  walkHeadline,
  walkPosition,
  type DraftingFlow,
  type FlowWalk,
  type Persona,
  type RailStep,
} from "../workflows/workflows";
import { cn } from "../../map/kit";
import { FrameThumb } from "./bits";
import styles from "./workflows.module.css";

function StepNode({ step }: { step: RailStep }) {
  const base = "relative z-[1] flex size-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold tabular";
  if (step.state === "done")
    return (
      <span key="done" className={cn(base, "border-success bg-success text-white dark:text-bg", styles.nodeLand)} aria-hidden>
        <Check className="size-3.5" strokeWidth={3} />
      </span>
    );
  if (step.state === "missed")
    return (
      <span key="missed" className={cn(base, "border-danger bg-danger text-white dark:text-bg", styles.nodeLand)} aria-hidden>
        <X className="size-3.5" strokeWidth={3} />
      </span>
    );
  if (step.state === "now")
    return (
      <span key="now" className={cn(base, "border-primary bg-panel text-primary dark:text-chart-1", styles.nodeNow)} aria-hidden>
        {step.index}
      </span>
    );
  return (
    <span key="next" className={cn(base, "border-border-strong bg-panel text-muted")} aria-hidden>
      {step.index}
    </span>
  );
}

const STATE_SR: Record<RailStep["state"], string> = { done: "reached", missed: "not reached", now: "walking now", next: "not yet" };

/** One step on the rail: what it is, what the explorer saw, what held, and its frame. */
function StepRow({ step, kind, i, last }: { step: RailStep; kind: string | null; i: number; last: boolean }) {
  const r = step.report;
  const landed = step.state === "done" || step.state === "missed";
  return (
    <li
      className={cn("relative flex gap-3 rounded-lg py-2 pl-0 pr-2", landed && styles.rowLand)}
      style={{ ["--i" as string]: i }}
      data-walk-step={step.index}
      data-step-state={step.state}
    >
      {landed ? <span key={`wash-${step.state}`} aria-hidden className={styles.wash} /> : null}
      {/* The spine to the next step: drawn down once this step has landed. */}
      {last ? null : (
        <span aria-hidden className={styles.segment}>
          {landed ? <span key="fill" className={cn(styles.segmentFill, step.state === "missed" && styles.segmentMissed)} /> : null}
        </span>
      )}
      <StepNode step={step} />
      <div className="flex min-w-0 flex-1 flex-col gap-1 pt-1">
        <p className={cn("text-sm leading-5", step.state === "next" ? "text-muted" : "font-medium text-fg")}>
          <span className="sr-only">
            Step {step.index}, {STATE_SR[step.state]}:{" "}
          </span>
          {step.text}
        </p>
        {r?.result ? <p className="text-xs leading-4 text-fg-2">{r.result}</p> : null}
        {step.state === "now" ? (
          <p className="flex items-center gap-1.5 text-xs text-primary dark:text-chart-1">
            <span className="v-live size-1.5" aria-hidden />
            On this step now
          </p>
        ) : null}
        {r && (r.checked.length > 0 || r.finding_id != null) ? (
          <ul className="flex flex-wrap gap-1 pt-0.5" aria-label="Checked on this step">
            {r.checked.map((c, ci) => (
              <li
                key={c}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[11px] font-medium",
                  r.reached ? "bg-success/10 text-success" : "bg-panel-2 text-fg-2",
                  styles.check,
                )}
                style={{ ["--i" as string]: ci }}
              >
                <Check aria-hidden className="size-2.5" strokeWidth={3} />
                {c}
              </li>
            ))}
            {r.finding_id != null ? (
              <li className={cn("inline-flex items-center gap-1 rounded-full bg-danger/10 px-1.5 py-px text-[11px] font-medium text-danger", styles.check)}>
                <Flag aria-hidden className="size-2.5" strokeWidth={2.5} />
                Finding #{r.finding_id}
              </li>
            ) : null}
          </ul>
        ) : null}
      </div>
      {r ? <FrameThumb frame={r.frame} kind={kind} label={`Step ${step.index}: ${step.text}`} /> : null}
    </li>
  );
}

/**
 * The walk in progress: "Walking: Log a bottle feed, step 3 of 5", who it walks as and
 * with what data, then the flow's steps as a rail. Steps light up as the explorer reports them
 * (reached or not), each with its result, the checks that held and its frame; the step it is on
 * now breathes; the spine fills to it. Beside the rail, the newest frame, developing in as each
 * one lands. Screen readers hear the headline and each step's result as they arrive.
 */
export function WalkInProgress({
  walk,
  flow,
  personas,
  kind,
}: {
  walk: FlowWalk;
  flow: DraftingFlow | null;
  personas: readonly Persona[];
  kind: TargetKind | null;
}) {
  const now = useNow(true);
  const rail = railSteps(flow, walk);
  const pos = walkPosition(flow, walk);
  const name = flow?.name ?? walk.flow_key;
  const headline = walkHeadline(name, pos);
  const persona = personaName(walk.persona ?? flow?.persona, personas);
  const data = dataPairs(Object.keys(walk.data_used).length ? walk.data_used : (flow?.data ?? {}));
  const latest = [...walk.steps].reverse().find((s) => s.frame) ?? null;
  const lastReported = walk.steps[walk.steps.length - 1] ?? null;
  const elapsed = Math.max(0, (now - Date.parse(walk.started_at)) / 1000);
  const frameKind = (walk.target_kind ?? flow?.target_kind ?? kind ?? "ios") as TargetKind;

  return (
    <section
      className="relative flex flex-col gap-4 overflow-hidden rounded-xl border border-primary/30 bg-panel p-4 shadow-[var(--shadow-md)]"
      aria-labelledby="walk-live-title"
      data-walk-live={walk.id}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-[radial-gradient(ellipse_at_top_left,color-mix(in_srgb,var(--color-fg)_14%,transparent),transparent_70%)]"
      />
      <header className="relative flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-center gap-2 text-xs">
            <span className="flex items-center gap-1.5 rounded-full border border-border bg-panel px-2 py-0.5 font-medium text-fg">
              <span className="v-live size-1.5 text-danger" aria-hidden />
              LIVE
            </span>
            <span className="font-mono text-2xs tabular text-muted" suppressHydrationWarning>
              {fmtClock(elapsed)} on this flow
            </span>
          </div>
          <h3 id="walk-live-title" className="text-lg font-semibold leading-6 tracking-[-0.01em] text-fg" data-walk-headline>
            {headline}
          </h3>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-fg-2">
            {persona ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5" data-walk-persona>
                <UserRound aria-hidden className="size-3 text-muted" />
                as {persona}
              </span>
            ) : null}
            {data.map((d) => (
              <span key={d} className="rounded-full bg-panel-2 px-2 py-0.5 font-mono text-[11px] text-fg-2">
                {d}
              </span>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
          <span className="font-mono text-2xl font-semibold tabular leading-none text-fg" aria-hidden>
            {pos.at}
            <span className="text-base text-muted">/{pos.total}</span>
          </span>
          <span className="text-2xs uppercase tracking-wide text-muted">steps</span>
        </div>
      </header>

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {headline}.{lastReported ? ` Step ${lastReported.index} ${lastReported.reached ? "reached" : "not reached"}${lastReported.result ? `: ${lastReported.result}` : ""}.` : ""}
      </p>

      <div className="relative grid grid-cols-1 gap-5 md:grid-cols-[minmax(0,1fr)_auto]">
        <ol className="relative flex flex-col gap-0.5 self-start" aria-label={`The steps of ${name}`}>
          {rail.map((s, i) => (
            <StepRow key={s.index} step={s} kind={frameKind} i={i} last={i === rail.length - 1} />
          ))}
        </ol>
        <aside className="hidden flex-col items-center gap-2 md:flex" aria-label="The newest frame" data-walk-current-frame>
          {latest?.frame ? (
            <>
              <div key={latest.frame} className={cn("w-[210px]", styles.develop)}>
                <div className={cn("rounded-[inherit]", styles.liveFrame)}>
                  <FindingShot path={latest.frame} alt={`Step ${latest.index}: ${latest.text}`} kind={frameKind} size="hero" className="max-w-[210px]" />
                </div>
              </div>
              <p className="max-w-[210px] text-center text-xs text-muted">
                Step {latest.index} · {latest.result ?? latest.text}
              </p>
            </>
          ) : (
            <div className="v-skeleton aspect-[402/874] w-[180px] rounded-[26px]" aria-label="No frame yet" />
          )}
        </aside>
      </div>
    </section>
  );
}
