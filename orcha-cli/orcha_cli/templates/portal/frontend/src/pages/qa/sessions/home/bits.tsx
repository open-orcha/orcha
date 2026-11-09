import type { ExplorationStatus } from "../explorations";
import { PHASE_LABEL, phasesFor } from "../work/words";
import { cn } from "../../map/kit";
import styles from "../motion.module.css";

/** The phases of an exploration, as every job page names them: Read, Explore, Review. */
export const PHASES = phasesFor("exploration").map((p) => PHASE_LABEL[p]);

/** Which phase a status is in: -1 waiting in the queue, 0..2 a phase, 3 finished. Checking is
 * still exploring (the explorer re-checks what it found). */
export function phaseIndex(status: ExplorationStatus): number {
  switch (status) {
    case "queued":
      return -1;
    case "studying":
      return 0;
    case "exploring":
    case "checking":
      return 1;
    default:
      return 3;
  }
}

/** The phases as segments, the compact form of the job page's phase bar: done ones filled, the
 * current one breathing. */
export function PhaseBar({ status, className }: { status: ExplorationStatus; className?: string }) {
  const at = phaseIndex(status);
  const n = PHASES.length;
  const label = at < 0 ? "Waiting for an agent" : at >= n ? "Finished" : `${PHASES[at]} (phase ${at + 1} of ${n})`;
  return (
    <div className={cn("flex flex-col gap-1", className)} role="img" aria-label={label} data-phase-bar={at}>
      <div className="flex gap-1" aria-hidden>
        {PHASES.map((p, i) => (
          <span
            key={p}
            className={cn(
              "h-1 flex-1 rounded-full",
              i < at ? "bg-primary" : i === at ? cn("bg-primary", styles.segLive) : "bg-border",
            )}
          />
        ))}
      </div>
      <div className="flex justify-between text-[10.5px] text-muted" aria-hidden>
        {PHASES.map((p, i) => (
          <span key={p} className={cn(i === at && "font-medium text-fg")}>
            {p}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A series' scores as a small line, newest at the right. Needs at least two points. */
export function Sparkline({ values, width = 72, height = 22, className }: { values: readonly number[]; width?: number; height?: number; className?: string }) {
  if (values.length < 2) return null;
  const pad = 2;
  const step = (width - pad * 2) / (values.length - 1);
  const y = (v: number) => pad + (1 - Math.max(0, Math.min(100, v)) / 100) * (height - pad * 2);
  const points = values.map((v, i) => `${(pad + i * step).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = values[values.length - 1];
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Score trend in this series: ${values.map((v) => Math.round(v)).join(", ")}`}
      className={cn("shrink-0 overflow-visible", className)}
      data-sparkline={values.length}
    >
      <polyline points={points} fill="none" stroke="var(--color-chart-1)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={pad + (values.length - 1) * step} cy={y(last)} r={2.2} fill="var(--color-chart-1)" />
    </svg>
  );
}
