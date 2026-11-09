import { useCallback, useEffect, useRef, useState } from "react";
import { Maximize2, Pause, Play, Video } from "../../map/kit/icons";
import { Empty, fmtMs } from "../../map/kit";
import {
  DESKTOP_FALLBACK,
  duoFallbackSizeFor,
  duoOrientationFromSize,
  frameScreenSize,
  isTabletStyle,
  resolveDuoPosture,
  screenAspect,
  type DuoPosture,
} from "../lib/device-frame";
import type { TargetKind } from "../types";
import { DeviceBezel, useFrameStyle } from "./device-bezel";
import { FrameCanvas } from "./frame-canvas";
import type { Frame } from "./model";
import { prefetchSignedUrls, urlFor } from "./use-signed-url";
import { useMeasuredReserve } from "./use-measured-reserve";
import { BrowserFrame } from "./browser-frame";
import { addressLabel, mediaFrameFor } from "./media-frame";

/**
 * A run's recording, in the same device frame the step player uses.
 *
 * The step player beside this shows what each step *looked* like, one press at a time; this plays
 * the run through at the pace it happened. A session stores no video, so the picture is its stored
 * frames, each held from its own timestamp until the next one: the same transport, timeline and
 * scrubbing a video would have, with long waits between screens compressed so a quiet minute does
 * not play as a still.
 *
 * The bezel is the same `DeviceBezel` the replay uses: a bare rectangle of device video reads as a
 * screenshot of nothing in particular, while the frame says "this is a phone" before anyone reads
 * a word.
 */

/** The longest one frame holds on screen when played at 1×. */
const MAX_HOLD_MS = 3000;
const SPEEDS = [1, 2, 4] as const;
const TICK_MS = 50;

/** Each frame's start on the played timeline: its real gap to the next, capped at `MAX_HOLD_MS`. */
export function playbackTimes(frames: readonly Pick<Frame, "atMs">[]): number[] {
  const out: number[] = [];
  let at = 0;
  frames.forEach((f, i) => {
    out.push(at);
    const next = frames[i + 1]?.atMs;
    const gap = next != null && f.atMs != null ? Math.max(0, next - f.atMs) : 800;
    at += Math.min(MAX_HOLD_MS, Math.max(120, gap));
  });
  return out;
}

/** The frame on screen at played time `t`. */
export function frameAt(times: readonly number[], t: number): number {
  let idx = 0;
  for (let i = 0; i < times.length; i++) {
    if (times[i] <= t) idx = i;
    else break;
  }
  return idx;
}

