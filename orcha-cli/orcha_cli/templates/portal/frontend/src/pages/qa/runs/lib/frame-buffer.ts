/**
 * The two stacked image layers behind a live or stepped frame (`BufferedImage`).
 *
 * A new frame is decoded off-screen first, then placed on the layer that is not showing and
 * raised above the other one. The frame it replaces stays fully opaque underneath until it is
 * covered, so the background never shows through between two frames.
 *
 * The version this replaced faded the old layer out while the new one faded in. Halfway
 * through, each was at 50% and together they covered only 75% of the box: on a black device
 * bezel every new step dimmed the screen by a quarter, which in a live run (a step every second
 * or two) read as the screen flickering.
 */

export type FrameSlot = "a" | "b";

export interface FrameLayers {
  a: string | null;
  b: string | null;
  front: FrameSlot;
  /** Bumped on every swap, so the caller can run the new front layer's fade once per frame. */
  seq: number;
}

export const EMPTY_LAYERS: FrameLayers = { a: null, b: null, front: "a", seq: 0 };

/** The URL on screen now, or null before the first frame. */
export function frontUrl(layers: FrameLayers): string | null {
  return layers[layers.front];
}

/**
 * `url` (already decoded) shown on top: it goes on the hidden layer, which becomes the front.
 * The same URL again changes nothing, so a re-render never replays the swap.
 */
export function showFrame(layers: FrameLayers, url: string): FrameLayers {
  if (frontUrl(layers) === url) return layers;
  const back: FrameSlot = layers.front === "a" ? "b" : "a";
  return { ...layers, [back]: url, front: back, seq: layers.seq + 1 };
}

/**
 * Both layers stay opaque; only the stacking order says which one is seen. The front layer is
 * faded in from transparent over the one below it (see `BufferedImage`), never the other way.
 */
export function layerStyle(layers: FrameLayers, slot: FrameSlot): { zIndex: number; opacity: number } {
  return { zIndex: layers.front === slot ? 1 : 0, opacity: 1 };
}

/**
 * Resolves once `url` has decoded (or failed to; `ok` says which), so it can be swapped in
 * without the `<img>` painting blank first. `decode()` is missing in some engines and rejects on
 * a broken image, hence the fallback to the load events.
 */
export function preloadFrame(url: string): Promise<{ ok: boolean; width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    const settle = (ok: boolean) => resolve({ ok, width: img.naturalWidth, height: img.naturalHeight });
    img.src = url;
    if (typeof img.decode === "function") {
      img.decode().then(
        () => settle(true),
        () => {
          // A rejected decode can still be a loaded image (a detached element in some engines).
          if (img.complete && img.naturalWidth > 0) settle(true);
          else {
            img.onload = () => settle(true);
            img.onerror = () => settle(false);
            if (img.complete) settle(img.naturalWidth > 0);
          }
        },
      );
    } else {
      img.onload = () => settle(true);
      img.onerror = () => settle(false);
    }
  });
}
