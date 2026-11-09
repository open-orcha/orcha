import type { ReactNode } from "react";
import { Smartphone, Tablet } from "../../map/kit/icons";
import { Select } from "../../map/kit";
import {
  DEVICE_FRAME_CHOICES,
  DEVICE_FRAME_LABEL,
  DUO_POSTURE_LABEL,
  duoGeometry,
  duoOrientationFromSize,
  frameStyleLabel,
  isLandscapeAspect,
  isTabletSize,
  isTabletStyle,
  MAC_TITLE_BAR_PX,
  phoneChromeGeometry,
  resolveDuoPosture,
  resolveFormFactor,
  resolveFrameStyle,
  tabletChromeGeometry,
  tabletStyleFor,
  useDeviceFrameChoice,
  type ChromeButton,
  type DeviceFrameChoice,
  type DeviceFrameStyle,
  type FrameHints,
  type DuoOrientation,
  type DuoPosture,
} from "../lib/device-frame";
import type { TargetKind } from "../types";
import { cn } from "../../map/kit";

/**
 * Parse an `aspect` prop like `"402 / 874"` (also tolerates `"402/874"`) into its two
 * numbers. Falls back to a phone-ish ratio if the string is malformed.
 */
function parseAspect(aspect: string): { w: number; h: number } {
  const m = /^\s*([\d.]+)\s*\/\s*([\d.]+)\s*$/.exec(aspect);
  if (!m) return { w: 402, h: 874 };
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0)
    return { w: 402, h: 874 };
  return { w, h };
}

/**
 * Caps the frame's width so its height (at the given aspect ratio) never exceeds the
 * vertical space left in the column after `reserve` px of chrome (header rows, scrubber,
 * controls, …) above/below it. Combined with the panel's own `max-w`, the frame is sized
 * by whichever of width/height is tighter, and stays centered when the pane is wider than
 * the cap allows.
 */
export function heightCapStyle(aspect: string, reserve: number) {
  const { w, h } = parseAspect(aspect);
  return {
    maxWidth: `min(100%, calc((100dvh - ${reserve}px) * ${w} / ${h}))`,
  };
}

/**
 * A phone bezel drawn in CSS around a screen: `iphone` (Dynamic Island, rounded corners,
 * side buttons, home indicator), `android` (punch-hole camera, thinner bezel, gesture bar)
 * or `none` (a plain rounded slab). Purely decorative: the screen keeps its own aspect ratio
 * and the screenshot is never covered except by the island / hole, which sit where the
 * real hardware does.
 *
 * Sized by both constraints: width never exceeds the pane (`max-w-[520px]` capped to the
 * container) AND height never exceeds the vertical space left in the column, so a very wide
 * pane on a short viewport doesn't push the bottom of the phone off-screen. `reserve` is the
 * vertical chrome (header rows, scrubber + controls, …) around the frame in the caller's
 * layout; pass 0 when the caller has no such chrome (e.g. the live-device-peek card).
 */
/** Whether this screen is tablet-shaped, in either orientation (`isTabletSize`: short/long
 * edge above 0.6).
 *
 * A phone is tall and narrow (the iPhone 17 Pro is 402x874, about 0.46); a tablet is much
 * closer to square (the iPad Pro 13" is 2064x2752, 0.75; a 16:10 Android tablet 0.625). The
 * iPhone Duo (closed ≈0.69) is squarer than any other phone but is still a phone —
 * `DeviceBezel` never asks this for a Duo style, which `resolveFrameStyle` picked by name.
 *
 * This matters because the phone bezel's corner radius is a percentage of *width*: on a wide
 * iPad screen that produces enormous rounding, and it also draws a notch and side buttons the
 * hardware does not have — so a phone style around a tablet-shaped screen is drawn as that
 * platform's tablet bezel instead (`tabletStyleFor`).
 */
export function isTabletAspect(aspect: string): boolean {
  const { w, h } = parseAspect(aspect);
  return isTabletSize(w, h);
}

