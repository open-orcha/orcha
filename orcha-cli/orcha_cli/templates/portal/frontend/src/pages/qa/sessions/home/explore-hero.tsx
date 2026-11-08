import type { CSSProperties, ReactNode } from "react";
import { ArrowRight, Bug, Compass, Plus, Timer } from "../../map/kit/icons";
import { Tooltip } from "../../../../components/primitives";
import { Button } from "../../map/kit";
import { severityDot } from "../../map/kit";
import { CountUp } from "../../map/kit";
import type { ExplorationScope } from "../explorations";
import type { Exploration } from "../explorations";
import { cn } from "../../map/kit";
import { RECIPE_ICON } from "../recipe-meta";
import motion from "../motion.module.css";
import { FeatureStat } from "./feature-stat";
import { formatSeconds, measuredWords, SEVERITY_ORDER, type ExploreStats } from "./home-model";
import styles from "./explore.module.css";

export interface QuickStart {
  recipe: ExplorationScope;
  title: string;
  promise: string;
  onStart: () => void;
}

const TICK: Record<Exploration["status"], string> = {
  done: "bg-success",
  failed: "bg-danger",
  cancelled: "bg-neutral",
  queued: "bg-progress",
  studying: "bg-progress",
  exploring: "bg-progress",
  checking: "bg-progress",
};
const TICK_MAX = 28;

/** A topographic outline: the header's backdrop, drawn once and faded at its edges. */
function Contours() {
  const rings = [
    "M330 40c90-28 210 4 252 74s8 170-88 196-238-10-288-84 34-158 124-186z",
    "M346 70c70-22 168 6 200 62s4 132-72 152-186-8-224-66 26-126 96-148z",
    "M362 100c52-16 124 6 148 48s2 98-54 112-138-6-166-48 20-96 72-112z",
    "M380 130c34-10 82 4 98 32s0 64-36 74-90-4-108-32 12-64 46-74z",
    "M398 158c18-6 42 2 50 16s0 32-18 36-46-2-56-16 6-32 24-36z",
  ];
  return (
    <svg aria-hidden viewBox="0 0 640 360" preserveAspectRatio="xMidYMid slice" className={styles.contour}>
      {rings.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="currentColor" strokeWidth={1.2} />
      ))}
      <path d="M120 300c80-40 150-30 230-60s140-90 250-80" fill="none" stroke="currentColor" strokeWidth={1} strokeDasharray="3 5" />
    </svg>
  );
}

function Stat({ icon, value, label, children, index }: { icon: ReactNode; value: string; label: string; children?: ReactNode; index: number }) {
  return (
    <div className="v-rise flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-panel/80 px-3.5 py-3 backdrop-blur-[2px]" style={{ "--i": index + 2 } as CSSProperties}>
      <span className="flex items-center gap-1.5 text-xs text-muted">
        {icon}
        {label}
      </span>
      <CountUp value={value} delay={140 + index * 90} className="text-2xl font-semibold tabular tracking-tight text-fg" />
      <div className="min-h-4 text-xs text-muted">{children}</div>
    </div>
  );
}

/* The recipe previews of the composer's picker, in small: they play on hover and focus, and
   rest on a frame that already says what the recipe does. */
function MapMini() {
  const screens: [number, number, number][] = [
    [14, 24, 0],
    [48, 10, 1],
    [48, 38, 1],
    [82, 4, 2],
    [82, 24, 2],
    [82, 44, 2],
  ];
  const links: [number, number][] = [
    [0, 1],
    [0, 2],
    [1, 3],
    [1, 4],
    [2, 5],
  ];
  return (
    <svg viewBox="0 0 106 56" className="absolute inset-0 size-full" aria-hidden>
      {links.map(([a, b]) => (
        <line key={`${a}-${b}`} x1={screens[a][0] + 6} y1={screens[a][1] + 4} x2={screens[b][0] + 6} y2={screens[b][1] + 4} stroke="var(--color-border-strong)" strokeWidth={1} />
      ))}
      {screens.map(([x, y, depth], i) => (
        <g key={i}>
          <rect x={x} y={y} width={12} height={9} rx={2} fill="var(--color-panel)" stroke="var(--color-primary)" />
          <rect
            x={x - 1}
            y={y - 1}
            width={14}
            height={11}
            rx={2.5}
            fill="var(--color-panel-2)"
            stroke="var(--color-border-strong)"
            strokeDasharray="2 1.5"
            className={motion.fogLift}
            // Resting on a frame where the crawl has reached every screen; hover plays it on.
            style={{ "--d": `${depth * 420 - 1800}ms` } as CSSProperties}
          />
        </g>
      ))}
    </svg>
  );
}

