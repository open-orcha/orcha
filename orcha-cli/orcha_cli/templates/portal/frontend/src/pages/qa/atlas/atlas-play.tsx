import { ArrowRight, ChevronLeft, ChevronRight, Maximize2, Pause, Play, RotateCcw, X } from "../map/kit/icons";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { PlatformIcon } from "../map/kit";
import { fmtRelative } from "../map/kit";
import { cn } from "../map/kit";
import styles from "./atlas.module.css";
import { areaSummary, PLATFORM_WORD, type AreaRow, type Shapes } from "./model";
import { areaStart, cameraAt, HOLD_MS, playScale, playSteps, STEP_GAP, stepWords, trackOf, type PlayStep } from "./play";
import play from "./play.module.css";
import { DeviceFrame } from "./screen-card";
import type { Atlas, Platform } from "./types";

/** Steps this far either side of the one on screen are drawn; the rest of the track is empty. */
const WINDOW = 3;
/** Room the stage leaves for the bar on top, the caption and the rail under it. */
const CHROME_H = 250;

const still = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function place(k: number, i: number): "current" | "near" | "far" {
  return k === i ? "current" : Math.abs(k - i) === 1 ? "near" : "far";
}

/** One step on the track: a screen's screenshots side by side, an area's title card, or the end. */
function Slide({ step, scale, name }: { step: PlayStep; scale: number; name: string }) {
  if (step.kind === "area") {
    return (
      <div className={play.areaCard}>
        <span className={play.areaNum}>{String(step.index).padStart(2, "0")}</span>
        <span className={play.areaName}>{step.area.name}</span>
        <span className={play.areaWords}>
          {step.shown} of {step.screens} {step.screens === 1 ? "screen" : "screens"} seen live
        </span>
      </div>
    );
  }
  if (step.kind === "end") {
    return (
      <div className={cn(play.areaCard, play.endCard)}>
        <span className={play.areaName}>That was {name}</span>
        <span className={play.areaWords}>
          {step.screens} {step.screens === 1 ? "screen" : "screens"} in {step.areas} {step.areas === 1 ? "area" : "areas"}, as runs saw them
        </span>
      </div>
    );
  }
  return (
    <div className={play.shots}>
      {step.shots.map((s) => (
        <div key={s.platform} className={play.shotWrap}>
          <DeviceFrame platform={s.platform} kind={s.kind} src={s.src} shot={s.shot} name={step.screen.name} route={step.screen.route} presence="seen" scale={scale} eager caption={false} />
        </div>
      ))}
    </div>
  );
}

/**
 * "Play the app": a guided tour of the storyboard as it is filtered. The camera pans along one
 * track, area by area: each area's title card, then its screens in the order a person walks them,
 * each lit as the camera reaches it (its screenshots develop in and drift a little while it
 * holds), the move that leads from the one before named on the arrow between them when the app's
 * flows have one. A rail of the areas under it shows how far the tour is; a click on an area jumps
 * there. Space plays and pauses, the arrows step, Escape leaves. Only screens runs have seen are
 * on the tour, and nothing is made up: a move the flows do not have is an unlabelled line.
 *
 * It pauses when the tab is hidden. Under reduced motion it does not play by itself and the camera
 * cuts instead of panning; the arrows and buttons step through the same tour.
 */
