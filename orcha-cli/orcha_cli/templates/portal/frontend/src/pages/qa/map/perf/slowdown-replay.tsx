import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Play, RotateCcw, Snail } from "../kit/icons";
import { Button, Dialog } from "../kit";
import { fmtSeconds, type PerfMetric } from "./perf";
import { cn } from "../kit";
import { useInView, usePlayClock } from "./perf-motion";
import motion from "./perf.module.css";

/**
 * "Replay the slowdown": the same action played twice side by side in real time, once at
 * the screen's usual speed and once at its latest, on one clock, so the difference is felt rather
 * than read. Both times are measured (the usual is the median of the screen's clean samples); the
 * picture is the screen as Orcha last saw it, and the placeholder before it appears is drawn by
 * Orcha (the wait is timed, not filmed). The stage is a pure function of the clock, so the
 * dialog, the teaching scene and reduced motion (the finished frame) all draw it the same way.
 */

/** How each metric's moment is said: "appeared after 2.41 s". */
const MOMENT: Partial<Record<PerfMetric, string>> = {
  appear: "appeared",
  launch: "showed its first screen",
  lcp: "showed its main content",
  settle: "settled",
};

export function momentOf(metric: PerfMetric): string {
  return MOMENT[metric] ?? "was ready";
}

/** "2.41 s": the stopwatch's two decimals. */
export function stopwatch(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(2)} s`;
}

/** What the stage plays. */
export interface ReplaySpec {
  screen: string;
  platform: string;
  metric: PerfMetric;
  frame: string | null;
  /** The usual time, ms, and how it is known ("median of its last 20 clean samples"). */
  usualMs: number;
  usualNote: string;
  /** The slow time, ms, and where it is from ("Latest run · Oct 27"). */
  nowMs: number;
  nowLabel: string;
  nowNote: string;
  /** The screen's address, shown in the browser's bar on the web. */
  address?: string;
}

/** How long the clock runs past the slower lane landing, so the landing reads. */
const TAIL_MS = 600;

/** The device a picture was taken on, from its shape: a tall phone, or a tablet (an iPad's
 * frame, which can hold a phone app in its middle). */
export type DeviceShape = "phone" | "tablet";

export function ReplayStage({ spec, ms, compact, example, shape = "phone" }: { spec: ReplaySpec; ms: number; compact?: boolean; example?: boolean; shape?: DeviceShape }) {
  const end = Math.max(spec.usualMs, spec.nowMs) + TAIL_MS;
  const done = ms >= spec.nowMs && ms >= spec.usualMs;
  const slower = spec.nowMs - spec.usualMs;
  return (
    <div className={cn("flex w-full flex-col", compact ? "gap-3" : "gap-5")} data-replay-stage data-replay-done={done ? "true" : "false"}>
      <div className={cn("grid grid-cols-2", compact ? "gap-3" : "gap-4 sm:gap-6")}>
        <Lane spec={spec} which="usual" ms={ms} compact={compact} example={example} shape={shape} />
        <Lane spec={spec} which="now" ms={ms} compact={compact} example={example} shape={shape} />
      </div>
      <Timeline spec={spec} ms={ms} end={end} compact={compact} />
      {done && slower > 0 ? (
        <p className={cn("text-center text-fg-2", compact ? "text-xs" : "text-sm")} data-replay-verdict>
          Same {spec.platform === "web" ? "page" : "screen"}, same action: <span className="font-semibold text-danger tabular">{fmtSeconds(slower)} slower</span> than usual,{" "}
          <span className="tabular">{(spec.nowMs / Math.max(1, spec.usualMs)).toFixed(1)}×</span> its usual time.
        </p>
      ) : (
        <p aria-hidden className={cn("text-center text-transparent select-none", compact ? "text-xs" : "text-sm")}>
          .
        </p>
      )}
    </div>
  );
}

function Lane({ spec, which, ms, compact, example, shape }: { spec: ReplaySpec; which: "usual" | "now"; ms: number; compact?: boolean; example?: boolean; shape: DeviceShape }) {
  const laneMs = which === "usual" ? spec.usualMs : spec.nowMs;
  const shown = ms >= laneMs;
  const slow = which === "now" && spec.nowMs > spec.usualMs;
  const t = Math.min(ms, laneMs);
  return (
    <div className="flex min-w-0 flex-col items-center gap-2" data-replay-lane={which}>
      <div className="flex w-full min-w-0 items-end justify-between gap-2">
        <div className="min-w-0">
          <p className={cn("truncate font-medium text-fg", compact ? "text-xs" : "text-sm")}>{which === "usual" ? "Usually" : spec.nowLabel}</p>
          {!compact ? <p className="truncate text-[11px] text-muted">{which === "usual" ? spec.usualNote : spec.nowNote}</p> : null}
        </div>
        <span className="flex items-center gap-1.5">
          <Dial ms={t} laneMs={laneMs} running={!shown && ms > 0} tone={shown ? (slow ? "slow" : "ok") : "run"} size={compact ? 14 : 18} />
          <span
            className={cn(
              "font-mono font-semibold tabular-nums transition-colors duration-200",
              compact ? "text-sm" : "text-xl",
              shown ? (slow ? "text-danger" : "text-success") : "text-fg",
            )}
            data-replay-clock={which}
          >
            {stopwatch(t)}
          </span>
        </span>
      </div>
      <Device spec={spec} shown={shown} ms={ms} compact={compact} example={example} slow={slow} shape={shape} />
      <span className={cn("h-5 text-[11px]", compact && "h-4")}>
        {shown ? (
          <span
            className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-px font-medium", motion.land, slow ? "border-danger/40 bg-danger/10 text-danger" : "border-success/40 bg-success/10 text-success")}
            data-replay-landed={which}
          >
            {momentOf(spec.metric)} at {stopwatch(laneMs)}
          </span>
        ) : ms > 0 ? (
          <span className="text-muted">waiting for the {spec.platform === "web" ? "page" : "screen"}…</span>
        ) : null}
      </span>
    </div>
  );
}

/** A stopwatch: its hand turns once a second while the lane waits and stops where it landed. */
function Dial({ ms, laneMs, running, tone, size }: { ms: number; laneMs: number; running: boolean; tone: "run" | "ok" | "slow"; size: number }) {
  const angle = ((ms % 1000) / 1000) * 360;
  const color = tone === "slow" ? "var(--color-danger)" : tone === "ok" ? "var(--color-success)" : "var(--color-primary)";
  const arc = Math.min(1, ms / Math.max(1, laneMs));
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 20 20" className="shrink-0" data-replay-dial={running ? "running" : "still"}>
      <rect x="8.5" y="0.5" width="3" height="2" rx="0.6" fill={color} />
      <circle cx="10" cy="11" r="7.5" fill="none" stroke="var(--color-border-strong)" strokeWidth="1.6" />
      <circle cx="10" cy="11" r="7.5" fill="none" stroke={color} strokeWidth="1.6" pathLength={1} strokeDasharray="1" strokeDashoffset={1 - arc} transform="rotate(-90 10 11)" strokeLinecap="round" />
      <line x1="10" y1="11" x2="10" y2="5.6" stroke={color} strokeWidth="1.6" strokeLinecap="round" style={{ transform: `rotate(${angle}deg)`, transformOrigin: "10px 11px" }} />
      <circle cx="10" cy="11" r="1.2" fill={color} />
    </svg>
  );
}

function Device({ spec, shown, ms, compact, example, slow, shape }: { spec: ReplaySpec; shown: boolean; ms: number; compact?: boolean; example?: boolean; slow: boolean; shape: DeviceShape }) {
  const web = spec.platform === "web";
  const tablet = !web && shape === "tablet";
  const screen = (
    <div className="relative h-full w-full overflow-hidden bg-panel" data-replay-screen={shown ? "shown" : "loading"}>
      <div className={cn("absolute inset-0", motion.develop)} data-shown={shown ? "true" : "false"}>
        {spec.frame && !example ? (
          <img src={spec.frame} alt="" className={cn("h-full w-full", tablet ? "bg-black object-contain" : "object-cover object-top")} draggable={false} />
        ) : (
          <DrawnScreen title={spec.screen} web={web} example={example} />
        )}
      </div>
      <div className={cn("absolute inset-0", motion.loading)} data-shown={shown ? "true" : "false"}>
        <Placeholder web={web} running={ms > 0 && !shown} />
      </div>
      {/* The action: a touch ripple where a thumb would tap, as the clock starts. */}
      {ms > 0 && ms < 520 ? <span aria-hidden className={cn("pointer-events-none absolute left-1/2 top-[62%] -ml-5 -mt-5 size-10 rounded-full bg-primary/40", motion.ripple)} /> : null}
      {shown && slow ? <span aria-hidden className="pointer-events-none absolute inset-0 ring-2 ring-inset ring-danger/50" /> : null}
    </div>
  );
  if (web) {
    return (
      <div className={cn("w-full overflow-hidden rounded-lg border border-border-strong bg-raised shadow-[var(--shadow-md)]", compact ? "max-w-[220px]" : "max-w-[360px]")}>
        <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
          <span aria-hidden className="size-1.5 rounded-full bg-[var(--color-border-strong)]" />
          <span aria-hidden className="size-1.5 rounded-full bg-[var(--color-border-strong)]" />
          <span aria-hidden className="size-1.5 rounded-full bg-[var(--color-border-strong)]" />
          <span className="ml-1 min-w-0 flex-1 truncate rounded bg-panel-2 px-1.5 py-px font-mono text-[10px] text-muted">{spec.address ?? spec.screen}</span>
        </div>
        <div className="aspect-[16/10] w-full">{screen}</div>
      </div>
    );
  }
  if (tablet) {
    return (
      <div className="relative aspect-[3/4] w-[min(244px,36vw)] rounded-[20px] bg-[#0c0c0e] p-[7px] shadow-[var(--shadow-md)] ring-1 ring-black/20 dark:ring-white/10">
        <div className="relative h-full w-full overflow-hidden rounded-[13px]">{screen}</div>
      </div>
    );
  }
  return (
    <div
      className={cn("relative aspect-[9/19.5] rounded-[22px] bg-[#0c0c0e] p-[5px] shadow-[var(--shadow-md)] ring-1 ring-black/20 dark:ring-white/10", compact ? "w-[112px] rounded-[16px] p-[4px]" : "w-[min(176px,38vw)]")}
    >
      <div className={cn("relative h-full w-full overflow-hidden", compact ? "rounded-[12px]" : "rounded-[18px]")}>
        {screen}
        <span aria-hidden className={cn("absolute left-1/2 top-1.5 -translate-x-1/2 rounded-full bg-[#0c0c0e]", compact ? "h-2 w-7" : "h-3 w-12")} />
      </div>
    </div>
  );
}

/** The wait before the screen shows: skeleton blocks with a light sweeping across them. */
function Placeholder({ web, running }: { web: boolean; running: boolean }) {
  const block = (cls: string, i: number) => (
    <span key={i} className={cn("relative block overflow-hidden rounded bg-[color-mix(in_srgb,var(--color-fg)_7%,transparent)]", cls)}>
      {running ? <span className={motion.shimmer} style={{ animationDelay: `${i * 90}ms` } as CSSProperties} /> : null}
    </span>
  );
  return (
    <div className={cn("flex h-full w-full flex-col gap-2 bg-panel", web ? "p-3" : "px-2.5 pb-3 pt-7")}>
      {block("h-3 w-1/2", 0)}
      {block("h-[22%] w-full rounded-md", 1)}
      {[2, 3, 4].map((i) => (
        <span key={i} className="flex items-center gap-2">
          {block("size-5 shrink-0 rounded-full", i)}
          <span className="flex flex-1 flex-col gap-1">
            {block("h-1.5 w-4/5", i + 3)}
            {block("h-1.5 w-1/2", i + 6)}
          </span>
        </span>
      ))}
    </div>
  );
}

/** A screen drawn by Orcha: the teaching example's order list, or, for a real screen Orcha
 * has no picture of, its name over plain blocks (never content it did not see). */
function DrawnScreen({ title, web, example }: { title: string; web: boolean; example?: boolean }) {
  const rows = ["#1042 · Two jars, olive", "#1041 · Linen tote", "#1039 · Serving bowl", "#1036 · Mug set"];
  return (
    <div className={cn("flex h-full w-full flex-col gap-1.5 bg-panel", web ? "p-3" : "px-2.5 pb-3 pt-7")}>
      <p className="truncate text-[11px] font-semibold text-fg">{title}</p>
      <span className="block h-[18%] w-full rounded-md bg-gradient-to-br from-fg/15 to-fg/5" />
      {rows.map((r, i) => (
        <span key={r} className="flex items-center gap-1.5 border-b border-border pb-1">
          <span className="size-3 shrink-0 rounded bg-primary/20" />
          {example ? (
            <span className="truncate text-[9px] text-fg-2">{r}</span>
          ) : (
            <span aria-hidden className="h-1.5 rounded-full bg-[color-mix(in_srgb,var(--color-fg)_12%,transparent)]" style={{ width: `${70 - i * 12}%` }} />
          )}
        </span>
      ))}
      {!example ? <p className="mt-auto text-center text-[9px] text-muted">No picture of this {web ? "page" : "screen"} yet</p> : null}
    </div>
  );
}

/** One clock under both lanes: their bars grow together, the playhead runs, and once both have
 * landed the gap between them is bracketed. */
function Timeline({ spec, ms, end, compact }: { spec: ReplaySpec; ms: number; end: number; compact?: boolean }) {
  const pct = (v: number) => `${Math.min(100, (v / end) * 100)}%`;
  const ticks: number[] = [];
  const step = end > 6000 ? 2000 : end > 3000 ? 1000 : 500;
  for (let t = 0; t <= end; t += step) ticks.push(t);
  const done = ms >= Math.max(spec.usualMs, spec.nowMs);
  const lanes = [
    { which: "usual" as const, label: "Usually", v: spec.usualMs, fill: "bg-success" },
    { which: "now" as const, label: spec.nowLabel, v: spec.nowMs, fill: spec.nowMs > spec.usualMs ? "bg-danger" : "bg-success" },
  ];
  return (
    <div className="flex flex-col gap-1.5" data-replay-timeline>
      <div className="relative">
        <div className="relative ml-[72px] h-4 text-[10px] text-muted">
          {ticks.map((t) => (
            <span key={t} className={cn("absolute whitespace-nowrap tabular", t === 0 ? "" : t + step > end ? "-translate-x-full" : "-translate-x-1/2")} style={{ left: pct(t) }}>
              {t === 0 ? "tap" : `${t / 1000} s`}
            </span>
          ))}
        </div>
        {lanes.map((l) => (
          <div key={l.which} className="flex items-center gap-2 py-0.5">
            <span className="w-16 shrink-0 truncate text-right text-[11px] text-fg-2">{l.label}</span>
            <div className="relative h-2 flex-1 rounded-full bg-[var(--color-border)]">
              <div
                className={cn("absolute inset-y-0 left-0 w-full origin-left rounded-full", l.fill)}
                style={{ transform: `scaleX(${Math.min(ms, l.v) / end})` }}
              />
            </div>
          </div>
        ))}
        {/* The playhead and the gap, over the bars' column. */}
        <div className="pointer-events-none absolute inset-y-0 left-[72px] right-0 overflow-hidden">
          {!done && ms > 0 ? (
            <div className="absolute inset-y-0 left-0 w-full" style={{ transform: `translateX(${(Math.min(ms, end) / end - 1) * 100}%)` }}>
              <span className="absolute inset-y-0 right-0 w-px bg-primary shadow-[0_0_8px_var(--color-primary)]" />
            </div>
          ) : null}
        </div>
        {done && spec.nowMs > spec.usualMs ? (
          <div className="relative ml-[72px] mt-1 h-4">
            <div className={cn("absolute top-0 h-2 border-x border-b border-danger/70", motion.bracket)} style={{ left: pct(spec.usualMs), width: `calc(${pct(spec.nowMs)} - ${pct(spec.usualMs)})` }} />
            {!compact ? (
              <span className={cn("absolute top-2 -translate-x-1/2 whitespace-nowrap text-[11px] font-medium text-danger", motion.land)} style={{ left: pct((spec.usualMs + spec.nowMs) / 2) }}>
                +{fmtSeconds(spec.nowMs - spec.usualMs)}
              </span>
            ) : null}
          </div>
        ) : (
          <div className="mt-1 h-4" />
        )}
      </div>
    </div>
  );
}

/** The dialog: opens on a real screen's two times and plays them once, with replay and slow motion. */
export function SlowdownReplay({ spec, trigger }: { spec: ReplaySpec; trigger: (open: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {trigger(() => setOpen(true))}
      {open ? <ReplayDialog spec={spec} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ReplayDialog({ spec, onClose }: { spec: ReplaySpec; onClose: () => void }) {
  const [rate, setRate] = useState(1);
  const [shape, setShape] = useState<DeviceShape | null>(spec.frame ? null : "phone");
  const end = Math.max(spec.usualMs, spec.nowMs) + TAIL_MS;
  const clock = usePlayClock(end, { autoPlay: false, rate });
  const { replay } = clock;
  // The picture first (its shape picks the device), so it never pops in mid-play.
  useEffect(() => {
    if (!spec.frame) return;
    let on = true;
    const img = new Image();
    const done = (s: DeviceShape) => on && setShape((was) => was ?? s);
    img.onload = () => done(img.naturalWidth / Math.max(1, img.naturalHeight) > 0.62 ? "tablet" : "phone");
    img.onerror = () => done("phone");
    img.src = spec.frame;
    const t = setTimeout(() => done("phone"), 1500);
    return () => {
      on = false;
      clearTimeout(t);
    };
  }, [spec.frame]);
  // Start after the dialog has settled in, so the first frames are seen.
  useEffect(() => {
    if (shape === null) return;
    const t = setTimeout(replay, 420);
    return () => clearTimeout(t);
  }, [replay, shape]);
  const done = clock.ms >= Math.max(spec.usualMs, spec.nowMs);
  const summary = `${spec.screen} usually ${momentOf(spec.metric)} after ${fmtSeconds(spec.usualMs)}. In the ${spec.nowLabel.toLowerCase()} it ${momentOf(spec.metric)} after ${fmtSeconds(spec.nowMs)}${spec.nowMs > spec.usualMs ? `, ${fmtSeconds(spec.nowMs - spec.usualMs)} slower` : ""}.`;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Replay the slowdown: ${spec.screen}`}
      description="The same action at its usual speed and at its latest, side by side on one clock, in real time."
      className="max-w-[760px]"
      footer={
        <>
          <p className="mr-auto max-w-[420px] text-[11px] leading-4 text-muted">
            Both times are measured. The picture is the {spec.platform === "web" ? "page" : "screen"} as Embodent last saw it; the placeholder before it appears is drawn by Embodent.
          </p>
          <Button size="sm" variant="ghost" aria-pressed={rate < 1} onClick={() => setRate((r) => (r < 1 ? 1 : 0.5))} data-replay-rate>
            <Snail aria-hidden />
            {rate < 1 ? "Half speed" : "Real time"}
          </Button>
          <Button size="sm" variant="secondary" onClick={replay} data-replay-again>
            {clock.ms > 0 && !clock.running ? <RotateCcw aria-hidden /> : <Play aria-hidden />}
            {clock.running ? "Playing…" : "Play again"}
          </Button>
        </>
      }
    >
      <div className="py-2" data-replay-dialog>
        <ReplayStage spec={spec} ms={clock.ms} shape={shape ?? "phone"} />
        <p className="sr-only" aria-live="polite">
          {done ? summary : ""}
        </p>
      </div>
    </Dialog>
  );
}

