import { useEffect, useState, type ReactNode } from "react";
import { ArrowUpRight, Pause, Play } from "../../map/kit/icons";
import { Link, StatusGlyph, buttonVariants, cn } from "../../map/kit";
import { qaHref } from "../../parts";
import { frameUrl } from "../../qaApi";
import { DeviceBezel, heightCapStyle, useFrameStyle } from "../../runs/replay/device-bezel";
import { BufferedImage } from "../../runs/replay/buffered-image";
import {
  DESKTOP_FALLBACK,
  duoFallbackSizeFor,
  frameScreenSize,
  isTabletStyle,
  tabletChromeGeometry,
  type DeviceFrameStyle,
} from "../../runs/lib/device-frame";
import type { PassFrame } from "./lib/draft-sources";
import { RunPlacement, type Placement } from "./run-placement";

// Vertical chrome around the frame in this card: the status/label row above it and the
// "N steps" caption below, plus gaps — kept small since the card itself sits inline in a
// page rather than filling a fixed-height column.
const PEEK_RESERVE_PX = 70;
/** A replay step's time on screen while playing. */
const PLAY_MS = 700;

/**
 * One frame in the bezel of the run's platform: a phone for iOS / Android, a browser window
 * for the web. The bezel follows the placement, never a device of another platform.
 */
export function FrameView({
  placement,
  path,
  fit = false,
  device,
}: {
  placement: Placement;
  path: string | null;
  /** The run's device record, for the phone-vs-tablet pick. */
  device?: unknown;
  /** Fill the space the parent leaves (a flex column of definite height): the whole frame is
   * scaled to fit it, by width or by height, whichever is tighter. */
  fit?: boolean;
}) {
  const url = path ? frameUrl(path) : null;
  const kind = placement.kind;
  const phone = kind !== "web";
  // The newest shown frame's size, kept while the next frame loads: falling back to the guess
  // between steps resized the bezel twice per step.
  const [loadedSize, setLoadedSize] = useState<{ w: number; h: number } | null>(null);
  const frameStyle = useFrameStyle(kind, placement.isDefault ? null : placement.device, {
    device,
    screenW: loadedSize?.w,
    screenH: loadedSize?.h,
  });
  const isDuoStyle = frameStyle === "iphone-duo";
  const tablet = isTabletStyle(frameStyle);
  // A live run has no `screen_w`/`screen_h` on the `runs` row yet (that lands once the run
  // finishes), so until a frame has actually loaded, the peek can only go by the device name:
  // a Duo gets its own closed-state proportions instead of the generic phone guess. Once the
  // image itself loads, `onFrame` replaces this with the image's own proportions.
  const duoClosed = duoFallbackSizeFor("closed", "portrait");
  const tabletFallback = tablet ? frameScreenSize({ style: frameStyle }) : null;
  const fallbackAspect = isDuoStyle
    ? `${duoClosed.w} / ${duoClosed.h}`
    : kind === "desktop"
      ? `${DESKTOP_FALLBACK.w} / ${DESKTOP_FALLBACK.h}`
      : tabletFallback
        ? `${tabletFallback.w} / ${tabletFallback.h}`
        : "9 / 19.5";
  const aspect = loadedSize ? `${loadedSize.w} / ${loadedSize.h}` : fallbackAspect;
  // Double-buffered: each step's frame is decoded first and faded in over the previous one,
  // which stays on screen until then. The `<img key={url}>` this replaced unmounted the painted
  // frame on every step and faded an empty element in from transparent — a blink per step.
  const screen = url ? (
    <BufferedImage
      src={url}
      alt=""
      onFrame={({ width, height }) => {
        if (width && height)
          setLoadedSize((prev) => (prev && prev.w === width && prev.h === height ? prev : { w: width, h: height }));
      }}
      // Duo / tablet: never crop (the box re-flows a paint after the image's own size is known).
      className={isDuoStyle || tablet || !phone || kind === "desktop" ? "object-contain" : "object-cover"}
      frontProps={{ "data-live-frame": "" }}
    />
  ) : (
    <div className="absolute inset-0 flex items-center justify-center text-xs text-muted" data-live-frame-empty>
      <span className="animate-shimmer h-2.5 w-1/2 rounded-sm" />
    </div>
  );
  const reserve = fit ? 0 : PEEK_RESERVE_PX;
  const frame = phone ? (
    <DeviceBezel
      style={frameStyle}
      aspect={aspect}
      reserve={reserve}
      className={fit ? "max-w-none" : kind === "desktop" ? undefined : tablet ? "mx-auto max-w-[360px]" : "mx-auto max-w-[220px]"}
    >
      {screen}
    </DeviceBezel>
  ) : (
    <div
      className="relative mx-auto w-full overflow-hidden rounded-lg border border-border bg-black shadow-[0_12px_30px_rgba(0,0,0,0.35)]"
      style={heightCapStyle("16 / 10", reserve)}
      data-browser-frame
    >
      <div className="flex h-5 items-center gap-1 border-b border-white/10 bg-[#1b1c1f] px-2" aria-hidden>
        <span className="size-1.5 rounded-full bg-white/20" />
        <span className="size-1.5 rounded-full bg-white/20" />
        <span className="size-1.5 rounded-full bg-white/20" />
      </div>
      <div className="relative w-full overflow-hidden bg-panel-2" style={{ aspectRatio: "16 / 10" }}>
        {screen}
      </div>
    </div>
  );
  if (!fit) return frame;
  return (
    // A size container: `cqh` is the height left for the frame, so the frame's width (the
    // bezel draws itself from its width) can be derived from it.
    <div className="flex min-h-0 w-full flex-1 items-center justify-center [container-type:size]" data-frame-fit>
      <div
        className="mx-auto transition-[width] duration-300 ease-out motion-reduce:transition-none"
        style={{ width: fitWidth(phone, aspect, frameStyle) }}
      >
        {frame}
      </div>
    </div>
  );
}

