import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronRight, Play } from "../../map/kit/icons";
import { fmtSeconds, type Baseline, type PerfCall } from "../../map/perf/perf";
import { cn } from "../../map/kit";
import { HEAT_FILL } from "../../map/perf/perf-ui";
import { usePlayClock } from "../../map/perf/perf-motion";
import { SlowdownReplay, stopwatch, type ReplaySpec } from "../../map/perf/slowdown-replay";
import motion from "../../map/perf/perf.module.css";

/**
 * The run tab's waterfall (#414): each screen from the action (0) to the screen appearing, then
 * settling while its data arrives, with the calls it waited on placed where they were sent, its
 * usual time and its budget. Every row starts from the same tap on one shared scale, so the
 * screens race and the slow one is the one still running. It plays like a stopwatch: a playhead
 * sweeps the scale and each bar grows as it passes (the clock reads the scale's time). A live
 * row plays at real speed as it arrives. Reduced motion: the finished frame.
 */

export type WfHeat = "slow" | "warm" | "ok" | "live";

export interface WfMark {
  label: string;
  at: number;
}

export interface WfRow {
  id: string;
  title: string;
  /** Under the title: "usual 1.1 s · +118%", "tap · #12". */
  sub?: ReactNode;
  heat: WfHeat;
  /** The headline time at the row's end (ms), and how it reads ("2.4 s"). */
  value: number | null;
  appear: number | null;
  settle: number | null;
  marks: WfMark[];
  calls: PerfCall[];
  usual: Baseline | null;
  budget: number | null;
  replay?: ReplaySpec | null;
  /** More about the row, shown when it is opened. */
  detail?: ReactNode;
  /** A live row that just arrived: it plays at real speed. */
  fresh?: boolean;
}

const TONE: Record<WfHeat, string> = {
  slow: HEAT_FILL.slow,
  warm: HEAT_FILL.warm,
  ok: "color-mix(in srgb, var(--color-fg-2) 75%, transparent)",
  live: "var(--color-primary)",
};

/** A round scale just over `v`: 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10 s… */
export function wfScale(v: number): number {
  const steps = [1000, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 8000, 10000, 15000, 20000, 30000];
  return steps.find((s) => s >= v) ?? Math.ceil(v / 10000) * 10000;
}

export function rowEnd(r: WfRow): number {
  return Math.max(r.appear ?? 0, r.settle ?? 0, r.value ?? 0, ...r.marks.map((m) => m.at), ...r.calls.map((c) => (c.start_ms ?? 0) + c.ms));
}

/** How long the stopwatch play of a scale takes: about two thirds of real time, 1.2 to 2.6 s. */
export function playMs(max: number): number {
  return Math.round(Math.min(2600, Math.max(1200, max * 0.66)));
}

export function Waterfall({
  rows,
  max,
  playKey,
  realTime,
  label,
}: {
  rows: readonly WfRow[];
  max: number;
  /** A new value plays the whole waterfall again. */
  playKey: number;
  /** Live: only fresh rows play, each at real speed. */
  realTime?: boolean;
  label: string;
}) {
  const play = playMs(max);
  const k = realTime ? 1 : play / max;
  const step = max > 6000 ? 2000 : max > 3000 ? 1000 : 500;
  const ticks: number[] = [];
  for (let t = 0; t <= max; t += step) ticks.push(t);
  const pct = (v: number) => `${Math.min(100, Math.max(0, (v / max) * 100)).toFixed(2)}%`;
  return (
    <div className="@container" role="list" aria-label={label} data-perf-waterfall>
      <div className="grid grid-cols-1 gap-x-3 @lg:grid-cols-[minmax(10rem,14rem)_minmax(0,1fr)]">
        <span className="hidden @lg:block" />
        <div className="relative mb-1 h-4 text-[10px] text-muted" aria-hidden>
          {ticks.map((t) => (
            <span key={t} className={cn("absolute whitespace-nowrap tabular", t === 0 ? "" : t >= max ? "-translate-x-full" : "-translate-x-1/2")} style={{ left: pct(t) }}>
              {t === 0 ? "action" : `${t / 1000} s`}
            </span>
          ))}
        </div>
      </div>
      <div className="relative" key={playKey}>
        {/* Gridlines and the playhead over the timeline column. */}
        <div className="pointer-events-none absolute inset-0 grid grid-cols-1 gap-x-3 @lg:grid-cols-[minmax(10rem,14rem)_minmax(0,1fr)]" aria-hidden>
          <span className="hidden @lg:block" />
          <div className="relative overflow-hidden">
            {ticks.map((t) => (
              <span key={t} className="absolute inset-y-0 w-px bg-[color-mix(in_srgb,var(--color-fg)_6%,transparent)]" style={{ left: pct(t) }} />
            ))}
            {!realTime ? (
              <div className={cn("absolute inset-y-0 left-0 w-full", motion.wfHead)} style={{ "--total": `${play}ms` } as CSSProperties}>
                <span className="absolute inset-y-0 right-0 w-px bg-primary shadow-[0_0_10px_var(--color-primary)]" />
              </div>
            ) : null}
          </div>
        </div>
        <div className="relative flex flex-col">
          {rows.map((r) => (
            <Row key={r.id} r={r} max={max} k={realTime && !r.fresh ? 0 : k} />
          ))}
        </div>
      </div>
    </div>
  );
}

