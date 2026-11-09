/**
 * The fog, painted once into a bitmap. It used to be live SVG: a blur filter over every tile,
 * filled with a masked cloud pattern on an endless drift animation. Every frame re-blurred the
 * whole map: 15-17 fps idle in Chrome and 2 fps (700 ms frames) in WebKit, the Mac app's
 * engine. Now a canvas draws the haze and the clouds per tile at its fog level, blurs the result
 * once, and the map shows it as one `<image>`. Showing and fading it costs a composite, not a
 * re-render. Client only.
 */
import { fogNoise } from "./fog-texture";

export interface FogRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** 0 (clear) .. 1 (thick fog). */
  fog: number;
}

export interface FogStyle {
  color: string;
  /** Opacity of the flat haze and of the cloud banks at fog 1. */
  haze: number;
  banks: number;
  blur: number;
}

/** The haze and cloud opacities the CSS gives the fog in each theme (`.fogHaze`, `.fogBank`). */
export function fogStyle(dark: boolean, color: string, narrow: boolean): FogStyle {
  return { color, haze: dark ? 0.26 : 0.45, banks: dark ? 0.8 : 1, blur: narrow ? 7 : 11 };
}

function tinted(noise: HTMLCanvasElement, color: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = noise.width;
  c.height = noise.height;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(noise, 0, 0);
  return c;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

/** A blob URL of the fog over `rects` on a `width` x `height` map, or null without a canvas.
 * The caller revokes it. */
export async function paintFog(rects: readonly FogRect[], width: number, height: number, style: FogStyle): Promise<string | null> {
  if (typeof document === "undefined" || width <= 0 || height <= 0) return null;
  const noise = fogNoise(7);
  const layer = document.createElement("canvas");
  layer.width = Math.round(width);
  layer.height = Math.round(height);
  const ctx = layer.getContext("2d");
  if (!ctx || !noise) return null;
  const clouds = tinted(noise, style.color);
  for (const r of rects) {
    if (r.fog <= 0) continue;
    ctx.save();
    roundRect(ctx, r.x - 3, r.y - 3, r.w + 6, r.h + 6, 10);
    ctx.globalAlpha = r.fog * style.haze;
    ctx.fillStyle = style.color;
    ctx.fill();
    ctx.clip();
    // Two layers of the same noise, the second turned around, like the SVG fog it replaces.
    ctx.globalAlpha = r.fog * style.banks;
    ctx.drawImage(clouds, -width * 0.05, -height * 0.05, width * 1.1, height * 1.1);
    ctx.globalAlpha = r.fog * style.banks * 0.7;
    ctx.translate(width / 2, height / 2);
    ctx.rotate(Math.PI);
    ctx.drawImage(clouds, -width * 0.65, -height * 0.675, width * 1.3, height * 1.35);
    ctx.restore();
  }
  const out = document.createElement("canvas");
  out.width = layer.width;
  out.height = layer.height;
  const octx = out.getContext("2d")!;
  // Soft edges, once. A canvas without `filter` (older engines) keeps them crisp.
  if ("filter" in octx) octx.filter = `blur(${style.blur}px)`;
  octx.drawImage(layer, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, "image/png"));
  return blob ? URL.createObjectURL(blob) : null;
}
