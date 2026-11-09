import { Link } from "../../map/kit";
import { forwardRef, useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { BufferedImage } from "../replay/buffered-image";
import { urlFor } from "../replay/use-signed-url";
import { PlatformIcon } from "../../map/kit";
import { fmtClock } from "../lib/run-counters";
import { plural } from "../../map/kit";
import { isTabletDeviceName } from "../lib/device-frame";
import { deviceLine, runClockMs, screenAspect, waitingLine, wallShape, type ShownTile, type WallResult } from "../lib/live-wall";
import { cn } from "../../map/kit";
import motion from "./live-wall.module.css";

/** A wall frame's crossfade: slower than the replay's cut, so a wall of screens changes calmly. */
const WALL_FADE_MS = 260;

const RESULT: Record<WallResult, { label: string; className: string }> = {
  passed: { label: "Passed", className: "bg-[#1f8a4c]/90 text-white" },
  failed: { label: "Failed", className: "bg-[#c0392b]/90 text-white" },
  stopped: { label: "Stopped", className: "bg-black/55 text-white" },
};

function dotClass(tile: ShownTile): string {
  if (tile.result === "passed") return "bg-[#34c77b]";
  if (tile.result === "failed") return "bg-[#ff5d52]";
  if (tile.endedAt != null) return "bg-[var(--wall-fg-4)]";
  if (tile.status === "finishing") return "bg-[#f5b544]";
  if (tile.status === "running") return "bg-[var(--wall-accent)]";
  return "bg-[var(--wall-fg-4)]";
}

function statusWord(tile: ShownTile): string {
  if (tile.result) return RESULT[tile.result].label;
  if (tile.endedAt != null) return "Ended";
  if (tile.status === "finishing") return "Finishing";
  if (tile.status === "preparing") return "Preparing";
  if (tile.status === "queued") return "Queued";
  return "Running";
}

/** Is the element on screen? Frames for a tile scrolled out of view stop loading. */
function useOnScreen<T extends Element>(): [Ref<T>, boolean] {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)), { rootMargin: "120px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, visible];
}

/**
 * One device on the wall: its live screen, crossfading frame to frame, and a thin line under it
 * (status dot, name, device, clock). Hover or focus shows the step count and the current action
 * over the bottom of the screen. A run is a link to its live page; a queued request is a quiet
 * placeholder.
 */