/** The stopwatch readout of a waterfall's play: the scale's time under the playhead, stopping
 * where the last screen settled (`end`). */
export function WaterfallClock({ max, end, playKey }: { max: number; end: number; playKey: number }) {
  const play = playMs(max);
  const clock = usePlayClock(Math.min(end, max), { rate: max / play });
  const { replay } = clock;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    replay();
  }, [playKey, replay]);
  return (
    <span className="flex flex-col items-end leading-tight" aria-hidden data-perf-wf-clock>
      <span className={cn("font-mono text-lg font-semibold tabular-nums transition-colors", clock.running ? "text-primary" : "text-fg")}>{stopwatch(clock.ms)}</span>
      <span className="text-[10px] text-muted">{clock.running ? "playing the screens back" : "until the last one settled"}</span>
    </span>
  );
}

function Row({ r, max, k }: { r: WfRow; max: number; k: number }) {
  const [open, setOpen] = useState(false);
  const pct = (v: number) => `${Math.min(100, Math.max(0, (v / max) * 100)).toFixed(2)}%`;
  const w = (from: number, to: number) => `${Math.max(0.4, Math.min(100, ((to - from) / max) * 100)).toFixed(2)}%`;
  const anim = k > 0;
  const seg = (start: number, len: number) => (anim ? ({ "--s": `${Math.round(start * k)}ms`, "--l": `${Math.max(60, Math.round(len * k))}ms` } as CSSProperties) : undefined);
  const at = (t: number) => (anim ? ({ "--s": `${Math.round(t * k)}ms` } as CSSProperties) : undefined);
  const tone = TONE[r.heat];
  const appear = r.appear ?? null;
  const settle = r.settle ?? null;
  const placed = r.calls.filter((c) => typeof c.start_ms === "number");
  const summary = [
    appear !== null ? `appeared after ${fmtSeconds(appear)}` : null,
    settle !== null ? `settled after ${fmtSeconds(settle)}` : null,
    ...r.marks.map((m) => `${m.label} at ${fmtSeconds(m.at)}`),
    r.usual ? `usually ${fmtSeconds(r.usual.median)}` : null,
    r.budget ? `budget ${fmtSeconds(r.budget)}` : null,
    r.calls.length ? `${r.calls.length} slowest call${r.calls.length === 1 ? "" : "s"}, the slowest ${fmtSeconds(Math.max(...r.calls.map((c) => c.ms)))}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <div role="listitem" className={cn("border-b border-border/70 last:border-b-0", open && "bg-[var(--color-hover)]")} data-perf-wf-row={r.id} data-heat={r.heat}>
      <div className="grid grid-cols-1 items-center gap-x-3 gap-y-1 py-2 @lg:grid-cols-[minmax(10rem,14rem)_minmax(0,1fr)]">
        <div className="flex min-w-0 items-start gap-1">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="-ml-1 mt-0.5 flex size-4 shrink-0 items-center justify-center rounded text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-primary/60"
            aria-label={`${open ? "Hide" : "Show"} the details of ${r.title}`}
            data-perf-wf-toggle
          >
            <ChevronRight className={cn("size-3.5 transition-transform duration-200", open && "rotate-90")} aria-hidden />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-[13px] font-medium text-fg" title={r.title}>
                {r.title}
              </span>
              {r.replay ? (
                <SlowdownReplay
                  spec={r.replay}
                  trigger={(openReplay) => (
                    <button
                      type="button"
                      onClick={openReplay}
                      className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 text-[11px] font-medium text-fg-2 outline-none hover:bg-[var(--color-hover)] hover:text-fg focus-visible:ring-2 focus-visible:ring-primary/60"
                      title="Replay the slowdown: this screen at its usual speed and at this run's, side by side"
                      data-perf-wf-replay
                    >
                      <Play className="size-2.5 fill-current" aria-hidden />
                      Replay
                    </button>
                  )}
                />
              ) : null}
              {r.value !== null ? (
                <span
                  className={cn("ml-auto shrink-0 pl-1 text-[13px] font-semibold tabular", anim && motion.wfLabel)}
                  style={{ color: r.heat === "ok" ? "var(--color-fg)" : tone, ...at(r.value) }}
                  data-perf-wf-value
                >
                  {fmtSeconds(r.value)}
                </span>
              ) : null}
            </div>
            {r.sub ? <div className="truncate text-[11px] text-fg-2">{r.sub}</div> : null}
          </div>
        </div>
        <div className="relative h-9" title={summary}>
          <span className="sr-only">{summary}</span>
          {/* The usual band and median, and the budget. */}
          {r.usual ? (
            <>
              <span aria-hidden className="absolute top-1 h-4 rounded-sm bg-[color-mix(in_srgb,var(--color-fg)_8%,transparent)]" style={{ left: pct(r.usual.median * 0.94), width: w(r.usual.median * 0.94, r.usual.p90) }} />
              <span aria-hidden className="absolute top-0 h-6 w-0.5 rounded-full bg-fg/70" style={{ left: pct(r.usual.median) }} />
            </>
          ) : null}
          {r.budget !== null && r.budget <= max ? <span aria-hidden className="absolute top-0 h-9 w-0 border-l border-dashed border-fg-2/50" style={{ left: pct(r.budget) }} /> : null}
          {/* The tap. */}
          <span aria-hidden className={cn("absolute left-0 top-[9px] size-[7px] -translate-x-1/2 rounded-full border-[1.5px] bg-panel", anim && motion.wfMark)} style={{ borderColor: tone, ...at(0) }} />
          {/* Appears: solid, from the tap. Then settling while the data arrives: hatched. */}
          {appear !== null ? (
            <span aria-hidden className={cn("absolute left-0 top-[9px] h-[7px] rounded-full", anim && motion.wfGrow)} style={{ width: w(0, appear), background: tone, ...seg(0, appear) }} />
          ) : null}
          {settle !== null && settle > (appear ?? 0) + 20 ? (
            <span
              aria-hidden
              className={cn("absolute top-[9px] h-[7px] rounded-r-full", motion.hatch, anim && motion.wfGrow)}
              style={{ left: pct(appear ?? 0), width: w(appear ?? 0, settle), color: tone, ...seg(appear ?? 0, settle - (appear ?? 0)) }}
            />
          ) : null}
          {/* Page marks (web): first byte, DOM ready, main content, load. */}
          {r.marks.map((m) => (
            <span key={m.label} aria-hidden className={cn("absolute top-[6px] h-[13px] w-[2px] -translate-x-1/2 rounded-full bg-fg", anim && motion.wfMark)} style={{ left: pct(m.at), ...at(m.at) }} title={`${m.label}: ${fmtSeconds(m.at)}`} />
          ))}
          {/* The calls it waited on, where they were sent. */}
          {placed.map((c, i) => (
            <span
              key={i}
              aria-hidden
              className={cn("absolute h-[3px] rounded-full", anim && motion.wfGrow)}
              style={{
                top: 21 + i * 5,
                left: pct(Math.max(0, c.start_ms ?? 0)),
                width: w(Math.max(0, c.start_ms ?? 0), (c.start_ms ?? 0) + c.ms),
                background: c.ms >= 2000 ? "var(--color-danger)" : c.ms >= 1000 ? "var(--color-warning)" : "var(--color-info)",
                opacity: 0.9,
                ...seg(Math.max(0, c.start_ms ?? 0), c.ms),
              }}
              title={`${c.method ?? ""} ${shortUrl(c.url)} · ${fmtSeconds(c.ms)}`}
            />
          ))}
        </div>
      </div>
      {open ? (
        <div className="grid grid-cols-1 gap-x-3 pb-3 @lg:grid-cols-[minmax(10rem,14rem)_minmax(0,1fr)]" data-perf-wf-detail>
          <span className="hidden @lg:block" />
          <div className="flex flex-col gap-2 text-xs">
            {r.calls.length ? (
              <ul className="flex flex-col gap-1">
                {r.calls.map((c, i) => (
                  <li key={i} className="flex min-w-0 items-center gap-2">
                    <span aria-hidden className="h-1.5 w-3 shrink-0 rounded-full" style={{ background: c.ms >= 2000 ? "var(--color-danger)" : c.ms >= 1000 ? "var(--color-warning)" : "var(--color-info)" }} />
                    <span className="shrink-0 font-mono text-[11px] text-fg-2">{c.method ?? "–"}</span>
                    <span className="min-w-0 truncate font-mono text-[11px] text-fg" title={c.url}>
                      {shortUrl(c.url)}
                    </span>
                    <span className="ml-auto shrink-0 tabular text-fg">{fmtSeconds(c.ms)}</span>
                    <span className="w-24 shrink-0 text-right tabular text-muted">{typeof c.start_ms === "number" ? `sent at +${fmtSeconds(Math.max(0, c.start_ms))}` : "when: not kept"}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">No call the app&apos;s own backend answered while it loaded.</p>
            )}
            {r.detail}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function WaterfallLegend({ web }: { web?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted" aria-hidden data-perf-wf-legend>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-[7px] w-5 rounded-full bg-[color-mix(in_srgb,var(--color-fg-2)_75%,transparent)]" />
        {web ? "first change" : "appears"}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className={cn("h-[7px] w-5 rounded-r-full text-[var(--color-fg-2)]", motion.hatch)} />
        settles
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-[3px] w-5 rounded-full bg-info" />
        API call
      </span>
      {web ? (
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-[2px] rounded-full bg-fg" />
          page mark
        </span>
      ) : null}
      <span className="inline-flex items-center gap-1.5">
        <span className="h-3 w-0.5 rounded-full bg-fg/70" />
        usual
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-3 w-0 border-l border-dashed border-fg-2/60" />
        budget
      </span>
    </div>
  );
}

export function shortUrl(url: string | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return u.pathname + (u.search ? "?…" : "");
  } catch {
    return url;
  }
}
