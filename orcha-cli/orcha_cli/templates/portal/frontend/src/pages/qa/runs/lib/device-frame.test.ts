import { describe, expect, it } from "vitest";
import {
  evidenceThumbSize,
  DUO_POSTURES,
  duoFallbackSize,
  duoFallbackSizeFor,
  duoFoldFromSize,
  duoGeometry,
  duoOrientationFromSize,
  isDuoDeviceName,
  isLandscapeAspect,
  legacyChoiceApplies,
  phoneChromeGeometry,
  resolveDuoPosture,
  resolveDuoStyle,
  resolveFrameStyle,
  screenAspect,
} from "./device-frame";

describe("resolveFrameStyle", () => {
  it("auto follows the run's platform", () => {
    expect(resolveFrameStyle("auto", "android")).toBe("android");
    expect(resolveFrameStyle("auto", "ios")).toBe("iphone");
  });

  it("web never draws a phone bezel", () => {
    expect(resolveFrameStyle("auto", "web")).toBe("none");
    expect(resolveFrameStyle("iphone", "web")).toBe("none");
  });

  it("an explicit choice is honoured", () => {
    expect(resolveFrameStyle("none", "ios")).toBe("none");
    expect(resolveFrameStyle("android", "ios")).toBe("android");
  });

  it("auto resolves to the Duo bezel when the run's device is an iPhone Duo", () => {
    expect(resolveFrameStyle("auto", "ios", "iPhone Duo")).toBe("iphone-duo");
  });

  it("an explicit iPhone choice still gets the Duo's own proportions on a Duo run", () => {
    expect(resolveFrameStyle("iphone", "ios", "iPhone Duo")).toBe("iphone-duo");
  });

  it("an explicit 'none' or 'android' choice is not overridden by a Duo device name", () => {
    expect(resolveFrameStyle("none", "ios", "iPhone Duo")).toBe("none");
    expect(resolveFrameStyle("android", "ios", "iPhone Duo")).toBe("android");
  });

  it("a Duo-like name on Android or web never resolves to the Duo bezel", () => {
    expect(resolveFrameStyle("auto", "android", "iPhone Duo")).toBe("android");
    expect(resolveFrameStyle("auto", "web", "iPhone Duo")).toBe("none");
  });

  it("a plain iPhone name does not resolve to the Duo bezel", () => {
    expect(resolveFrameStyle("auto", "ios", "iPhone 17 Pro")).toBe("iphone");
    expect(resolveFrameStyle("auto", "ios", null)).toBe("iphone");
    expect(resolveFrameStyle("auto", "ios", undefined)).toBe("iphone");
  });
});

describe("isDuoDeviceName", () => {
  it("matches 'iPhone Duo' case-insensitively", () => {
    expect(isDuoDeviceName("iPhone Duo")).toBe(true);
    expect(isDuoDeviceName("iphone duo")).toBe(true);
    expect(isDuoDeviceName("IPHONE DUO")).toBe(true);
  });

  it("matches a longer product name that still says Duo", () => {
    expect(isDuoDeviceName("iPhone Duo Pro")).toBe(true);
  });

  it("does not match an unrelated device name", () => {
    expect(isDuoDeviceName("iPhone 17 Pro")).toBe(false);
    expect(isDuoDeviceName("iPhone Air")).toBe(false);
  });

  it("handles null/undefined/empty", () => {
    expect(isDuoDeviceName(null)).toBe(false);
    expect(isDuoDeviceName(undefined)).toBe(false);
    expect(isDuoDeviceName("")).toBe(false);
  });
});

describe("screenAspect", () => {
  it("uses the run's captured resolution when present", () => {
    expect(screenAspect(1398, 2034, "9 / 19.5")).toBe("1398 / 2034");
  });

  it("falls back when width or height is missing, zero, or negative", () => {
    expect(screenAspect(null, 2034, "9 / 19.5")).toBe("9 / 19.5");
    expect(screenAspect(1398, null, "9 / 19.5")).toBe("9 / 19.5");
    expect(screenAspect(0, 0, "9 / 19.5")).toBe("9 / 19.5");
    expect(screenAspect(-1, 100, "9 / 19.5")).toBe("9 / 19.5");
    expect(screenAspect(undefined, undefined, "16 / 10")).toBe("16 / 10");
  });
});

