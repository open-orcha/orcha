import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { EMPTY_LAYERS, layerStyle, preloadFrame, showFrame, type FrameLayers } from "../lib/frame-buffer";
import { cn } from "../../map/kit";

/** Long enough to read as a cut between screens, well under a live step's interval. */
export const FRAME_FADE_MS = 140;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * An image that changes without ever blanking: a live device frame, a replay step. Each new
 * `src` is decoded off-screen and only then put on screen, on the layer above the frame it
 * replaces, which stays painted underneath (`@/lib/common/frame-buffer`). Neither `<img>` is ever
 * unmounted, so a decoded bitmap is never thrown away, and until the next frame is ready the
 * previous one simply stays.
 *
 * The obvious `<img key={src} src={src} className="animate-fade-in">` blinks on every frame:
 * the new key unmounts the painted image, the new element is empty until its bytes arrive and
 * decode, and the fade starts it from transparent over the background.
 *
 * Fills its nearest positioned ancestor.
 */
export function BufferedImage({
  src,
  alt,
  className,
  fadeMs = FRAME_FADE_MS,
  frontProps,
  onFrame,
  onError,
}: {
  /** The image to show; null keeps whatever is showing (nothing, before the first frame). */
  src: string | null;
  alt: string;
  /** Classes for both `<img>` layers (`object-cover`, `object-top`, …). */
  className?: string;
  fadeMs?: number;
  /** Attributes for the `<img>` on screen only (`data-*` hooks for tests and probes). */
  frontProps?: Record<`data-${string}`, string>;
  /** A frame has been put on screen, with its natural size. */
  onFrame?: (frame: { url: string; width: number; height: number }) => void;
  /** `src` could not be loaded; the previous frame stays on screen. */
  onError?: (url: string) => void;
}) {
  const [layers, setLayers] = useState<FrameLayers>(EMPTY_LAYERS);
  const refs = { a: useRef<HTMLImageElement>(null), b: useRef<HTMLImageElement>(null) };
  // Held in refs: callers pass these inline, and as effect dependencies a new identity on every
  // render would restart the load of the frame that is already on its way.
  const callbacks = useRef({ onFrame, onError });
  useEffect(() => {
    callbacks.current = { onFrame, onError };
  }, [onFrame, onError]);

  useEffect(() => {
    if (!src) return;
    let live = true;
    void preloadFrame(src).then(({ ok, width, height }) => {
      if (!live) return;
      if (!ok) {
        callbacks.current.onError?.(src);
        return;
      }
      setLayers((prev) => showFrame(prev, src));
      callbacks.current.onFrame?.({ url: src, width, height });
    });
    return () => {
      live = false;
    };
  }, [src]);

  // The new front layer fades in over the old frame, which stays opaque below it: the box is
  // covered at every moment of the change. Once per swap (`seq`), never on other re-renders.
  const front = refs[layers.front];
  useLayoutEffect(() => {
    if (layers.seq === 0 || fadeMs <= 0 || prefersReducedMotion()) return;
    const el = front.current;
    if (!el || typeof el.animate !== "function") return;
    const fade = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: fadeMs, easing: "linear" });
    return () => fade.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one fade per swap
  }, [layers.seq]);

  return (
    <div className="absolute inset-0 overflow-hidden" data-buffered-image>
      {(["a", "b"] as const).map((slot) => {
        const url = layers[slot];
        if (!url) return null;
        const isFront = layers.front === slot;
        return (
          // eslint-disable-next-line @next/next/no-img-element -- local artifact / signed URL
          <img
            key={slot}
            ref={refs[slot]}
            src={url}
            alt={isFront ? alt : ""}
            aria-hidden={isFront ? undefined : true}
            draggable={false}
            className={cn("absolute inset-0 size-full", className)}
            style={layerStyle(layers, slot)}
            {...(isFront ? frontProps : undefined)}
          />
        );
      })}
    </div>
  );
}
