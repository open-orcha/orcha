import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Pause, Play, RotateCcw } from "../../../map/kit/icons";
import { Button, Select } from "../../../map/kit";
import { cn } from "../../../map/kit";
import { layoutMap } from "../map-layout";
import { countNote, linePlot, mapAreas, shortDate, timelapseFrames, type Frame } from "./growth-model";
import styles from "./growth.module.css";
import { useOnScreen, useSeen } from "./motion";
import type { CoverageGrowth } from "./types";

const H = 250;
const PAD = 18;
const LEFT = 40;
/** The mini map's height in CSS pixels; its width is the column's, so labels never scale. */
const MAP_H = 222;
/** The whole time-lapse takes about this long, whatever the number of days. */
const RUN_MS = 7000;

/** The element's width in CSS pixels, so the chart draws at its real size (text never scales). */
function useWidth<T extends HTMLElement>(fallback: number): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** The newest figure; on the baseline's own day the two dots overlap, so it says both. */
function lastLabel(points: { day: string; kind: string; pct: number }[]): string {
  const last = points[points.length - 1];
  const base = points.find((p) => p.kind === "baseline");
  return base && base !== last && base.day === last.day && base.pct !== last.pct ? `${base.pct}% → ${last.pct}%` : `${last.pct}%`;
}

/**
 * The app as a mini map: one tile per area, sized by its screens, filled from the bottom to its
 * share covered on the frame's day. The part it had at the baseline is grey, what came since is
 * green, and an area that rose that day glows. A tile picks the area for the line.
 */
