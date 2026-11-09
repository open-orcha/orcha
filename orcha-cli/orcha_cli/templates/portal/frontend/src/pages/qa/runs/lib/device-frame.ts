import { useCallback, useSyncExternalStore } from "react";
import type { TargetKind } from "../types";
import { formFactorFromRecord, isPhoneDeviceName, isTabletDeviceName, type FormFactor } from "./form-factor";

export { deviceFormFactor, formFactorFromRecord, isTabletDevice, isTabletDeviceName, type FormFactor } from "./form-factor";

/** Which bezel to draw around device frames: pick by the run's device, or force one. */
export type DeviceFrameChoice = "auto" | "iphone" | "android" | "ipad" | "android-tablet" | "none";
/** `iphone-duo*` styles are still an iPhone (kind `ios`) — they get their own entries only
 * because the foldable draws completely different chrome depending on fold state:
 * `iphone-duo-open` (unfolded, ~1.29 wide when landscape) is one continuous screen with a hinge
 * and two button bumps; `iphone-duo-closed` (folded, ~0.69 wide) has a spine along the left edge
 * and a prominent corner camera. `iphone-duo` is kept as an alias that resolves to one of the
 * two by aspect (see `resolveDuoStyle`), so existing callers that only know about the single
 * Duo style keep working.
 *
 * `ipad` / `android-tablet` are the tablet bezels: a thin uniform bezel with no notch, island
 * or punch-hole, drawn portrait or landscape to match the capture. */
export type DeviceFrameStyle =
  | "iphone"
  | "iphone-duo"
  | "iphone-duo-open"
  | "iphone-duo-closed"
  | "android"
  | "ipad"
  | "android-tablet"
  /** A desktop app's window (docs/desktop-apps.md): macOS title bar with traffic lights. */
  | "mac-window"
  | "none";


export const DEVICE_FRAME_CHOICES: readonly DeviceFrameChoice[] = [
  "auto",
  "iphone",
  "android",
  "ipad",
  "android-tablet",
  "none",
];
export const DEVICE_FRAME_LABEL: Record<DeviceFrameChoice, string> = {
  auto: "Auto",
  iphone: "iPhone",
  android: "Android phone",
  ipad: "iPad",
  "android-tablet": "Android tablet",
  none: "No frame",
};

/** Stored per target kind: one global choice meant that picking "iPhone" on an iOS run
 * then drew an iPhone bezel around every Android run too — notch and all. The kind is
 * part of the key so a preference only ever applies to the platform it was made on, and a
 * tablet run has its own key (`…:ios:tablet`) so a choice made on a phone run never puts an
 * iPad run in a phone bezel (or the reverse). The phone key keeps its pre-tablet name, so
 * existing preferences carry over untouched. */
const KEY_PREFIX = "orcha:qa-device-frame";
export function frameChoiceKey(kind: TargetKind, formFactor: FormFactor = "phone"): string {
  return formFactor === "tablet" ? `${KEY_PREFIX}:${kind}:tablet` : `${KEY_PREFIX}:${kind}`;
}
/** Pre-split key: read once so an existing choice is not silently dropped. */
const LEGACY_KEY = KEY_PREFIX;
const listeners = new Set<() => void>();

function isChoice(v: string | null): v is DeviceFrameChoice {
  return v != null && (DEVICE_FRAME_CHOICES as readonly string[]).includes(v);
}

/** Whether a pre-split global choice should carry over to `kind`. An "iphone" preference
 * says nothing about how an Android run should look, so it must not. Exported for tests. */
export function legacyChoiceApplies(
  legacy: DeviceFrameChoice,
  kind: TargetKind,
): boolean {
  if (legacy === "auto") return false;
  return (
    legacy === "none" ||
    (legacy === "iphone" && kind === "ios") ||
    (legacy === "android" && kind === "android")
  );
}

function read(kind: TargetKind, formFactor: FormFactor): DeviceFrameChoice {
  try {
    const own = localStorage.getItem(frameChoiceKey(kind, formFactor));
    if (isChoice(own)) return own;
    // The pre-split global choice predates tablets: it only ever described a phone.
    if (formFactor === "tablet") return "auto";
    // Migrate the old global choice, but only onto the platform it can sensibly describe:
    // an "iphone" preference says nothing about how an Android run should look.
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (isChoice(legacy) && legacy !== "auto") {
      if (legacyChoiceApplies(legacy, kind)) return legacy;
    }
    return "auto";
  } catch {
    return "auto";
  }
}

function write(kind: TargetKind, formFactor: FormFactor, choice: DeviceFrameChoice) {
  try {
    const key = frameChoiceKey(kind, formFactor);
    if (choice === "auto") localStorage.removeItem(key);
    else localStorage.setItem(key, choice);
    // The global key would keep winning for other kinds on the next read; drop it once
    // the viewer has expressed a per-kind preference.
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // ignore
  }
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key && e.key.startsWith(KEY_PREFIX)) cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

/** The viewer's bezel preference (per browser, per platform and form factor), hydration-safe
 * (server renders "auto"). */
export function useDeviceFrameChoice(
  kind: TargetKind,
  formFactor: FormFactor = "phone",
): [DeviceFrameChoice, (c: DeviceFrameChoice) => void] {
  const choice = useSyncExternalStore(
    subscribe,
    useCallback(() => read(kind, formFactor), [kind, formFactor]),
    () => "auto" as DeviceFrameChoice,
  );
  const set = useCallback((c: DeviceFrameChoice) => write(kind, formFactor, c), [kind, formFactor]);
  return [choice, set];
}

/** Whether a device name is Apple's foldable — "iPhone Duo" as reported by `simctl`/`xcrun`,
 * matched case-insensitively and by substring so a longer product name (e.g. a future "iPhone
 * Duo Pro") still resolves. It is still `kind: "ios"` everywhere else (labels, capability
 * grouping, run device picker) — this only decides which bezel chrome to draw. */
export function isDuoDeviceName(name: string | null | undefined): boolean {
  if (!name) return false;
  return /\bduo\b/i.test(name);
}

