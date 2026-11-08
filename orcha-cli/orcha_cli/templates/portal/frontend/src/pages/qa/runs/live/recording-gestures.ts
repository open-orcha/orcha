/**
 * Turning a person's hands on the live recording screen into recorder commands, as pure
 * functions and small timer-driven batchers (no React): a press-move-release becomes a tap,
 * a long press or a swipe with its real points and speed; trackpad and mouse-wheel scrolling
 * becomes wheel scrolls by the real deltas, coalesced; keys typed while the screen has focus
 * become typed text. See `recording-screen.tsx`.
 *
 * Everything here works in screen units (the device's points / the page's CSS pixels), the
 * same units `clickToPoint` produces.
 */
import type { Json, RecordingCommandKind, ScreenSize, TargetKind } from "./recording";

/** A pointer that stays this still for this long is a long press, not a tap. */
export const LONG_PRESS_MS = 500;
/** Longest long press sent (the device holds the touch this long). */
export const MAX_LONG_PRESS_MS = 10_000;
/** A pointer that moved less than this (screen units) is pressing, not dragging. */
export const DRAG_SLOP = 12;
/** A swipe plays at least this fast and at most this slow. */
export const MIN_SWIPE_MS = 40;
export const MAX_SWIPE_MS = 3_000;
/** Wheel deltas are sent at most this often while a scroll is going on (web). */
/**
 * How often a long web scroll sends what has accumulated. Each batch is a command the worker
 * plays and captures (~250 ms); sending faster than that only builds a backlog the mirror
 * then catches up on, which reads as lag and jitter. A flick shorter than this goes out as
 * one command when the wheel rests (`WHEEL_GESTURE_IDLE_MS`).
 */
export const WHEEL_BATCH_MS = 250;

/**
 * A trackpad scroll drifts a little on the axis the fingers did not mean; below this share of
 * the main axis the drift is dropped, so a vertical scroll stays vertical.
 */
export const WHEEL_DRIFT_RATIO = 0.3;
/** On a phone a wheel scroll is one swipe, sent once the wheel has been still this long. */
export const WHEEL_GESTURE_IDLE_MS = 140;
/** Typed characters are sent once typing pauses this long (or before any other input). */
export const TYPE_IDLE_MS = 450;

export interface PointerSample {
  x: number;
  y: number;
  /** Milliseconds, any monotonic origin (`event.timeStamp`). */
  t: number;
}

export type Command = { kind: RecordingCommandKind; args: Record<string, Json> };

export type GestureCommand =
  | { kind: "tap"; args: { x: number; y: number } }
  | { kind: "long_press"; args: { x: number; y: number; duration_ms: number } }
  | { kind: "swipe"; args: { x1: number; y1: number; x2: number; y2: number; duration_ms: number } };

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * A press, its moves and its release (screen units, in order) as one command:
 * - it never left the press point (within `DRAG_SLOP`): a tap, or a long press with the time
 *   it was held once that reached `LONG_PRESS_MS`;
 * - it moved: a swipe from the press point to the release point, lasting from when the
 *   pointer started moving to the release. A flick is short and fast, so it flings on the
 *   device; a slow, careful drag plays slowly and scrolls exactly that far.
 */
export function gestureToCommand(
  samples: readonly PointerSample[],
  {
    slop = DRAG_SLOP,
    longPressMs = LONG_PRESS_MS,
    pressSeenAt,
  }: { slop?: number; longPressMs?: number; pressSeenAt?: number } = {},
): GestureCommand | null {
  if (samples.length === 0) return null;
  const start = samples[0];
  const end = samples[samples.length - 1];
  const moved = samples.findIndex((s) => dist(s, start) >= slop);
  if (moved === -1) {
    const held = holdDuration(start.t, end.t, pressSeenAt);
    if (held >= longPressMs) {
      return { kind: "long_press", args: { x: start.x, y: start.y, duration_ms: Math.round(Math.min(held, MAX_LONG_PRESS_MS)) } };
    }
    return { kind: "tap", args: { x: start.x, y: start.y } };
  }
  // The finger was still until the sample before the first one past the slop.
  const began = samples[Math.max(0, moved - 1)].t;
  return {
    kind: "swipe",
    args: {
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      duration_ms: Math.round(clamp(end.t - began, MIN_SWIPE_MS, MAX_SWIPE_MS)),
    },
  };
}

