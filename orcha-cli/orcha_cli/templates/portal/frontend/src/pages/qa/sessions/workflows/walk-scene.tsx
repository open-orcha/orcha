import { useEffect, useRef, useState } from "react";
import { Check, Footprints, ListOrdered, ScrollText } from "../../map/kit/icons";
import { rankModelWorkflows, type AppModel } from "../workflows/workflows";
import { cn } from "../../map/kit";
import styles from "./workflows.module.css";

/** The example flow the scene walks: the project's own when it has one, never another app's. */
export interface WalkExample {
  name: string;
  /** Three or four steps. */
  steps: string[];
  /** What each step shows once done ("✓ …"), one per step. */
  checks: string[];
  /** The draft scenario the walk becomes. */
  scenario: string;
}

const MAX_STEPS = 4;

/**
 * The scene's example, from what Orcha knows of this project: the App model's most important
 * workflow that says how to walk it (three steps or more), else a flow around one of its
 * features ("Open Notebooks"), else a flow any app has. Never a hard-coded flow of another
 * app's domain (a baby tracker's bottle feed on a notebook app read as wrong data).
 */
export function walkExample(model: AppModel | null | undefined, feature?: string | null): WalkExample {
  const wf = rankModelWorkflows(model?.workflows ?? []).find((w) => w.steps.filter((s) => s.text.trim()).length >= 3);
  if (wf) {
    const steps = wf.steps.filter((s) => s.text.trim()).slice(0, MAX_STEPS);
    return {
      name: wf.name,
      steps: steps.map((s) => s.text),
      checks: steps.map((s) => (s.screen ? `${s.screen} shown` : "Seen on the screen")),
      scenario: wf.name,
    };
  }
  const f = feature?.trim();
  if (f) {
    return {
      name: `Use ${f} end to end`,
      steps: [`Open ${f}`, "Start its main task", "Enter the test data", "Save and read the result"],
      checks: [`${f} shown`, "The form opens", "The values are in", "The result is shown"],
      scenario: `${f}: the main task, start to finish`,
    };
  }
  return {
    name: "Your app's top flow",
    steps: ["Open the app", "Start the main task", "Enter the test data", "Save and read the result"],
    checks: ["The first screen shown", "The form opens", "The values are in", "The result is shown"],
    scenario: "The top flow, start to finish",
  };
}

const BEAT_MS = 950;

const PHASES = [
  { title: "Ranked", line: "The drafter's flows, most at risk first.", Icon: ListOrdered },
  { title: "Walked", line: "Step by step, as a real user, with test data.", Icon: Footprints },
  { title: "Kept", line: "Each walked flow becomes a draft scenario.", Icon: ScrollText },
] as const;

function phaseAt(beat: number, steps: number): number {
  if (beat <= 0) return 0;
  if (beat <= steps) return 1;
  return 2;
}

/** A tiny example screen for a step: bars, not a real frame, since this is an example. */
function MiniScreen({ i }: { i: number }) {
  return (
    <span className="flex h-[46px] w-[23px] shrink-0 flex-col gap-[3px] rounded-[5px] border border-border-strong bg-panel p-[3px] shadow-[var(--shadow-sm)]">
      <span className="h-[2px] w-3/4 rounded-full bg-border-strong" />
      <span className={cn("h-[9px] rounded-[2px]", i % 2 ? "bg-primary/25" : "bg-success/20")} />
      <span className="h-[2px] w-1/2 rounded-full bg-border" />
      <span className="h-[2px] w-2/3 rounded-full bg-border" />
      <span className="mt-auto h-[4px] rounded-full bg-primary/40" />
    </span>
  );
}

/**
 * The teaching scene of a workflow-driven exploration, shown until the first flows are
 * queued: one example flow (`walkExample`: the project's own when Orcha knows one), marked
 * "For example", walked step by step (each step lands with its frame and its check), then an
 * arrow draws and the walk becomes a draft scenario. One take is about eight seconds and loops
 * only while on screen. Under reduced motion it is the finished frame. It is an example, so it
 * is hidden from screen readers, which get it as one sentence.
 */
