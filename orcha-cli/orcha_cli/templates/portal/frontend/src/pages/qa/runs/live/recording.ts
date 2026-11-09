/**
 * The live screen's geometry and wording: from a click to a point on the device, the crosshair,
 * an address typed by hand, an input said in words.
 */
import type { TargetKind } from "../../map/kit";

export type { TargetKind };
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];
export type RecordingCommandKind = "tap" | "long_press" | "type" | "swipe" | "press" | "wait" | "open_url" | "finish";

/** One input as the portal holds it. `sent`: handed to the tool server, not played yet. */
export interface RecordingCommand {
  id: string;
  seq: number;
  kind: RecordingCommandKind;
  args: Record<string, Json>;
  status: "pending" | "sent" | "done" | "failed";
  result: string | null;
}

export interface ScreenSize {
  width: number;
  height: number;
}

function positive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/**
 * The run's screen in the units taps are sent in (points on iOS, CSS pixels on the web,
 * pixels on Android): `runs.screen_w/screen_h` when the run has them, else the size a screen
 * tree reported (`tree`). Web and Android frames are captured 1:1, so their own size is a
 * safe last resort; an iOS frame's pixel-to-point scale (2x or 3x) can't be told from the
 * image, so with neither source known this returns null rather than guess.
 */
export function screenSizeFor(
  kind: TargetKind,
  run: { screen_w: number | null; screen_h: number | null } | null,
  frame: { naturalWidth: number; naturalHeight: number } | null,
  tree: ScreenSize | null = null,
): ScreenSize | null {
  if (run && positive(run.screen_w) && positive(run.screen_h)) {
    return { width: run.screen_w, height: run.screen_h };
  }
  if (tree && positive(tree.width) && positive(tree.height)) return tree;
  if (kind === "ios") return null;
  if (!frame || !positive(frame.naturalWidth) || !positive(frame.naturalHeight)) return null;
  return { width: frame.naturalWidth, height: frame.naturalHeight };
}

/**
 * The keyboard crosshair on the live screen: arrow keys move it by `step` screen units
 * (`bigStep` with Shift), clamped inside the screen. Returns null for keys it doesn't handle.
 */
export function moveCrosshair(
  point: { x: number; y: number },
  key: string,
  shift: boolean,
  screen: ScreenSize,
  step = 10,
  bigStep = 50,
): { x: number; y: number } | null {
  const d = shift ? bigStep : step;
  const maxX = Math.max(0, Math.floor(screen.width) - 1);
  const maxY = Math.max(0, Math.floor(screen.height) - 1);
  const clamp = (v: number, max: number) => Math.min(max, Math.max(0, Math.round(v)));
  switch (key) {
    case "ArrowLeft":
      return { x: clamp(point.x - d, maxX), y: clamp(point.y, maxY) };
    case "ArrowRight":
      return { x: clamp(point.x + d, maxX), y: clamp(point.y, maxY) };
    case "ArrowUp":
      return { x: clamp(point.x, maxX), y: clamp(point.y - d, maxY) };
    case "ArrowDown":
      return { x: clamp(point.x, maxX), y: clamp(point.y + d, maxY) };
    default:
      return null;
  }
}

/**
 * A click on the displayed frame as a point on the device screen, rounded to whole units, or
 * null when it landed outside the frame. `rect` is the frame element's bounding box; the image
 * fills it exactly (the frame keeps the screenshot's aspect).
 */
export function clickToPoint(
  click: { clientX: number; clientY: number },
  rect: { left: number; top: number; width: number; height: number },
  screen: ScreenSize,
): { x: number; y: number } | null {
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  const fx = (click.clientX - rect.left) / rect.width;
  const fy = (click.clientY - rect.top) / rect.height;
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
  return {
    x: Math.min(Math.round(fx * screen.width), Math.max(0, Math.floor(screen.width) - 1)),
    y: Math.min(Math.round(fy * screen.height), Math.max(0, Math.floor(screen.height) - 1)),
  };
}

/**
 * The address a person typed for a web recording, as an absolute http(s) URL. A bare host
 * ("example.com/shop") gets `https://`, like a browser's address bar; anything that is not
 * http(s) (`file:`, `javascript:`, …) is refused.
 */
export function normalizeRecordingUrl(input: string): { ok: true; url: string } | { ok: false; error: string } {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "Enter the address of the site to record." };
  if (/\s/.test(raw)) return { ok: false, error: "A web address has no spaces." };
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[^/:]+:\d+(\/|$)/.test(raw);
  let url: URL;
  try {
    url = new URL(hasScheme ? raw : `https://${raw}`);
  } catch {
    return { ok: false, error: "That is not a web address." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "Only http:// and https:// addresses can be recorded." };
  }
  if (!url.hostname) return { ok: false, error: "That is not a web address." };
  return { ok: true, url: url.href };
}

function direction(dx: number, dy: number): "up" | "down" | "left" | "right" {
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

function typedChars(args: Record<string, Json>): string {
  const n = typeof args.chars === "number" ? args.chars : String(args.text ?? "").length;
  return `${n} character${n === 1 ? "" : "s"}`;
}

function describeSwipe(args: Record<string, Json>): string {
  const n = (v: Json | undefined) => (typeof v === "number" ? v : 0);
  if (args.dx != null || args.dy != null) {
    const dx = n(args.dx);
    const dy = n(args.dy);
    return `Scroll ${direction(dx, dy)} ${Math.round(Math.hypot(dx, dy))} px`;
  }
  if (args.x1 != null) {
    const dx = n(args.x2) - n(args.x1);
    const dy = n(args.y2) - n(args.y1);
    const speed = typeof args.duration_ms === "number" ? ` in ${args.duration_ms} ms` : "";
    return `Swipe ${direction(dx, dy)} ${Math.round(Math.hypot(dx, dy))}${speed} from (${args.x1}, ${args.y1})`;
  }
  return `Swipe ${String(args.direction ?? "")}`;
}

/** One line per command for the recording's command list. A secret typed into a secure field
 * reads as dots and the credential it is, never its value. */
export function describeCommand(kind: RecordingCommandKind, args: Record<string, Json>): string {
  switch (kind) {
    case "tap":
    case "long_press":
      // The worker names a played tap by the element it hit (`label`, D77).
      if (typeof args.label === "string" && args.label) return `${kind === "tap" ? "Tap" : "Long press"} ${args.label}`;
      return `${kind === "tap" ? "Tap" : "Long press"} at (${args.x}, ${args.y})`;
    case "type":
      // What a person typed is never shown back: they took over to sign in, as often as not.
      return `Type ${typedChars(args)}`;
    case "swipe":
      return describeSwipe(args);
    case "open_url":
      return `Go to ${String(args.url ?? "")}`;
    case "press":
      return `Press ${String(args.key ?? "")}`;
    case "wait":
      return `Wait ${String(args.ms ?? "")} ms`;
    case "finish":
      return "Finish";
  }
}