function DeepDiveMini() {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className={cn("flex gap-1.5", motion.zoom)}>
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={cn("h-6 w-6 rounded-[4px] border", i === 2 ? "border-primary bg-primary/15" : "border-border-strong bg-panel")} />
        ))}
      </div>
    </div>
  );
}

function JourneysMini() {
  return (
    <svg viewBox="0 0 120 56" className="absolute inset-0 size-full" aria-hidden>
      <path
        d="M18 38 C 40 6, 58 6, 60 28 S 86 52, 102 18"
        fill="none"
        stroke="var(--color-primary)"
        strokeWidth={2}
        strokeLinecap="round"
        className={motion.path}
        style={{ animationDelay: "-2200ms" }}
      />
      {[
        [18, 38],
        [60, 28],
        [102, 18],
      ].map(([x, y]) => (
        <rect key={x} x={x - 6} y={y - 8} width={12} height={16} rx={2.5} fill="var(--color-panel)" stroke="var(--color-border-strong)" />
      ))}
    </svg>
  );
}

const MINI: Partial<Record<ExplorationScope, () => ReactNode>> = { map: MapMini, explore: JourneysMini, draft: DeepDiveMini };

function QuickStartCard({ start, index, can, reason }: { start: QuickStart; index: number; can: boolean; reason: string | null }) {
  const Icon = RECIPE_ICON[start.recipe];
  const Mini = MINI[start.recipe];
  const card = (
    <button
      type="button"
      disabled={!can}
      onClick={start.onStart}
      className={cn(
        "v-rise group relative flex w-full min-w-0 items-start gap-3 rounded-lg border border-border bg-panel/85 p-3 text-left outline-none backdrop-blur-[2px] transition-[transform,border-color,background-color] duration-200 hover:-translate-y-px hover:border-border-strong hover:bg-panel focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60 motion-reduce:transition-none motion-reduce:hover:translate-y-0",
        motion.recipe,
      )}
      style={{ "--i": index + 6 } as CSSProperties}
      data-quick-start={start.recipe}
    >
      <span className={cn(motion.preview, "w-[88px] shrink-0 border border-border max-xl:hidden")} aria-hidden>
        {Mini ? <Mini /> : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <Icon aria-hidden className="size-3.5 shrink-0 text-muted" strokeWidth={2} />
          <span className="min-w-0 truncate text-base font-semibold text-fg" title={start.title}>
            {start.title}
          </span>
        </span>
        <span className="line-clamp-2 text-xs leading-4 text-fg-2">{start.promise}</span>
      </span>
      <ArrowRight
        aria-hidden
        className="absolute bottom-3 right-3 size-3.5 -translate-x-1 text-muted opacity-0 transition-[opacity,transform] duration-200 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100 motion-reduce:transition-none"
      />
    </button>
  );
  return can ? card : <Tooltip label={reason || "Only a person can start QA work"} placement="bottom">{card}</Tooltip>;
}

/**
 * The Explore tab's header: what exploring has found so far for this project (explorations
 * run, issues found, features explored, time spent, counting up as the page opens), the big
 * New exploration, and quick starts that open the Run check dialog preset.
 * A running exploration shows live beneath. A project never explored gets the teaching scene
 * in place of the figures.
 */
export function ExploreHero({
  features,
  onNew,
  can,
  reason,
  stats,
  empty,
  starts,
  live,
  scene,
}: {
  /** The feature map (null while it loads). */
  features: readonly { last_explored_at: string | null }[] | null;
  onNew: () => void;
  /** Who may start QA work, and why not. */
  can: boolean;
  reason: string | null;
  stats: ExploreStats;
  empty: boolean;
  starts: readonly QuickStart[];
  /** The live view of the newest running exploration, when one runs. */
  live?: ReactNode;
  /** The teaching scene, shown when nothing was explored yet. */
  scene?: ReactNode;
}) {
  const severities = SEVERITY_ORDER.filter((s) => stats.bySeverity[s]);
  const ticker = stats.ticker.slice(0, TICK_MAX);
  const counts = {
    done: stats.ticker.filter((s) => s === "done").length,
    stopped: stats.ticker.filter((s) => s === "cancelled").length,
    failed: stats.ticker.filter((s) => s === "failed").length,
  };

  return (
    <div className="relative isolate flex flex-col gap-5 overflow-hidden rounded-xl border border-border bg-panel p-5 sm:p-6" data-exploration-hero>
      <Contours />

      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <span aria-hidden className="v-float flex size-11 shrink-0 items-center justify-center rounded-xl border border-border bg-panel-2 text-fg-2 shadow-[var(--shadow-sm)]">
          <Compass className="size-5" strokeWidth={1.75} />
        </span>
        <div className="v-rise min-w-[240px] flex-1">
          <h2 className="text-xl font-semibold tracking-tight text-fg">Explorations</h2>
          <p className="max-w-[640px] text-base text-fg-2">
            Embodent explores your app the way a new user would, clears the map one feature at a time and hands back a report you can keep.
          </p>
        </div>
        {(() => {
          const btn = (
            <Button variant="primary" size="lg" disabled={!can} onClick={onNew} className="v-rise max-sm:w-full" style={{ "--i": 1 } as CSSProperties} data-new-exploration>
              <Plus /> New exploration
            </Button>
          );
          return can ? btn : <Tooltip label={reason || "Only a person can start QA work"} placement="bottom">{btn}</Tooltip>;
        })()}
      </div>

      {empty ? (
        <div className="flex flex-col gap-3 border-t border-border pt-4" data-exploration-empty>
          <p className="text-sm text-fg-2">Not explored yet. Here is what the first exploration does: pick a start below, or start your own.</p>
          {scene}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" data-explore-stats>
          <Stat icon={<Compass aria-hidden className="size-3.5" strokeWidth={2} />} value={String(stats.explorations)} label={stats.explorations === 1 ? "Exploration" : "Explorations"} index={0}>
            <span className="flex items-center gap-[3px]" role="img" aria-label={`${counts.done} done, ${counts.stopped} stopped, ${counts.failed} failed${stats.live ? `, ${stats.live} running` : ""}`}>
              {ticker.map((s, i) => (
                <span key={i} className={cn("size-1.5 rounded-full", TICK[s], styles.tick)} style={{ "--i": i } as CSSProperties} />
              ))}
              {stats.ticker.length > TICK_MAX ? <span className="ml-0.5">+{stats.ticker.length - TICK_MAX}</span> : null}
            </span>
          </Stat>
          <Stat icon={<Bug aria-hidden className="size-3.5" strokeWidth={2} />} value={String(stats.issues)} label="Issues found" index={1}>
            {severities.length > 0 ? (
              <span className="flex flex-wrap items-center gap-x-2">
                {severities.map((s) => (
                  <span key={s} className="inline-flex items-center gap-1">
                    <span aria-hidden className={cn("size-1.5 rounded-full", severityDot[s])} />
                    {stats.bySeverity[s]} {s}
                  </span>
                ))}
              </span>
            ) : stats.explorations > 0 ? (
              "No bugs found"
            ) : (
              "None in a report yet"
            )}
            {stats.measured > 0 ? (
              <span className="mt-0.5 block" title="Automatic checks such as contrast and tap size, not bugs an agent reported" data-measured-count={stats.measured}>
                {measuredWords(stats.measured)}
              </span>
            ) : null}
          </Stat>
          <FeatureStat features={features} index={2} />
          <Stat icon={<Timer aria-hidden className="size-3.5" strokeWidth={2} />} value={stats.timed > 0 ? formatSeconds(stats.seconds) : "0 min"} label="Time exploring" index={3}>
            {stats.timed > 0 ? `across ${stats.timed} ${stats.timed === 1 ? "run" : "runs"}` : stats.live > 0 ? "The first one is running" : "Nothing has run yet"}
          </Stat>
        </div>
      )}

      {live}

      <div className="flex flex-col gap-2">
        <h3 className="text-xs font-medium text-muted">Start a run</h3>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-3" data-quick-starts>
          {starts.map((s, i) => (
            <QuickStartCard key={s.recipe} start={s} index={i} can={can} reason={reason} />
          ))}
        </div>
      </div>
    </div>
  );
}