describe("isLandscapeAspect", () => {
  it("a 2424x1080 Android capture (migration 009 landscape) reads as landscape", () => {
    expect(isLandscapeAspect(2424, 1080)).toBe(true);
  });

  it("a 2622x1206 iPhone capture (migration 009 landscape) reads as landscape", () => {
    expect(isLandscapeAspect(2622, 1206)).toBe(true);
  });

  it("a plain portrait capture is not landscape", () => {
    expect(isLandscapeAspect(1206, 2622)).toBe(false);
  });

  it("falls back to portrait on missing/invalid dimensions", () => {
    expect(isLandscapeAspect(null, null)).toBe(false);
    expect(isLandscapeAspect(0, 0)).toBe(false);
    expect(isLandscapeAspect(undefined, 100)).toBe(false);
  });
});

/** A landscape run must still get a phone bezel whose decorations sit on the edge they'd
 * physically be on once the device is rotated — not stretched or left pinned to the box's
 * geometric top/left, which on a wide landscape capture is no longer where the real
 * notch/camera/buttons are (task: "no stretching", "buttons/notch on the correct edge"). */
describe("phoneChromeGeometry", () => {
  it("iPhone portrait keeps the island hugging the top edge, centered horizontally", () => {
    const geo = phoneChromeGeometry("portrait", "iphone");
    expect(geo.island.top).toBe("1.6%");
    expect(geo.island.left).toBe("50%");
    expect(geo.island.transform).toContain("translateX");
  });

  it("iPhone landscape (e.g. a 2622x1206 capture) moves the island to the left edge, centered vertically", () => {
    const geo = phoneChromeGeometry("landscape", "iphone");
    expect(geo.island.left).toBe("1.6%");
    expect(geo.island.top).toBe("50%");
    expect(geo.island.transform).toContain("translateY");
    // Width/height swap with the rotation: the island is a wide-short pill lying along the
    // top edge in portrait, and becomes a tall-narrow pill lying along the left edge here.
    expect(geo.island.width).toBe("3.9%");
    expect(geo.island.height).toBe("27%");
  });

  it("iPhone landscape moves the 3 left-edge buttons to the bottom edge and the right-edge button to the top edge", () => {
    const portrait = phoneChromeGeometry("portrait", "iphone");
    const landscape = phoneChromeGeometry("landscape", "iphone");
    expect(portrait.buttons.filter((b) => b.edge === "left")).toHaveLength(3);
    expect(portrait.buttons.filter((b) => b.edge === "right")).toHaveLength(1);
    expect(landscape.buttons.filter((b) => b.edge === "bottom")).toHaveLength(3);
    expect(landscape.buttons.filter((b) => b.edge === "top")).toHaveLength(1);
  });

  it("Android portrait keeps the punch-hole camera hugging the top edge, centered horizontally", () => {
    const geo = phoneChromeGeometry("portrait", "android");
    expect(geo.punchHole.top).toBe("1.4%");
    expect(geo.punchHole.left).toBe("50%");
  });

  it("Android landscape (e.g. a 2424x1080 capture) moves the punch-hole camera to the left edge, centered vertically", () => {
    const geo = phoneChromeGeometry("landscape", "android");
    expect(geo.punchHole.left).toBe("1.4%");
    expect(geo.punchHole.top).toBe("50%");
    expect(geo.punchHole.transform).toContain("translateY");
  });

  it("Android landscape moves both right-edge buttons to the top edge", () => {
    const portrait = phoneChromeGeometry("portrait", "android");
    const landscape = phoneChromeGeometry("landscape", "android");
    expect(portrait.buttons.every((b) => b.edge === "right")).toBe(true);
    expect(landscape.buttons.every((b) => b.edge === "top")).toBe(true);
  });

  it("never stretches a decoration: landscape values are a 90° relabelling of the same portrait measurements", () => {
    const pIphone = phoneChromeGeometry("portrait", "iphone");
    const lIphone = phoneChromeGeometry("landscape", "iphone");
    expect(lIphone.island.width).toBe(pIphone.island.height);
    expect(lIphone.island.height).toBe(pIphone.island.width);
    const pAndroid = phoneChromeGeometry("portrait", "android");
    const lAndroid = phoneChromeGeometry("landscape", "android");
    expect(lAndroid.gestureBar.width).toBe(pAndroid.gestureBar.height);
    expect(lAndroid.gestureBar.height).toBe(pAndroid.gestureBar.width);
  });
});