/** One iPhone/Android side button, protruding 3px past whichever body edge it belongs to
 * (`button.edge`) — portrait's left/right buttons and landscape's rotated top/bottom buttons
 * are drawn by the exact same span, just against a different edge. */
function ChromeButtonSpan({ button }: { button: ChromeButton }) {
  const edgeClass: Record<ChromeButton["edge"], string> = {
    left: "absolute -left-[3px] w-[3px] rounded-l-sm bg-[#2a2a2e]",
    right: "absolute -right-[3px] w-[3px] rounded-r-sm bg-[#2a2a2e]",
    top: "absolute -top-[3px] h-[3px] rounded-t-sm bg-[#2a2a2e]",
    bottom: "absolute -bottom-[3px] h-[3px] rounded-b-sm bg-[#2a2a2e]",
  };
  const style =
    button.edge === "left" || button.edge === "right"
      ? { top: button.at, height: button.length }
      : { left: button.at, width: button.length };
  return <span aria-hidden className={edgeClass[button.edge]} style={style} />;
}

export function DeviceBezel({
  style,
  aspect,
  reserve = 220,
  duoPosture,
  title,
  className,
  children,
}: {
  style: DeviceFrameStyle;
  aspect: string;
  /** `mac-window` only: the window's title (the app's name), centred in the title bar. */
  title?: string | null;
  /** Vertical space (px) taken by chrome above/below the frame in the column. */
  reserve?: number;
  /** Duo only: the run's actual posture (`resolveDuoPosture`'s result). A run may only ever be
   * viewed in the posture it was recorded in, so this is not a viewer preference — omitting it
   * falls back to deriving one from `aspect` alone via `duoFoldFromSize`/`duoOrientationFromSize`
   * (closed if the aspect reads closed, else flat), which is enough for callers that haven't
   * threaded the run's `duo_posture` through yet. */
  duoPosture?: DuoPosture;
  className?: string;
  children: ReactNode;
}) {
  const capStyle = heightCapStyle(aspect, reserve);
  const { w: aspectW, h: aspectH } = parseAspect(aspect);
  // A tablet screenshot must never wear phone hardware: the notch, the side buttons and the
  // width-relative corner radius all belong to a phone, and on a 4:3-ish screen they read as
  // a broken aspect ratio rather than as a bezel. Skipped for the Duo styles: their own
  // squarer-than-phone aspects are expected (see `isTabletAspect`), not a sign that this is
  // secretly a tablet.
  const isDuoStyle =
    style === "iphone-duo" || style === "iphone-duo-open" || style === "iphone-duo-closed";
  if (style === "mac-window") {
    return (
      <MacWindowFrame aspect={aspect} reserve={reserve} title={title} className={className}>
        {children}
      </MacWindowFrame>
    );
  }
  const effective: DeviceFrameStyle =
    !isDuoStyle && isTabletAspect(aspect) ? tabletStyleFor(style) : style;
  if (isTabletStyle(effective)) {
    return (
      <TabletBezel style={effective} aspect={aspect} reserve={reserve} className={className}>
        {children}
      </TabletBezel>
    );
  }
  if (isDuoStyle) {
    const posture = duoPosture ?? resolveDuoPosture(null, aspectW, aspectH);
    const orientation = duoOrientationFromSize(aspectW, aspectH);
    return (
      <DuoBezel
        posture={posture}
        orientation={orientation}
        aspect={aspect}
        capStyle={capStyle}
        className={className}
      >
        {children}
      </DuoBezel>
    );
  }
  if (effective === "iphone" || effective === "android") {
    // Portrait keeps the exact positions this bezel always drew (see `phoneChromeGeometry`'s
    // portrait constants — copied verbatim from the pre-orientation literals); landscape (a
    // run rotated before capture — migration 009) moves each decoration to the edge it would
    // physically sit on once turned, so the notch/camera/buttons never end up pinned to what
    // is now a long edge. Content itself is never rotated — only these overlays.
    const orientation = isLandscapeAspect(aspectW, aspectH) ? "landscape" : "portrait";
    const geo = phoneChromeGeometry(orientation, effective);
    if (effective === "iphone") {
      return (
        <div
          data-device="phone"
          data-device-frame="iphone"
          data-device-orientation={orientation}
          className={cn("relative mx-auto w-full max-w-[520px]", className)}
          style={capStyle}
        >
          {/* side buttons */}
          {geo.buttons.map((b, i) => (
            <ChromeButtonSpan key={i} button={b} />
          ))}
          <div className="rounded-[13.5%/6.4%] bg-[#0b0b0c] p-[2.4%] shadow-[0_16px_40px_rgba(0,0,0,0.45),inset_0_0_0_1px_rgba(255,255,255,0.08)]">
            <div
              className="relative w-full overflow-hidden rounded-[11.5%/5.5%] bg-black"
              style={{ aspectRatio: aspect }}
            >
              {children}
              {/* Dynamic Island */}
              <span
                aria-hidden
                className="absolute z-10 rounded-full bg-black shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]"
                style={geo.island}
              />
              {/* home indicator */}
              <span
                aria-hidden
                className="absolute z-10 rounded-full bg-white/80 mix-blend-difference"
                style={geo.homeIndicator}
              />
            </div>
          </div>
        </div>
      );
    }
    return (
      <div
        data-device="phone"
        data-device-frame="android"
        data-device-orientation={orientation}
        className={cn("relative mx-auto w-full max-w-[520px]", className)}
        style={capStyle}
      >
        {geo.buttons.map((b, i) => (
          <ChromeButtonSpan key={i} button={b} />
        ))}
        <div className="rounded-[10%/4.8%] bg-[#101012] p-[1.8%] shadow-[0_16px_40px_rgba(0,0,0,0.45),inset_0_0_0_1px_rgba(255,255,255,0.07)]">
          <div
            className="relative w-full overflow-hidden rounded-[8.5%/4%] bg-black"
            style={{ aspectRatio: aspect }}
          >
            {children}
            {/* punch-hole camera */}
            <span
              aria-hidden
              className="absolute z-10 rounded-full bg-black shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]"
              style={{ ...geo.punchHole, aspectRatio: "1 / 1" }}
            />
            {/* gesture bar */}
            <span
              aria-hidden
              className="absolute z-10 rounded-full bg-white/70 mix-blend-difference"
              style={geo.gestureBar}
            />
          </div>
        </div>
      </div>
    );
  }
  return (
    <div
      data-device="phone"
      data-device-frame="none"
      className={cn(
        "mx-auto w-full max-w-[520px] rounded-[30px] bg-black p-1.5 shadow-[0_12px_30px_rgba(0,0,0,0.35)]",
        className,
      )}
      style={capStyle}
    >
      <div
        className="relative w-full overflow-hidden rounded-[24px] bg-black"
        style={{ aspectRatio: aspect }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * A tablet, drawn in CSS around its screen: `ipad` (thin, even graphite bezel, softly rounded
 * corners, a front camera dot on the long edge, top and volume buttons) or `android-tablet`
 * (a slightly thicker bezel with squarer corners). No notch, island or punch-hole — a tablet
 * has none. Portrait or landscape follows the screen box (`aspect`): a landscape capture gets
 * the bezel turned a quarter-turn — the camera and buttons move with it — while the capture
 * itself is never rotated. All proportions come from `tabletChromeGeometry`, as fractions of
 * the screen's short side, so the bezel stays the same thickness on every edge at any size.
 *
 * Sized like the phone bezels, but wider: the pane's width (up to 760px portrait / 980px
 * landscape), capped so the whole body — bezel included — fits the column's height.
 */
export function TabletBezel({
  style,
  aspect,
  reserve = 220,
  className,
  children,
}: {
  style: "ipad" | "android-tablet";
  aspect: string;
  reserve?: number;
  className?: string;
  children: ReactNode;
}) {
  const { w, h } = parseAspect(aspect);
  const geo = tabletChromeGeometry(style, w, h);
  const landscape = isLandscapeAspect(w, h);
  const ipad = style === "ipad";
  return (
    <div
      data-device="tablet"
      data-device-frame={style}
      data-device-orientation={landscape ? "landscape" : "portrait"}
      className={cn("relative mx-auto w-full", landscape ? "max-w-[980px]" : "max-w-[760px]", className)}
      style={heightCapStyle(geo.bodyAspect, reserve)}
    >
      {geo.buttons.map((b, i) => (
        <ChromeButtonSpan key={i} button={b} />
      ))}
      <div
        className={cn(
          "relative",
          ipad
            ? "bg-[#1c1c1e] shadow-[0_16px_40px_rgba(0,0,0,0.45),inset_0_0_0_1px_rgba(255,255,255,0.10),inset_0_0_0_2px_rgba(0,0,0,0.6)]"
            : "bg-[#101012] shadow-[0_16px_40px_rgba(0,0,0,0.45),inset_0_0_0_1px_rgba(255,255,255,0.07)]",
        )}
        style={{ borderRadius: geo.bodyRadius, padding: geo.bodyPad }}
      >
        {/* front camera, in the bezel of the long edge */}
        <span
          aria-hidden
          data-tablet-camera
          className="absolute z-10 rounded-full bg-[#050506] shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]"
          style={{ ...geo.camera, aspectRatio: "1 / 1" }}
        />
        <div
          className="relative w-full overflow-hidden bg-black"
          style={{ aspectRatio: aspect, borderRadius: geo.screenRadius }}
          data-tablet-screen
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * Apple's iPhone Duo simulator chrome, pixel-matched against Apple's own Simulator
 * screenshots (not eyeballed — see `duoGeometry`'s docstring for how each measurement was
 * taken) rather than a generic phone bezel: a titanium body, asymmetric screen/body corner
 * radii when closed (small on the spine side, large on the other — this asymmetry alone is
 * what reads as "folded"; there is no separate spine-strip layer drawn), and no home
 * indicator in any posture — the reference chrome simply doesn't draw one.
 *
 * A run may only ever be shown in the posture (and orientation) it was actually recorded in —
 * see `resolveDuoPosture` — so `posture`/`orientation` here are facts about the run, not a
 * viewer's choice.
 *
 * - **Closed**: a prominent hole-punch camera *inside* the screen's corner (see the "don't
 *   double-draw" note below) plus the top/side buttons; the wider body padding on the spine
 *   side is a real (small) measurement, not a decorative flourish.
 * - **Flat**: one continuous screen — the hinge shows only as a faint line at the centre,
 *   running perpendicular to the fold (vertical for landscape, horizontal for portrait). All
 *   four body/screen corners equal (no asymmetry).
 * - **Book**: the same flat body chrome (unwarped), but for image/canvas content the
 *   screenshot itself is split at the hinge into two halves, each given a mild
 *   `perspective()` + `rotateY`/`rotateX` tilt so they visually recede toward the centre —
 *   matching a photo of the physical hinge held open partway — plus a soft shading gradient
 *   along the hinge. Video content (live view, run recordings) is never split — only the
 *   hinge line/gradient overlay is drawn on top of the flat video, since two independently
 *   warped, synced video elements is not worth it for a decorative tilt.
 *
 * The screenshot itself is never cropped or stretched: it fills the screen cutout and each
 * caller sets `object-contain` on its own media element, so a run recorded at any resolution
 * still shows in full without this component needing to know about it.
 */
function DuoBezel({
  posture,
  orientation,
  aspect,
  capStyle,
  className,
  children,
}: {
  posture: DuoPosture;
  orientation: DuoOrientation;
  aspect: string;
  capStyle: { maxWidth: string };
  className?: string;
  children: ReactNode;
}) {
  const geo = duoGeometry(posture, orientation);
  const isBook = posture === "book";

  // `closed` only: the content sits inset from the screen cutout's own edge by
  // `geo.screenInset` (the black gap — see its docstring), with a matching (slightly smaller)
  // corner radius of its own, rather than being drawn full-bleed with black strips overlaid on
  // top. The overlay approach was tried first and looked right for `<img>` content, but a
  // `<canvas>`/`<video>` element does not reliably respect an ancestor's *elliptical, per-
  // corner-different* `border-radius` + `overflow:hidden` clip in Chromium once another
  // sibling (the black strips) also occupies that box — the canvas painted past the rounded
  // corner into the gap the strips were meant to cover, since the strips are straight edges
  // and never actually reached the true (rounded) clip boundary in the corner sectors. Insetting
  // the content itself sidesteps the whole problem: the always-visible black `bg-black` screen
  // background (already on the outer div two levels up) shows through the gap on its own, and
  // the content's own smaller radius means its corners never extend into that gap in the first
  // place, regardless of how any single browser clips canvas/video vs. img.
  const contentWrapperStyle = geo.screenInset
    ? {
        position: "absolute" as const,
        top: geo.screenInset.top,
        right: geo.screenInset.right,
        bottom: geo.screenInset.bottom,
        left: geo.screenInset.left,
        borderRadius: geo.screenRadius,
        overflow: "hidden" as const,
      }
    : undefined;
  const screenContent = isBook ? (
    <BookHalves axis={geo.hinge?.axis ?? "vertical"}>{children}</BookHalves>
  ) : contentWrapperStyle ? (
    <div className="relative" style={contentWrapperStyle}>
      <div className="absolute inset-0">{children}</div>
    </div>
  ) : (
    <div className="absolute inset-0">{children}</div>
  );

  const body = (
    <div
      // Graphite body colour + a bright rim highlight just inside the outer edge, both
      // re-sampled directly off Apple's own closed-Duo capture (32.png, flat area beside the
      // right side button: body ≈#494949, rim highlight peak ≈#585858 — the highlight is
      // rendered here as an opaque 2px ring, not a soft drop-shadow blend, since Apple's own
      // rim reads as a crisp bright line rather than a gradient). There is no separate darker
      // "spine" layer poking out past the body's edge — a uniform background sits right up
      // against it in the reference; the fold reads through the corner-radius asymmetry
      // (`geo.bodyRadius`/`geo.screenRadius`) *and* the wide black `screenInset` gap on the
      // spine edge (see below), not an extra drawn body layer.
      className="relative bg-[#494949] shadow-[0_16px_40px_rgba(0,0,0,0.5),inset_0_0_0_2px_#585858,inset_-1px_-1px_0_rgba(0,0,0,0.5)]"
      style={{ borderRadius: geo.bodyRadius, padding: geo.bodyPad }}
    >
      {/* Two small raised buttons on the top edge, right of centre — protrude above the body
          silhouette like every other bezel's side buttons, rather than sitting flush inside
          the padding. */}
      <span
        aria-hidden
        className="absolute top-0 z-10 -translate-y-1/2 rounded-full bg-[#4a4d51] shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
        style={{ left: geo.topButtons.left, width: geo.topButtons.width, height: "3px" }}
      />
      {/* Side button, right edge — the longer of the two Apple's own chrome shows. */}
      <span
        aria-hidden
        className="absolute -right-[3px] z-10 rounded-r-sm bg-[#4a4d51] shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
        style={{ top: geo.sideButton.top, height: geo.sideButton.height, width: "3px" }}
      />
      <div
        className="relative z-10 w-full overflow-hidden bg-black"
        style={{ aspectRatio: aspect, borderRadius: geo.screenRadius }}
      >
        {geo.hinge && (
          // Flat/book: a very faint line at the centre, perpendicular to the fold axis —
          // never drawn across the screenshot's own content, only overlaid on top of it.
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute z-20 bg-white/10",
              geo.hinge.axis === "vertical"
                ? "inset-y-0 left-1/2 w-px -translate-x-1/2"
                : "inset-x-0 top-1/2 h-px -translate-y-1/2",
            )}
          />
        )}
        {isBook && (
          // Book: a soft shading gradient along the hinge, on top of the split content —
          // reads as the two panels catching light differently as they angle away from flat.
          <span
            aria-hidden
            className={cn(
              "pointer-events-none absolute z-20",
              geo.hinge?.axis === "vertical"
                ? "inset-y-0 left-1/2 w-[6%] -translate-x-1/2 bg-[linear-gradient(to_right,transparent,rgba(0,0,0,0.35),transparent)]"
                : "inset-x-0 top-1/2 h-[6%] -translate-y-1/2 bg-[linear-gradient(to_bottom,transparent,rgba(0,0,0,0.35),transparent)]",
            )}
          />
        )}
        {/* The screenshot/video fills the screen area; this wrapper only clips to the
            rounded screen shape, it never crops or stretches the media itself — each
            caller's own element sets `object-contain` for that. */}
        {screenContent}
        {/* Camera hole-punch — inside the screen cutout (not the body), positioned per
            `geo.camera`. Zero-size (nothing rendered) for `closed`, where the simulator's own
            capture already bakes the camera into the wallpaper pixels — drawing a second
            circle on top produced a "figure-8" (two overlapping black circles) — and for
            flat/book, which draw no camera at all. */}
        {parseFloat(geo.camera.size) > 0 && (
          <span
            aria-hidden
            className="absolute z-30 rounded-full bg-black shadow-[inset_0_0_0_1px_rgba(255,255,255,0.18),0_0_0_1px_rgba(0,0,0,0.6)]"
            style={{
              top: geo.camera.top,
              right: geo.camera.right,
              width: geo.camera.size,
              aspectRatio: "1 / 1",
            }}
          />
        )}
      </div>
    </div>
  );

  const wrapperClass = cn("relative mx-auto w-full max-w-[560px]", className);

  // Book's shallow-V + perspective warp is drawn entirely inside the screen cutout by
  // `BookHalves` (each half of the *content* gets its own tilt) — the body chrome itself is
  // drawn once, flat and undivided, same as `flat`. Splitting the whole frame (body included)
  // into two independently transformed halves was tried first and discarded: each half ended
  // up showing a squeezed copy of the *entire* content rather than just its own portion, since
  // the content-splitting and the frame-splitting were both trying to divide the same box.
  // Keeping the body flat and warping only the content avoids that, and still reads as a fold
  // once combined with the hinge line + shading gradient drawn in `body` above.
  return (
    <div
      data-device="phone"
      data-device-frame={`duo-${posture}-${orientation}`}
      className={wrapperClass}
      style={capStyle}
    >
      {body}
    </div>
  );
}

/** Mild decorative tilt for each `book` content half — just enough to read as "not flat"
 * without distorting the image beyond recognition. */
const BOOK_TILT_DEG = 12;

/**
 * Splits the screen content into its two hinge halves for `book`, each a full-size copy of the
 * same content clipped to its own half (so neither half is stretched — only cropped, the same
 * trick every other half-box in this file uses), then gives each half's *container* a mild
 * `perspective()` + `rotateY`/`rotateX` pivoted at the hinge seam, so the pair reads as
 * receding away from the viewer toward the centre — a photo of the physical hinge held open
 * partway. Only used for `<img>`/canvas-style content — `RunVideo`/live view pass a `<video>`
 * through `DeviceBezel` untouched (no split, no warp): two independently warped, synced video
 * elements is not worth building for a purely decorative tilt, so a video inside a `book`
 * bezel gets the flat content with only the body chrome + hinge gradient (`DuoBezel`'s own
 * hinge/gradient overlay) suggesting the fold.
 *
 * Detection: video content is any child whose type renders a `<video>` — since this component
 * only ever receives the same `children` `DeviceBezel` was given (an `<img>`/canvas or a
 * `<video>` element from the caller), a simple `isVideoChild` check on the direct child is
 * enough without needing a prop threaded through every caller.
 */
function BookHalves({ children, axis }: { children: ReactNode; axis: "horizontal" | "vertical" }) {
  const isVideo = isVideoChild(children);
  if (isVideo) {
    // Flat content for video: no split, no warp — just the body chrome + hinge gradient.
    return <div className="absolute inset-0">{children}</div>;
  }
  const isVertical = axis === "vertical"; // landscape: hinge runs vertically, halves side by side
  return (
    <div className="absolute inset-0" style={{ perspective: "1200px" }}>
      <div
        className={cn(
          "absolute overflow-hidden",
          isVertical ? "inset-y-0 left-0 w-1/2" : "inset-x-0 top-0 h-1/2",
        )}
        style={{
          transformOrigin: isVertical ? "right center" : "bottom center",
          transform: isVertical ? `rotateY(${-BOOK_TILT_DEG}deg)` : `rotateX(${BOOK_TILT_DEG}deg)`,
        }}
      >
        <div className={isVertical ? "absolute inset-y-0 left-0 w-[200%]" : "absolute inset-x-0 top-0 h-[200%]"}>
          {children}
        </div>
      </div>
      <div
        className={cn(
          "absolute overflow-hidden",
          isVertical ? "inset-y-0 right-0 w-1/2" : "inset-x-0 bottom-0 h-1/2",
        )}
        style={{
          transformOrigin: isVertical ? "left center" : "top center",
          transform: isVertical ? `rotateY(${BOOK_TILT_DEG}deg)` : `rotateX(${-BOOK_TILT_DEG}deg)`,
        }}
      >
        <div
          className={isVertical ? "absolute inset-y-0 right-0 w-[200%]" : "absolute inset-x-0 bottom-0 h-[200%]"}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function isVideoChild(node: ReactNode): boolean {
  if (node == null || typeof node !== "object") return false;
  const nodes = Array.isArray(node) ? node : [node];
  return nodes.some((n) => {
    if (n == null || typeof n !== "object" || !("type" in n)) return false;
    const type = (n as { type?: unknown }).type;
    if (type === "video") return true;
    // A caller-defined component (e.g. RunVideo renders its own <video> further down) — this
    // module has no way to see through it, so such content is treated as non-video (split) by
    // default; every current video caller (`run-video.tsx`, live view) passes a bare `<video>`
    // straight through, not a wrapping component, so this holds for the callers that exist.
    return false;
  });
}

/** Read-only chip shown wherever the free posture picker used to be: a run may only ever be
 * viewed in the posture and orientation it was actually recorded in (the worker fails the run
 * at preflight otherwise), so there is nothing left to choose here. */
export function DuoPostureChip({
  posture,
  orientation,
  className,
}: {
  posture: DuoPosture;
  orientation: DuoOrientation;
  className?: string;
}) {
  const orientationLabel = orientation === "landscape" ? "Landscape" : "Portrait";
  return (
    <span
      data-duo-posture-chip
      title="This run's recorded fold state. Not a viewing choice."
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-border bg-hover px-2 py-0.5 text-xs text-muted",
        className,
      )}
    >
      <Smartphone className="size-3" aria-hidden />
      Duo · {DUO_POSTURE_LABEL[posture]}
      {posture !== "closed" ? ` · ${orientationLabel}` : ""}
    </span>
  );
}

/**
 * A desktop app's window, drawn the way macOS draws it: a title bar with the three traffic
 * lights and the window title, rounded top corners, a hairline edge and a soft shadow. The
 * capture is the window's content only (CDP never sees native chrome), so the frame supplies
 * the title bar and the screenshot sits below it at its own aspect ratio. Sized like the
 * browser frame: the full pane width, capped so the whole window fits the column's height.
 */
export function MacWindowFrame({
  aspect,
  reserve = 220,
  title,
  className,
  children,
}: {
  aspect: string;
  reserve?: number;
  title?: string | null;
  className?: string;
  children: ReactNode;
}) {
  const capStyle = heightCapStyle(aspect, reserve + MAC_TITLE_BAR_PX);
  return (
    <div
      data-device="window"
      data-device-frame="mac-window"
      className={cn(
        "mx-auto w-full overflow-hidden rounded-[10px] border border-border-strong bg-panel shadow-[0_18px_44px_rgba(0,0,0,0.22),0_0_0_0.5px_rgba(0,0,0,0.2)] dark:shadow-[0_18px_44px_rgba(0,0,0,0.6),0_0_0_0.5px_rgba(0,0,0,0.6)]",
        className,
      )}
      style={capStyle}
    >
      <div
        className="relative flex items-center border-b border-border bg-panel-2 px-3"
        style={{ height: MAC_TITLE_BAR_PX }}
      >
        <span aria-hidden className="flex items-center gap-2">
          <span className="size-3 rounded-full bg-[#ff5f57] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.25)]" />
          <span className="size-3 rounded-full bg-[#febc2e] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.25)]" />
          <span className="size-3 rounded-full bg-[#28c840] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.25)]" />
        </span>
        {title ? (
          <span
            className="pointer-events-none absolute inset-x-16 truncate text-center text-xs font-medium text-fg-2"
            data-window-title
          >
            {title}
          </span>
        ) : null}
      </div>
      <div className="relative w-full bg-black" style={{ aspectRatio: aspect }}>
        {children}
      </div>
    </div>
  );
}

/** Bezel picker for the replay header: Auto (by the run's device), iPhone, Android phone,
 * iPad, Android tablet, none. On a Duo run this is replaced by `DuoPostureChip` (read-only — see
 * its docstring), rendered by the caller since it needs the run's resolved posture/orientation,
 * not just its kind/device name. The preference is kept per platform *and* form factor, so a
 * choice made on an iPhone run never puts an iPad run in a phone bezel. */
export function DeviceFrameSelect({
  kind,
  deviceName,
  hints,
  className,
}: {
  kind: TargetKind;
  /** The run's device name, so "Auto" previews what it will actually draw ("iPad", "iPhone
   * Duo", …) rather than the platform's phone. */
  deviceName?: string | null;
  /** The device record and capture size, for a run whose name does not say phone or tablet. */
  hints?: FrameHints;
  className?: string;
}) {
  const formFactor = resolveFormFactor({ deviceName, ...hints });
  const [choice, setChoice] = useDeviceFrameChoice(kind, formFactor);
  // A browser has its own chrome, and a desktop app always wears its Mac window.
  if (kind === "web" || kind === "desktop") return null;
  const autoStyle = resolveFrameStyle("auto", kind, deviceName, hints);
  const isDuoRun = resolveFrameStyle(choice, kind, deviceName, hints) === "iphone-duo";
  if (isDuoRun) return null;
  return (
    <label
      className={cn("flex items-center gap-1 text-xs text-muted", className)}
      title="Device frame"
    >
      {formFactor === "tablet" ? (
        <Tablet className="size-3.5" aria-hidden />
      ) : (
        <Smartphone className="size-3.5" aria-hidden />
      )}
      <Select
        dimension="sm"
        value={choice}
        onChange={(e) => setChoice(e.target.value as DeviceFrameChoice)}
        aria-label="Device frame"
        className="w-auto"
        data-device-frame-select
        data-device-frame-auto={autoStyle}
      >
        {DEVICE_FRAME_CHOICES.map((c) => (
          <option key={c} value={c}>
            {c === "auto" ? `Auto (${frameStyleLabel(autoStyle)})` : DEVICE_FRAME_LABEL[c]}
          </option>
        ))}
      </Select>
    </label>
  );
}

/** Convenience: the resolved style for a kind under the viewer's preference. `deviceName` is
 * the run's device name (e.g. `run.device_name`, `device.name`) — passing it lets "Auto" (and
 * an explicit "iPhone" choice) resolve to the Duo's own bezel on a Duo run, and "Auto" to a
 * tablet bezel on an iPad / Android tablet run. `hints` (the device record, the capture size)
 * settle phone vs tablet when the name does not. */
export function useFrameStyle(
  kind: TargetKind,
  deviceName?: string | null,
  hints: FrameHints = {},
): DeviceFrameStyle {
  const formFactor = resolveFormFactor({ deviceName, ...hints });
  const [choice] = useDeviceFrameChoice(kind, formFactor);
  return resolveFrameStyle(choice, kind, deviceName, hints);
}