/** The short/long edge ratio above which a capture is tablet-shaped. Phones are tall and
 * narrow (iPhone 17 Pro 402×874 ≈ 0.46, Pixel 9a ≈ 0.45); tablets are near-square (iPad
 * 3:4 = 0.75, a 16:10 Android tablet = 0.625 — hence "short/long", so it counts either way up,
 * and a threshold just under 16:10). The Duo (≈0.69–0.70) is recognised by name first. */
export const TABLET_ASPECT_THRESHOLD = 0.6;

/** Whether a capture of this size is tablet-shaped, in either orientation. */
export function isTabletSize(
  w: number | null | undefined,
  h: number | null | undefined,
): boolean {
  if (!w || !h || w <= 0 || h <= 0) return false;
  return Math.min(w, h) / Math.max(w, h) > TABLET_ASPECT_THRESHOLD;
}

/**
 * Phone or tablet, from the best evidence available, in this order:
 * 1. The device record's own form factor (`runs.device`, `run_requests.device`, a cloud
 *    catalog entry), when it carries one. A simulator's comes from its device type (#455), so
 *    it is right whatever the simulator is called: a renamed iPad ("Design review") is a
 *    tablet, an iPhone someone called "Team iPad" a phone.
 * 2. The device name: an iPhone (Duo included) is a phone; an iPad / Galaxy Tab / Pixel Tablet
 *    / anything named "tablet" is a tablet. Names are what `simctl`/`adb`/cloud catalogs report,
 *    so this is right from the first render for a record that says nothing (an Android AVD, a
 *    run from before #455).
 * 3. The capture's aspect ratio (`isTabletSize`): the last resort, for a run that names no
 *    device ("Any booted simulator") and has no record.
 *
 * `screen_w`/`screen_h` on a run are *not* proof of a phone: an iPhone-only app on an iPad
 * runs in compatibility mode and the worker reports the app window's logical size (390×844)
 * while every captured frame is the full iPad screen (2064×2752). That is why the size is last.
 */
export function resolveFormFactor(input: {
  deviceName?: string | null;
  device?: unknown;
  screenW?: number | null;
  screenH?: number | null;
}): FormFactor {
  const { deviceName } = input;
  const record = input.device;
  const fromRecord = formFactorFromRecord(record);
  if (fromRecord) return fromRecord;
  if (isPhoneDeviceName(deviceName) || isDuoDeviceName(deviceName)) return "phone";
  if (isTabletDeviceName(deviceName)) return "tablet";
  const recordName =
    record && typeof record === "object" && typeof (record as { name?: unknown }).name === "string"
      ? ((record as { name: string }).name)
      : null;
  if (isPhoneDeviceName(recordName) || isDuoDeviceName(recordName)) return "phone";
  if (isTabletDeviceName(recordName)) return "tablet";
  return isTabletSize(input.screenW, input.screenH) ? "tablet" : "phone";
}

/** Whether a style is one of the tablet bezels. */
export function isTabletStyle(style: DeviceFrameStyle): style is "ipad" | "android-tablet" {
  return style === "ipad" || style === "android-tablet";
}

/** The tablet bezel of a phone style's platform (`iphone` → `ipad`, `android` →
 * `android-tablet`); any other style comes back unchanged. */
export function tabletStyleFor(style: DeviceFrameStyle): DeviceFrameStyle {
  if (style === "iphone") return "ipad";
  if (style === "android") return "android-tablet";
  return style;
}

/** What a resolved style is called in the picker's "Auto (…)" entry. */
export function frameStyleLabel(style: DeviceFrameStyle): string {
  switch (style) {
    case "android":
      return "Android phone";
    case "ipad":
      return "iPad";
    case "android-tablet":
      return "Android tablet";
    case "iphone-duo":
    case "iphone-duo-open":
    case "iphone-duo-closed":
      return "iPhone Duo";
    case "none":
      return "No frame";
    case "mac-window":
      return "Mac window";
    default:
      return "iPhone";
  }
}

/** Extra evidence for "Auto": the device record and the capture size, consulted when the
 * device name alone does not settle phone vs tablet (see `resolveFormFactor`). */
export interface FrameHints {
  device?: unknown;
  screenW?: number | null;
  screenH?: number | null;
}

/** Resolve the preference for a run's target kind. "Auto" draws the bezel of the run's own
 * device: the Duo's when the device name says so, a tablet's (iPad on iOS, Android tablet on
 * Android) when `resolveFormFactor` says tablet, else the platform's phone. An explicit choice
 * is honoured, except that "iPhone" on a Duo run still gets the Duo's own proportions (a phone
 * bezel stretched over a much squarer capture reads as broken, not as a choice). */
export function resolveFrameStyle(
  choice: DeviceFrameChoice,
  kind: TargetKind,
  deviceName?: string | null,
  hints: FrameHints = {},
): DeviceFrameStyle {
  if (kind === "web") return "none";
  // A desktop app is a window on the worker's Mac, never a phone: "No frame" is the only
  // other choice that applies to it.
  if (kind === "desktop") return choice === "none" ? "none" : "mac-window";
  const isDuo = kind === "ios" && isDuoDeviceName(deviceName);
  if (choice === "auto") {
    if (isDuo) return "iphone-duo";
    const tablet = resolveFormFactor({ deviceName, ...hints }) === "tablet";
    if (kind === "android") return tablet ? "android-tablet" : "android";
    return tablet ? "ipad" : "iphone";
  }
  if (choice === "iphone" && isDuo) return "iphone-duo";
  return choice;
}

/** A capture's orientation: the capture's own pixels win (a landscape image needs a landscape
 * bezel, whatever was asked for), then the run's recorded `orientation` (migration 009) while
 * no size is known yet, then portrait. */
export function resolveOrientation(
  w: number | null | undefined,
  h: number | null | undefined,
  runOrientation?: "portrait" | "landscape" | null,
): "portrait" | "landscape" {
  if (w && h && w > 0 && h > 0) return w > h ? "landscape" : "portrait";
  return runOrientation === "landscape" ? "landscape" : "portrait";
}

/** A tablet's screen size until the real capture is known, portrait: the iPad Pro 13" (M5)
 * capture (2064×2752, 3:4) and a 16:10 Android tablet (Pixel Tablet, 1600×2560). Landscape
 * swaps them (`tabletFallbackSize`). */