describe("resolveDuoStyle", () => {
  it("picks the open (landscape) style when the screen is wider than tall", () => {
    expect(resolveDuoStyle("iphone-duo", 2202, 1706)).toBe("iphone-duo-open");
  });

  it("picks the closed (portrait) style when the screen is taller than wide", () => {
    expect(resolveDuoStyle("iphone-duo", 1398, 2034)).toBe("iphone-duo-closed");
  });

  it("picks the closed style for a square screen (not wider than tall)", () => {
    expect(resolveDuoStyle("iphone-duo", 1000, 1000)).toBe("iphone-duo-closed");
  });

  it("falls back to the closed style when dimensions are missing", () => {
    expect(resolveDuoStyle("iphone-duo", null, null)).toBe("iphone-duo-closed");
    expect(resolveDuoStyle("iphone-duo", undefined, undefined)).toBe("iphone-duo-closed");
  });

  it("passes non-alias styles through unchanged, regardless of dimensions", () => {
    expect(resolveDuoStyle("iphone", 2202, 1706)).toBe("iphone");
    expect(resolveDuoStyle("android", null, null)).toBe("android");
    expect(resolveDuoStyle("none", 100, 900)).toBe("none");
    expect(resolveDuoStyle("iphone-duo-open", 1398, 2034)).toBe("iphone-duo-open");
    expect(resolveDuoStyle("iphone-duo-closed", 2202, 1706)).toBe("iphone-duo-closed");
  });
});

describe("duoFallbackSize", () => {
  it("returns a landscape size (wider than tall) for open", () => {
    const { w, h } = duoFallbackSize("iphone-duo-open");
    expect(w).toBeGreaterThan(h);
    expect(w / h).toBeCloseTo(1.29, 1);
  });

  it("returns a portrait size (taller than wide) for closed", () => {
    const { w, h } = duoFallbackSize("iphone-duo-closed");
    expect(h).toBeGreaterThan(w);
    expect(w / h).toBeCloseTo(0.69, 1);
  });
});

describe("duoOrientationFromSize", () => {
  it("landscape when wider than tall", () => {
    expect(duoOrientationFromSize(2853, 2007)).toBe("landscape");
  });

  it("portrait when taller than wide, or on missing/invalid dimensions", () => {
    expect(duoOrientationFromSize(2007, 2853)).toBe("portrait");
    expect(duoOrientationFromSize(null, null)).toBe("portrait");
    expect(duoOrientationFromSize(0, 0)).toBe("portrait");
  });
});

describe("duoFoldFromSize", () => {
  it("detects open whenever width exceeds height", () => {
    expect(duoFoldFromSize(2853, 2007)).toBe("open");
    expect(duoFoldFromSize(2202, 1706)).toBe("open");
  });

  it("detects the folded outer display as closed", () => {
    expect(duoFoldFromSize(1398, 2034)).toBe("closed");
  });

  it("detects the unfolded panel captured portrait as open, not closed, despite the similar aspect ratio", () => {
    // 1398/2034 = 0.687 and 2007/2853 = 0.703 — within 2.3% of each other, so this only works
    // if the function keys off the nearer reference ratio rather than a fixed threshold.
    expect(duoFoldFromSize(2007, 2853)).toBe("open");
  });

  it("scales with capture resolution (a @1x or @2x capture of either size still resolves correctly)", () => {
    expect(duoFoldFromSize(1398 / 3, 2034 / 3)).toBe("closed");
    expect(duoFoldFromSize((2007 / 3) * 2, (2853 / 3) * 2)).toBe("open");
  });

  it("falls back to closed when a dimension is missing, zero, or negative", () => {
    expect(duoFoldFromSize(null, 2034)).toBe("closed");
    expect(duoFoldFromSize(1398, null)).toBe("closed");
    expect(duoFoldFromSize(undefined, undefined)).toBe("closed");
    expect(duoFoldFromSize(0, 0)).toBe("closed");
    expect(duoFoldFromSize(-1, 100)).toBe("closed");
  });
});

