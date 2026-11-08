/**
 * The fog's texture: soft, cloudy white-on-transparent value noise drawn once on a small canvas
 * and stretched over the map by `fog-paint.ts`. Seeded, so the fog looks the same on every
 * visit. Client only.
 */

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fractal value noise in 0..1 on a `w` x `h` grid. */
export function fogField(w: number, h: number, seed = 7, octaves = 5): Float32Array {
  const rand = rng(seed);
  const out = new Float32Array(w * h);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const cell = Math.max(2, Math.round(w / (3 * 2 ** o)));
    const gw = Math.ceil(w / cell) + 2;
    const gh = Math.ceil(h / cell) + 2;
    const grid = Float32Array.from({ length: gw * gh }, () => rand());
    for (let y = 0; y < h; y++) {
      const gy = y / cell;
      const y0 = Math.floor(gy);
      const fy = gy - y0;
      const sy = fy * fy * (3 - 2 * fy);
      for (let x = 0; x < w; x++) {
        const gx = x / cell;
        const x0 = Math.floor(gx);
        const fx = gx - x0;
        const sx = fx * fx * (3 - 2 * fx);
        const a = grid[y0 * gw + x0];
        const b = grid[y0 * gw + x0 + 1];
        const c = grid[(y0 + 1) * gw + x0];
        const d = grid[(y0 + 1) * gw + x0 + 1];
        out[y * w + x] += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
      }
    }
    total += amp;
    amp *= 0.52;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

const cache = new Map<number, HTMLCanvasElement>();

/** The fog's noise as a canvas of white with cloudy alpha, or null where there is no canvas
 * (tests, server). Drawn once per seed. */
export function fogNoise(seed = 7, w = 220, h = 140): HTMLCanvasElement | null {
  const hit = cache.get(seed);
  if (hit) return hit;
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const field = fogField(w, h, seed);
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < field.length; i++) {
    // Contrast: thin wisps between thick banks.
    const v = Math.min(1, Math.max(0, (field[i] - 0.34) * 2.4));
    const a = v * v * (3 - 2 * v);
    img.data[i * 4] = 255;
    img.data[i * 4 + 1] = 255;
    img.data[i * 4 + 2] = 255;
    img.data[i * 4 + 3] = Math.round(a * 255);
  }
  ctx.putImageData(img, 0, 0);
  cache.set(seed, canvas);
  return canvas;
}
