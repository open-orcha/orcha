import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useMeasuredReserve } from "./use-measured-reserve";
import { ChevronLeft, ChevronRight, ImageOff, Pause, Play } from "../../map/kit/icons";
import { Button } from "../../map/kit";
import { severityDot } from "../../map/kit";
import { LiveBadge } from "../check/live-badge";
import { StatusGlyph } from "../../map/kit";
import { verdictDot } from "../check/verdict-icon";
import { fmtMs } from "../../map/kit";
import { staleBannerTone } from "../lib/stale";
import type { ScenarioOutcome, TargetKind } from "../types";
import { cn } from "../../map/kit";
import { WITHHELD_FRAME_NOTE } from "../lib/withheld-frame";
import {
  DESKTOP_FALLBACK,
  duoFallbackSizeFor,
  duoOrientationFromSize,
  frameScreenSize,
  isDuoDeviceName,
  isTabletStyle,
  resolveDuoPosture,
  type DeviceFrameStyle,
  type DuoPosture,
  type FrameHints,
} from "../lib/device-frame";
import {
  DeviceBezel,
  DeviceFrameSelect,
  DuoPostureChip,
  useFrameStyle,
} from "./device-bezel";
import { FrameCanvas } from "./frame-canvas";
import { BrowserFrame } from "./browser-frame";
import { addressLabel } from "./media-frame";
import type { Frame, Pin } from "./model";
import { prefetchSignedUrls, signPath } from "./use-signed-url";

const SPEEDS = [1, 2, 4, 8] as const;
const BASE_INTERVAL_MS = 800;

// Vertical chrome around the device frame in the replay column, so the frame's height cap
// leaves room for it instead of pushing the frame's bottom off-screen. Normal mode reserves
// the page header, the pane's own header row, the scrubber/time row, the controls row, the
// optional legacy/label caption and pane padding/gaps (measured ~212px at 1728×1117 on the
// Steps tab); live mode has only the header row above the frame and no rows below it, but
// must also cover the Scenarios tab's extra tab-bar strip above the 3-column split (measured
// ~162px there). Both include a safety margin for slightly taller browser chrome.
const NORMAL_RESERVE_PX = 240;
const LIVE_RESERVE_PX = 180;
// What sits below the frame: scrubber, time and controls rows and padding (normal), or only
// padding (live). Added to where the frame actually starts on screen.
const NORMAL_BELOW_PX = 120;
const LIVE_BELOW_PX = 28;



/** A scrubber marker coloured by scenario-criterion outcome rather than finding severity. */
export interface CriterionPin {
  frameIndex: number;
  outcome: ScenarioOutcome;
  label: string;
}

const outcomeVerdictKey: Record<ScenarioOutcome, keyof typeof verdictDot> = {
  pass: "passed",
  fail: "failed",
  warning: "warning",
  blocked: "unprocessable",
  unprocessable: "unprocessable",
  inconclusive: "inconclusive",
  needs_setup: "needs_setup",
  running: "running",
};

/** Live-mode data: the newest streamed frame while a run is still executing (spec §3 "Live mode"). */
export interface LiveReplayState {
  framePath: string | null;
  atMs: number;
  stepCount: number;
  /**
   * Minutes since the last step/result arrived (stall-detection §2), or null before the
   * first tick. The banner shows from 2 min, turning to a warning tone from 5 min — well
   * before the worker's own stall timeout (15 min) gives up on the run.
   */
  staleMinutes?: number | null;
}

export interface ReplayProps {
  frames: readonly Frame[];
  pins: readonly Pin[];
  /** Scenario-criterion markers, coloured by outcome; shown alongside `pins`. */
  criterionPins?: readonly CriterionPin[];
  index: number;
  onIndexChange: (index: number) => void;
  kind: TargetKind;
  screenW: number | null;
  screenH: number | null;
  /** The run's device name (`run.device_name`) — lets "Auto" (and an explicit "iPhone"
   * choice) resolve to the Duo's own bezel when this run was captured on one. */
  deviceName?: string | null;
  /** `runs.duo_posture` (once the run row has one) — the fold state this run was actually
   * recorded in. Reconciled against the capture's own size by `resolveDuoPosture`, which wins
   * whenever they disagree (e.g. a run finished before this landed on the row). */
  duoPosture?: DuoPosture | null;
  /** Live mode only: the *request's* `duo_posture`, used until the run row has its own — a
   * run still in progress has no `runs.duo_posture` yet. */
  requestDuoPosture?: DuoPosture | null;
  /** `runs.device` / `run_requests.device` — a stored form factor there settles phone vs
   * tablet when the device name does not. */
  device?: unknown;
  /** `runs.orientation` (migration 009): orients the frame until a capture has loaded. */
  orientation?: "portrait" | "landscape" | null;
  /** Evidence-only sequence (runs synced without step frames). */
  legacy: boolean;
  /** Text shown in the placeholder when the frame is missing. */
  placeholderText?: string;
  /**
   * Present while the run is still executing: shows the LIVE badge, the
   * newest frame, elapsed time and step count, and disables scrubbing.
   */
  live?: LiveReplayState;
  /** A web run's page address (the target URL, or the live step's page): the browser frame's
   * address bar. A replayed frame shows its own page instead. */
  address?: string | null;
  className?: string;
}