function FramePlayer({ frames, fit, onSize }: { frames: readonly Frame[]; fit: "cover" | "contain"; onSize: (size: { w: number; h: number }) => void }) {
  const times = useRef<number[]>([]);
  times.current = playbackTimes(frames);
  const total = (times.current[times.current.length - 1] ?? 0) + 800;
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const shell = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setAt((t) => {
        const next = t + TICK_MS * speed;
        if (next >= total) {
          setPlaying(false);
          return total;
        }
        return next;
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [playing, speed, total]);

  const index = frameAt(times.current, at);
  const frame = frames[index];
  useEffect(() => {
    prefetchSignedUrls(frames.slice(index + 1, index + 4).map((f) => f.path));
  }, [frames, index]);

  return (
    <div ref={shell} className="group/video absolute inset-0 bg-black" data-frame-player>
      {frame ? <FrameCanvas path={frame.path} alt={frame.label} fit={fit} onSize={onSize} onUnavailable={noop} /> : null}
      <div className="absolute inset-x-0 bottom-0 z-10 flex items-center gap-2 bg-[linear-gradient(to_top,rgb(0_0_0/0.7),transparent)] px-2.5 pb-1.5 pt-6 text-white" data-frame-player-controls>
        <button
          type="button"
          aria-label={playing ? "Pause" : "Play"}
          className="grid size-6 shrink-0 place-items-center rounded hover:bg-white/15"
          onClick={() => {
            if (!playing && at >= total) setAt(0);
            setPlaying((p) => !p);
          }}
          data-frame-player-play
        >
          {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        </button>
        <span className="shrink-0 font-mono text-xs tabular" data-frame-player-time>
          {fmtMs(frame?.atMs ?? 0)}
        </span>
        <input
          type="range"
          aria-label="Seek"
          min={0}
          max={total}
          step={10}
          value={Math.min(at, total)}
          onChange={(e) => {
            setPlaying(false);
            setAt(Number(e.target.value));
          }}
          className="h-1 min-w-0 flex-1 cursor-pointer accent-white"
          data-frame-player-seek
        />
        <span className="shrink-0 font-mono text-xs tabular">{fmtMs(frames[frames.length - 1]?.atMs ?? 0)}</span>
        <button
          type="button"
          aria-label={`Speed ${speed} times`}
          className="h-6 shrink-0 rounded px-1 font-mono text-xs tabular hover:bg-white/15"
          onClick={() => setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length])}
          data-frame-player-speed
        >
          {speed}×
        </button>
        <button
          type="button"
          aria-label="Full screen"
          className="grid size-6 shrink-0 place-items-center rounded hover:bg-white/15"
          onClick={() => void shell.current?.requestFullscreen?.()}
        >
          <Maximize2 className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

const noop = () => undefined;

export function RunVideo({
  frames,
  kind,
  deviceName,
  device,
  duoPosture: runDuoPosture,
  screenW,
  screenH,
  posterPath = null,
  address = null,
}: {
  /** The session's stored frames, oldest first. */
  frames: readonly Frame[];
  kind: TargetKind;
  /** The run's device name (`run.device_name`) — lets a Duo recording draw the Duo bezel
   * instead of the default iPhone one once "Auto" resolves it. */
  deviceName?: string | null;
  /** `runs.device` — a stored form factor there settles phone vs tablet when the name does not. */
  device?: unknown;
  /** `runs.duo_posture` — the fold state this run was actually recorded in. A run may only
   * ever be shown in the posture it was recorded in, so this drives the bezel directly rather
   * than through any viewer choice. */
  duoPosture?: DuoPosture | null;
  /** The run's captured resolution (`run.screen_w`/`run.screen_h`), so the poster starts in
   * the right proportions instead of the generic phone guess until the video's own metadata
   * loads and corrects it (see `onMetadata` below). */
  screenW?: number | null;
  screenH?: number | null;
  /** A step frame to show before play (`posterFramePath`), so the video is never a black box. */
  posterPath?: string | null;
  /** A web run's page address, for the browser frame's address bar. */
  address?: string | null;
}) {
  // The recording's own size, once its metadata has loaded: the truth about the capture.
  const [videoSize, setVideoSize] = useState<{ w: number; h: number } | null>(null);
  // The frame fits the height left below where it starts (the theater stacks chrome above it).
  const [frameSlotRef, frameReserve] = useMeasuredReserve(150, 60);
  const frameStyle = useFrameStyle(kind, deviceName, {
    device,
    screenW: videoSize?.w ?? screenW,
    screenH: videoSize?.h ?? screenH,
  });
  const mediaFrame = mediaFrameFor(kind, frameStyle, { w: videoSize?.w ?? screenW, h: videoSize?.h ?? screenH });
  const tablet = isTabletStyle(frameStyle) || (mediaFrame !== "browser" && isTabletStyle(mediaFrame));
  const isDuoStyle =
    frameStyle === "iphone-duo" || frameStyle === "iphone-duo-open" || frameStyle === "iphone-duo-closed";
  // A Duo run with no `screen_w`/`screen_h` yet (e.g. recorded before capture stored it, or
  // still running) falls back to a size for its recorded posture rather than a plain phone
  // guess, so the poster starts in roughly the right shape until the video's own metadata
  // corrects it below.
  const duoPosture = resolveDuoPosture(runDuoPosture, screenW, screenH);
  const duoOrientation = duoOrientationFromSize(screenW, screenH);
  const fallbackAspect = isDuoStyle
    ? (() => {
        const { w, h } = duoFallbackSizeFor(duoPosture, duoOrientation);
        return `${w} / ${h}`;
      })()
    : kind === "web"
      ? "16 / 10"
      : kind === "desktop"
        ? `${DESKTOP_FALLBACK.w} / ${DESKTOP_FALLBACK.h}`
        : "9 / 19.5";
  const [aspect, setAspect] = useState(() => {
    // A plain phone or tablet: a tablet whose run size is a compatibility-mode app window
    // (390×844 on an iPad) must not start in that phone shape — see `frameScreenSize`.
    if (!isDuoStyle && (kind === "ios" || kind === "android")) {
      const { w, h } = frameScreenSize({ style: frameStyle, screenW, screenH });
      return `${w} / ${h}`;
    }
    return screenAspect(screenW, screenH, fallbackAspect);
  });
  const onFrameSize = useCallback((size: { w: number; h: number }) => {
    setVideoSize((prev) => (prev && prev.w === size.w && prev.h === size.h ? prev : size));
    setAspect(`${size.w} / ${size.h}`);
  }, []);

  if (frames.length === 0) {
    return (
      <Empty
        icon={Video}
        title="No frames for this run"
        description="It stopped before its first screen, or its screens could not be stored."
        className="min-h-[240px] rounded-lg border border-dashed border-border"
      />
    );
  }

  // Re-resolve the posture against whatever `aspect` currently is (the fallback until the
  // video's `onLoadedMetadata` fires, the real resolution after) rather than the original
  // `screenW`/`screenH` props, so a stale fallback never disagrees with what's on screen.
  const [aspectW, aspectH] = aspect.split(" / ").map(Number);
  const liveDuoPosture = isDuoStyle ? resolveDuoPosture(duoPosture, aspectW, aspectH) : duoPosture;

  // Until a frame has loaded, `aspect` may still be the style-appropriate fallback rather than the
  // capture's real size, so a Duo, a browser and a tablet are never cropped to fit.
  const fit = mediaFrame === "browser" || isDuoStyle || tablet ? "contain" : "cover";
  const video = <FramePlayer frames={frames} fit={fit} onSize={onFrameSize} />;
  return (
    <div className="flex flex-col items-center gap-3 py-2" data-run-video>
      {/* Framed by the run's platform (`mediaFrameFor`): a web run in a browser window, a desktop
          one in a Mac window, a phone or tablet in its own bezel. */}
      <div ref={frameSlotRef} className="w-full" data-run-video-frame-slot>
        {mediaFrame === "browser" ? (
          <BrowserFrame aspect={aspect} reserve={frameReserve} address={addressLabel(address)}>
            {video}
          </BrowserFrame>
        ) : (
          <DeviceBezel style={mediaFrame} aspect={aspect} reserve={frameReserve} duoPosture={liveDuoPosture ?? undefined}>
            {video}
          </DeviceBezel>
        )}
      </div>
      {posterPath ? (
        <a
          href={urlFor(frames[frames.length - 1].path)}
          download
          className="text-xs text-muted underline-offset-2 hover:text-fg hover:underline"
          data-run-video-download
        >
          Download the last frame
        </a>
      ) : null}
    </div>
  );
}