export function WalkScene({ className, example }: { className?: string; example?: WalkExample }) {
  const ex = example ?? walkExample(null);
  const steps = ex.steps;
  const checks = ex.checks;
  const n = steps.length;
  /** Beats of one take: 0 queued, 1..n the steps land, n+1 the arrow draws, n+2 the scenario lands, n+3 hold. */
  const last = n + 4;
  const held = n + 3;
  const [beat, setBeat] = useState(held);
  const [resetting, setResetting] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el || typeof window === "undefined") return;
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof IntersectionObserver === "undefined") return;
    let timer = 0;
    let at = 0;
    let visible = false;
    const tick = () => {
      if (!visible) return;
      if (at > last) {
        setResetting(true);
        timer = window.setTimeout(() => {
          at = 0;
          setBeat(0);
          timer = window.setTimeout(() => {
            setResetting(false);
            at = 1;
            timer = window.setTimeout(tick, BEAT_MS);
          }, 80);
        }, 380);
        return;
      }
      setBeat(at);
      at += 1;
      timer = window.setTimeout(tick, at === n + 2 ? BEAT_MS * 0.8 : BEAT_MS);
    };
    const io = new IntersectionObserver(([entry]) => {
      const was = visible;
      visible = entry.isIntersecting;
      if (visible && !was) {
        window.clearTimeout(timer);
        at = 0;
        setBeat(0);
        at = 1;
        timer = window.setTimeout(tick, BEAT_MS * 1.2);
      }
      if (!visible) window.clearTimeout(timer);
    });
    io.observe(el);
    return () => {
      io.disconnect();
      window.clearTimeout(timer);
    };
  }, [n, last]);

  const landed = Math.min(beat, n);
  const arrow = beat >= n + 1;
  const kept = beat >= n + 2;
  const phase = phaseAt(beat, n);

  return (
    <div ref={root} className={cn("flex flex-col gap-4", className)} data-walk-scene>
      <p className="sr-only">
        An example of a workflow-driven exploration: the drafter ranks the app&apos;s flows, the explorer walks one, for example {ex.name}, step by step with test data, and the walk becomes a draft scenario.
      </p>
      <div aria-hidden className={cn("grid grid-cols-1 items-center gap-3 sm:grid-cols-[minmax(0,1fr)_56px_minmax(0,0.9fr)]", styles.sceneBody, resetting && styles.sceneResetting)}>
        {/* The flow, walked */}
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-panel p-3 shadow-[var(--shadow-sm)]" data-walk-example={ex.name}>
          <span className="text-[10.5px] font-medium uppercase tracking-wide text-muted">For example</span>
          <div className="flex items-center gap-2">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary font-mono text-[10px] font-semibold text-primary-fg">1</span>
            <span className="min-w-0 truncate text-sm font-semibold text-fg">{ex.name}</span>
            <span className="ml-auto shrink-0 rounded-full bg-primary/10 px-1.5 text-[10.5px] font-medium leading-[18px] text-primary dark:text-chart-1">Never walked</span>
          </div>
          <ol className="relative flex flex-col gap-1.5 pl-1">
            <span className="absolute bottom-3 left-[13px] top-3 w-[2px] rounded-full bg-border" />
            <span
              className="absolute left-[13px] top-3 w-[2px] origin-top rounded-full bg-primary transition-transform duration-700 motion-reduce:transition-none"
              style={{ height: "calc(100% - 24px)", transform: `scaleY(${landed <= 1 ? 0 : (landed - 1) / (n - 1)})` }}
            />
            {steps.map((s, i) => {
              const done = i < landed;
              const now = i === landed && beat > 0 && beat <= steps.length;
              return (
                <li key={`${i}-${s}`} className={cn("relative flex items-center gap-2.5", styles.sceneStep, !done && !now && styles.sceneStepDim)}>
                  <span
                    className={cn(
                      "relative z-[1] flex size-[22px] shrink-0 items-center justify-center rounded-full border-2 bg-panel text-[10px] font-semibold",
                      styles.sceneNode,
                      done ? cn("border-success bg-success text-white dark:text-bg", styles.sceneNodeOn) : now ? cn("border-primary text-primary", styles.nodeNow) : "border-border-strong text-muted",
                    )}
                  >
                    {done ? <Check className="size-3" strokeWidth={3} /> : i + 1}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[12.5px] font-medium text-fg">{s}</span>
                    <span className={cn("truncate text-[11px] text-success", styles.sceneFrame, !done && styles.sceneFrameHidden)}>✓ {checks[i]}</span>
                  </span>
                  <span className={cn(styles.sceneFrame, !done && styles.sceneFrameHidden)}>
                    <MiniScreen i={i} />
                  </span>
                </li>
              );
            })}
          </ol>
        </div>

        {/* The arrow: the walk becomes a scenario */}
        <svg viewBox="0 0 56 24" className="mx-auto hidden h-6 w-14 sm:block" fill="none">
          <path d="M2 12 H48" pathLength={1} stroke="var(--color-primary)" strokeWidth={2} strokeLinecap="round" className={cn(styles.sceneArrow, arrow && styles.sceneArrowDrawn)} />
          <path d="M42 6 L50 12 L42 18" pathLength={1} stroke="var(--color-primary)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={cn(styles.sceneArrow, arrow && styles.sceneArrowDrawn)} />
        </svg>

        {/* The draft scenario built from the walk */}
        <div className={cn("flex flex-col gap-2 rounded-xl border border-primary/40 bg-raised p-3 shadow-[var(--shadow-md)]", styles.sceneScenario, !kept && styles.sceneScenarioHidden)}>
          <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
            <ScrollText className="size-3 text-primary dark:text-chart-1" strokeWidth={2.25} />
            Draft scenario
          </span>
          <span className="text-sm font-semibold text-fg">{ex.scenario}</span>
          <span className="flex flex-col gap-0.5 text-[11px] text-fg-2">
            {steps.slice(0, 3).map((s, i) => (
              <span key={`${i}-${s}`} className="truncate">
                {i + 1}. {s}
              </span>
            ))}
            {n > 3 ? <span className="text-muted">and {n - 3} more {n - 3 === 1 ? "step" : "steps"}</span> : null}
          </span>
          <span className="flex items-center gap-1 text-[11px] font-medium text-success">
            <Check className="size-3" strokeWidth={3} />
            {n} checks from the walk
          </span>
        </div>
      </div>

      <ol aria-hidden className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {PHASES.map((p, i) => {
          const on = i === phase;
          return (
            <li
              key={p.title}
              className={cn(
                "flex flex-col gap-0.5 rounded-lg border bg-panel px-3 py-2 transition-[border-color,background-color] duration-300 motion-reduce:transition-none",
                on ? "border-primary/60 bg-primary/[0.06]" : "border-border",
              )}
            >
              <span className="flex items-center gap-1.5 text-sm font-medium text-fg">
                <p.Icon className={cn("size-3.5", on ? "text-primary dark:text-chart-1" : "text-muted")} strokeWidth={2} />
                {p.title}
              </span>
              <span className="text-xs leading-4 text-muted">{p.line}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