/** The teaching version: an example screen, looped while it is on screen, labelled as one. */
export function ExampleReplay({ compact = true }: { compact?: boolean }) {
  const spec: ReplaySpec = {
    screen: "Order history",
    platform: "ios",
    metric: "appear",
    frame: null,
    usualMs: 1180,
    usualNote: "median of its last 20 runs",
    nowMs: 3400,
    nowLabel: "Today",
    nowNote: "today's run",
  };
  const ref = useRef<HTMLDivElement | null>(null);
  const inView = useInView(ref);
  const end = spec.nowMs + TAIL_MS;
  const clock = usePlayClock(end, { autoPlay: false, active: inView });
  const { replay, running, reduced } = clock;
  // Loop: rest on the verdict for a moment, then play again (only while on screen).
  useEffect(() => {
    if (reduced || !inView || running) return;
    const t = setTimeout(replay, clock.ms >= end ? 2600 : 500);
    return () => clearTimeout(t);
  }, [reduced, inView, running, replay, clock.ms, end]);
  return (
    <div ref={ref} aria-hidden className="relative w-full max-w-[400px] rounded-xl border border-border bg-raised/60 p-4 shadow-[var(--shadow-md)]" data-perf-scene>
      <span className="absolute -top-2.5 left-4 rounded-full border border-border bg-raised px-2 text-[10px] font-medium uppercase tracking-wide text-muted">Example</span>
      <ReplayStage spec={spec} ms={clock.ms} compact={compact} example />
    </div>
  );
}