/** The frame's width so that its full height fits the size container it sits in. */
export function fitWidth(phone: boolean, aspect: string, style?: DeviceFrameStyle): string {
  // The browser frame: a 22px title bar (with its borders) over a 16:10 page.
  if (!phone) return "min(100%, calc((100cqh - 22px) * 16 / 10))";
  const m = /^\s*([\d.]+)\s*\/\s*([\d.]+)\s*$/.exec(aspect);
  const w = m ? Number(m[1]) : 0;
  const h = m ? Number(m[2]) : 0;
  if (style && isTabletStyle(style) && w > 0 && h > 0) {
    // A tablet's bezel is a fixed share of its short side on every edge: fit the whole body.
    const [bw, bh] = tabletChromeGeometry(style, w, h).bodyAspect.split("/").map((n) => Number(n.trim()));
    return `min(100%, calc(100cqh * ${(bw / bh).toFixed(4)}))`;
  }
  const ratio = w > 0 && h > 0 ? h / w : 19.5 / 9;
  // The bezel adds a few percent of its width around the screen: 0.08 of the width on top of
  // the screen's own height keeps every phone style inside the box.
  return `min(100%, calc(100cqh / ${(ratio + 0.08).toFixed(4)}))`;
}

/**
 * A small live view of a run in progress: the newest frame, in the bezel of the run's own
 * platform, with a LIVE badge, where it runs and a link to the full run. `frames` is what the
 * page polls.
 */
export function LiveDevicePeek({
  runId,
  placement,
  frames = [],
  actionCount = 0,
  fit = false,
  caption,
  device,
  className,
}: {
  runId: string;
  placement: Placement;
  /** The run's device record, for `FrameView`'s phone-vs-tablet pick. */
  device?: unknown;
  frames?: readonly PassFrame[];
  /** The actions it has taken so far. */
  actionCount?: number;
  /** The side-by-side review: the frame fills the column's height, the status sits under it. */
  fit?: boolean;
  /** `fit` only: a line shown right under the frame (the exploration's status). */
  caption?: ReactNode;
  className?: string;
}) {
  const isLive = true;
  const latest = frames.length ? frames[frames.length - 1] : null;
  const actions = `${actionCount} ${actionCount === 1 ? "action" : "actions"}`;

  if (fit) {
    return (
      <aside
        className={cn("flex min-h-0 flex-1 flex-col gap-2.5", className)}
        data-live-peek={runId}
        data-live-peek-kind={placement.kind}
      >
        <FrameView placement={placement} path={latest?.frame_path ?? null} device={device} fit />
        {caption}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <LiveBadge live={isLive} />
          <RunPlacement placement={placement} className="min-w-0" />
          <span className="font-mono text-2xs tabular text-muted" data-live-peek-actions>{actions}</span>
          <Link
            href={qaHref({ view: "sessions", session: runId })}
            className={cn(buttonVariants({ size: "sm", variant: "ghost" }), "ml-auto shrink-0")}
            data-live-peek-open
          >
            Open exploration <ArrowUpRight />
          </Link>
        </div>
      </aside>
    );
  }

  return (
    <aside className={cn("flex flex-col gap-2", className)} data-live-peek={runId} data-live-peek-kind={placement.kind}>
      <div className="flex items-center gap-2 text-xs">
        <LiveBadge live={isLive} />
        <Link
          href={qaHref({ view: "sessions", session: runId })}
          className={cn(buttonVariants({ size: "sm", variant: "ghost" }), "ml-auto shrink-0")}
          data-live-peek-open
        >
          Open exploration <ArrowUpRight />
        </Link>
      </div>
      <RunPlacement placement={placement} className="min-w-0" />
      <FrameView placement={placement} path={latest?.frame_path ?? null} device={device} />
      <p className="text-center font-mono text-2xs text-muted" data-live-peek-actions>{actions}</p>
    </aside>
  );
}

