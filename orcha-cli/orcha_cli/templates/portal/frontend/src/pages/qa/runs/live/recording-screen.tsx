import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "../../map/kit";
import { resolveFormFactor } from "../lib/device-frame";
import { urlFor } from "../replay/use-signed-url";
import { clickToPoint, moveCrosshair, screenSizeFor, type TargetKind } from "./recording";
import {
  DRAG_SLOP,
  LONG_PRESS_MS,
  TypeBuffer,
  WheelBatcher,
  clampSlide,
  gestureToCommand,
  keyToInput,
  screenScale,
  wheelPixels,
  type Command,
  type PointerSample,
} from "./recording-gestures";
import { NO_OFFSET, type Offset } from "./recording-inputs";
import type { LiveFrame } from "./recording-live";
import { liveFrameSrc } from "./use-live-frame";

const PLATFORM_NAMES: Record<string, string> = { ios: "iOS", android: "Android", web: "web" };

/**
 * The newest frame, swapped in only once it has loaded, so the screen never blanks between
 * frames and the slide for in-flight scrolls is undone in the same paint the new frame lands.
 */
function useShownFrame(framePath: string | null, frameSeq: number | null): { path: string; seq: number | null } | null {
  const [shown, setShown] = useState(framePath ? { path: framePath, seq: frameSeq } : null);
  const shownPath = shown?.path ?? null;
  useEffect(() => {
    if (!framePath || framePath === shownPath) return;
    let live = true;
    const img = new Image();
    const swap = () => {
      if (live) setShown({ path: framePath, seq: frameSeq });
    };
    img.onload = swap;
    img.onerror = swap;
    img.src = urlFor(framePath);
    return () => {
      live = false;
    };
  }, [framePath, frameSeq, shownPath]);
  return shown;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where the frame is drawn, from its box rather than the image: the image slides with a drag
 * or scroll (a CSS transform), and a point must keep meaning the same spot on the device.
 */
function frameRect(box: HTMLElement | null): Rect | null {
  if (!box) return null;
  const r = box.getBoundingClientRect();
  return { left: r.left + box.clientLeft, top: r.top + box.clientTop, width: box.clientWidth, height: box.clientHeight };
}

interface Press {
  samples: PointerSample[];
  /** Where it started on the displayed frame (CSS pixels from its top-left). */
  left: number;
  top: number;
  clientX: number;
  clientY: number;
  /** `performance.now()` once the press was handled: holds count from here (D108). */
  seenAt: number;
}

/**
 * The live screen of the recording's run, driven the way the device would be:
 * - click: a tap; press and hold: a long press for as long as it was held;
 * - drag: a swipe with the real start, end and speed (a flick flings; on the web it scrolls
 *   the page by the dragged distance);
 * - trackpad or mouse wheel: a scroll by the real deltas (web: a wheel scroll every
 *   `WHEEL_BATCH_MS`; a phone: one swipe per wheel gesture);
 * - typing while the screen has focus: text into the focused field (sent when typing
 *   pauses), Enter (and on the web Backspace, Tab, Escape) as key presses.
 *
 * Inputs are in screen units: the size the tool server reports. An iOS frame's pixel-to-point
 * scale can't be read off the image, so without it input is blocked with a message rather than
 * sent to a guessed point.
 *
 * The screen is the newest live frame (`LiveDeviceView` reads it with `useLiveFrame`), the stored
 * frames (one per action, for the trace) are the fallback.
 *
 * Feedback is immediate: a ripple where a tap landed, a ring while holding, and the frame
 * slides with a drag or scroll (`slideFor`) until the frame showing the result is loaded
 * (the slide follows the drag without easing when the person prefers reduced motion).
 *
 * Keyboard without a pointer: arrow keys move a crosshair (Shift for bigger steps) and Enter
 * or Space tap at it.
 */
export function RecordingScreen({
  framePath,
  frameSeq,
  live = null,
  wakeLive = () => {},
  kind,
  run,
  interactive,
  longPress = false,
  slideFor = () => NO_OFFSET,
  onInput,
  onShown,
  onLiveShown,
  compact = false,
  deviceName,
  framed = false,
  onSize,
}: {
  framePath: string | null;
  frameSeq: number | null;
  /** The newest live frame. */
  live?: LiveFrame | null;
  /** Asks for the next live frame at once: every input does. */
  wakeLive?: () => void;
  kind: TargetKind;
  run: { id: string; screen_w: number | null; screen_h: number | null } | null;
  interactive: boolean;
  /** "Long press instead of tap" is on: a click long-presses. */
  longPress?: boolean;
  /** How far the frame on screen (by its seq) is slid for inputs still in flight (displayed pixels). */
  slideFor?: (shownSeq: number | null) => Offset;
  /** One input, with how far it slid the frame (displayed pixels). */
  onInput: (command: Command, slide: Offset) => void;
  /** The recorded frame now loaded (by its step seq). */
  onShown?: (seq: number) => void;
  /** The live frame now on screen shows the result of commands up to this seq. */
  onLiveShown?: (cmdSeq: number) => void;
  /** A small, read-only frame (the recap beside the write-up after Finish). */
  compact?: boolean;
  /** The recording's device name: an iPad / Android tablet gets a wider screen box. */
  deviceName?: string | null;
  /** Drawn inside a device bezel or browser frame: it fills the frame's screen. */
  framed?: boolean;
  /** The frame's size in pixels, once it has loaded. */
  onSize?: (size: { width: number; height: number }) => void;
}) {
  const hintId = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [natural, setNatural] = useState<{ naturalWidth: number; naturalHeight: number } | null>(null);
  const [box, setBox] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [ripple, setRipple] = useState<{ left: number; top: number; key: number } | null>(null);
  const [holding, setHolding] = useState<{ left: number; top: number } | null>(null);
  const [crosshair, setCrosshair] = useState<{ x: number; y: number } | null>(null);
  const [armed, setArmed] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dragSlide, setDragSlide] = useState<Offset>(NO_OFFSET);
  const [wheelSlide, setWheelSlide] = useState<Offset>(NO_OFFSET);
  const [typing, setTyping] = useState("");

  const shown = useShownFrame(framePath, frameSeq);
  const screen = screenSizeFor(kind, run, natural, null);
  // A tablet is near-square: the phone's 300px column would shrink it to a thumbnail.
  const tablet =
    (kind === "ios" || kind === "android") &&
    resolveFormFactor({
      deviceName,
      screenW: natural?.naturalWidth ?? run?.screen_w,
      screenH: natural?.naturalHeight ?? run?.screen_h,
    }) === "tablet";
  const mobileWidth = tablet ? (compact ? "w-[260px]" : "w-[520px]") : compact ? "w-[180px]" : "w-[300px]";
  const canTap = interactive && !!screen;

  // Every input also asks the live stream for its next frame at once.
  const input = useCallback(
    (command: Command, slide: Offset) => {
      wakeLive();
      onInput(command, slide);
    },
    [onInput, wakeLive],
  );

  // The latest props for the batchers' timer callbacks.
  const latest = useRef({ onInput: input, screen });
  useEffect(() => {
    latest.current = { onInput: input, screen };
  }, [input, screen]);

  // Displayed-pixel slide of wheel deltas not sent yet; handed over with the next batch.
  const wheelSlideRef = useRef<Offset>(NO_OFFSET);
  const batchers = useRef<{ wheel: WheelBatcher; type: TypeBuffer } | null>(null);
  useEffect(() => {
    const wheel = new WheelBatcher(
      kind,
      () => latest.current.screen,
      (command) => {
        const slide = wheelSlideRef.current;
        wheelSlideRef.current = NO_OFFSET;
        setWheelSlide(NO_OFFSET);
        latest.current.onInput(command, slide);
      },
    );
    const type = new TypeBuffer((command) => latest.current.onInput(command, NO_OFFSET), setTyping);
    batchers.current = { wheel, type };
    return () => {
      wheel.flush();
      type.flush();
      batchers.current = null;
    };
  }, [kind]);

  const shownSeq = shown?.seq ?? null;
  const hasFrame = shown !== null || live !== null;
  useEffect(() => {
    if (shownSeq != null) onShown?.(shownSeq);
  }, [shownSeq, onShown]);
  const liveCmdSeq = live?.cmdSeq ?? null;
  useEffect(() => {
    if (liveCmdSeq != null) onLiveShown?.(liveCmdSeq);
  }, [liveCmdSeq, onLiveShown]);

  // The displayed size, for scaling wheel deltas and capping the slide.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setBox({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [hasFrame]);

  /** Everything typed or scrolled so far goes out before the next input, keeping order. */
  const flushBuffers = useCallback(() => {
    batchers.current?.type.flush();
    batchers.current?.wheel.flush();
  }, []);

  const send = useCallback(
    (command: Command, slide: Offset = NO_OFFSET) => {
      flushBuffers();
      input(command, slide);
    },
    [flushBuffers, input],
  );

  // Wheel and trackpad: a native listener, since React's is passive and the page behind
  // must not scroll while the person scrolls the device.
  const canTapRef = useRef(canTap);
  useEffect(() => {
    canTapRef.current = canTap;
  }, [canTap]);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const current = latest.current.screen;
      const rect = frameRect(boxRef.current);
      if (!canTapRef.current || !current || !rect || e.ctrlKey) return; // Ctrl+wheel is the browser's zoom
      const point = clickToPoint(e, rect, current);
      if (!point) return;
      e.preventDefault();
      batchers.current?.type.flush();
      const raw = wheelPixels(e, { width: rect.width, height: rect.height });
      const scale = screenScale(current, rect);
      batchers.current?.wheel.push(point, raw.dx * scale.x, raw.dy * scale.y);
      const next = { x: wheelSlideRef.current.x - raw.dx, y: wheelSlideRef.current.y - raw.dy };
      wheelSlideRef.current = next;
      setWheelSlide(next);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [hasFrame]);

  const press = useRef<Press | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearHold() {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
    setHolding(null);
  }

  function pointAt(e: { clientX: number; clientY: number }, rect: Rect, clamp: boolean) {
    if (!screen) return null;
    const c = clamp
      ? {
          clientX: Math.min(Math.max(e.clientX, rect.left), rect.left + rect.width),
          clientY: Math.min(Math.max(e.clientY, rect.top), rect.top + rect.height),
        }
      : e;
    return clickToPoint(c, rect, screen);
  }

  function onPointerDown(e: PointerEvent<HTMLImageElement>) {
    const rect = frameRect(boxRef.current);
    if (!canTap || !screen || !rect || e.button !== 0) return;
    const point = pointAt(e, rect, false);
    if (!point) return;
    e.preventDefault();
    boxRef.current?.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const left = e.clientX - rect.left;
    const top = e.clientY - rect.top;
    setArmed(false);
    clearHold();
    holdTimer.current = setTimeout(() => setHolding({ left, top }), LONG_PRESS_MS);
    // Last: the hold is measured from when the page got here, not from the event's timestamp,
    // so a main thread that was busy when the press arrived cannot make a click a long press.
    press.current = { samples: [{ ...point, t: e.timeStamp }], left, top, clientX: e.clientX, clientY: e.clientY, seenAt: performance.now() };
  }

  function onPointerMove(e: PointerEvent<HTMLImageElement>) {
    const p = press.current;
    const rect = frameRect(boxRef.current);
    if (!p || !rect) return;
    const point = pointAt(e, rect, true);
    if (!point) return;
    p.samples.push({ ...point, t: e.timeStamp });
    const first = p.samples[0];
    if (Math.hypot(point.x - first.x, point.y - first.y) >= DRAG_SLOP) {
      clearHold();
      // The content follows the finger, as it will on the device.
      setDragSlide({ x: e.clientX - p.clientX, y: e.clientY - p.clientY });
    }
  }

  function onPointerUp(e: PointerEvent<HTMLImageElement>) {
    const p = press.current;
    press.current = null;
    clearHold();
    const slide = dragSlide;
    setDragSlide(NO_OFFSET);
    const rect = frameRect(boxRef.current);
    if (!p || !canTap || !screen || !rect) return;
    const end = pointAt(e, rect, true);
    if (end) p.samples.push({ ...end, t: e.timeStamp });
    const command = gestureToCommand(p.samples, { pressSeenAt: p.seenAt });
    if (!command) return;
    if (command.kind === "swipe") {
      setCrosshair({ x: command.args.x2, y: command.args.y2 });
      send(command, slide);
      return;
    }
    setCrosshair({ x: command.args.x, y: command.args.y });
    setRipple({ left: p.left, top: p.top, key: Date.now() });
    send(command.kind === "tap" && longPress ? { kind: "long_press", args: command.args } : command);
  }

  function onPointerCancel() {
    press.current = null;
    clearHold();
    setDragSlide(NO_OFFSET);
  }

  function tapAtCrosshair(current: { x: number; y: number }) {
    if (!screen) return;
    const rect = frameRect(boxRef.current);
    setRipple({
      left: rect ? (current.x / screen.width) * rect.width : 0,
      top: rect ? (current.y / screen.height) * rect.height : 0,
      key: Date.now(),
    });
    send({ kind: longPress ? "long_press" : "tap", args: current });
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!canTap || !screen) return;
    const current = crosshair ?? { x: Math.round(screen.width / 2), y: Math.round(screen.height / 2) };
    const moved = moveCrosshair(current, e.key, e.shiftKey, screen);
    if (moved) {
      e.preventDefault();
      setCrosshair(moved);
      setArmed(true);
      return;
    }
    // After the arrows placed the crosshair, Enter or Space taps there.
    if (armed && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      setCrosshair(current);
      tapAtCrosshair(current);
      return;
    }
    const input = keyToInput(e, kind);
    if (!input) return;
    e.preventDefault();
    setArmed(false);
    const buffers = batchers.current;
    if (input.type === "text") {
      buffers?.wheel.flush();
      buffers?.type.add(input.text);
      return;
    }
    if (input.key === "backspace" && buffers?.type.backspace()) return;
    send({ kind: "press", args: { key: input.key } });
  }

  if (!shown && !live) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-lg border border-border bg-panel-2 text-sm text-muted",
          kind === "web" ? "aspect-[16/10] w-full" : cn(tablet ? "aspect-[3/4]" : "aspect-[9/19.5]", mobileWidth),
        )}
        data-recording-screen="waiting"
        role="status"
      >
        Waiting for the first screen…
      </div>
    );
  }

  const platform = PLATFORM_NAMES[kind] ?? kind;
  const alt = live
    ? `Live ${platform} screen of the recording`
    : `Live ${platform} screen of the recording${shown?.seq != null ? `, frame ${shown.seq}` : ""}`;
  const src = live ? liveFrameSrc(live) : urlFor(shown!.path);
  const reportSize = (width: number, height: number) => onSize?.({ width, height });
  const shownCrosshair = canTap && focused && armed ? (crosshair ?? (screen ? { x: Math.round(screen.width / 2), y: Math.round(screen.height / 2) } : null)) : null;
  const pending = slideFor(shown?.seq ?? null);
  const slide = clampSlide({ x: pending.x + dragSlide.x + wheelSlide.x, y: pending.y + dragSlide.y + wheelSlide.y }, box);
  const dragging = dragSlide.x !== 0 || dragSlide.y !== 0;

  return (
    <div className={cn("flex flex-col gap-1.5", framed && "absolute inset-0")}>
      <div
        ref={boxRef}
        className={cn(
          framed
            ? "relative size-full overflow-hidden bg-black outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-fg"
            : "relative overflow-hidden rounded-lg border border-border bg-black shadow-[0_12px_30px_rgba(0,0,0,0.35)] outline-none focus-visible:ring-2 focus-visible:ring-fg",
          !framed && (kind === "web" ? "w-full" : mobileWidth),
          !framed && compact && "shadow-sm",
        )}
        data-recording-screen="live"
        role={canTap ? "application" : undefined}
        tabIndex={canTap ? 0 : undefined}
        aria-label={canTap ? `${alt}. Tap target` : undefined}
        aria-describedby={canTap ? hintId : undefined}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          batchers.current?.type.flush();
        }}
      >
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          draggable={false}
          onLoad={(e) => {
            const { naturalWidth, naturalHeight } = e.currentTarget;
            setNatural((prev) =>
              prev?.naturalWidth === naturalWidth && prev?.naturalHeight === naturalHeight ? prev : { naturalWidth, naturalHeight },
            );
            reportSize(naturalWidth, naturalHeight);
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          data-recording-frame
          data-recording-live={live ? live.n : undefined}
          data-recording-slide={slide.x !== 0 || slide.y !== 0 ? `${Math.round(slide.x)},${Math.round(slide.y)}` : undefined}
          style={{
            transform: slide.x !== 0 || slide.y !== 0 ? `translate3d(${slide.x}px, ${slide.y}px, 0)` : undefined,
          }}
          className={cn(
            framed ? "block size-full touch-none select-none" : "block h-auto w-full touch-none select-none",
            dragging ? "transition-none" : "transition-transform duration-[90ms] ease-out motion-reduce:transition-none",
            canTap ? "cursor-crosshair" : "cursor-default",
          )}
        />
        {shownCrosshair && screen ? (
          <span
            aria-hidden
            data-recording-crosshair
            className="pointer-events-none absolute size-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-fg bg-fg/20"
            style={{ left: `${(shownCrosshair.x / screen.width) * 100}%`, top: `${(shownCrosshair.y / screen.height) * 100}%` }}
          />
        ) : null}
        {holding ? (
          <span
            aria-hidden
            data-recording-holding
            className="pointer-events-none absolute size-10 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-fg"
            style={{ left: holding.left, top: holding.top }}
          />
        ) : null}
        {ripple ? (
          <span
            key={ripple.key}
            aria-hidden
            className="pointer-events-none absolute size-8 -translate-x-1/2 -translate-y-1/2 animate-ping rounded-full bg-fg/60"
            style={{ left: ripple.left, top: ripple.top, animationIterationCount: 1, animationFillMode: "forwards" }}
          />
        ) : null}
        {typing ? (
          <span
            className="pointer-events-none absolute bottom-2 left-1/2 max-w-[90%] -translate-x-1/2 truncate rounded-md border border-border bg-panel px-2 py-1 font-mono text-xs text-fg"
            data-recording-typing
          >
            {typing}
            <span className="animate-pulse">▌</span>
          </span>
        ) : null}
      </div>
      {canTap ? (
        <p id={hintId} className={framed ? "absolute sr-only" : "sr-only"}>
          Type to enter text into the focused field. Use the arrow keys to move the crosshair (hold Shift for bigger steps), then
          press Enter or Space to tap there.
        </p>
      ) : null}
      {shownCrosshair ? (
        <p className="text-center font-mono text-xs text-muted" aria-live="polite" data-recording-crosshair-position>
          ({shownCrosshair.x}, {shownCrosshair.y})
        </p>
      ) : null}
      {interactive && !screen ? (
        <p className={cn("text-center text-xs text-sev-major", framed && "absolute inset-x-2 bottom-2 rounded-md bg-panel px-2 py-1")} role="status" data-recording-size-unknown>
          The device’s screen size isn’t known yet, so tapping is paused until the session reports it.
        </p>
      ) : null}
    </div>
  );
}
