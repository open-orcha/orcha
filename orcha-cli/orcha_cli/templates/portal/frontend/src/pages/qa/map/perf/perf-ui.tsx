import { useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { HEAT_LABEL, fmtSeconds, type Baseline, type HeatLevel } from "./perf";
import { cn } from "../kit";
import { ExampleReplay } from "./slowdown-replay";
import motion from "./perf.module.css";

/** The colour of each heat, as text and as a dot. The word is always shown beside the colour. */
export const HEAT_TEXT: Record<HeatLevel, string> = { slow: "text-danger", warm: "text-warning", ok: "text-success" };
export const HEAT_FILL: Record<HeatLevel, string> = { slow: "var(--color-danger)", warm: "var(--color-warning)", ok: "var(--color-success)" };

export function HeatBadge({ heat, className }: { heat: HeatLevel; className?: string }) {
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-px text-xs font-medium", HEAT_TEXT[heat], className)}
      style={{ borderColor: `color-mix(in srgb, ${HEAT_FILL[heat]} 35%, transparent)`, background: `color-mix(in srgb, ${HEAT_FILL[heat]} 9%, transparent)` }}
      data-perf-heat={heat}
    >
      <span aria-hidden className="size-1.5 rounded-full" style={{ background: HEAT_FILL[heat] }} />
      {HEAT_LABEL[heat]}
    </span>
  );
}

/**
 * One screen's trend: a point per run (oldest first) on a scale from zero, the screen's usual
 * band (its median to its p90) behind it, and its budget as a dashed line. The line draws itself
 * in; the newest point takes the heat colour, and on a slow screen it breathes three times. Hover
 * or arrow keys read each run's time.
 */
