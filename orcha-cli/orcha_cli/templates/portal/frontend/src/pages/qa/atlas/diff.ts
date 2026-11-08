/**
 * Where two screenshots of a screen differ, measured from their pixels (the before and after
 * slider's "Highlight what changed", screen-detail.tsx). Both are drawn small at one size; the
 * picture is cut into cells, a cell whose colours moved past a threshold is marked, neighbouring
 * marked cells join, and each group is one box. Pure (`diffRegions` takes the pixels), so it is
 * tested alone; `measureDiff` draws the two images in a canvas in the browser. Nothing here guesses:
 * a box is drawn only where the pixels differ.
 */

export interface Box {
  /** Fractions of the picture, 0..1. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DiffResult {
  boxes: Box[];
  /** The share of the picture whose cells differ, 0..1. */
  changed: number;
}

/** The width both pictures are drawn at before they are compared. */
export const DIFF_W = 96;
const CELL = 4;
/** A cell differs when its pixels' mean colour distance passes this (0..255). */
const THRESHOLD = 22;
const MAX_BOXES = 8;

/**
 * The boxes where two pictures of `w`×`h` RGBA pixels differ. Groups of a single cell are dropped
 * (noise: a blinking caret, a clock), the rest are sorted biggest first, at most eight.
 */
export function diffRegions(a: ArrayLike<number>, b: ArrayLike<number>, w: number, h: number, opts: { cell?: number; threshold?: number } = {}): DiffResult {
  const cell = opts.cell ?? CELL;
  const threshold = opts.threshold ?? THRESHOLD;
  const cols = Math.ceil(w / cell);
  const rows = Math.ceil(h / cell);
  if (!cols || !rows || a.length < w * h * 4 || b.length < w * h * 4) return { boxes: [], changed: 0 };
  const marked = new Uint8Array(cols * rows);
  let count = 0;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let sum = 0;
      let px = 0;
      for (let y = cy * cell; y < Math.min(h, (cy + 1) * cell); y++) {
        for (let x = cx * cell; x < Math.min(w, (cx + 1) * cell); x++) {
          const i = (y * w + x) * 4;
          sum += (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
          px += 1;
        }
      }
      if (px && sum / px > threshold) {
        marked[cy * cols + cx] = 1;
        count += 1;
      }
    }
  }
  // Groups of marked cells, a cell's eight neighbours and one cell beyond joining it (so a line of
  // text that changed is one box, not a box per word).
  const seen = new Uint8Array(cols * rows);
  const groups: { x0: number; y0: number; x1: number; y1: number; n: number }[] = [];
  for (let start = 0; start < marked.length; start++) {
    if (!marked[start] || seen[start]) continue;
    const g = { x0: cols, y0: rows, x1: -1, y1: -1, n: 0 };
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const k = stack.pop()!;
      const cx = k % cols;
      const cy = (k - cx) / cols;
      g.x0 = Math.min(g.x0, cx);
      g.y0 = Math.min(g.y0, cy);
      g.x1 = Math.max(g.x1, cx);
      g.y1 = Math.max(g.y1, cy);
      g.n += 1;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const nk = ny * cols + nx;
          if (marked[nk] && !seen[nk]) {
            seen[nk] = 1;
            stack.push(nk);
          }
        }
      }
    }
    if (g.n > 1) groups.push(g);
  }
  groups.sort((p, q) => (q.x1 - q.x0 + 1) * (q.y1 - q.y0 + 1) - (p.x1 - p.x0 + 1) * (p.y1 - p.y0 + 1));
  const boxes = groups.slice(0, MAX_BOXES).map((g) => ({
    x: (g.x0 * cell) / w,
    y: (g.y0 * cell) / h,
    w: (Math.min(w, (g.x1 + 1) * cell) - g.x0 * cell) / w,
    h: (Math.min(h, (g.y1 + 1) * cell) - g.y0 * cell) / h,
  }));
  return { boxes, changed: count / (cols * rows) };
}

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${src}`));
    img.src = src;
  });
}

/**
 * Draws two screenshots at one small size and finds where they differ. Null where a canvas is not
 * available (a test DOM) or a picture does not load.
 */
export async function measureDiff(before: string, after: string): Promise<DiffResult | null> {
  if (typeof document === "undefined") return null;
  try {
    const [a, b] = await Promise.all([load(before), load(after)]);
    const w = DIFF_W;
    const h = Math.max(8, Math.round((DIFF_W * (b.naturalHeight || 1)) / (b.naturalWidth || 1)));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(a, 0, 0, w, h);
    const pa = ctx.getImageData(0, 0, w, h).data;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(b, 0, 0, w, h);
    const pb = ctx.getImageData(0, 0, w, h).data;
    return diffRegions(pa, pb, w, h);
  } catch {
    return null;
  }
}