export const WallTile = forwardRef<HTMLAnchorElement, {
  tile: ShownTile;
  now: number;
  focused: boolean;
  /** The filmstrip in focus mode: no hover line, a smaller strip. */
  compact?: boolean;
  /** Animate in when it first appears (off under reduced motion, and on the first paint). */
  animateIn: boolean;
  onFocus: () => void;
}>(function WallTile({ tile, now, focused, compact = false, animateIn, onFocus }, ref) {
  const [boxRef, onScreen] = useOnScreen<HTMLDivElement>();
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  // The frame shown: the newest while the tile is on screen, held while it is scrolled away.
  const [shown, setShown] = useState(tile.framePath);
  if (onScreen && shown !== tile.framePath && tile.framePath) setShown(tile.framePath);

  const shape = wallShape(tile.kind, isTabletDeviceName(tile.device));
  const aspect = screenAspect(shape, natural);
  const ended = tile.endedAt != null;
  // The run clock starts with the session; a tile still preparing times its stage instead (#200).
  const elapsed = runClockMs(tile, now);
  const queued = tile.status === "queued" && !ended;
  const href = tile.href;
  const radius = shape === "phone" ? "rounded-[clamp(8px,7cqw,22px)]" : shape === "tablet" ? "rounded-[clamp(6px,3cqw,14px)]" : "rounded-md";

  // The screen and its caption are one unit centered in the cell: the screen as large as the
  // cell allows at its own aspect, the caption under it never narrower than a readable line.
  const reserve = compact ? 22 : 40;
  const screenWidth = `min(100%, calc((100cqh - ${reserve}px) * ${aspect.toFixed(4)}))`;
  const screen = (
    <div
      ref={boxRef}
      className={cn("relative mx-auto overflow-hidden", radius, motion.screen, queued && "opacity-60")}
      style={{ aspectRatio: String(aspect), width: screenWidth }}
      data-wall-screen={shape}
    >
        {shown ? (
          <BufferedImage
            src={urlFor(shown)}
            alt={`${tile.name} on ${tile.device}`}
            className="object-contain"
            fadeMs={WALL_FADE_MS}
            frontProps={{ "data-wall-frame": shown }}
            onFrame={({ width, height }) => {
              if (width && height) setNatural((p) => (p && p.w === width && p.h === height ? p : { w: width, h: height }));
            }}
          />
        ) : (
          <Waiting tile={tile} compact={compact} now={now} />
        )}
        {!compact && !ended && !queued ? (
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent px-2.5 pb-2 pt-6 text-[11px] leading-4 text-white/90 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-has-[:focus-visible]:opacity-100 motion-reduce:transition-none"
            data-wall-hover
          >
            <span className="tabular text-white/60" data-wall-actions>
              {plural(tile.actions, "action")}
            </span>
            {tile.action ? (
              <span className="block truncate font-mono text-white/90" data-wall-action>
                {tile.action}
              </span>
            ) : null}
          </div>
        ) : null}
        {tile.result || ended ? (
          <span
            className={cn(
              "absolute right-2 top-2 rounded-full px-2 py-0.5 text-[11px] font-semibold tracking-wide shadow-sm",
              tile.result ? RESULT[tile.result].className : "bg-black/55 text-white",
              motion.badge,
            )}
            data-wall-result={tile.result ?? "ended"}
          >
            {tile.result ? RESULT[tile.result].label : "Ended"}
          </span>
        ) : null}
    </div>
  );

  const strip = (
    <div className={cn("flex w-full min-w-0 shrink-0 flex-col justify-center px-0.5", compact ? "h-[18px] text-[10px]" : "h-[34px] text-[11.5px]")}>
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", dotClass(tile), !ended && tile.status !== "queued" && motion.breathe)}
          data-wall-status={ended ? (tile.result ?? "ended") : tile.status}
        />
          <span className="min-w-0 flex-1 truncate font-medium leading-4 text-[var(--wall-fg)]" data-wall-name>
            {tile.name}
          </span>
        <span className="shrink-0 font-mono tabular leading-4 text-[var(--wall-fg-2)]" data-wall-clock suppressHydrationWarning>
          {elapsed == null ? "" : fmtClock(elapsed)}
        </span>
      </div>
      {!compact ? (
        <span className="flex min-w-0 items-center gap-1 pl-3 text-[10.5px] leading-4 text-[var(--wall-fg-3)]" data-wall-device-line>
          <PlatformIcon kind={tile.kind} className="size-3 shrink-0 opacity-70" />
          <span className="truncate" data-wall-device>
            {deviceLine(tile)}
          </span>
        </span>
      ) : null}
    </div>
  );

  const label = `${tile.name}, ${tile.device}, ${statusWord(tile)}${elapsed == null ? "" : `, ${fmtClock(elapsed)}`}`;
  // The whole unit is one link (stretched over it), so the provider's live view can sit on top
  // as its own link rather than nested inside the tile's.
  const unit = (
    <div
      className={cn("relative flex min-w-0 flex-col", compact ? "gap-1" : "gap-1.5")}
      style={{ width: compact ? "100%" : `max(min(100%, 232px), ${screenWidth})` }}
    >
      {screen}
      {strip}
      {href ? (
        <Link
          ref={ref}
          href={href}
          className="absolute inset-0 z-[1] rounded-md outline-none"
          aria-label={label}
          tabIndex={focused ? 0 : -1}
          onFocus={onFocus}
          title={`Open ${tile.name}`}
          data-wall-open={tile.key}
        />
      ) : null}
    </div>
  );

  const className = cn(
    "group relative flex min-h-0 min-w-0 flex-1 items-center justify-center rounded-lg p-1.5 outline-none [container-type:size]",
    motion.tile,
    ended && motion.ended,
    animateIn && motion.enter,
    tile.leaving && motion.leaving,
  );
  const data = {
    "data-wall-tile": tile.key,
    "data-wall-run": tile.runId ?? undefined,
    "data-wall-state": ended ? "ended" : tile.status,
    ...(focused ? { "data-wall-focused": "" } : {}),
  };
  return (
    <div className={className} {...data} {...(href ? {} : { role: "group", "aria-label": label })}>
      {unit}
    </div>
  );
});

/** A tile before its first frame: what preparation is doing, over a slow light. */
function Waiting({ tile, compact, now }: { tile: ShownTile; compact: boolean; now: number }): ReactNode {
  const queued = tile.status === "queued";
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[var(--wall-waiting)] px-3 text-center" data-wall-waiting>
      {!queued ? (
        <span aria-hidden className="relative h-px w-1/2 overflow-hidden bg-[var(--wall-line)]">
          <span className={cn("absolute inset-y-0 left-0 w-1/3 bg-[var(--wall-accent)] opacity-70", motion.sweep)} />
        </span>
      ) : null}
      {!compact ? (
        <span className={cn("max-w-full text-[11px] leading-4", queued ? "text-[var(--wall-fg-3)]" : "text-[var(--wall-fg-2)]")} data-wall-phase>
          {waitingLine(tile, now)}
        </span>
      ) : null}
    </div>
  );
}