/**
 * Replay pane: device frame with the current image, scrubber with severity
 * pins, play/pause + speeds, prev/next. Keyboard: ← → step, space toggles play.
 * In `live` mode it shows the newest streamed frame instead (no scrubbing).
 */
export function Replay({
  frames,
  pins,
  criterionPins = [],
  index,
  onIndexChange,
  kind,
  screenW,
  screenH,
  deviceName,
  duoPosture,
  requestDuoPosture,
  device,
  orientation,
  legacy,
  placeholderText,
  live,
  address,
  className,
}: ReplayProps) {
  const [playing, setPlaying] = useState(false);
  const [frameSlotRef, frameReserve] = useMeasuredReserve(live ? LIVE_RESERVE_PX : NORMAL_RESERVE_PX, live ? LIVE_BELOW_PX : NORMAL_BELOW_PX);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const count = frames.length;
  const last = Math.max(0, count - 1);
  const safeIndex = Math.min(Math.max(0, index), last);
  const frame = frames[safeIndex];

  // Playback: each tick schedules the next frame (800ms ÷ speed); stops at the end.
  useEffect(() => {
    if (!playing || count === 0) return;
    if (safeIndex >= last) {
      const stop = setTimeout(
        () => setPlaying(false),
        BASE_INTERVAL_MS / speed,
      );
      return () => clearTimeout(stop);
    }
    const t = setTimeout(
      () => onIndexChange(safeIndex + 1),
      BASE_INTERVAL_MS / speed,
    );
    return () => clearTimeout(t);
  }, [playing, speed, count, last, safeIndex, onIndexChange]);

  // Warm signed URLs + image cache for the frames ahead.
  useEffect(() => {
    const ahead = frames.slice(safeIndex + 1, safeIndex + 4).map((f) => f.path);
    prefetchSignedUrls(ahead);
    for (const p of ahead) {
      void signPath(p)
        .then((url) => {
          const img = new Image();
          img.src = url;
        })
        .catch(() => undefined);
    }
  }, [frames, safeIndex]);

  useEffect(() => {
    prefetchSignedUrls(frames.map((f) => f.path));
  }, [frames]);

  // Keyboard shortcuts (ignored while typing or on focused controls).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // A focused tablist already used the arrow to move between tabs; don't also step.
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName ?? "";
      // Never steal keys from text entry / native controls that use them.
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag) || t?.isContentEditable)
        return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        onIndexChange(Math.max(0, safeIndex - 1));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        onIndexChange(Math.min(last, safeIndex + 1));
      } else if (e.key === " " && !["BUTTON", "A"].includes(tag)) {
        // Space on a focused button/link activates it natively; don't double up.
        e.preventDefault();
        setPlaying((p) => !p);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [last, safeIndex, onIndexChange]);

  // `?? ` alone would keep a falsy-but-present `0` (e.g. an early live run
  // whose screen size hasn't been detected yet) and collapse the aspect-ratio
  // box to zero height, leaving what looks like a totally blank frame.
  //
  // A Duo run needs its own fallback here: the generic "assume a plain iPhone" guess
  // (402/874) is a ~0.46 ratio, but even the Duo's *closed* cover display is ~0.69 wide and
  // its open panel wider still — sizing the aspect box to a plain phone made a live Duo run
  // (no `screen_w`/`screen_h` in the `runs` row yet) draw its actual capture, `object-cover`,
  // into a box far taller and narrower than the image, cropping both sides. The posture used
  // for that fallback is the run's own (`duoPosture`), falling back to the request's
  // (`requestDuoPosture`) while a live run has no run-row posture yet, and finally "closed" —
  // never a viewer preference, since a run may only ever be shown in the posture it was
  // actually recorded in.
  const isDuo = kind === "ios" && isDuoDeviceName(deviceName);
  const effectiveDuoPosture = duoPosture ?? requestDuoPosture ?? "closed";
  const duoFallback = isDuo
    ? duoFallbackSizeFor(effectiveDuoPosture, "landscape")
    : null;
  // The frame on screen's own pixel size, once one has loaded: the truth about the capture.
  // `screen_w`/`screen_h` is not — an iPhone-only app on an iPad reports its 390×844 window
  // while every frame is the iPad's full 2064×2752 screen — and a live run has none yet.
  const [loaded, setLoaded] = useState<{ w: number; h: number } | null>(null);
  const onFrameSize = useCallback((size: { w: number; h: number }) => {
    setLoaded((prev) => (prev && prev.w === size.w && prev.h === size.h ? prev : size));
  }, []);
  const hints: FrameHints = {
    device,
    screenW: loaded?.w ?? screenW,
    screenH: loaded?.h ?? screenH,
  };
  const style = useFrameStyle(kind, deviceName, hints);
  const tablet = isTabletStyle(style);
  // Plain phones and tablets size from the loaded frame, then the run row, then a fallback
  // oriented by `runs.orientation`; the Duo, web and desktop keep their own sizing.
  const mobileSize =
    !isDuo && (kind === "ios" || kind === "android")
      ? frameScreenSize({ style, loaded, screenW, screenH, runOrientation: orientation })
      : null;
  const w = mobileSize?.w ?? (screenW || duoFallback?.w || (kind === "web" ? 1280 : kind === "desktop" ? DESKTOP_FALLBACK.w : 402));
  const h = mobileSize?.h ?? (screenH || duoFallback?.h || (kind === "web" ? 800 : kind === "desktop" ? DESKTOP_FALLBACK.h : 874));
  // Never crop while the box can still be a guess: a Duo, a desktop window and a tablet (whose
  // run size may describe a compatibility-mode window) letterbox instead.
  const fit = isDuo || tablet || kind === "desktop" ? "contain" : "cover";
  const resolvedPosture = isDuo ? resolveDuoPosture(effectiveDuoPosture, w, h) : null;
  const resolvedOrientation = isDuo ? duoOrientationFromSize(w, h) : null;

  return (
    <div
      data-replay
      data-replay-mode={live ? "live" : "normal"}
      className={cn(
        "flex flex-col items-center gap-3 border-r border-border bg-panel-2 p-4.5",
        className,
      )}
    >
      {live ? (
        <div className="flex w-full flex-col gap-1.5">
          <div className="flex w-full items-center justify-between gap-2">
            <LiveBadge />
            {isDuo && resolvedPosture && resolvedOrientation ? (
              <DuoPostureChip
                posture={resolvedPosture}
                orientation={resolvedOrientation}
                className="ml-auto"
              />
            ) : (
              <DeviceFrameSelect kind={kind} deviceName={deviceName} hints={hints} className="ml-auto" />
            )}
            <span
              className="font-mono text-xs tabular text-muted"
              data-replay-live-meta
              // The elapsed clock starts from Date.now() on the server and again on the client, so
              // the seconds can differ by one at hydration; the next tick corrects it.
              suppressHydrationWarning
            >
              {fmtMs(live.atMs)} · {live.stepCount}{" "}
              {live.stepCount === 1 ? "step" : "steps"}
            </span>
          </div>
          {(() => {
            const tone = staleBannerTone(live.staleMinutes);
            return tone ? (
              <p
                className="flex items-center gap-1.5 text-xs text-fg"
                data-replay-stale-banner
                data-tone={tone}
              >
                <StatusGlyph status={tone === "danger" ? "fail" : "warning"} decorative className="size-3" />
                No activity for {live.staleMinutes} min
              </p>
            ) : null;
          })()}
        </div>
      ) : kind !== "web" && kind !== "desktop" ? (
        <div className="flex w-full items-center justify-end">
          {isDuo && resolvedPosture && resolvedOrientation ? (
            <DuoPostureChip posture={resolvedPosture} orientation={resolvedOrientation} />
          ) : (
            <DeviceFrameSelect kind={kind} deviceName={deviceName} hints={hints} />
          )}
        </div>
      ) : null}

      <div ref={frameSlotRef} className="w-full" data-replay-frame-slot>
      <DeviceFrame
        kind={kind}
        aspect={`${w} / ${h}`}
        style={style}
        duoPosture={resolvedPosture ?? undefined}
        reserve={frameReserve}
        address={(live ? null : addressLabel(frame?.label)) ?? addressLabel(address)}
      >
        {live ? (
          live.framePath ? (
            <LiveFrameImage path={live.framePath} fit={fit} onSize={onFrameSize} />
          ) : (
            <Placeholder text="Waiting for the first frame…" />
          )
        ) : frame ? (
          <FrameImage
            frame={frame}
            placeholderText={placeholderText}
            fit={fit}
            onSize={onFrameSize}
          />
        ) : (
          <Placeholder text="No frames for this run" />
        )}
      </DeviceFrame>
      </div>

      {live ? null : (
        <>
          <div className="flex w-full items-center gap-2.5 font-mono text-sm tabular text-muted">
            <span className="w-9 shrink-0 text-right" data-replay-time>
              {legacy ? safeIndex + 1 : fmtMs(frame?.atMs ?? 0)}
            </span>
            <Scrubber
              count={count}
              index={safeIndex}
              pins={pins}
              criterionPins={criterionPins}
              onChange={(i) => {
                setPlaying(false);
                onIndexChange(i);
              }}
            />
            <span className="w-9 shrink-0">
              {legacy ? count : fmtMs(frames[last]?.atMs ?? 0)}
            </span>
          </div>

          {/* A narrow pane wraps the speeds under the transport instead of pushing them out. */}
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                icon
                aria-label="Previous frame"
                title="Previous (←)"
                disabled={safeIndex <= 0}
                onClick={() => onIndexChange(safeIndex - 1)}
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="default"
                size="sm"
                icon
                aria-label={playing ? "Pause" : "Play"}
                title={playing ? "Pause (space)" : "Play (space)"}
                data-replay-play
                disabled={count < 2}
                onClick={() => {
                  if (!playing && safeIndex >= last) onIndexChange(0);
                  setPlaying((p) => !p);
                }}
              >
                {playing ? <Pause /> : <Play />}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon
                aria-label="Next frame"
                title="Next (→)"
                disabled={safeIndex >= last}
                onClick={() => onIndexChange(safeIndex + 1)}
              >
                <ChevronRight />
              </Button>
              <span
                className="ml-1 font-mono text-xs tabular text-muted"
                data-replay-index
                title={count === 0 ? undefined : `Screen ${safeIndex + 1} of the ${count} the agent read (the Steps tab also lists its actions)`}
              >
                {count === 0 ? "0 / 0" : `${safeIndex + 1} / ${count}`}
              </span>
            </div>
            <div
              className="ml-auto flex items-center gap-1"
              role="radiogroup"
              aria-label="Playback speed"
            >
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={speed === s}
                  onClick={() => setSpeed(s)}
                  className={cn(
                    "h-5 rounded-md border border-border px-1.5 text-xs leading-none transition-colors",
                    speed === s
                      ? "bg-hover text-fg"
                      : "text-muted hover:text-fg",
                  )}
                >
                  {s}×
                </button>
              ))}
            </div>
          </div>

          {legacy && count > 0 ? (
            <p className="w-full text-xs text-muted" data-replay-legacy>
              Legacy run: evidence only. This run was synced without step
              frames, so the evidence screenshots stand in for the timeline.
            </p>
          ) : legacy ? (
            <p className="w-full text-xs text-muted" data-replay-nothing>
              Nothing was recorded: the run stopped before its first step.
            </p>
          ) : null}
          {frame ? (
            <p
              className="w-full truncate text-xs text-muted"
              title={frame.label}
            >
              {legacy ? `E${frame.seq} · ` : `step ${frame.seq} · `}
              {frame.label}
            </p>
          ) : null}
          {frame?.withheld ? (
            <p className="w-full text-xs text-muted" data-replay-withheld>
              {WITHHELD_FRAME_NOTE}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function DeviceFrame({
  kind,
  aspect,
  style,
  duoPosture,
  reserve,
  address,
  children,
}: {
  kind: TargetKind;
  /** A web run's address bar (`addressLabel`). */
  address?: string | null;
  aspect: string;
  /** The resolved bezel (`useFrameStyle`), resolved once by `Replay` for the picker and this. */
  style: DeviceFrameStyle;
  /** The run's resolved Duo posture (`resolveDuoPosture`'s result) — a run's own fact, not a
   * viewer choice, so the bezel that draws it needs no per-run persistence. */
  duoPosture?: DuoPosture;
  /** Vertical space (px) taken by chrome above/below the frame in the column. */
  reserve: number;
  children: ReactNode;
}) {
  if (kind === "web") {
    return (
      <BrowserFrame aspect={aspect} reserve={reserve} address={address}>
        {children}
      </BrowserFrame>
    );
  }
  return (
    <DeviceBezel style={style} aspect={aspect} reserve={reserve} duoPosture={duoPosture}>
      {children}
    </DeviceBezel>
  );
}

/**
 * A stepped frame. `FrameCanvas` holds the previous frame until the next one has decoded, so
 * stepping does not blink through the background — see its own docstring for why the plain
 * `<img src={signedUrl}>` it replaced flashed on every step.
 *
 * The placeholder is shown only once a frame has actually failed, never merely because the
 * next URL has not arrived yet: "not signed yet" was the state that produced the flash.
 */
function FrameImage({
  frame,
  placeholderText,
  fit,
  onSize,
}: {
  frame: Frame;
  placeholderText?: string;
  /** The loaded frame's natural size, so the bezel can follow the capture. */
  onSize?: (size: { w: number; h: number }) => void;
  /** `"contain"` on a Duo run so the image is never cropped while the box's aspect can still
   * be a fallback guess (see the `w`/`h` computation above `DeviceFrame`'s render). */
  fit?: "cover" | "contain";
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const onUnavailable = useCallback(() => setBroken(frame.path), [frame.path]);
  if (broken === frame.path) return <Placeholder text={placeholderText ?? frame.label} />;
  return (
    <FrameCanvas path={frame.path} alt={frame.label} onUnavailable={onUnavailable} fit={fit} onSize={onSize} />
  );
}

/** Live-mode frame: the same no-flash canvas, fed by whatever the newest frame path is. */
function LiveFrameImage({
  path,
  fit,
  onSize,
}: {
  path: string;
  fit?: "cover" | "contain";
  onSize?: (size: { w: number; h: number }) => void;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const onUnavailable = useCallback(() => setBroken(path), [path]);
  if (broken === path) return <Placeholder text="frame unavailable" />;
  return <FrameCanvas path={path} alt="live frame" onUnavailable={onUnavailable} fit={fit} onSize={onSize} />;
}

function Placeholder({ text }: { text: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-panel-2 px-4 text-center text-muted">
      <ImageOff className="size-4" strokeWidth={1.5} aria-hidden />
      <span className="text-xs">frame missing</span>
      <span className="line-clamp-3 text-xs">{text}</span>
    </div>
  );
}

function Scrubber({
  count,
  index,
  pins,
  criterionPins = [],
  onChange,
}: {
  count: number;
  index: number;
  pins: readonly Pin[];
  criterionPins?: readonly CriterionPin[];
  onChange: (index: number) => void;
}) {
  const last = Math.max(1, count - 1);
  const pct = (i: number) => (count <= 1 ? 0 : (i / last) * 100);
  return (
    <div className="relative flex h-5 flex-1 items-center">
      <div className="relative h-1 w-full rounded-full bg-border">
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-accent"
          style={{ width: `${pct(index)}%` }}
        />
        {pins.map((p, i) => (
          <span
            key={`sev-${i}`}
            title={p.label}
            data-replay-pin
            className={cn(
              "absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-panel-2",
              severityDot[p.severity],
            )}
            style={{ left: `${pct(p.frameIndex)}%` }}
          />
        ))}
        {criterionPins.map((p, i) => (
          <span
            key={`crit-${i}`}
            title={p.label}
            data-replay-criterion-pin
            className={cn(
              "absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-panel-2",
              verdictDot[outcomeVerdictKey[p.outcome]],
            )}
            style={{ left: `${pct(p.frameIndex)}%` }}
          />
        ))}
      </div>
      <input
        type="range"
        aria-label="Frame"
        min={0}
        max={last}
        step={1}
        value={Math.min(index, last)}
        disabled={count <= 1}
        onChange={(e) => onChange(Number(e.target.value))}
        data-replay-scrubber
        className={cn(
          "absolute inset-0 m-0 w-full cursor-pointer appearance-none bg-transparent disabled:cursor-default",
          "[&::-webkit-slider-runnable-track]:h-5 [&::-webkit-slider-runnable-track]:bg-transparent",
          "[&::-webkit-slider-thumb]:mt-1 [&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-panel-2 [&::-webkit-slider-thumb]:bg-accent",
          "[&::-moz-range-track]:bg-transparent [&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-panel-2 [&::-moz-range-thumb]:bg-accent",
        )}
      />
    </div>
  );
}