export const IPAD_FALLBACK = { w: 2064, h: 2752 } as const;
export const ANDROID_TABLET_FALLBACK = { w: 1600, h: 2560 } as const;

export function tabletFallbackSize(
  style: "ipad" | "android-tablet",
  orientation: "portrait" | "landscape" = "portrait",
): { w: number; h: number } {
  const p = style === "ipad" ? IPAD_FALLBACK : ANDROID_TABLET_FALLBACK;
  return orientation === "landscape" ? { w: p.h, h: p.w } : { w: p.w, h: p.h };
}

/** A phone's screen size until the real capture is known (the iPhone 17 Pro, 402×874),
 * swapped for a run recorded in landscape. */
export function phoneFallbackSize(orientation: "portrait" | "landscape" = "portrait") {
  return orientation === "landscape" ? { w: 874, h: 402 } : { w: 402, h: 874 };
}

/**
 * The screen box for a device frame: the frame actually on screen (its natural size, once
 * loaded) wins over the run row's `screen_w`/`screen_h` — which on a compatibility-mode iPad
 * run is the app window's logical size, not the capture — and both win over the style's
 * fallback (oriented by `runOrientation`). Duo, web and desktop callers keep their own
 * fallbacks; this is for the plain phone/tablet styles.
 */
export function frameScreenSize(input: {
  style: DeviceFrameStyle;
  loaded?: { w: number; h: number } | null;
  screenW?: number | null;
  screenH?: number | null;
  runOrientation?: "portrait" | "landscape" | null;
}): { w: number; h: number } {
  const { style, loaded, screenW, screenH, runOrientation } = input;
  if (loaded && loaded.w > 0 && loaded.h > 0) return loaded;
  const orientation = resolveOrientation(null, null, runOrientation);
  const tablet = isTabletStyle(style);
  if (screenW && screenH && screenW > 0 && screenH > 0) {
    // A tablet style with a phone-shaped run size is the compatibility-mode case above: the
    // row's size describes the app window, not the screen, so it cannot size the frame.
    if (!tablet || isTabletSize(screenW, screenH)) return { w: screenW, h: screenH };
  }
  if (tablet) return tabletFallbackSize(style, orientation);
  return phoneFallbackSize(orientation);
}

/** Fallback screen size for each fold state, used only until a run's real `screen_w`/
 * `screen_h` (or a loaded image/video's natural size) is known. Ratios match Apple's
 * simulator chrome: closed (folded, portrait) is ~0.69 wide, open (unfolded, landscape) is
 * ~1.29 wide — see `duoGeometry` for the bezel constants drawn around each. These are also
 * the two hardware sizes `duoFoldFromSize` bands against (see there for why the closed and
 * open-portrait aspects alone cannot tell the two apart). */
const DUO_CLOSED_FALLBACK = { w: 1398, h: 2034 } as const;
const DUO_OPEN_FALLBACK = { w: 2202, h: 1706 } as const;
/** Apple's simulator reports the unfolded panel as 2007×2853 in portrait (2853×2007 in
 * landscape) — taller than a naive "assume ~1.29 wide" guess scaled down would suggest.
 * `duoFoldFromSize` uses this, not `DUO_OPEN_FALLBACK`, to size-check a portrait capture
 * against the real hardware. */
const DUO_OPEN_PORTRAIT_LONG_EDGE = 2853;

/** Resolve the Duo's fold-state style by aspect: wider than tall is the unfolded book-style
 * screen, anything else (including square) is the folded cover screen. Only meaningful for
 * `"iphone-duo"` (the alias) — passing any other style back unchanged lets callers run every
 * style through this without a branch of their own.
 *
 * @deprecated Kept for callers that only distinguish landscape-vs-not; new code should use
 * `duoFoldFromSize`/`resolveDuoPosture` instead, which also separate closed from open-portrait
 * — two states this function cannot tell apart since it never looks at absolute size, only the
 * sign of `w - h`. */
export function resolveDuoStyle(
  style: DeviceFrameStyle,
  screenW: number | null | undefined,
  screenH: number | null | undefined,
): DeviceFrameStyle {
  if (style !== "iphone-duo") return style;
  const w = screenW ?? DUO_CLOSED_FALLBACK.w;
  const h = screenH ?? DUO_CLOSED_FALLBACK.h;
  return w > h ? "iphone-duo-open" : "iphone-duo-closed";
}

/** The fallback screen size (used when a run has no `screen_w`/`screen_h` yet, e.g. a live
 * peek or a run recorded before capture stored it) for a resolved — not aliased — Duo style. */
export function duoFallbackSize(style: "iphone-duo-open" | "iphone-duo-closed") {
  return style === "iphone-duo-open" ? DUO_OPEN_FALLBACK : DUO_CLOSED_FALLBACK;
}

/**
 * A Duo bezel's posture: the three fold states Apple's own Simulator toolbar offers, and the
 * only three the worker will ever record a run in (migration 008, `runs.duo_posture`).
 * Neither simctl nor CoreSimulator can set the fold state, so the worker detects it from the
 * capture and fails a run whose fold state does not match the posture that was requested —
 * which means a run's frame here must always match how it actually looks, never a free
 * viewing choice.
 *
 * - `closed`: outer cover screen only, captured 1398×2034 (portrait).
 * - `book`: unfolded, the two halves angled like an open book — captured 2007×2853 portrait
 *   or 2853×2007 landscape, same capture size and shape as `flat`; only the drawn chrome
 *   (and its shallow-V, perspective-warped halves) differs.
 * - `flat`: unfolded flat — same capture sizes as `book`.
 */
export type DuoPosture = "closed" | "book" | "flat";

export const DUO_POSTURES: readonly DuoPosture[] = ["closed", "book", "flat"];

export const DUO_POSTURE_LABEL: Record<DuoPosture, string> = {
  closed: "Closed",
  book: "Book",
  flat: "Flat",
};

/** Orientation of an unfolded (book/flat) capture — derived purely from the capture's own
 * pixel size, never chosen by a viewer: `duoOrientationFromSize`'s only signal is which side
 * is longer. */