/**
 * How long the pointer was held, in the page's own time (D108). `down` and `up` are the
 * events' `timeStamp`s (when the browser received them); `seenAt` is `performance.now()` when
 * the page finished handling the press. On a busy main thread the press can sit unhandled for
 * seconds, and an automated click (mousedown, then mouseup once the mousedown was handled) or a
 * person's quick click both arrive with their release long after the press's own timestamp:
 * counting from `down` turned ordinary clicks into 6-10 second long presses. The hold counts
 * from whichever came later, so a stall before the page saw the press is never a hold, while
 * a real hold on an idle page reads exactly as before (`seenAt` is then `down` + a few ms).
 */
export function holdDuration(down: number, up: number, seenAt?: number): number {
  const from = seenAt !== undefined && Number.isFinite(seenAt) ? Math.max(down, seenAt) : down;
  return Math.max(0, up - from);
}

/** A `WheelEvent`'s delta in CSS pixels of the page it fired on (lines and pages converted). */
export function wheelPixels(
  e: { deltaX: number; deltaY: number; deltaMode: number },
  page: { width: number; height: number },
  lineHeight = 16,
): { dx: number; dy: number } {
  const unit = e.deltaMode === 1 ? lineHeight : e.deltaMode === 2 ? page.height : 1;
  const unitX = e.deltaMode === 2 ? page.width : unit;
  return { dx: e.deltaX * unitX, dy: e.deltaY * unit };
}

/**
 * Screen units per pixel of the displayed frame: a mirror drawn at half size scrolls the
 * page twice as far as the wheel moved, so the content under the pointer moves with the
 * fingers exactly as it would on the page itself.
 */
export function screenScale(screen: ScreenSize, displayed: { width: number; height: number }): { x: number; y: number } {
  return {
    x: displayed.width > 0 ? screen.width / displayed.width : 1,
    y: displayed.height > 0 ? screen.height / displayed.height : 1,
  };
}

/**
 * A wheel scroll on a phone screen as a swipe that moves the content the same distance:
 * from the pointer, the opposite way of the scroll, kept on the screen.
 */
export function wheelToSwipe(
  point: { x: number; y: number },
  dx: number,
  dy: number,
  screen: ScreenSize,
  durationMs = 300,
): GestureCommand {
  const maxX = Math.max(0, Math.floor(screen.width) - 1);
  const maxY = Math.max(0, Math.floor(screen.height) - 1);
  return {
    kind: "swipe",
    args: {
      x1: Math.round(clamp(point.x, 0, maxX)),
      y1: Math.round(clamp(point.y, 0, maxY)),
      x2: Math.round(clamp(point.x - dx, 0, maxX)),
      y2: Math.round(clamp(point.y - dy, 0, maxY)),
      duration_ms: durationMs,
    },
  };
}

export interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Coalesces wheel events into wheel-scroll commands. On the web a flick is one command, sent
 * when the wheel rests (`WHEEL_GESTURE_IDLE_MS`); a scroll that keeps going sends what has
 * accumulated every `WHEEL_BATCH_MS` so the page keeps moving. On a phone it waits for the
 * wheel to rest and sends one swipe for the whole gesture. Fractions carry over between
 * batches, so nothing is lost to rounding, and drift on the minor axis is dropped.
 */
export class WheelBatcher {
  private dx = 0;
  private dy = 0;
  private point: { x: number; y: number } | null = null;
  private timer: unknown = null;
  private idle: unknown = null;

  constructor(
    private readonly kind: TargetKind,
    private readonly screen: () => ScreenSize | null,
    private readonly send: (command: Command) => void,
    private readonly timers: Timers = realTimers,
  ) {}

  /** One wheel event at `point` (screen units), already scaled to screen units. */
  push(point: { x: number; y: number }, dx: number, dy: number): void {
    this.dx += dx;
    this.dy += dy;
    this.point ??= point;
    if (this.kind === "web") {
      // A batch goes out when the wheel rests, or every WHEEL_BATCH_MS while it keeps going.
      if (this.idle !== null) this.timers.clear(this.idle);
      this.idle = this.timers.set(() => this.flush(), WHEEL_GESTURE_IDLE_MS);
      if (this.timer === null) this.timer = this.timers.set(() => this.flush(), WHEEL_BATCH_MS);
    } else {
      if (this.timer !== null) this.timers.clear(this.timer);
      this.timer = this.timers.set(() => this.flush(), WHEEL_GESTURE_IDLE_MS);
    }
  }

