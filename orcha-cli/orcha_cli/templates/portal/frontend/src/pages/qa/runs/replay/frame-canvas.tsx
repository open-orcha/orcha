import { useEffect, useRef, useState } from "react";
import { BufferedImage } from "./buffered-image";
import { signPath } from "./use-signed-url";

/**
 * One frame of a replay, swapped without a flash.
 *
 * The obvious implementation — `<img src={signedUrl}>` where the URL is re-signed per path —
 * flashes on every step, for three compounding reasons, all of which this component exists to
 * avoid:
 *
 * 1. **The URL went null between frames.** `useSignedUrl` keys its state by path, so the moment
 *    `path` changed it reported `url: null` and the caller swapped in a grey `animate-pulse`
 *    box — even though the next URL was already cached and resolved on the very next tick. The
 *    eye reads image → grey → image as a flash regardless of how brief the grey is. Here the
 *    last signed URL stays until the next one is signed.
 * 2. **`key={path}` rebuilt the element.** A new key destroys the `<img>` and mounts a fresh
 *    one, throwing away the decoded bitmap the prefetcher had just paid for.
 * 3. **Nothing waited for a decode.** Pointing an existing `<img>` at a new `src` clears it to
 *    blank and paints only once the browser has decoded the bytes.
 *
 * (2) and (3) are `BufferedImage`'s job: two persistent layers, the next frame decoded
 * off-screen and faded in *over* the one it replaces, which stays opaque underneath. (An
 * earlier version cross-faded both layers, which let the bezel show through at mid-fade and
 * dimmed the screen on every live step — see `@/lib/common/frame-buffer`.) A short fade rather than a
 * hard cut: consecutive device screenshots are mostly identical, so a hard swap makes only the
 * changed region pop, which reads as a glitch. Reduced motion gets the cut.
 */
export function FrameCanvas({
  path,
  alt,
  onUnavailable,
  fit = "cover",
  onSize,
}: {
  /** Storage object path for this frame; null while there is nothing to show yet. */
  path: string | null;
  alt: string;
  /** Called when a frame cannot be signed or loaded, so the caller can show its placeholder. */
  onUnavailable?: () => void;
  /**
   * `object-fit` for both image layers. Defaults to `"cover"`, which is right whenever the
   * caller's box is already sized to the capture's own aspect ratio (the common case — a phone
   * or tablet screen fills its bezel exactly). Pass `"contain"` when the box's aspect can be
   * momentarily wrong relative to the image it ends up holding — e.g. a live Duo run whose box
   * still assumes a plain-phone ratio until `screen_w`/`screen_h` arrives — so the frame is
   * letterboxed instead of cropped in the meantime.
   */
  fit?: "cover" | "contain";
  /** The frame now on screen's natural pixel size, so the caller can size its bezel to the
   * capture rather than to a guess (or to a run size that describes something else). */
  onSize?: (size: { w: number; h: number }) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const failed = useRef<string | null>(null);
  // Held in a ref, not a dependency: the callers build this callback inline, so a new identity
  // arrives on every render, and as a dependency it would re-sign the frame on every render.
  const unavailable = useRef(onUnavailable);
  useEffect(() => {
    unavailable.current = onUnavailable;
  }, [onUnavailable]);

  useEffect(() => {
    if (!path) return;
    let live = true;
    signPath(path).then(
      (signed) => {
        if (live) setUrl(signed);
      },
      () => {
        // Only once per frame, and only while it is still the frame asked for: a stale error
        // must not blank a frame that has since moved on.
        if (!live || failed.current === path) return;
        failed.current = path;
        unavailable.current?.();
      },
    );
    return () => {
      live = false;
    };
  }, [path]);

  return (
    <BufferedImage
      src={url}
      alt={alt}
      className={fit === "contain" ? "object-contain" : "object-cover"}
      frontProps={{ "data-replay-frame": "" }}
      onFrame={({ width, height }) => {
        if (width > 0 && height > 0) onSize?.({ w: width, h: height });
      }}
      onError={() => {
        if (!path || failed.current === path) return;
        failed.current = path;
        unavailable.current?.();
      }}
    />
  );
}