export type DuoOrientation = "portrait" | "landscape";

/** `w > h` is landscape; anything else (including a square, which never actually occurs on
 * real hardware) is portrait. */
export function duoOrientationFromSize(
  w: number | null | undefined,
  h: number | null | undefined,
): DuoOrientation {
  if (!w || !h || w <= 0 || h <= 0) return "portrait";
  return w > h ? "landscape" : "portrait";
}

/** The two known hardware aspect ratios (short edge ÷ long edge) a tall-ish Duo capture can
 * be: the folded outer cover display, and the unfolded inner panel held portrait. */
const DUO_CLOSED_ASPECT = DUO_CLOSED_FALLBACK.w / DUO_CLOSED_FALLBACK.h; // 1398/2034 ≈ 0.6873
const DUO_OPEN_PORTRAIT_ASPECT = 2007 / DUO_OPEN_PORTRAIT_LONG_EDGE; // 2007/2853 ≈ 0.7035

/**
 * Auto-detect whether a Duo capture is the folded cover screen (`"closed"`) or the unfolded
 * inner panel (`"open"`), from its pixel size alone. Landscape is unambiguous — width >
 * height only ever happens for the unfolded panel shown sideways, so that's always `"open"`.
 * Portrait is not: the folded **outer** cover display (1398×2034, aspect 0.687) and the
 * unfolded **inner** panel captured portrait (2007×2853, aspect 0.704) land within 2.3% of
 * each other's aspect ratio, so a single `w/h` threshold (e.g. "> 0.7 is open") occasionally
 * misfiles one as the other depending on exactly where the cutoff falls.
 *
 * The fix is not absolute size — a capture's pixel dimensions scale with the simulator's
 * recording scale factor (@1x/@2x/@3x), which this module has no way to know ahead of time, so
 * two same-fold captures at different scales are not comparable by raw pixel count. What *is*
 * scale-invariant is the aspect ratio itself: whichever of the two known reference ratios
 * (0.6873 for closed, 0.7035 for open-portrait) the capture's own ratio sits closer to is
 * almost certainly which one it is, since the two are only 2.3% apart and any real capture
 * lands within a fraction of a percent of its own hardware's exact ratio. So: bucket first
 * into "wide" (open, unambiguous) vs. "tall-ish", then within that band pick the nearer
 * reference ratio rather than a fixed midpoint.
 *
 * Falls back to `"closed"` when a dimension is missing (e.g. a live run with no captured frame
 * yet) — so an unresolved Duo run still reads as *a* Duo rather than nothing, and a run that
 * genuinely has no capture never appears to contradict a `book`/`flat` request it hasn't had
 * the chance to fail preflight on yet.
 */
export function duoFoldFromSize(
  w: number | null | undefined,
  h: number | null | undefined,
): "closed" | "open" {
  if (!w || !h || w <= 0 || h <= 0) return "closed";
  if (w > h) return "open";
  const aspect = w / h;
  const distanceToClosed = Math.abs(aspect - DUO_CLOSED_ASPECT);
  const distanceToOpenPortrait = Math.abs(aspect - DUO_OPEN_PORTRAIT_ASPECT);
  return distanceToClosed <= distanceToOpenPortrait ? "closed" : "open";
}

/**
 * The posture actually shown for a run, reconciling what was requested (`runPosture`, from
 * `run_requests.duo_posture`/`runs.duo_posture`) with what the capture itself proves
 * (`duoFoldFromSize`). The capture is the ground truth for open-vs-closed — the worker refuses
 * a run whose fold state doesn't match what was asked, but a run recorded before that check
 * existed, or one whose request carried no posture at all, can still reach the UI, so this
 * never trusts `runPosture` blindly:
 *
 * - Capture says **closed** → always `"closed"`, regardless of what was requested (a closed
 *   capture is never a book or flat view no matter what the request says).
 * - Capture says **open** → the requested posture when it's `"book"` or `"flat"` (both are
 *   valid open-panel views and the capture alone cannot tell them apart — they're pixel-
 *   identical, only the physical hinge angle differs); otherwise `"flat"` (the plainer of the
 *   two open chromes, and a reasonable default for an open capture with no posture on record).
 */
export function resolveDuoPosture(
  runPosture: DuoPosture | null | undefined,
  w: number | null | undefined,
  h: number | null | undefined,
): DuoPosture {
  if (duoFoldFromSize(w, h) === "closed") return "closed";
  return runPosture === "book" || runPosture === "flat" ? runPosture : "flat";
}

/** The fallback screen size for a posture/orientation pair, used until a run's real
 * `screen_w`/`screen_h` (or a loaded image/video's natural size) is known. */
const DUO_OPEN_PORTRAIT_FALLBACK = { w: 2007, h: DUO_OPEN_PORTRAIT_LONG_EDGE } as const;

export function duoFallbackSizeFor(posture: DuoPosture, orientation: DuoOrientation) {
  if (posture === "closed") return DUO_CLOSED_FALLBACK;
  return orientation === "landscape" ? DUO_OPEN_FALLBACK : DUO_OPEN_PORTRAIT_FALLBACK;
}