  /** Send what has accumulated now (also called before any other input, to keep order). */
  flush(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    if (this.idle !== null) this.timers.clear(this.idle);
    this.timer = this.idle = null;
    const point = this.point;
    let dx = Math.round(this.dx);
    let dy = Math.round(this.dy);
    if (!point || (dx === 0 && dy === 0)) return;
    this.dx -= dx;
    this.dy -= dy;
    this.point = null;
    // Drop the drift on the minor axis (the whole gesture's, not one event's).
    if (Math.abs(dx) < Math.abs(dy) * WHEEL_DRIFT_RATIO) dx = 0;
    else if (Math.abs(dy) < Math.abs(dx) * WHEEL_DRIFT_RATIO) dy = 0;
    if (dx === 0 && dy === 0) return;
    if (this.kind === "web") {
      this.send({ kind: "swipe", args: { x: Math.round(point.x), y: Math.round(point.y), dx, dy } });
      return;
    }
    const screen = this.screen();
    if (screen) this.send(wheelToSwipe(point, dx, dy, screen));
  }

  cancel(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    if (this.idle !== null) this.timers.clear(this.idle);
    this.timer = this.idle = null;
    this.dx = this.dy = 0;
    this.point = null;
  }
}

/** Keys typed into the focused screen that play as a key press rather than text. */
export const SCREEN_PRESS_KEYS: Readonly<Record<string, string>> = {
  Enter: "enter",
  Backspace: "backspace",
  Tab: "tab",
  Escape: "escape",
};

/** Which of `SCREEN_PRESS_KEYS` a platform can press (a phone has no Tab, Escape or Backspace key here). */
export function pressableKeys(kind: TargetKind): readonly string[] {
  return kind === "web" ? ["enter", "backspace", "tab", "escape"] : ["enter"];
}

/**
 * What a key typed into the focused screen does: a character to type, a key to press, or
 * nothing (shortcuts with Ctrl/Cmd/Alt stay with the browser; arrows move the crosshair).
 */
export function keyToInput(
  e: { key: string; ctrlKey?: boolean; metaKey?: boolean },
  kind: TargetKind,
): { type: "text"; text: string } | { type: "press"; key: string } | null {
  if (e.ctrlKey || e.metaKey) return null;
  const press = SCREEN_PRESS_KEYS[e.key];
  if (press) return pressableKeys(kind).includes(press) ? { type: "press", key: press } : null;
  // A printable key (Alt+key on a Mac types a symbol, which `key` already holds).
  return e.key.length === 1 ? { type: "text", text: e.key } : null;
}

/**
 * Collects characters typed into the screen and sends them as one `type` command once typing
 * pauses (`TYPE_IDLE_MS`) or another input comes (`flush`). Backspace edits what has not been
 * sent yet instead of pressing the key.
 */
export class TypeBuffer {
  private text = "";
  private timer: unknown = null;

  constructor(
    private readonly send: (command: Command) => void,
    private readonly onChange: (pending: string) => void = () => {},
    private readonly timers: Timers = realTimers,
  ) {}

  get pending(): string {
    return this.text;
  }

  add(text: string): void {
    this.text += text;
    this.onChange(this.text);
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => this.flush(), TYPE_IDLE_MS);
  }

  /** Remove the last unsent character; false when nothing was pending (press the key then). */
  backspace(): boolean {
    if (!this.text) return false;
    this.text = Array.from(this.text).slice(0, -1).join("");
    this.onChange(this.text);
    return true;
  }

  flush(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    const text = this.text;
    this.text = "";
    if (text) {
      this.onChange("");
      this.send({ kind: "type", args: { text } });
    }
  }
}

/**
 * How far the frame is slid while scrolls are on their way (displayed pixels), capped so it
 * never leaves its box entirely: the content moves the way it will once the new frame lands.
 */
export function clampSlide(
  offset: { x: number; y: number },
  box: { width: number; height: number },
  cap = 0.6,
): { x: number; y: number } {
  // Not measured yet (0x0): nothing to cap against.
  return {
    x: box.width > 0 ? clamp(offset.x, -box.width * cap, box.width * cap) : offset.x,
    y: box.height > 0 ? clamp(offset.y, -box.height * cap, box.height * cap) : offset.y,
  };
}