function MiniMap({
  report,
  frame,
  base,
  picked,
  onPick,
  step,
}: {
  report: CoverageGrowth;
  frame: Frame | null;
  base: Frame | null;
  picked: string | null;
  onPick: (key: string | null) => void;
  step: number;
}) {
  const [box, MAP_W] = useWidth<HTMLDivElement>(360);
  const areas = useMemo(() => mapAreas(report), [report]);
  const layout = useMemo(
    () =>
      layoutMap(
        areas.map((a) => ({
          key: a.key,
          name: a.name,
          paths: [`app/${a.key}`],
          entry: null,
          source: "code",
          importance: a.screens,
        })),
        MAP_W,
        MAP_H,
        { gap: 3, header: 0 },
      ),
    [areas, MAP_W],
  );
  const name = new Map(areas.map((a) => [a.key, a]));
  const day = frame ?? null;
  return (
    <div ref={box}>
      <svg
        viewBox={`0 0 ${MAP_W} ${MAP_H}`}
        width={MAP_W}
        height={MAP_H}
        className="block w-full"
        role="group"
        aria-label={`The app's areas on ${day ? shortDate(day.day) : "today"}, each filled to its share of screens covered`}
      >
        {layout.tiles.map((t) => {
          const a = name.get(t.key)!;
          const now = day?.areas[t.key] ?? null;
          const then = base?.areas[t.key] ?? null;
          const thenShare = Math.min(1, Math.max(0, (then ?? 0) / 100));
          const nowShare = Math.min(1, Math.max(0, (now ?? 0) / 100));
          const gain = Math.max(0, nowShare - thenShare);
          const big = t.w > 54 && t.h > 30;
          const label = `${a.name}: ${now === null ? "evidence unknown" : `${now}%`}${then !== null && now !== null ? `, ${then}% at the baseline` : ""}, ${a.screens} ${a.screens === 1 ? "screen" : "screens"}`;
          return (
            <g
              key={t.key}
              className={styles.mapTile}
              data-picked={picked === t.key}
              role="button"
              tabIndex={0}
              aria-pressed={picked === t.key}
              aria-label={label}
              onClick={() => onPick(picked === t.key ? null : t.key)}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onPick(picked === t.key ? null : t.key);
                }
              }}
              style={{ "--step": `${step}ms` } as CSSProperties}
              data-growth-map-tile={t.key}
            >
              <title>{label}</title>
              <rect className={styles.mapBody} x={t.x} y={t.y} width={t.w} height={t.h} rx="4" />
              <rect className={styles.mapThen} x={t.x + 1} y={t.y + 1} width={Math.max(0, t.w - 2)} height={Math.max(0, t.h - 2)} rx="3" style={{ transform: `scaleY(${thenShare})` }} />
              <rect
                className={styles.mapGain}
                x={t.x + 1}
                y={t.y + 1}
                width={Math.max(0, t.w - 2)}
                height={Math.max(0, t.h - 2)}
                rx="3"
                style={{
                  transform: `translateY(${-thenShare * (t.h - 2)}px) scaleY(${gain})`,
                }}
              />
              {day?.rose.includes(t.key) ? <rect key={day.day} className={styles.mapGlow} x={t.x + 1.5} y={t.y + 1.5} width={t.w - 3} height={t.h - 3} rx="3" /> : null}
              {big ? (
                <>
                  <text className={styles.mapLabel} x={t.x + 6} y={t.y + 14}>
                    {a.name.length * 6 > t.w - 10 ? `${a.name.slice(0, Math.max(3, Math.floor((t.w - 14) / 6)))}…` : a.name}
                  </text>
                  <text className={styles.mapPct} x={t.x + 6} y={t.y + 27}>
                    {now === null ? "?" : `${now}%`}
                  </text>
                </>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/**
 * Coverage over time, as a time-lapse: press play and coverage grows day by day from the
 * baseline, the line advancing with a playhead while the app's areas fill in on the mini map.
 * Every frame is a stored daily point (or the baseline, or today's live figure); nothing is
 * interpolated between days. Pauses offscreen; under reduced motion each day simply swaps in.
 */
export function OverTime({ report }: { report: CoverageGrowth }) {
  const [area, setArea] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [box, W] = useWidth<HTMLDivElement>(640);
  const [seenRef, seen] = useSeen<HTMLElement>();
  const [screenRef, onScreen] = useOnScreen<HTMLDivElement>();
  const frames = useMemo(() => timelapseFrames(report.series), [report.series]);
  const plot = useMemo(() => linePlot(report.series, area, W, H, PAD, LEFT), [report.series, area, W]);
  const areas = report.now.areas.filter((a) => a.screens > 0);
  const label = area ? (areas.find((a) => a.key === area)?.name ?? area) : "All screens";
  const step = Math.round(Math.min(700, Math.max(160, RUN_MS / Math.max(1, frames.length))));
  const canPlay = frames.length > 2;
  const last = frames.length - 1;
  const frame = at === null ? (frames[last] ?? null) : frames[at];
  const baseFrame = frames.find((f) => f.kind === "baseline") ?? frames[0] ?? null;

  // Playback: one day per step; stops on today.
  useEffect(() => {
    if (!playing || !onScreen) return;
    const t = setTimeout(() => {
      const next = (at ?? -1) + 1;
      if (next >= last) {
        setAt(last);
        setPlaying(false);
      } else setAt(next);
    }, step);
    return () => clearTimeout(t);
  }, [playing, onScreen, at, last, step]);

  function play() {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (at === null || at >= last) setAt(0);
    setPlaying(true);
  }

  // The playhead on the line: the frame's day, on this line's points (an area may skip days).
  const atDay = frame?.day ?? null;
  const shown = at === null ? plot.points : plot.points.filter((p) => atDay !== null && p.day <= atDay);
  const head = at === null ? null : (shown[shown.length - 1] ?? null);
  const revealX = head ? head.x : W;
  const h = hover !== null ? plot.points[hover] : null;
  const delta = frame && baseFrame ? frame.pct - baseFrame.pct : null;
  const dayIndex = at ?? last;

  return (
    <section ref={seenRef} aria-labelledby="growth-time" className="rounded-xl border border-border bg-panel p-4" data-growth-time>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="growth-time" className="text-sm font-semibold text-fg">
            Coverage over time
          </h2>
          <p className="text-xs text-muted">One point a day from the baseline; today&apos;s is live. Press play to watch it grow.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 text-xs text-fg-2">
            <span>Area</span>
            <Select
              aria-label="Area"
              dimension="sm"
              className="max-w-[11rem]"
              value={area ?? ""}
              options={[{ value: "", label: "All screens" }, ...areas.map((a) => ({ value: a.key, label: a.name }))]}
              onChange={(e) => setArea(e.target.value || null)}
              data-growth-area-pick
            />
          </div>
        </div>
      </div>

      <div ref={screenRef} className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          {plot.points.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted">No figure for {label} yet: its evidence is unknown.</p>
          ) : (
            <div className="relative" ref={box}>
              <svg
                viewBox={`0 0 ${W} ${H}`}
                width={W}
                height={H}
                className="block w-full overflow-visible"
                role="group"
                aria-label={`${label}: ${plot.points.map((p) => `${shortDate(p.day)}${p.kind === "baseline" ? " (baseline)" : ""} ${p.pct}%`).join(", ")}`}
                onMouseLeave={() => setHover(null)}
              >
                <defs>
                  <linearGradient id="growth-area-fill" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="var(--g-orcha)" stopOpacity="0.22" />
                    <stop offset="100%" stopColor="var(--g-orcha)" stopOpacity="0" />
                  </linearGradient>
                  <clipPath id="growth-reveal">
                    <rect
                      className={styles.reveal}
                      x={0}
                      y={0}
                      width={W}
                      height={H}
                      style={
                        {
                          transform: `scaleX(${Math.max(0, Math.min(1, (revealX + 1) / W))})`,
                          "--step": playing ? `${step}ms` : "0ms",
                        } as CSSProperties
                      }
                    />
                  </clipPath>
                </defs>
                {[0, 50, 100].map((v) => {
                  const y = PAD + (1 - v / 100) * (H - PAD * 2);
                  return (
                    <g key={v}>
                      <line className={styles.grid} x1={LEFT} x2={W} y1={y} y2={y} />
                      <text x={LEFT - 6} y={y + 3} textAnchor="end" className="fill-[var(--color-muted)] text-[10px]">
                        {v}%
                      </text>
                    </g>
                  );
                })}
                {plot.baselineX !== null ? (
                  <g>
                    <line className={styles.baselineRule} x1={plot.baselineX} x2={plot.baselineX} y1={PAD} y2={H - PAD} />
                    <text x={plot.baselineX + 5} y={12} className="fill-[var(--color-fg-2)] text-[10px]">
                      Baseline
                    </text>
                  </g>
                ) : null}
                {plot.countX !== null ? (
                  // Where the screen count changed (#467): the points before it are on the old count.
                  <g data-growth-count-changed>
                    <line className={styles.baselineRule} x1={plot.countX} x2={plot.countX} y1={PAD} y2={H - PAD} strokeDasharray="3 3" />
                    <text x={plot.countX + 5} y={24} className="fill-[var(--color-fg-2)] text-[10px]">
                      Count changed
                    </text>
                  </g>
                ) : null}
                <g clipPath="url(#growth-reveal)">
                  {plot.points.length > 1 ? (
                    <path className={cn(styles.area, !seen && styles.paused)} d={`${plot.path} L${plot.points[plot.points.length - 1].x},${H - PAD} L${plot.points[0].x},${H - PAD} Z`} />
                  ) : null}
                  <path key={`${area ?? "all"}`} className={cn(styles.line, !seen && styles.paused)} d={plot.path} pathLength={1} />
                </g>
                {(at === null ? plot.points : shown).map((p, i) => {
                  const t = plot.points.length > 1 ? (p.x - plot.points[0].x) / Math.max(1, plot.points[plot.points.length - 1].x - plot.points[0].x) : 0;
                  return (
                    <g
                      key={`${p.day}-${p.kind}`}
                      role="img"
                      onMouseEnter={() => setHover(i)}
                      onFocus={() => setHover(i)}
                      onBlur={() => setHover(null)}
                      tabIndex={0}
                      aria-label={`${shortDate(p.day)}${p.kind === "baseline" ? ", the baseline" : p.kind === "now" ? ", now" : ""}: ${p.pct}%`}
                    >
                      <circle cx={p.x} cy={p.y} r={12} fill="transparent" />
                      <circle
                        className={cn(styles.dot, p.kind === "baseline" && styles.dotBase, !seen && styles.paused)}
                        cx={p.x}
                        cy={p.y}
                        r={p.kind === "point" ? 3 : 4.5}
                        style={(at !== null ? { animation: "none" } : { "--t": t }) as CSSProperties}
                      />
                    </g>
                  );
                })}
                {head ? (
                  <g
                    className={styles.playhead}
                    style={
                      {
                        transform: `translate(${head.x}px, 0)`,
                        "--step": playing ? `${step}ms` : "0ms",
                      } as CSSProperties
                    }
                    aria-hidden
                  >
                    <line className={styles.playheadLine} x1={0} x2={0} y1={PAD} y2={H - PAD} />
                    <g style={{ transform: `translate(0, ${head.y}px)` }} className={styles.playhead}>
                      <circle className={styles.playheadHalo} r={6} cx={0} cy={0} />
                      <circle className={styles.playheadDot} r={5} cx={0} cy={0} />
                    </g>
                  </g>
                ) : null}
                {at === null && plot.points.length > 0 ? (
                  <text
                    x={plot.points[plot.points.length - 1].x - 6}
                    y={plot.points[plot.points.length - 1].y - 12}
                    textAnchor="end"
                    className={cn("fill-[var(--color-fg)] text-[12px] font-semibold", styles.landed)}
                    style={{ animationDelay: "1400ms" }}
                  >
                    {lastLabel(plot.points)}
                  </text>
                ) : null}
              </svg>
              {plot.points.length === 1 ? (
                <p className="pointer-events-none absolute left-[52px] top-6 max-w-[16rem] text-xs text-muted" data-growth-one-point>
                  One point so far. Embodent records one a day from the baseline, so the line grows from here.
                </p>
              ) : null}
              {at !== null && frame ? (
                <div className="pointer-events-none absolute left-[52px] top-5 rounded-lg bg-panel/80 px-2 py-1 backdrop-blur-[2px]" aria-hidden data-growth-lapse-counter>
                  <p className="text-[34px] font-semibold leading-none tracking-[-0.03em] tabular-nums text-fg">{head ? head.pct : frame.pct}%</p>
                  <p className="mt-1 text-xs tabular-nums text-fg-2">
                    {shortDate(frame.day)}
                    {baseFrame ? ` · day ${Math.max(0, Math.round((Date.parse(frame.day) - Date.parse(baseFrame.day)) / 86_400_000))}` : ""}
                  </p>
                </div>
              ) : null}
              {h && at === null ? (
                <div
                  className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md border border-border bg-raised px-2 py-1 text-xs text-fg shadow-[var(--shadow-md)]"
                  style={{
                    left: `${(h.x / W) * 100}%`,
                    top: `${(h.y / H) * 100 - 3}%`,
                  }}
                  data-growth-tooltip
                >
                  <span className="text-muted">
                    {shortDate(h.day)}
                    {h.kind === "baseline" ? " · baseline" : h.kind === "now" ? " · now" : ""}
                  </span>{" "}
                  <span className="font-semibold tabular-nums">{h.pct}%</span>
                </div>
              ) : null}
            </div>
          )}
          {countNote(report.count) ? (
            <p className="mt-1 text-2xs text-muted" data-growth-count-note>
              {countNote(report.count)}
            </p>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-2" data-growth-timelapse>
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted">Where it grew</p>
            <ul className="flex items-center gap-3 text-2xs text-fg-2" aria-hidden>
              <li className="inline-flex items-center gap-1">
                <span className={cn(styles.swatch, styles.swatchThen)} /> At the baseline
              </li>
              <li className="inline-flex items-center gap-1">
                <span className={cn(styles.swatch, styles.swatchOrcha)} /> Since then
              </li>
            </ul>
          </div>
          {frames.length > 0 ? <MiniMap report={report} frame={frame} base={baseFrame} picked={area} onPick={setArea} step={playing ? step : 420} /> : null}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-3">
        <Button size="sm" variant={playing ? "default" : "primary"} onClick={play} disabled={!canPlay} aria-pressed={playing} data-growth-play>
          {playing ? <Pause /> : at !== null && at >= last ? <RotateCcw /> : <Play />}
          {playing ? "Pause" : at !== null && at >= last ? "Play again" : "Play the time-lapse"}
        </Button>
        {canPlay ? (
          <>
            <input
              type="range"
              min={0}
              max={last}
              step={1}
              value={dayIndex}
              onChange={(e) => {
                setPlaying(false);
                setAt(Number(e.target.value));
              }}
              className={cn(styles.scrub, "min-w-[8rem] flex-1")}
              aria-label="Day of the time-lapse"
              aria-valuetext={frame ? `${shortDate(frame.day)}: ${frame.pct}%` : undefined}
              data-growth-scrub
            />
            <p className="min-w-[11rem] text-right text-sm tabular-nums text-fg-2" aria-live={playing ? "off" : "polite"} data-growth-frame={frame?.day}>
              <span className="font-medium text-fg">{frame ? shortDate(frame.day) : ""}</span>
              {frame?.kind === "baseline" ? " · baseline" : frame?.kind === "now" ? " · today" : ""} · <span className="font-semibold text-fg">{frame?.pct}%</span>
              {delta !== null && delta !== 0 ? (
                <span className="text-[var(--g-orcha)]">
                  {" "}
                  {delta > 0 ? "+" : "−"}
                  {Math.abs(delta)}
                </span>
              ) : null}
            </p>
          </>
        ) : (
          <p className="text-xs text-muted">The time-lapse plays once there are a few days of points after the baseline. The worker records one a day.</p>
        )}
      </div>
    </section>
  );
}