/** Bezel geometry for one Duo posture+orientation pair, in percentages of the outer frame box
 * (the same units `DeviceBezel`'s other styles already use for corner radii, insets, etc).
 * Kept in one place so `device-bezel.tsx` only ever reads constants here rather than
 * re-deriving them.
 *
 * Measured pixel-by-pixel off Apple's own Simulator chrome (31.png / 32.png closed-portrait,
 * 28.png flat-landscape) by scanning rows/columns of the reference screenshots for the
 * background→graphite→black-border→content transitions and fitting circles to the corner
 * arcs — not eyeballed. Two corrections from an earlier pass worth calling out because they
 * looked plausible but weren't: there is no separate darker "spine" layer poking out past the
 * closed body's left edge (a uniform background sits right up against the body — the fold
 * only reads via the corner-radius asymmetry below), and CSS's single `border-radius` shorthand
 * cannot express that asymmetry at all (it's one radius pair applied to all four corners), so
 * `bodyRadius`/`screenRadius` are full 4-corner `border-radius` values here, not `"x% / y%"`.
 *
 * - **Closed / portrait**: screen box ≈443×642 (aspect 0.690, target 0.687). Padding (of
 *   screen w/h) left ≈5.9%, right ≈3.8%, top ≈3.1%, bottom ≈2.5% — the asymmetry (not a
 *   separate layer) is what reads as the folded spine. Body corner radii ≈14.4%/10.3% (w/h) on
 *   the right, ≈3.7%/2.7% on the left; screen corner radii ≈13.1%/9.0% right, ≈2.7%/1.9% left.
 *   Camera: solid black circle ≈12.2% of screen width, top edge ≈4.0% of screen height from
 *   the screen's top, right edge ≈2.0% of screen width from the screen's right (matches the
 *   simulator's own baked-in camera dot — see `device-bezel.tsx`'s "don't double-draw" note).
 *   Top edge buttons ≈47–59% and ≈63–75% of body width; right-edge side button ≈29–44% of
 *   body height.
 * - **Closed / landscape**: same body rotated 90° — the corner asymmetry (large/small) moves
 *   from left/right to bottom/top, buttons rotate with the body.
 * - **Flat / landscape**: uniform ≈2.1% bezel on all four edges, no radius asymmetry (all four
 *   corners equal). Faint hinge line at the vertical centre. Top buttons ≈69–77%/≈81–90% of
 *   body width; side button ≈29–44% of body height.
 * - **Flat / portrait**: same proportions, rotated 90° (hinge horizontal instead of vertical).
 * - **Book**: same body chrome as `flat` at the same orientation — the shallow-V + perspective
 *   warp is drawn on the *content* by `DuoBezel`/`BookHalves`, not by different geometry
 *   constants here.
 *
 * Fields:
 * - `bodyRadius`/`screenRadius`: outer body / inner screen-cutout corner radii, as a full CSS
 *   `border-radius` value (`"top-left top-right bottom-right bottom-left"`, each corner its
 *   own `"x% y%"` elliptical pair) so the left/right (or top/bottom, once rotated) asymmetry
 *   closed needs can actually be expressed — flat/book use the same corner value all round.
 * - `bodyPad`: the titanium border thickness on each edge (top, right, bottom, left CSS
 *   shorthand order) — the only margin between the body's outer edge and the screen cutout.
 * - `hinge`: `flat`/`book` only — a faint line at the centre, perpendicular to the fold axis.
 * - `camera`: hole-punch position (from the nearest screen edge, inside the screen cutout) and
 *   diameter.
 * - `topButtons`/`sideButton`: button bumps, as CSS length percentages/positions.
 */
export interface DuoGeometry {
  /** Full CSS `border-radius` value covering all four corners (see the docstring above). */
  bodyRadius: string;
  screenRadius: string;
  /** CSS `padding` shorthand: `"top right bottom left"`. */
  bodyPad: string;
  /** `flat`/`book` only — the faint hinge line down the centre, perpendicular to the fold
   * axis; `null` for `closed`. */
  hinge: { axis: "horizontal" | "vertical" } | null;
  /** `closed` only — a black inset drawn *inside* the screen cutout, on top of the capture,
   * thin on three edges and wide on the spine edge (each value a CSS length percentage of
   * screen w/h, e.g. `"4.5%"`). Apple's own chrome reads the fold through this asymmetric
   * black gap between the body's rim highlight and the screen content, not just the
   * corner-radius asymmetry — measured off 32.png's left edge (rim → thin ~1.5% black gap on
   * three edges, ~4.5% wide on the spine edge). Four independent edge strips rather than a
   * single CSS `padding`/`border` shorthand string: `border-width` does not accept percentage
   * values at all (they silently compute to `0px`), so each edge needs its own percentage
   * `width`/`height` on its own absolutely-positioned strip — see `device-bezel.tsx`.  `null`
   * for flat/book, which have no such inset (their thin uniform bezel is all `bodyPad`). */
  screenInset: { top: string; right: string; bottom: string; left: string } | null;
  camera: { top: string; right: string; size: string };
  topButtons: { top: string; left: string; width: string; height: string };
  sideButton: { top: string; height: string };
}

/** Builds a valid CSS `border-radius` value for four independently-elliptical corners: each
 * `[xPct, yPct]` pair is that corner's horizontal/vertical radius (as a percentage of the
 * box's width/height respectively), in CSS's own corner order (top-left, top-right,
 * bottom-right, bottom-left). CSS's actual syntax for this is "all four horizontal radii,
 * then a `/`, then all four vertical radii" — not one `/`-separated group per corner, which
 * looks plausible but silently parses as something else. */
function fourCornerRadius(
  topLeft: readonly [number, number],
  topRight: readonly [number, number],
  bottomRight: readonly [number, number],
  bottomLeft: readonly [number, number],
): string {
  const h = [topLeft[0], topRight[0], bottomRight[0], bottomLeft[0]].map((n) => `${n}%`).join(" ");
  const v = [topLeft[1], topRight[1], bottomRight[1], bottomLeft[1]].map((n) => `${n}%`).join(" ");
  return `${h} / ${v}`;
}

/** Same four corners, all equal — for postures with no left/right (or top/bottom) asymmetry. */
function uniformCornerRadius(xPct: number, yPct: number): string {
  return fourCornerRadius([xPct, yPct], [xPct, yPct], [xPct, yPct], [xPct, yPct]);
}

