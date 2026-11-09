import { describe, expect, it } from "vitest";
import { EMPTY_LAYERS, frontUrl, layerStyle, showFrame } from "./frame-buffer";

describe("frame buffer", () => {
  it("puts each new frame on the hidden layer and raises it", () => {
    const one = showFrame(EMPTY_LAYERS, "f1");
    expect(frontUrl(one)).toBe("f1");
    const two = showFrame(one, "f2");
    expect(frontUrl(two)).toBe("f2");
    // The frame it replaces is still there, underneath.
    expect(two[one.front]).toBe("f1");
    expect(two.front).not.toBe(one.front);
    const three = showFrame(two, "f3");
    expect(frontUrl(three)).toBe("f3");
    expect(three[two.front]).toBe("f2");
    expect([one.seq, two.seq, three.seq]).toEqual([1, 2, 3]);
  });

  it("does nothing for the frame already on screen", () => {
    const one = showFrame(EMPTY_LAYERS, "f1");
    expect(showFrame(one, "f1")).toBe(one);
  });

  it("keeps both layers opaque, so the background never shows between frames", () => {
    const two = showFrame(showFrame(EMPTY_LAYERS, "f1"), "f2");
    const front = layerStyle(two, two.front);
    const back = layerStyle(two, two.front === "a" ? "b" : "a");
    expect(front.opacity).toBe(1);
    expect(back.opacity).toBe(1);
    expect(front.zIndex).toBeGreaterThan(back.zIndex);
  });
});