describe("resolveDuoPosture", () => {
  it("a closed capture always resolves to closed, regardless of what was requested", () => {
    expect(resolveDuoPosture("book", 1398, 2034)).toBe("closed");
    expect(resolveDuoPosture("flat", 1398, 2034)).toBe("closed");
    expect(resolveDuoPosture(null, 1398, 2034)).toBe("closed");
  });

  it("an open capture honours a book/flat request", () => {
    expect(resolveDuoPosture("book", 2853, 2007)).toBe("book");
    expect(resolveDuoPosture("flat", 2853, 2007)).toBe("flat");
    expect(resolveDuoPosture("book", 2007, 2853)).toBe("book");
  });

  it("an open capture with no usable request defaults to flat", () => {
    expect(resolveDuoPosture(null, 2853, 2007)).toBe("flat");
    expect(resolveDuoPosture(undefined, 2853, 2007)).toBe("flat");
    expect(resolveDuoPosture("closed", 2853, 2007)).toBe("flat");
  });

  it("missing dimensions read as closed (duoFoldFromSize's own fallback)", () => {
    expect(resolveDuoPosture("book", null, null)).toBe("closed");
  });
});

/** Pulls the 4 corner horizontal radii (as %) out of a `duoGeometry(...).bodyRadius`/
 * `screenRadius` value (CSS `"h1 h2 h3 h4 / v1 v2 v3 v4"`), in CSS order: top-left, top-right,
 * bottom-right, bottom-left. */
function cornerXRadii(value: string): [number, number, number, number] {
  const [hPart] = value.split(" / ");
  const corners = hPart.trim().split(/\s+/).map(parseFloat);
  return [corners[0], corners[1], corners[2], corners[3]];
}