export function duoGeometry(posture: DuoPosture, orientation: DuoOrientation): DuoGeometry {
  if (posture === "closed") {
    // Body: right corners large (14.4% / 10.3%), left corners small (3.7% / 2.7%) — measured
    // off 32.png. CSS border-radius corner order is top-left, top-right, bottom-right,
    // bottom-left.
    const BODY_SMALL: [number, number] = [3.7, 2.7];
    const BODY_LARGE: [number, number] = [14.4, 10.3];
    const SCREEN_SMALL: [number, number] = [2.7, 1.9];
    const SCREEN_LARGE: [number, number] = [13.1, 9.0];
    if (orientation === "landscape") {
      // Rotated 90° from portrait: the small/large corner asymmetry moves from left/right to
      // top/bottom (small corners now on top, large on bottom), and the buttons/camera/side
      // button rotate with the body.
      return {
        bodyRadius: fourCornerRadius(BODY_SMALL, BODY_SMALL, BODY_LARGE, BODY_LARGE),
        screenRadius: fourCornerRadius(SCREEN_SMALL, SCREEN_SMALL, SCREEN_LARGE, SCREEN_LARGE),
        // top right bottom left — the wider padding (folded spine) now runs along the bottom.
        bodyPad: "2.5% 3.8% 5.9% 3.1%",
        hinge: null,
        // Uniform ~1.6% on all four edges — see the portrait case below for how this was
        // measured and re-verified (an earlier pass here used 4.5% on the spine edge from an
        // eyeballed zoom crop; re-measuring the same crop's own pixel columns, and
        // cross-checking against both reference screenshots' native resolution, put the real
        // ratio at ~1.6% on every edge, not 4.5% on one).
        screenInset: { top: "1.6%", right: "1.6%", bottom: "1.6%", left: "1.6%" },
        // No drawn camera at all: the simulator's own capture already bakes the camera
        // hole-punch into the wallpaper pixels, so a real Duo run never needs (and must never
        // get) a second circle drawn on top of it — see `camera.size: "0%"` below and
        // `device-bezel.tsx`'s "don't draw a camera for closed" note.
        camera: { top: "0%", right: "0%", size: "0%" },
        topButtons: { top: "0%", left: "58%", width: "16%", height: "0.9%" },
        sideButton: { top: "20%", height: "12%" },
      };
    }
    return {
      bodyRadius: fourCornerRadius(BODY_SMALL, BODY_LARGE, BODY_LARGE, BODY_SMALL),
      screenRadius: fourCornerRadius(SCREEN_SMALL, SCREEN_LARGE, SCREEN_LARGE, SCREEN_SMALL),
      // top right bottom left — measured off 32.png (no separate spine layer; the corner
      // asymmetry above is what reads as the fold).
      bodyPad: "3.1% 3.8% 2.5% 5.9%",
      hinge: null,
      // A black gap sits between the body's rim highlight and the screen content on every
      // edge (Apple never draws the screenshot flush against the body) — measured directly
      // off both 31.png and 32.png at native resolution (row/column scans on the left AND
      // right edges independently): the gap is ~7-8px on a ~443-490px-wide screen box on
      // both sides, i.e. uniform ~1.6% of screen width/height, not wider on the spine edge.
      // (A first pass here used 4.5% on the spine edge, eyeballed off a small zoom crop
      // without dividing by the crop's own screen width — re-measuring the same crop's pixel
      // columns and cross-checking against the full-resolution references corrected it.) The
      // fold reads through the corner-radius asymmetry alone; this inset is uniform.
      screenInset: { top: "1.6%", right: "1.6%", bottom: "1.6%", left: "1.6%" },
      // No drawn camera at all: the simulator's own capture already bakes the camera
      // hole-punch into the wallpaper pixels at this exact position — drawing a second circle
      // on top produced a "figure-8" (two overlapping black circles) rather than one
      // prominent camera. A closed-Duo run's frame simply never draws its own camera; see
      // `device-bezel.tsx`'s corresponding note.
      camera: { top: "0%", right: "0%", size: "0%" },
      topButtons: { top: "0%", left: "47%", width: "12%", height: "0.9%" },
      sideButton: { top: "29%", height: "15%" },
    };
  }
  // flat and book share geometry; DuoBezel/BookHalves draw book's shallow-V + perspective warp
  // on the content only. No corner asymmetry here — all four corners equal, and no screen
  // inset (their thin uniform bezel is all `bodyPad`; unlike closed there is no extra black
  // gap to draw on top of the content).
  if (orientation === "portrait") {
    return {
      bodyRadius: uniformCornerRadius(9, 6),
      screenRadius: uniformCornerRadius(8.6, 5.8),
      bodyPad: "2.1% 2.1% 2.1% 2.1%",
      hinge: { axis: "horizontal" },
      screenInset: null,
      camera: { top: "0%", right: "0%", size: "0%" },
      topButtons: { top: "0%", left: "58%", width: "9%", height: "0.9%" },
      sideButton: { top: "29%", height: "15%" },
    };
  }
  return {
    bodyRadius: uniformCornerRadius(6, 9),
    screenRadius: uniformCornerRadius(5.8, 8.6),
    bodyPad: "2.1% 2.1% 2.1% 2.1%",
    hinge: { axis: "vertical" },
    screenInset: null,
    camera: { top: "0%", right: "0%", size: "0%" },
    topButtons: { top: "0%", left: "69%", width: "9%", height: "0.9%" },
    sideButton: { top: "29%", height: "15%" },
  };
}

/** Aspect ratio string (`"w / h"`) for a `DeviceBezel`'s screen cutout: the run's actual
 * captured resolution when known, so any device — Duo included — gets proportions that match
 * its hardware instead of the assumed iPhone ratio. Falls back to a style-appropriate default
 * (`fallbackAspect`, e.g. `frame-canvas`'s hardcoded phone/browser guess) only until the real
 * `screen_w`/`screen_h` arrives — from the `runs` row, or a video's own `videoWidth`/
 * `videoHeight` once its metadata loads. */
export function screenAspect(
  screenW: number | null | undefined,
  screenH: number | null | undefined,
  fallbackAspect: string,
): string {
  if (screenW && screenH && screenW > 0 && screenH > 0) return `${screenW} / ${screenH}`;
  return fallbackAspect;
}

/** `w > h` is landscape; anything else (including a square) is portrait — the plain `iphone`/
 * `android` bezels' own orientation test (mirrors `duoOrientationFromSize`, kept as a separate,
 * plainly-named function here since it's used for hardware that has nothing to do with the
 * Duo). A device physically rotated 90° still records a capture whose pixels are already
 * correctly landscape — this only decides which edge the bezel's decorations belong on. */
export function isLandscapeAspect(
  w: number | null | undefined,
  h: number | null | undefined,
): boolean {
  return Boolean(w && h && w > 0 && h > 0 && w > h);
}

