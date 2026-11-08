import type { CSSProperties, ReactNode } from "react";
import { Camera, History } from "../../../map/kit/icons";
import { cn } from "../../../map/kit";
import { CoverageSteps } from "../coverage-states";
import styles from "./growth.module.css";

/**
 * Taking a baseline, as a moment (#413 modernize). Three beats, each tied to the real request:
 *
 * - `measuring`: the POST is running. Viewfinder corners hunt for focus over the subject (the
 *   coverage being frozen) and the steps say what Python is doing.
 * - `shoot`: the baseline is stored. The iris closes, the flash fires, the iris opens.
 * - `print`: the frozen figure, from the stored baseline itself, drops in like a print.
 *
 * Reduced motion: no iris, no flash; the steps and the print simply appear.
 */
export type ShutterPhase = "measuring" | "shoot" | "print";

export interface Snapshot {
  pct: number | null;
  screens: number;
  covered: number;
  day: string;
  /** A re-baseline: the baseline it replaced, kept in the history. */
  replaced: string | null;
}

const BLADES = 6;

/** Six blades around the centre; `teach` loops them for the empty state. */
export function Iris({ teach = false }: { teach?: boolean }) {
  return (
    <svg viewBox="-50 -50 100 100" preserveAspectRatio="xMidYMid slice" className={styles.blades} aria-hidden>
      <g className={teach ? undefined : styles.bladeTwist}>
        {Array.from({ length: BLADES }, (_, i) => (
          <g key={i} transform={`rotate(${i * (360 / BLADES)})`}>
            <polygon className={teach ? cn(styles.blade, styles.teachBlade) : styles.blade} points="0,6 -66,-96 66,-96" />
          </g>
        ))}
      </g>
    </svg>
  );
}

export function BaselineShutter({ phase, again, steps, snapshot, children }: {
  phase: ShutterPhase;
  again: boolean;
  steps: { key: string; label: string }[];
  snapshot: Snapshot | null;
  /** What is being frozen: the coverage as it stands. */
  children: ReactNode;
}) {
  const title = again ? "Re-baselining" : "Taking the baseline";
  return (
    <section
      className={cn(styles.hero, "grid min-h-[300px] items-stretch gap-6 p-6 md:grid-cols-[1.25fr_1fr] md:p-8")}
      aria-busy={phase === "measuring"}
      aria-labelledby="growth-shutter-title"
      data-growth-shutter={phase}
    >
      <div className={cn("relative min-h-[220px] overflow-hidden rounded-xl", phase !== "measuring" && styles.shoot)}>
        <div className={cn("absolute inset-0 transition-[filter,opacity] duration-300", phase === "print" && cn(styles.frozen, "opacity-60"))}>{children}</div>
        <div className={cn(styles.viewfinder, phase === "measuring" && styles.focusing)} aria-hidden>
          <i />
          <i />
          <i />
          <i />
        </div>
        {phase !== "measuring" ? <Iris /> : null}
        <div className={styles.flash} aria-hidden />
        {phase === "print" && snapshot ? (
          <div className="absolute inset-0 grid place-items-center p-4">
            <figure className={cn(styles.print, "w-[min(300px,90%)]")} data-growth-print>
              <div className={cn(styles.develop, "rounded-md bg-panel-2 px-4 py-5 text-center")}>
                <p className="text-2xs font-semibold uppercase tracking-[0.14em] text-muted">{again ? "New baseline" : "Baseline"}</p>
                <p className={cn(styles.bigNum, "mt-1 text-fg")}>{snapshot.pct === null ? "?" : `${snapshot.pct}%`}</p>
                <p className="mt-1 text-sm text-fg-2">
                  {snapshot.covered} of {snapshot.screens} {snapshot.screens === 1 ? "screen" : "screens"} covered
                </p>
              </div>
              <figcaption className="mt-2.5 flex items-center justify-between gap-2 px-1">
                <span className="text-sm font-medium text-fg">{snapshot.day}</span>
                <span className={cn(styles.stamp, "rounded border border-[var(--g-orcha)] px-1.5 text-2xs font-semibold uppercase tracking-[0.1em] text-[var(--g-orcha)]")}>Frozen</span>
              </figcaption>
            </figure>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col justify-center" aria-live="polite">
        <p className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.08em] text-muted">
          <Camera className="size-3.5" aria-hidden /> {title}
        </p>
        <h2 id="growth-shutter-title" className="mt-1.5 text-xl font-semibold tracking-[-0.01em] text-fg">
          {phase === "print" ? "Coverage is frozen as the reference" : "Freezing coverage as it is right now"}
        </h2>
        {phase === "print" && snapshot ? (
          <div className={cn(styles.landed, "mt-3 flex flex-col gap-1.5 text-sm text-fg-2")}>
            <p>
              From today, every point above <span className="font-semibold tabular-nums text-fg">{snapshot.pct === null ? "this figure" : `${snapshot.pct}%`}</span> is growth, per area and overall.
            </p>
            {snapshot.replaced ? (
              <p className="flex items-center gap-1.5 text-muted">
                <History className="size-3.5" aria-hidden /> The {snapshot.replaced} baseline is kept in the history.
              </p>
            ) : null}
          </div>
        ) : (
          <div className="mt-3" style={{ "--i": 0 } as CSSProperties}>
            <CoverageSteps steps={steps} />
          </div>
        )}
      </div>
    </section>
  );
}

/** The subject being frozen: the app's biggest areas as they stand, your tests then Orcha. */
export function SubjectBars({ areas }: { areas: { key: string; name: string; screens: number; covered: number; by_your_tests: number; pct: number | null }[] }) {
  const rows = [...areas].filter((a) => a.screens > 0).sort((a, b) => b.screens - a.screens || a.name.localeCompare(b.name)).slice(0, 9);
  const W = 360;
  const floor = 150;
  const bw = Math.min(26, (W - 40) / Math.max(1, rows.length) - 10);
  // Labels fit their slot (about 5px a character at this size).
  const chars = Math.max(3, Math.floor((W - 44) / Math.max(1, rows.length) / 5.4));
  return (
    <svg viewBox={`0 0 ${W} 190`} preserveAspectRatio="xMidYMid meet" className="h-full w-full" aria-hidden data-growth-subject>
      <line x1="10" x2={W - 10} y1={floor + 0.5} y2={floor + 0.5} className={styles.grid} />
      {rows.map((a, i) => {
        const x = 22 + i * ((W - 44) / Math.max(1, rows.length)) + 4;
        const h = ((a.pct ?? 0) / 100) * 120;
        const yours = a.covered > 0 ? (Math.min(a.by_your_tests, a.covered) / a.covered) * h : 0;
        return (
          <g key={a.key}>
            <rect x={x} y={floor - 120} width={bw} height="120" rx="3" style={{ fill: "var(--g-track)" }} />
            {h > 0 ? (
              <>
                <rect x={x} y={floor - h} width={bw} height={h - yours} rx="3" style={{ fill: "var(--g-orcha)" }} />
                {yours > 0 ? <rect x={x} y={floor - yours} width={bw} height={yours} rx="3" style={{ fill: "var(--g-yours)" }} /> : null}
              </>
            ) : null}
            <text x={x + bw / 2} y={floor + 16} textAnchor="middle" className="fill-[var(--color-muted)] text-[9px]">
              {a.name.length > chars ? `${a.name.slice(0, Math.max(1, chars - 1))}…` : a.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