function LiveBadge({ live }: { live: boolean }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2 py-0.5 font-medium",
        live ? "text-fg" : "text-muted",
      )}
    >
      <span
        className={cn("size-1.5 rounded-full", live ? "bg-danger motion-safe:animate-pulse" : "bg-muted")}
        aria-hidden
      />
      {live ? "LIVE" : "Finished"}
    </span>
  );
}

/**
 * The exploration after it ended: its frames stay on the page, with a scrubber and a play
 * button, the blocker that ended it (and its screenshot), and a link to the exploration.
 * Live viewing ending must not read as the view being lost.
 */
export function ExplorationReplay({
  runId,
  placement,
  frames,
  blocker,
  fit = false,
  caption,
  device,
  className,
}: {
  runId: string;
  placement: Placement;
  /** The run's device record, for `FrameView`'s phone-vs-tablet pick. */
  device?: unknown;
  frames: readonly PassFrame[];
  blocker?: { title: string; frame: string | null } | null;
  /** The side-by-side review: the frame fills the column's height, the controls sit under it. */
  fit?: boolean;
  /** `fit` only: a line shown under the scrubber (the exploration's status). */
  caption?: ReactNode;
  className?: string;
}) {
  const last = frames.length - 1;
  const [picked, setPicked] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const index = Math.min(picked ?? last, last);
  const current = frames[index] ?? null;
  // Shown instead of the scrubbed frame while the blocker's screenshot is pinned.
  const [pinBlocker, setPinBlocker] = useState(false);

  // Playing stops by itself on the last step (derived, so no state is set from an effect).
  const isPlaying = playing && index < last;
  useEffect(() => {
    if (!isPlaying) return;
    const timer = setInterval(() => setPicked((i) => Math.min((i ?? last) + 1, last)), PLAY_MS);
    return () => clearInterval(timer);
  }, [isPlaying, last]);

  if (frames.length === 0 && !blocker) return null;
  const path = pinBlocker && blocker?.frame ? blocker.frame : (current?.frame_path ?? blocker?.frame ?? null);

  const header = (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2 py-0.5 font-medium text-muted">
        <span className="size-1.5 rounded-full bg-muted" aria-hidden />
        Ended
      </span>
      {fit ? <RunPlacement placement={placement} className="min-w-0" /> : null}
      <Link
        href={qaHref({ view: "sessions", session: runId })}
        className={cn(buttonVariants({ size: "sm", variant: "ghost" }), "ml-auto shrink-0")}
        data-explore-watch-replay
      >
        <Play /> Open exploration
      </Link>
    </div>
  );

  const blockerButton = blocker ? (
    <button
      type="button"
      onClick={() => setPinBlocker((v) => !v)}
      className={cn(
        "flex items-start gap-2 rounded-md border border-border px-2.5 py-2 text-left text-sm transition-colors",
        pinBlocker ? "bg-selected" : "bg-panel-2 hover:bg-hover",
      )}
      aria-pressed={pinBlocker}
      title={blocker.frame ? "Show the screenshot of the blocker" : undefined}
      data-explore-blocker
    >
      <StatusGlyph status="fail" size={14} decorative className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium text-muted">Blocker</span>
        <span className={cn("block text-fg", fit && "line-clamp-2")}>{blocker.title}</span>
      </span>
      {blocker.frame ? <span className="shrink-0 text-xs text-muted">{pinBlocker ? "Showing" : "Screenshot"}</span> : null}
    </button>
  ) : null;

  const scrubber =
    frames.length > 1 ? (
      <div className="flex items-center gap-2" data-explore-scrubber>
        <button
          type="button"
          onClick={() => {
            setPinBlocker(false);
            if (isPlaying) {
              setPlaying(false);
              return;
            }
            if (index >= last) setPicked(0);
            setPlaying(true);
          }}
          className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-fg-2 hover:bg-hover hover:text-fg"
          aria-label={isPlaying ? "Pause" : "Play the exploration's steps"}
        >
          {isPlaying ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        </button>
        <input
          type="range"
          min={0}
          max={last}
          value={index}
          onChange={(e) => {
            setPlaying(false);
            setPinBlocker(false);
            setPicked(Number(e.target.value));
          }}
          aria-label="Step"
          className="h-1 min-w-0 flex-1 cursor-pointer accent-[var(--color-primary)]"
        />
        <span className="shrink-0 font-mono text-2xs tabular text-muted">
          {index + 1}/{frames.length}
        </span>
      </div>
    ) : null;

  if (fit) {
    // The side-by-side review: the frame fills the column, the controls sit compactly under it.
    return (
      <aside className={cn("flex min-h-0 flex-1 flex-col gap-2.5", className)} data-exploration-replay={runId}>
        <FrameView placement={placement} path={path} device={device} fit />
        {scrubber}
        {caption}
        {header}
        {blockerButton}
      </aside>
    );
  }

  return (
    <aside className={cn("flex flex-col gap-2.5", className)} data-exploration-replay={runId}>
      {header}
      <RunPlacement placement={placement} className="min-w-0" />
      {blockerButton}
      <FrameView placement={placement} path={path} device={device} />
      {scrubber}
    </aside>
  );
}
