
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { Check } from "../../map/kit/icons";
import { cn } from "../../map/kit";
import { layoutMap, type LayoutArea } from "./map-layout";
import styles from "../../map/coverage.module.css";

const GHOST: LayoutArea[] = [5, 3, 3, 2, 2, 2, 1.5, 1.5, 1, 1, 1, 1].map((importance, i) => ({
  key: `g${i}`,
  name: "",
  paths: [`app/${i < 5 ? "core" : i < 9 ? "account" : "extras"}/f${i}`],
  entry: null,
  source: "code",
  importance,
}));
const TINTS = ["--cov-strong", "--cov-covered", "--cov-thin", "--cov-covered", "--cov-strong", "--cov-failing"];

/** A small territory of placeholder tiles: breathing while coverage is computed, lighting up
 * one by one in the teaching state (what the map will look like). */
function GhostMap({ mode, width = 520, height = 260 }: { mode: "loading" | "teach"; width?: number; height?: number }) {
  const layout = useMemo(() => layoutMap(GHOST, width, height, { gap: 8, header: 0 }), [width, height]);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full max-w-[520px]" aria-hidden>
      {layout.tiles.map((t, i) => (
        <rect
          key={t.key}
          x={t.x}
          y={t.y}
          width={t.w}
          height={t.h}
          rx="8"
          className={cn(styles.ghostTile, mode === "teach" && styles.revealTile)}
          style={{ "--i": i, "--c": `var(${TINTS[i % TINTS.length]})` } as CSSProperties}
        />
      ))}
    </svg>
  );
}

/** What a computation goes through, in order. Coverage is one call, so the steps advance on a
 * timer and the last one stays lit until the answer lands; the counts are the last report's
 * when there is one (Recompute), never invented. */
export function coverageSteps(prev?: { scenarios: number; links: number; areas: number } | null): { key: string; label: string }[] {
  const n = (count: number | undefined, one: string, many: string) => (count ? `${count} ${count === 1 ? one : many}` : many);
  return [
    { key: "scenarios", label: `Reading ${n(prev?.scenarios, "scenario", "scenarios")}` },
    { key: "runs", label: "Reading runs and explorations" },
    { key: "links", label: prev?.links ? `Matching ${n(prev.links, "link", "links")} to feature areas` : "Matching scenarios to feature areas" },
    { key: "areas", label: `Mapping ${n(prev?.areas, "area", "areas")}` },
  ];
}

const STEP_MS = 520;

function useStepIndex(count: number): number {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (i >= count - 1) return;
    const t = setTimeout(() => setI((v) => Math.min(count - 1, v + 1)), STEP_MS);
    return () => clearTimeout(t);
  }, [i, count]);
  return i;
}

/** The steps as a short checklist: done ones ticked, the current one breathing. */
export function CoverageSteps({ steps, compact = false, row = false }: { steps: { key: string; label: string }[]; compact?: boolean; row?: boolean }) {
  const at = useStepIndex(steps.length);
  return (
    <ol className={cn("flex", row ? "flex-row flex-wrap gap-x-5 gap-y-1" : "flex-col", !row && (compact ? "gap-1" : "gap-1.5"))} aria-live="polite" data-coverage-steps>
      {steps.map((s, i) => {
        const state = i < at ? "done" : i === at ? "active" : "pending";
        return (
          <li key={s.key} className={cn(styles.step, "flex items-center gap-2", compact ? "text-xs" : "text-sm")} data-step={s.key} data-step-state={state} style={{ "--i": i } as CSSProperties}>
            <span className={styles.stepMark} aria-hidden>
              {state === "done" ? <Check className="size-3" strokeWidth={2.5} /> : null}
            </span>
            <span className={state === "pending" ? "text-muted" : "text-fg-2"}>{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function CoverageLoading() {
  return (
    <div className={cn(styles.stage, "grid min-h-[380px] items-center gap-8 p-6 md:grid-cols-[1.2fr_1fr] md:p-10")} data-coverage-loading>
      <div className="flex justify-center">
        <GhostMap mode="loading" />
      </div>
      <div className={styles.rise}>
        <p className="mb-3 text-base font-semibold text-fg">Mapping coverage</p>
        <CoverageSteps steps={coverageSteps()} />
      </div>
    </div>
  );
}

/** Recompute, over the map it will replace: the same steps with the last report's numbers. */
export function CoverageRecomputing({ prev }: { prev: { scenarios: number; links: number; areas: number } }) {
  return (
    <div className={cn(styles.recomputing, "pointer-events-none absolute right-3 top-3 z-[4] rounded-xl border border-border bg-panel/95 px-4 py-3 shadow-[var(--shadow-md)]")} data-coverage-recomputing>
      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.08em] text-muted">Recomputing</p>
      <CoverageSteps steps={coverageSteps(prev)} compact />
    </div>
  );
}

/** No feature areas yet: what the map is, and the two ways to fill it. */
export function CoverageNoFeatures({ actions }: { actions: ReactNode }) {
  return (
    <div className={cn(styles.stage, "grid items-center gap-6 p-6 md:grid-cols-[1fr_1.1fr] md:p-10")} data-coverage-empty="no-features">
      <div className={styles.rise}>
        <h2 className="text-xl font-semibold text-fg">Map your app first</h2>
        <p className="mt-2 max-w-md text-base text-fg-2">
          Coverage is counted per feature area, not per line of code. Agents find the areas in your code, or while they explore the app.
        </p>
        <p className="mt-2 max-w-md text-sm text-muted">Then every area lights up as scenarios test it. Untested ones stay in the fog.</p>
        <div className="mt-4 flex flex-wrap gap-2">{actions}</div>
      </div>
      <div className="flex justify-center">
        <GhostMap mode="teach" />
      </div>
    </div>
  );
}

/** Areas but no scenario: the map stays in fog, with the way out on top. */
export function CoverageNoScenarios({ children, action }: { children: ReactNode; action: ReactNode }) {
  return (
    <div className="relative" data-coverage-empty="no-scenarios">
      {children}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
        <div className={cn("pointer-events-auto max-w-sm rounded-xl border border-border bg-panel/90 p-5 text-center shadow-[var(--shadow-md)] backdrop-blur", styles.rise)}>
          <h2 className="text-lg font-semibold text-fg">Every area is still in the fog</h2>
          <p className="mt-1.5 text-sm text-fg-2">No scenario tests this app yet. Draft the first ones and watch the map light up.</p>
          <div className="mt-3 flex justify-center">{action}</div>
        </div>
      </div>
    </div>
  );
}