/** One decoration's full inline-style position, ready to spread onto a `<span style>` —
 * exactly the properties needed (unset sides are simply omitted, never `"auto"`-padded) plus
 * the `transform` that centers it on whichever axis it isn't pinned to. Kept as ready-to-use
 * CSS rather than a set of flags so `device-bezel.tsx` never has to re-derive which sides or
 * which translate axis apply for a given edge — that logic lives here, once. */
export type ChromeDecorStyle = {
  top?: string;
  left?: string;
  right?: string;
  bottom?: string;
  width?: string;
  height?: string;
  transform: string;
};

/** One side button: which body edge it protrudes from, its position along that edge (percent
 * from the edge's own start corner) and its length. */
export interface ChromeButton {
  edge: "left" | "right" | "top" | "bottom";
  at: string;
  length: string;
}

/** Decorative chrome positions for the plain `iphone`/`android` bezels (`DeviceBezel`), for
 * each physical edge the run's device was actually rotated to before capture (migration 009:
 * `runs.orientation`/`run_requests.orientation`). Portrait values are exactly the positions the
 * bezel already drew before orientation existed — landscape rotates each decoration 90° onto
 * the edge it would physically sit on once the phone is turned, rather than leaving it pinned
 * to the box's geometric "top"/"left"/"right", which on a landscape capture is no longer where
 * the real notch/button/camera would be.
 *
 * Landscape here always means "rotated with the top edge now on the left" (matching how both
 * iOS and Android report a captured landscape frame — home button/indicator side becomes the
 * right edge, camera/notch side becomes the left edge), since a capture's pixels alone can't
 * distinguish landscape-left from landscape-right and the worker doesn't record which one it
 * is; the frame is decorative in either case — content is never rotated, only these overlays. */
export interface PhoneChromeGeometry {
  /** iPhone only: the Dynamic Island pill (zeroed-out, unused style on Android). */
  island: ChromeDecorStyle;
  /** iPhone only: the home indicator bar. */
  homeIndicator: ChromeDecorStyle;
  /** Android only: the punch-hole camera. */
  punchHole: ChromeDecorStyle;
  /** Android only: the gesture bar. */
  gestureBar: ChromeDecorStyle;
  /** iPhone: 3 buttons on the "left" edge + 1 on the "right" edge (portrait); Android: 2
   * buttons on the "right" edge (portrait). Landscape moves them to the top/bottom edges. */
  buttons: readonly ChromeButton[];
}

const IPHONE_PORTRAIT: PhoneChromeGeometry = {
  island: { top: "1.6%", left: "50%", width: "27%", height: "3.9%", transform: "translateX(-50%)" },
  homeIndicator: { bottom: "1.1%", left: "50%", width: "36%", height: "0.6%", transform: "translateX(-50%)" },
  punchHole: { top: "0%", left: "0%", width: "0%", height: "0%", transform: "none" },
  gestureBar: { bottom: "0%", left: "0%", width: "0%", height: "0%", transform: "none" },
  buttons: [
    { edge: "left", at: "14%", length: "4%" },
    { edge: "left", at: "21%", length: "7%" },
    { edge: "left", at: "30%", length: "7%" },
    { edge: "right", at: "23%", length: "11%" },
  ],
};

/** iPhone rotated 90° (top edge now on the left): the island moves from hugging the top,
 * centered horizontally, to hugging the left, centered vertically — same for every other
 * decoration, each rotated the same quarter-turn. */
const IPHONE_LANDSCAPE: PhoneChromeGeometry = {
  island: { top: "50%", left: "1.6%", width: "3.9%", height: "27%", transform: "translateY(-50%)" },
  homeIndicator: { top: "50%", right: "1.1%", width: "0.6%", height: "36%", transform: "translateY(-50%)" },
  punchHole: { top: "0%", left: "0%", width: "0%", height: "0%", transform: "none" },
  gestureBar: { top: "0%", left: "0%", width: "0%", height: "0%", transform: "none" },
  buttons: [
    { edge: "bottom", at: "14%", length: "4%" },
    { edge: "bottom", at: "21%", length: "7%" },
    { edge: "bottom", at: "30%", length: "7%" },
    { edge: "top", at: "23%", length: "11%" },
  ],
};

const ANDROID_PORTRAIT: PhoneChromeGeometry = {
  island: { top: "0%", left: "0%", width: "0%", height: "0%", transform: "none" },
  homeIndicator: { bottom: "0%", left: "0%", width: "0%", height: "0%", transform: "none" },
  punchHole: { top: "1.4%", left: "50%", width: "3.2%", height: "3.2%", transform: "translateX(-50%)" },
  gestureBar: { bottom: "1%", left: "50%", width: "30%", height: "0.5%", transform: "translateX(-50%)" },
  buttons: [
    { edge: "right", at: "18%", length: "9%" },
    { edge: "right", at: "29%", length: "5%" },
  ],
};

const ANDROID_LANDSCAPE: PhoneChromeGeometry = {
  island: { top: "0%", left: "0%", width: "0%", height: "0%", transform: "none" },
  homeIndicator: { top: "0%", left: "0%", width: "0%", height: "0%", transform: "none" },
  punchHole: { top: "50%", left: "1.4%", width: "3.2%", height: "3.2%", transform: "translateY(-50%)" },
  gestureBar: { right: "1%", top: "50%", width: "0.5%", height: "30%", transform: "translateY(-50%)" },
  buttons: [
    { edge: "top", at: "18%", length: "9%" },
    { edge: "top", at: "29%", length: "5%" },
  ],
};

export function phoneChromeGeometry(
  orientation: DuoOrientation,
  kind: "iphone" | "android",
): PhoneChromeGeometry {
  if (kind === "iphone") return orientation === "portrait" ? IPHONE_PORTRAIT : IPHONE_LANDSCAPE;
  return orientation === "portrait" ? ANDROID_PORTRAIT : ANDROID_LANDSCAPE;
}