export function AtlasPlay({
  atlas,
  rows,
  platforms,
  shapes,
  onClose,
  onOpenScreen,
}: {
  atlas: Atlas;
  rows: readonly AreaRow[];
  platforms: readonly Platform[];
  shapes: Shapes;
  onClose: () => void;
  onOpenScreen: (id: string) => void;
}) {
  const steps = useMemo(() => playSteps(atlas, rows, platforms, shapes), [atlas, rows, platforms, shapes]);
  const total = steps.filter((s) => s.kind === "screen").length;
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(() => !still());
  const [view, setView] = useState(() => ({ w: typeof window === "undefined" ? 1280 : window.innerWidth, h: typeof window === "undefined" ? 800 : window.innerHeight }));
  const ref = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);

  const allShots = useMemo(() => steps.flatMap((s) => (s.kind === "screen" ? s.shots : [])), [steps]);
  const scale = playScale(Math.max(220, view.h - CHROME_H), allShots);
  const track = useMemo(() => trackOf(steps, scale), [steps, scale]);
  const step = steps[i] ?? null;
  const last = steps.length - 1;

  const go = useCallback((k: number) => setI(Math.max(0, Math.min(last, k))), [last]);

  // The dialog opens modal (the top layer, focus kept inside), and the stage is measured.
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal?.();
    const box = stage.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => setView({ w: Math.round(e.contentRect.width), h: Math.round(window.innerHeight) }));
    ro.observe(box);
    return () => ro.disconnect();
  }, []);

  // Playing: each step holds, then the camera moves on; the end stops it.
  useEffect(() => {
    if (!playing || !step || step.kind === "end") return;
    const t = window.setTimeout(() => {
      setI((k) => {
        const next = Math.min(last, k + 1);
        if (steps[next]?.kind === "end") setPlaying(false);
        return next;
      });
    }, HOLD_MS[step.kind]);
    return () => window.clearTimeout(t);
  }, [playing, step, last, steps]);

  // A hidden tab pauses the tour.
  useEffect(() => {
    const hide = () => {
      if (document.hidden) setPlaying(false);
    };
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, []);

  const onKey = (e: KeyboardEvent<HTMLDialogElement>) => {
    const tag = (e.target as HTMLElement).tagName;
    if (e.key === "ArrowRight") go(i + 1);
    else if (e.key === "ArrowLeft") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(last);
    else if (e.key === " " && tag !== "BUTTON") setPlaying((p) => !p);
    else return;
    e.preventDefault();
  };

  const replay = () => {
    setI(0);
    setPlaying(!still());
  };

  // The rail: one segment per area, as long as its steps, filled up to where the tour is.
  const segments = useMemo(() => {
    const out: { key: string; name: string; from: number; to: number }[] = [];
    steps.forEach((s, k) => {
      if (s.kind === "area") out.push({ key: s.area.key, name: s.area.name, from: k, to: k });
      else if (s.kind === "screen" && out.length) out[out.length - 1].to = k;
    });
    return out;
  }, [steps]);

  const camera = cameraAt(track, i, view.w);
  const words = step ? stepWords(step, total) : "";
  const screenStep = step?.kind === "screen" ? step : null;
  const areaOf = step && step.kind !== "end" ? step.area : null;
  const areaIndex = areaOf ? segments.findIndex((s) => s.key === areaOf.key) + 1 : 0;

  return (
    <dialog
      ref={ref}
      className={cn(styles.palette, play.theater)}
      aria-label={`Play the app: a tour of ${atlas.name ?? "the app"}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onKeyDown={onKey}
      data-paused={!playing || undefined}
      data-atlas-play-tour
    >
      <div className={play.top}>
        <div className="flex min-w-0 items-center gap-3">
          <span className={play.reel} aria-hidden data-on={playing || undefined}>
            <i />
            <i />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-fg">Play the app</p>
            <p className="truncate text-xs text-muted">
              {atlas.name ?? "The app"} · {total} {total === 1 ? "screen" : "screens"} seen live, area by area
            </p>
          </div>
        </div>
        <div className={play.controls}>
          <button type="button" className={play.icon} onClick={() => go(i - 1)} disabled={i === 0} aria-label="Previous step" title="Previous step (Left arrow)" data-atlas-play-prev>
            <ChevronLeft className="size-4" aria-hidden />
          </button>
          <button type="button" className={cn(play.icon, play.main)} onClick={() => (step?.kind === "end" ? replay() : setPlaying((p) => !p))} aria-label={playing ? "Pause" : "Play"} autoFocus data-atlas-play-toggle>
            {playing ? <Pause className="size-4 fill-current" aria-hidden /> : <Play className="size-4 fill-current" aria-hidden />}
          </button>
          <button type="button" className={play.icon} onClick={() => go(i + 1)} disabled={i === last} aria-label="Next step" title="Next step (Right arrow)" data-atlas-play-next>
            <ChevronRight className="size-4" aria-hidden />
          </button>
          {/* A screen's place among the tour's screens; on an area's title card, the area's. */}
          <span className={play.counter} aria-hidden>
            {step?.kind === "area" ? (
              <>
                Area {areaIndex}
                <span className="text-muted"> of {segments.length}</span>
              </>
            ) : (
              <>
                {screenStep ? screenStep.n : total}
                <span className="text-muted"> / {total}</span>
              </>
            )}
          </span>
        </div>
        <div className="flex items-center justify-end gap-2">
          {screenStep ? (
            <button type="button" className={cn(play.pill, play.pillQuiet)} onClick={() => onOpenScreen(screenStep.screen.id)} data-atlas-play-open>
              <Maximize2 className="size-3.5" aria-hidden /> Details
            </button>
          ) : null}
          <button type="button" className={play.icon} onClick={onClose} aria-label="Close the tour" data-atlas-play-close>
            <X className="size-4" aria-hidden />
          </button>
        </div>
      </div>

      <div ref={stage} className={play.stage}>
        <div className={play.spot} aria-hidden />
        <div className={play.track} style={{ transform: `translate3d(${camera}px, 0, 0)` }} aria-hidden>
          {steps.map((s, k) => {
            if (Math.abs(k - i) > WINDOW) return null;
            const next = steps[k + 1];
            const move = next?.kind === "screen" ? next.move : null;
            return (
              <div key={s.key}>
                <div
                  className={play.slide}
                  data-place={place(k, i)}
                  data-kind={s.kind}
                  style={{ left: track.x[k], width: track.w[k] }}
                  onClick={k !== i ? () => go(k) : undefined}
                >
                  <Slide step={s} scale={scale} name={atlas.name ?? "the app"} />
                </div>
                {next && k + 1 <= i + WINDOW ? (
                  <div className={play.link} data-into={k + 1 === i || undefined} data-moved={move ? "true" : undefined} style={{ left: track.x[k] + track.w[k], width: STEP_GAP }}>
                    <svg width={STEP_GAP} height="24" viewBox={`0 0 ${STEP_GAP} 24`}>
                      <path d={`M14,12 L${STEP_GAP - 20},12`} pathLength={1} className={play.linkLine} />
                      <path d={`M${STEP_GAP - 12},12 L${STEP_GAP - 20},7.5 L${STEP_GAP - 20},16.5 Z`} className={play.linkHead} />
                    </svg>
                    {move ? <span className={play.linkLabel}>{move}</span> : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      <div className={play.caption}>
        {step ? (
          <div key={step.key} className={play.captionIn}>
            {areaOf ? (
              <span className={play.captionArea}>
                <span className={play.areaChip}>{String(areaIndex).padStart(2, "0")}</span>
                {areaOf.name}
              </span>
            ) : null}
            {screenStep ? (
              <>
                <p className={play.captionName}>{screenStep.screen.name}</p>
                <p className={play.captionMeta}>
                  {screenStep.move ? (
                    <span className="inline-flex items-center gap-1 text-fg-2">
                      <ArrowRight className="size-3.5" aria-hidden />
                      {screenStep.move}
                    </span>
                  ) : null}
                  {screenStep.shots.map((s) => (
                    <span key={s.platform} className="inline-flex items-center gap-1">
                      <PlatformIcon kind={s.platform} className="size-3" />
                      {PLATFORM_WORD[s.platform]}
                    </span>
                  ))}
                  {screenStep.screen.last_seen_at ? <span>Seen {fmtRelative(screenStep.screen.last_seen_at)}</span> : null}
                </p>
              </>
            ) : step.kind === "area" ? (
              <p className={play.captionMeta}>{areaSummary(step.area.summary) ?? `${step.shown} ${step.shown === 1 ? "screen" : "screens"} to see here`}</p>
            ) : (
              <span className="flex flex-wrap justify-center gap-2">
                <button type="button" className={play.pill} onClick={replay} data-atlas-play-again>
                  <RotateCcw className="size-3.5" aria-hidden /> Play again
                </button>
                <button type="button" className={cn(play.pill, play.pillQuiet)} onClick={onClose}>
                  Back to the atlas
                </button>
              </span>
            )}
            {playing && step.kind !== "end" ? <span className={play.hold} style={{ "--hold": `${HOLD_MS[step.kind]}ms` } as CSSProperties} aria-hidden /> : null}
          </div>
        ) : null}
      </div>

      <nav className={play.rail} aria-label="Areas on the tour">
        {segments.map((seg, n) => {
          const done = i > seg.to ? 1 : i < seg.from ? 0 : (i - seg.from + 1) / (seg.to - seg.from + 1);
          return (
            <button
              key={seg.key}
              type="button"
              className={play.seg}
              style={{ flexGrow: seg.to - seg.from + 1 }}
              onClick={() => go(areaStart(steps, seg.key))}
              aria-current={i >= seg.from && i <= seg.to ? "step" : undefined}
              aria-label={`${String(n + 1).padStart(2, "0")} ${seg.name}`}
              title={seg.name}
            >
              <span className={play.segTrack}>
                <span className={play.segFill} style={{ transform: `scaleX(${done})` }} />
              </span>
              <span className={play.segName}>{seg.name}</span>
            </button>
          );
        })}
      </nav>
      <p className="sr-only" aria-live="polite" data-atlas-play-words>
        {words}
      </p>
    </dialog>
  );
}
