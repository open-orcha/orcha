import type { CSSProperties, ReactNode } from "react";
import { cn } from "../../../map/kit";
import { CoverageSteps } from "../coverage-states";
import coverageStyles from "../../../map/coverage.module.css";
import { Iris } from "./baseline-shutter";
import { growthSteps } from "./growth-model";
import styles from "./growth.module.css";
import { useOnScreen } from "./motion";

const BARS = [
  { h: 46, g: 40 },
  { h: 70, g: 26 },
  { h: 24, g: 52 },
  { h: 58, g: 30 },
  { h: 16, g: 44 },
  { h: 38, g: 34 },
];

/**
 * The teaching scene: coverage as it is today (blue bars), the shutter freezes it (the ticks),
 * and what Orcha adds rises above the ticks (green). One calm 7.2 s loop, paused offscreen;
 * reduced motion shows the finished frame: ticks with growth above them.
 */
function BaselineScene() {
  const [ref, on] = useOnScreen<HTMLDivElement>();
  const floor = 150;
  return (
    <div ref={ref} className={cn("relative w-full max-w-[400px]", !on && styles.paused)} aria-hidden>
      <div className="relative overflow-hidden rounded-xl border border-border bg-panel/70 p-4">
        <svg viewBox="0 0 300 168" className="block h-auto w-full">
          <line x1="8" x2="292" y1={floor + 0.5} y2={floor + 0.5} className={styles.grid} />
          {BARS.map((b, i) => {
            const x = 22 + i * 46;
            return (
              <g key={i} style={{ "--i": i } as CSSProperties}>
                <rect x={x} y={floor - b.h} width="22" height={b.h} rx="3" className={styles.teachBar} style={{ fill: "var(--g-yours)", opacity: 0.75 }} />
                <rect x={x} y={floor - b.h - b.g} width="22" height={b.g} rx="3" className={styles.teachGrow} style={{ fill: "var(--g-orcha)" }} />
                <rect x={x - 5} y={floor - b.h - 1.5} width="32" height="3" rx="1.5" className={styles.teachTick} style={{ fill: "var(--g-before)" }} />
              </g>
            );
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0">
          <Iris teach />
        </div>
        <div className={cn(styles.flash, styles.teachFlash)} />
        <div className={styles.viewfinder}>
          <i />
          <i />
          <i />
          <i />
        </div>
      </div>
      <div className="relative mt-3 h-5 text-center text-sm text-fg-2">
        <span className={cn(styles.teachCaption, "absolute inset-0")} data-at="0">
          Coverage as it is today
        </span>
        <span className={cn(styles.teachCaption, "absolute inset-0")} data-at="1">
          Frozen as the baseline
        </span>
        <span className={cn(styles.teachCaption, "absolute inset-0")} data-at="2">
          What Embodent adds rises above the line
        </span>
      </div>
    </div>
  );
}

/** The live view while coverage is measured: the page's own shape, breathing, with the steps on top. */
export function GrowthLoading({ prev }: { prev?: { screens: number; flows: number } | null }) {
  return (
    <div className="flex flex-col gap-4" data-growth-loading aria-busy="true">
      <div className={cn(styles.hero, "grid min-h-[220px] items-center gap-8 p-6 md:grid-cols-[1.2fr_1fr] md:p-8")}>
        <div className="flex flex-col gap-4">
          <span className="v-skeleton h-3 w-40" />
          <span className="v-skeleton h-12 w-64" />
          <span className="v-skeleton h-3 w-full max-w-md rounded-full" />
        </div>
        <div>
          <p className="mb-3 text-base font-semibold text-fg">Measuring coverage growth</p>
          <CoverageSteps steps={growthSteps(prev)} />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" aria-hidden>
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-3 rounded-xl border border-border bg-panel p-4">
            <span className="v-skeleton size-10 rounded-full" style={{ "--d": `${i * 120}ms` } as CSSProperties} />
            <span className="flex flex-1 flex-col gap-2">
              <span className="v-skeleton h-5 w-16" style={{ "--d": `${i * 120}ms` } as CSSProperties} />
              <span className="v-skeleton h-3 w-32" style={{ "--d": `${i * 120}ms` } as CSSProperties} />
            </span>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-panel p-4" aria-hidden>
        {[62, 48, 75, 30, 55].map((w, i) => (
          <div key={i} className="grid grid-cols-[10rem_1fr_5rem] items-center gap-3">
            <span className="v-skeleton h-3 w-28" />
            <span className={cn(styles.track, styles.ghostLoading)} style={{ "--i": i } as CSSProperties}>
              <span className="absolute inset-y-0 left-0 rounded-[4px] bg-[var(--g-track)]" style={{ width: `${w}%` }} />
            </span>
            <span className="v-skeleton h-3 w-14 justify-self-end" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Teaching empty states: no map yet, or a map but no baseline to measure growth from. */
export function GrowthTeach({ kind, actions, now, freshDays = 30 }: { kind: "no_map" | "no_baseline"; actions: ReactNode; now?: ReactNode; freshDays?: number }) {
  return (
    <div className={cn(coverageStyles.stage, "grid items-center gap-8 p-6 md:grid-cols-[1.1fr_1fr] md:p-10")} data-growth-empty={kind}>
      <div className={coverageStyles.rise}>
        {kind === "no_map" ? (
          <>
            <h2 className="text-xl font-semibold text-fg">See what Embodent adds to your coverage</h2>
            <p className="mt-2 max-w-lg text-base text-fg-2">
              Growth starts from a baseline: the screens of your app and which of them your own tests already cover. Map the app first, from its code and your tests, and Embodent keeps that as the baseline.
            </p>
            <p className="mt-2 max-w-lg text-sm text-muted">From then on every area shows where it started, where it is now, and what Embodent added: scenarios, data variations and newly reached screens.</p>
          </>
        ) : (
          <>
            <h2 className="text-xl font-semibold text-fg">No baseline yet</h2>
            <p className="mt-2 max-w-lg text-base text-fg-2">
              A baseline is coverage as it is today, frozen: which screens your tests cover, which flows and how much data they try. Embodent takes one by itself when onboarding brings your tests in, or at the first map of the app. Take one now to start counting.
            </p>
            <p className="mt-2 max-w-lg text-sm text-muted">Only validated scenarios that passed in the last {freshDays} days will count as covered. A failing or stale one shows as at risk, never as covered.</p>
          </>
        )}
        {now ? <div className="mt-4">{now}</div> : null}
        <div className="mt-5 flex flex-wrap gap-2">{actions}</div>
      </div>
      <div className="flex justify-center">
        <BaselineScene />
      </div>
    </div>
  );
}