/**
 * Geometry for the tablet bezels (`ipad`, `android-tablet`), in the screen's own units so the
 * bezel stays uniform at any size and in either orientation. Everything is a fraction of the
 * screen's *short* side (`S`), then turned into the CSS percentages each box needs:
 *
 * - `bodyPad`: the bezel thickness, a CSS `padding` percentage — which CSS always resolves
 *   against the containing block's *width*, so the same thickness is a smaller percentage of a
 *   wide landscape body than of a portrait one.
 * - `bodyRadius` / `screenRadius`: elliptical `x% / y%` corner radii that come out circular on
 *   the body / screen box (a single `%` radius on a non-square box draws an ellipse).
 * - `bodyAspect`: the whole body's aspect (`"w / h"`, screen plus bezel on both sides), so the
 *   height cap fits the *frame*, not just the screen, inside the column.
 * - `camera`: the front camera dot, centred in the bezel of the device's long edge (where both
 *   the iPad Pro (M4/M5) and the Pixel Tablet put it) — top in landscape, the right edge in
 *   portrait (the device turned a quarter-turn back).
 * - `buttons`: side buttons, defined for portrait and rotated with the body for landscape
 *   (same quarter-turn as the phone bezels: the portrait top edge becomes the left edge).
 *
 * No notch, island, punch-hole or home indicator: a tablet has none in its bezel, and iPadOS
 * draws its own home indicator into the capture.
 */
export interface TabletChromeGeometry {
  bodyPad: string;
  bodyRadius: string;
  screenRadius: string;
  bodyAspect: string;
  camera: ChromeDecorStyle;
  buttons: readonly ChromeButton[];
}

/** Per-style constants, all as fractions of the screen's short side. The iPad's bezel is thin
 * and even; the generic Android tablet's a little thicker with slightly squarer corners. */
const TABLET_SPECS: Record<
  "ipad" | "android-tablet",
  { bezel: number; bodyR: number; screenR: number; camera: number; portraitButtons: readonly ChromeButton[] }
> = {
  ipad: {
    bezel: 0.036,
    bodyR: 0.075,
    screenR: 0.045,
    camera: 0.011,
    portraitButtons: [
      { edge: "top", at: "76%", length: "8%" },
      { edge: "right", at: "9%", length: "5%" },
      { edge: "right", at: "15.5%", length: "5%" },
    ],
  },
  "android-tablet": {
    bezel: 0.048,
    bodyR: 0.06,
    screenR: 0.03,
    camera: 0.012,
    portraitButtons: [
      { edge: "top", at: "12%", length: "6%" },
      { edge: "top", at: "21%", length: "9%" },
    ],
  },
};

/** One portrait button turned a quarter-turn counter-clockwise (portrait top → left, right →
 * top, bottom → right, left → bottom), keeping its position along the edge in the new edge's
 * own start-corner terms. */
function rotateButtonToLandscape(b: ChromeButton): ChromeButton {
  const at = parseFloat(b.at);
  const len = parseFloat(b.length);
  const flipped = `${+(100 - at - len).toFixed(2)}%`;
  switch (b.edge) {
    case "top":
      return { edge: "left", at: flipped, length: b.length };
    case "right":
      return { edge: "top", at: b.at, length: b.length };
    case "bottom":
      return { edge: "right", at: flipped, length: b.length };
    case "left":
      return { edge: "bottom", at: b.at, length: b.length };
  }
}

const pct = (n: number) => `${+n.toFixed(3)}%`;

export function tabletChromeGeometry(
  style: "ipad" | "android-tablet",
  screenW: number,
  screenH: number,
): TabletChromeGeometry {
  const spec = TABLET_SPECS[style];
  const w = screenW > 0 ? screenW : IPAD_FALLBACK.w;
  const h = screenH > 0 ? screenH : IPAD_FALLBACK.h;
  const s = Math.min(w, h);
  const bezel = spec.bezel * s;
  const bodyW = w + 2 * bezel;
  const bodyH = h + 2 * bezel;
  const bodyR = spec.bodyR * s;
  const screenR = spec.screenR * s;
  const landscape = w > h;
  const cam = pct((100 * spec.camera * s) / bodyW);
  // Centred in the bezel strip: half the bezel in from the body's outer edge.
  const camera: ChromeDecorStyle = landscape
    ? { top: pct((100 * bezel) / 2 / bodyH), left: "50%", width: cam, transform: "translate(-50%, -50%)" }
    : { top: "50%", right: pct((100 * bezel) / 2 / bodyW), width: cam, transform: "translate(50%, -50%)" };
  return {
    bodyPad: pct((100 * bezel) / bodyW),
    bodyRadius: `${pct((100 * bodyR) / bodyW)} / ${pct((100 * bodyR) / bodyH)}`,
    screenRadius: `${pct((100 * screenR) / w)} / ${pct((100 * screenR) / h)}`,
    bodyAspect: `${+bodyW.toFixed(2)} / ${+bodyH.toFixed(2)}`,
    camera,
    buttons: landscape ? spec.portraitButtons.map(rotateButtonToLandscape) : spec.portraitButtons,
  };
}


/** A desktop window's size until a run's real capture size is known: Electron's common
 * default window (Orcha's is 1100x760). */
export const DESKTOP_FALLBACK = { w: 1100, h: 760 } as const;

/** Height (px) of the macOS window frame's title bar, above the captured window content. */
export const MAC_TITLE_BAR_PX = 28;

/** Pixel box for an evidence thumbnail: a fixed height, with the width following the run's
 * real capture ratio (`screen_w`/`screen_h`) so a web run reads as a browser and an iPad as a
 * tablet instead of every thumbnail being squeezed into a phone. Until the capture size is
 * known, the target kind picks the guess: a 1440×900 desktop viewport for web, a 440×956
 * phone otherwise. Width is clamped so a very wide capture still fits a findings card. */
export function evidenceThumbSize(
  kind: "web" | "ios" | "android" | "desktop" | null | undefined,
  screenW: number | null | undefined,
  screenH: number | null | undefined,
  height = 139,
): { w: number; h: number } {
  const known = screenW && screenH && screenW > 0 && screenH > 0 ? screenW / screenH : null;
  const aspect = known ?? (kind === "web" ? 1440 / 900 : kind === "desktop" ? DESKTOP_FALLBACK.w / DESKTOP_FALLBACK.h : 440 / 956);
  const w = Math.min(260, Math.max(48, Math.round(height * aspect)));
  return { w, h: height };
}