export function PerfSparkline({
  points,
  usual,
  budget,
  heat,
  label,
  width = 132,
  height = 34,
  delay = 0,
  fmt = fmtSeconds,
}: {
  points: readonly number[];
  usual?: Baseline | null;
  budget: number | null;
  heat: HeatLevel;
  label: string;
  width?: number;
  height?: number;
  delay?: number;
  fmt?: (v: number) => string;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const pad = 4;
  const n = points.length;
  const top = Math.max(...points, usual?.p90 ?? 0, 1) * 1.12;
  const showBudget = budget !== null && budget <= top * 1.35;
  const max = Math.max(top, showBudget && budget ? budget * 1.08 : 0);
  const y = (v: number) => pad + (1 - v / max) * (height - pad * 2);
  const x = (i: number) => (n <= 1 ? width / 2 : pad + (i * (width - pad * 2)) / (n - 1));
  const coords = points.map((v, i) => ({ x: x(i), y: y(v) }));
  const line = coords.map((c, i) => `${i ? "L" : "M"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  const area = n > 1 ? `${line} L${coords[n - 1].x.toFixed(1)},${height} L${coords[0].x.toFixed(1)},${height} Z` : "";
  const last = coords[n - 1];
  const prev = coords[n - 2];
  const tint = HEAT_FILL[heat];
  const d = (ms: number) => ({ "--d": `${delay + ms}ms` }) as CSSProperties;

  function pick(e: PointerEvent<HTMLDivElement>) {
    const box = ref.current?.getBoundingClientRect();
    if (!box || n === 0) return;
    const rel = ((e.clientX - box.left) / box.width) * width;
    setAt(Math.max(0, Math.min(n - 1, Math.round(((rel - pad) / (width - pad * 2)) * (n - 1)))));
  }
  function key(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      setAt((a) => Math.max(0, Math.min(n - 1, (a ?? n - 1) + (e.key === "ArrowLeft" ? -1 : 1))));
    } else if (e.key === "Escape") setAt(null);
  }

  return (
    <div
      ref={ref}
      className="relative shrink-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
      style={{ width, height }}
      tabIndex={n > 1 ? 0 : undefined}
      onPointerMove={pick}
      onPointerLeave={() => setAt(null)}
      onKeyDown={key}
      onBlur={() => setAt(null)}
      data-perf-sparkline
    >
      <svg role="img" aria-label={label} width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
        <defs>
          <linearGradient id={`${id}-a`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={heat === "ok" ? "var(--color-fg-2)" : tint} stopOpacity={heat === "ok" ? 0.12 : 0.2} />
            <stop offset="100%" stopColor={heat === "ok" ? "var(--color-fg-2)" : tint} stopOpacity={0} />
          </linearGradient>
        </defs>
        {usual ? (
          <g className={motion.fadeIn} style={d(0)}>
            <rect x={0} width={width} y={y(usual.p90) - 1} height={Math.max(2, y(usual.median) - y(usual.p90) + 2)} rx={2} fill="var(--color-fg)" opacity={0.07} />
            <line x1={0} x2={width} y1={y(usual.median)} y2={y(usual.median)} stroke="var(--color-fg-2)" strokeOpacity={0.35} strokeWidth={1} />
          </g>
        ) : null}
        {showBudget && budget ? <line x1={0} x2={width} y1={y(budget)} y2={y(budget)} stroke="var(--color-border-strong)" strokeDasharray="3 3" strokeWidth={1} className={motion.fadeIn} style={d(80)} /> : null}
        {area ? <path d={area} fill={`url(#${id}-a)`} className={motion.fadeIn} style={d(500)} /> : null}
        {n > 1 ? <path d={line} pathLength={1} fill="none" stroke="var(--color-fg-2)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" className={motion.draw} style={d(60)} /> : null}
        {/* The step into the newest run, in its heat. */}
        {prev && last && heat !== "ok" ? (
          <path d={`M${prev.x.toFixed(1)},${prev.y.toFixed(1)} L${last.x.toFixed(1)},${last.y.toFixed(1)}`} pathLength={1} fill="none" stroke={tint} strokeWidth={2} strokeLinecap="round" className={motion.draw} style={d(700)} />
        ) : null}
        {last ? (
          <>
            {heat === "slow" ? <circle cx={last.x} cy={last.y} r={3.5} fill={tint} className={motion.halo} style={d(950)} /> : null}
            <circle cx={last.x} cy={last.y} r={3} fill={tint} stroke="var(--color-panel)" strokeWidth={1.5} className={motion.dotPop} style={d(880)} />
          </>
        ) : null}
        {at !== null && coords[at] ? (
          <g>
            <line x1={coords[at].x} x2={coords[at].x} y1={0} y2={height} stroke="var(--color-fg)" strokeOpacity={0.25} />
            <circle cx={coords[at].x} cy={coords[at].y} r={3} fill="var(--color-fg)" />
          </g>
        ) : null}
      </svg>
      {at !== null && coords[at] ? (
        <span
          className="pointer-events-none absolute bottom-full z-10 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-raised px-1.5 py-0.5 text-[11px] text-fg shadow-[var(--shadow-md)]"
          style={{ left: Math.max(24, Math.min(width - 24, coords[at].x)) }}
          data-perf-spark-tip
        >
          <span className="font-semibold tabular">{fmt(points[at])}</span>
          <span className="text-muted"> · {at === n - 1 ? "latest run" : `${n - 1 - at} run${n - 1 - at === 1 ? "" : "s"} before`}</span>
        </span>
      ) : null}
    </div>
  );
}

/**
 * A screen's newest time on the list's shared scale, so ranks read as lengths: the bar grows from
 * zero, over the screen's usual band (median to p90) with its median marked and its budget dashed.
 */
export function RankBar({ value, usual, budget, max, heat, index = 0, className }: { value: number; usual: Baseline | null; budget: number | null; max: number; heat: HeatLevel; index?: number; className?: string }) {
  const pct = (v: number) => `${Math.min(100, (v / max) * 100).toFixed(2)}%`;
  return (
    <div className={cn("relative h-2 w-full", className)} aria-hidden data-perf-rankbar>
      <div className="absolute inset-0 rounded-full bg-[color-mix(in_srgb,var(--color-fg)_6%,transparent)]" />
      {usual ? <div className="absolute -inset-y-1 rounded-sm bg-[color-mix(in_srgb,var(--color-fg)_9%,transparent)]" style={{ left: pct(usual.median * 0.94), width: `calc(${pct(usual.p90)} - ${pct(usual.median * 0.94)})` }} /> : null}
      <div
        className="v-grow-x absolute inset-y-0 left-0 rounded-full"
        style={{ width: pct(value), background: heat === "ok" ? "color-mix(in srgb, var(--color-fg-2) 70%, transparent)" : HEAT_FILL[heat], "--i": index, "--d": "120ms" } as CSSProperties}
      />
      {usual ? <div className="absolute -inset-y-1.5 w-0.5 rounded-full bg-fg" style={{ left: pct(usual.median) }} /> : null}
      {budget !== null && budget <= max ? <div className="absolute -inset-y-1.5 w-0 border-l border-dashed border-fg-2/60" style={{ left: pct(budget) }} /> : null}
    </div>
  );
}

/** A bar of this run's time against the usual one: what "usually 1.2 s" looks like. */
export function VsUsualBar({ value, usual, budget }: { value: number; usual: number | null; budget: number | null }) {
  const top = Math.max(value, usual ?? 0, budget ?? 0, 1);
  const pct = (v: number) => `${Math.min(100, (v / top) * 100).toFixed(1)}%`;
  const slow = usual !== null ? value > usual * 1.5 : budget !== null && value > budget;
  return (
    <div className="relative h-1.5 w-24 rounded-full bg-[var(--color-border)]" aria-hidden data-perf-bar>
      <div className={cn("v-grow-x absolute inset-y-0 left-0 rounded-full", slow ? "bg-danger" : "bg-[var(--color-fg-2)]")} style={{ width: pct(value) }} />
      {usual !== null ? <div className="absolute -inset-y-1 w-px bg-fg" style={{ left: pct(usual) }} title="usual" /> : null}
      {budget !== null ? <div className="absolute -inset-y-1 w-px border-l border-dashed border-[var(--color-border-strong)]" style={{ left: pct(budget) }} /> : null}
    </div>
  );
}

/** A stopwatch glyph; its hand goes round while `running` (a run timing screens now). */
export function StopwatchGlyph({ running, className }: { running?: boolean; className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className={cn("size-4 shrink-0", className)} data-perf-stopwatch={running ? "running" : "still"}>
      <rect x="8.5" y="0.6" width="3" height="2" rx="0.6" fill="currentColor" />
      <line x1="15.2" y1="4.6" x2="16.6" y2="3.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="10" cy="11" r="7.3" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <g className={running ? motion.hand : undefined} style={{ transformOrigin: "10px 11px" }}>
        <line x1="10" y1="11" x2="10" y2="6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </g>
      <circle cx="10" cy="11" r="1.2" fill="currentColor" />
    </svg>
  );
}

/**
 * Teaching empty state: the feature working, as the replay it gives a slow screen. An example
 * Order history usually appears after 1.2 s; today it takes 3.4 s, and both play side by side on
 * one clock. It loops while on screen and stands on the finished frame under reduced motion.
 * Then what the page will show, and its action.
 */
export function PerfTeachingEmpty({ title, body, action, compact }: { title: string; body: string; action?: React.ReactNode; compact?: boolean }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-6 px-4 text-center sm:px-6", compact ? "min-h-[260px] py-8" : "min-h-[420px] py-10")} data-perf-empty>
      <div className="v-pop w-full max-w-[400px]">
        <ExampleReplay />
      </div>
      <div className="flex max-w-[520px] flex-col gap-1.5">
        <h2 className="v-rise text-[15px] font-semibold text-fg" style={{ "--d": "220ms" } as CSSProperties}>
          {title}
        </h2>
        <p className="v-rise text-base text-fg-2" style={{ "--d": "280ms" } as CSSProperties}>
          {body}
        </p>
      </div>
      {action ? (
        <div className="v-rise" style={{ "--d": "360ms" } as CSSProperties}>
          {action}
        </div>
      ) : null}
    </div>
  );
}
