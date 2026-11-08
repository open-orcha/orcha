/**
 * Which frame a run's media (a step frame, the live screen, the recording) is drawn in, by the
 * run's platform: a web run in a browser window (traffic lights, address bar), a desktop app in
 * a Mac window, an iPhone/Android run in its phone, a tablet-sized capture in its tablet. The
 * player, the live view and the Video tab all use this, so the same run never wears two
 * different devices (a web recording used to sit in a phone-shaped black box).
 */
import { isTabletSize, tabletStyleFor, type DeviceFrameStyle } from "../lib/device-frame";
import type { TargetKind } from "../types";

export type MediaFrame = "browser" | DeviceFrameStyle;

/**
 * The frame for `kind` given the bezel the viewer's preference resolved to (`useFrameStyle`)
 * and the capture's size when known. Web is always a browser window and desktop always a Mac
 * window (unless the viewer chose no frame); a phone style over a tablet-shaped capture becomes
 * the platform's tablet, so the frame follows the capture rather than letterboxing it.
 */
export function mediaFrameFor(kind: TargetKind, style: DeviceFrameStyle, size: { w?: number | null; h?: number | null } = {}): MediaFrame {
  if (kind === "web") return "browser";
  if (kind === "desktop") return style === "none" ? "none" : "mac-window";
  if ((style === "iphone" || style === "android") && isTabletSize(size.w ?? null, size.h ?? null)) return tabletStyleFor(style);
  return style;
}

/** The address bar's text for a web run: the page's origin and path, without the scheme
 * (as a browser shows it), or null when there is no URL to show. */
export function addressLabel(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const path = u.pathname === "/" ? "" : u.pathname;
    return `${u.host}${path}${u.search}`;
  } catch {
    return null;
  }
}

/** The recording's poster: the first step frame that was captured (not withheld), so the video
 * never sits as a black box before play. */
export function posterFramePath(frames: readonly { path: string; withheld?: boolean }[]): string | null {
  return frames.find((f) => !f.withheld)?.path ?? null;
}
