/** "Highlight what changed": where two screenshots' pixels differ, as boxes. */
import { describe, expect, it } from "vitest";
import { diffRegions } from "./diff";

function picture(w: number, h: number, paint?: (x: number, y: number) => [number, number, number] | null): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = paint?.(x, y) ?? [245, 245, 245];
      px.set([...c, 255], (y * w + x) * 4);
    }
  return px;
}

describe("diffRegions", () => {
  const W = 40;
  const H = 80;
  const base = picture(W, H);

  it("finds nothing in two equal pictures", () => {
    expect(diffRegions(base, picture(W, H), W, H)).toEqual({ boxes: [], changed: 0 });
  });

  it("boxes a region that changed, where it is", () => {
    // A button that turned blue, 16 x 8 pixels at (8, 48).
    const after = picture(W, H, (x, y) => (x >= 8 && x < 24 && y >= 48 && y < 56 ? [30, 90, 230] : null));
    const { boxes, changed } = diffRegions(base, after, W, H);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].x).toBeCloseTo(8 / W, 5);
    expect(boxes[0].y).toBeCloseTo(48 / H, 5);
    expect(boxes[0].w).toBeCloseTo(16 / W, 5);
    expect(boxes[0].h).toBeCloseTo(8 / H, 5);
    expect(changed).toBeCloseTo(8 / 200, 5);
  });

  it("joins a line of changed words into one box, keeps two places apart, and drops a lone speck", () => {
    const after = picture(W, H, (x, y) => {
      if (y >= 8 && y < 12 && ((x >= 4 && x < 12) || (x >= 16 && x < 24))) return [0, 0, 0]; // two words, one gap
      if (y >= 60 && y < 68 && x >= 28 && x < 36) return [200, 30, 30]; // a badge far below
      if (x >= 36 && y < 4) return [0, 0, 0]; // a clock's tick: one cell
      return null;
    });
    const { boxes } = diffRegions(base, after, W, H);
    expect(boxes).toHaveLength(2);
    expect(boxes.some((b) => b.y < 0.2 && b.w >= 20 / W)).toBe(true);
    expect(boxes.some((b) => b.y > 0.7)).toBe(true);
  });

  it("ignores a change below the threshold and pictures it cannot read", () => {
    const faint = picture(W, H, () => [235, 235, 235]);
    expect(diffRegions(base, faint, W, H).boxes).toEqual([]);
    expect(diffRegions(base, new Uint8ClampedArray(4), W, H)).toEqual({ boxes: [], changed: 0 });
  });
});