describe("duoGeometry", () => {
  it("flat/book landscape has a vertical hinge line, top buttons right of centre, and no corner asymmetry", () => {
    const geo = duoGeometry("flat", "landscape");
    expect(geo.hinge).not.toBeNull();
    expect(geo.hinge?.axis).toBe("vertical");
    expect(parseFloat(geo.topButtons.left)).toBeGreaterThan(50);
    const [tl, tr, br, bl] = cornerXRadii(geo.bodyRadius);
    expect(tl).toBe(tr);
    expect(tr).toBe(br);
    expect(br).toBe(bl);
  });

  it("flat/book portrait has a horizontal hinge line", () => {
    const geo = duoGeometry("flat", "portrait");
    expect(geo.hinge).not.toBeNull();
    expect(geo.hinge?.axis).toBe("horizontal");
  });

  it("book shares geometry with flat at the same orientation", () => {
    expect(duoGeometry("book", "landscape")).toEqual(duoGeometry("flat", "landscape"));
    expect(duoGeometry("book", "portrait")).toEqual(duoGeometry("flat", "portrait"));
  });

  it("closed portrait has small left corners and large right corners, no hinge line, wider left body padding, no drawn camera, and a uniform screen inset", () => {
    const geo = duoGeometry("closed", "portrait");
    expect(geo.hinge).toBeNull();
    const [bodyTL, bodyTR, bodyBR, bodyBL] = cornerXRadii(geo.bodyRadius);
    // top-left/bottom-left (spine side) are small; top-right/bottom-right are large.
    expect(bodyTR).toBeGreaterThan(bodyTL);
    expect(bodyBR).toBeGreaterThan(bodyBL);
    const [top, right, bottom, left] = geo.bodyPad.split(" ").map(parseFloat);
    expect(left).toBeGreaterThan(top);
    expect(left).toBeGreaterThan(right);
    expect(left).toBeGreaterThan(bottom);
    // Closed draws no camera at all: the simulator's own capture already bakes it into the
    // wallpaper, so a second drawn circle would double up.
    expect(parseFloat(geo.camera.size)).toBe(0);
    // The screen inset (black gap between the rim and the content) is uniform on all four
    // edges — measured directly off both reference screenshots at native resolution, the fold
    // reads through the corner-radius asymmetry alone, not a wider gap on the spine edge.
    expect(geo.screenInset).not.toBeNull();
    const inset = geo.screenInset!;
    expect(inset.top).toBe(inset.right);
    expect(inset.right).toBe(inset.bottom);
    expect(inset.bottom).toBe(inset.left);
  });

  it("flat/book has no camera and no screen inset", () => {
    const geo = duoGeometry("flat", "landscape");
    expect(parseFloat(geo.camera.size)).toBe(0);
    expect(geo.screenInset).toBeNull();
  });

  it("closed landscape moves the corner asymmetry to top/bottom and widens the bottom padding, but keeps a uniform screen inset", () => {
    const geo = duoGeometry("closed", "landscape");
    expect(geo.hinge).toBeNull();
    const [bodyTL, , bodyBR, bodyBL] = cornerXRadii(geo.bodyRadius);
    expect(bodyBR).toBeGreaterThan(bodyTL);
    expect(bodyBL).toBeGreaterThan(bodyTL);
    const [, , bottom, left] = geo.bodyPad.split(" ").map(parseFloat);
    expect(bottom).toBeGreaterThan(left);
    const inset = geo.screenInset!;
    expect(inset.top).toBe(inset.right);
    expect(inset.right).toBe(inset.bottom);
    expect(inset.bottom).toBe(inset.left);
  });

  it("every posture/orientation pair defines a side button and rounded corners", () => {
    for (const posture of DUO_POSTURES) {
      for (const orientation of ["portrait", "landscape"] as const) {
        const geo = duoGeometry(posture, orientation);
        expect(geo.sideButton.height).toMatch(/%$/);
        expect(geo.bodyRadius).toMatch(/\//);
        expect(geo.screenRadius).toMatch(/\//);
      }
    }
  });
});

describe("duoFallbackSizeFor", () => {
  it("closed is portrait-shaped and matches the folded cover size regardless of orientation param", () => {
    const { w, h } = duoFallbackSizeFor("closed", "landscape");
    expect(h).toBeGreaterThan(w);
    expect(w / h).toBeCloseTo(0.69, 1);
  });

  it("flat/book landscape is wider than tall", () => {
    const { w, h } = duoFallbackSizeFor("flat", "landscape");
    expect(w).toBeGreaterThan(h);
  });

  it("flat/book portrait is taller than wide", () => {
    const { w, h } = duoFallbackSizeFor("book", "portrait");
    expect(h).toBeGreaterThan(w);
  });
});

/** The preference used to be one global key, so choosing "iPhone" on an iOS run drew an
 * iPhone bezel — notch and all — around every Android run. It is now stored per kind, and
 * a pre-split choice only carries over where it still describes the platform. */
describe("legacyChoiceApplies", () => {
  it("does not carry an iPhone choice onto Android", () => {
    expect(legacyChoiceApplies("iphone", "android")).toBe(false);
    expect(legacyChoiceApplies("android", "ios")).toBe(false);
  });

  it("carries a choice onto the platform it describes", () => {
    expect(legacyChoiceApplies("iphone", "ios")).toBe(true);
    expect(legacyChoiceApplies("android", "android")).toBe(true);
  });

  it("carries 'no frame' everywhere, since it describes any platform", () => {
    expect(legacyChoiceApplies("none", "ios")).toBe(true);
    expect(legacyChoiceApplies("none", "android")).toBe(true);
  });

  it("never treats auto as a stored preference", () => {
    expect(legacyChoiceApplies("auto", "ios")).toBe(false);
  });
});


describe("evidenceThumbSize", () => {
  it("follows the run's capture ratio when known", () => {
    expect(evidenceThumbSize("web", 1440, 900)).toEqual({ w: 222, h: 139 });
    expect(evidenceThumbSize("ios", 1398, 2034)).toEqual({ w: 96, h: 139 });
    expect(evidenceThumbSize("ios", 2064, 2752)).toEqual({ w: 104, h: 139 });
  });
  it("guesses a browser for web and a phone otherwise until the capture size arrives", () => {
    expect(evidenceThumbSize("web", null, null)).toEqual({ w: 222, h: 139 });
    expect(evidenceThumbSize("ios", 0, 0)).toEqual({ w: 64, h: 139 });
    expect(evidenceThumbSize(undefined, undefined, undefined)).toEqual({ w: 64, h: 139 });
  });
  it("clamps very wide or narrow captures", () => {
    expect(evidenceThumbSize("web", 5000, 1000).w).toBe(260);
    expect(evidenceThumbSize("ios", 100, 1000).w).toBe(48);
  });
});
