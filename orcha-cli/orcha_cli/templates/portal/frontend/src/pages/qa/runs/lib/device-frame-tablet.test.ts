import { describe, expect, it } from "vitest";
import {
  DEVICE_FRAME_CHOICES,
  DEVICE_FRAME_LABEL,
  formFactorFromRecord,
  frameChoiceKey,
  frameScreenSize,
  frameStyleLabel,
  isTabletDeviceName,
  isTabletSize,
  resolveFormFactor,
  resolveFrameStyle,
  resolveOrientation,
  tabletChromeGeometry,
  tabletFallbackSize,
  tabletStyleFor,
} from "./device-frame";

describe("isTabletDeviceName", () => {
  it("recognises iPads by their simctl names", () => {
    expect(isTabletDeviceName("iPad Pro 13-inch (M5)")).toBe(true);
    expect(isTabletDeviceName("iPad Air 11-inch (M3)")).toBe(true);
    expect(isTabletDeviceName("iPad mini (A17 Pro)")).toBe(true);
    expect(isTabletDeviceName("iPad (A16)")).toBe(true);
  });

  it("recognises Android tablets: Galaxy Tab, Pixel Tablet, AVD names, Nexus", () => {
    expect(isTabletDeviceName("Samsung Galaxy Tab S10+")).toBe(true);
    expect(isTabletDeviceName("Galaxy Tab S9")).toBe(true);
    expect(isTabletDeviceName("Pixel Tablet")).toBe(true);
    expect(isTabletDeviceName("Pixel_Tablet")).toBe(true);
    expect(isTabletDeviceName("Medium_Tablet_API_35")).toBe(true);
    expect(isTabletDeviceName("Pixel C")).toBe(true);
    expect(isTabletDeviceName("Nexus 9")).toBe(true);
  });

  it("does not match phones", () => {
    expect(isTabletDeviceName("iPhone 17 Pro")).toBe(false);
    expect(isTabletDeviceName("iPhone Duo")).toBe(false);
    expect(isTabletDeviceName("Pixel 9a")).toBe(false);
    expect(isTabletDeviceName("Pixel_9a")).toBe(false);
    expect(isTabletDeviceName("Samsung Galaxy S24")).toBe(false);
    expect(isTabletDeviceName("Pixel Camera Test")).toBe(false);
    expect(isTabletDeviceName("Nexus 5X")).toBe(false);
    expect(isTabletDeviceName(null)).toBe(false);
    expect(isTabletDeviceName("")).toBe(false);
  });
});

describe("isTabletSize", () => {
  it("is near-square in either orientation", () => {
    expect(isTabletSize(2064, 2752)).toBe(true); // iPad 3:4
    expect(isTabletSize(2752, 2064)).toBe(true); // landscape
    expect(isTabletSize(1600, 2560)).toBe(true); // 16:10 Android tablet
    expect(isTabletSize(2560, 1600)).toBe(true);
  });

  it("is false for phones, either way up, and for unknown sizes", () => {
    expect(isTabletSize(402, 874)).toBe(false);
    expect(isTabletSize(874, 402)).toBe(false);
    expect(isTabletSize(1080, 2424)).toBe(false);
    expect(isTabletSize(null, null)).toBe(false);
    expect(isTabletSize(0, 100)).toBe(false);
  });
});

describe("formFactorFromRecord", () => {
  it("reads a stored form factor under its usual keys", () => {
    expect(formFactorFromRecord({ kind: "android", form_factor: "tablet" })).toBe("tablet");
    expect(formFactorFromRecord({ formFactor: "Phone" })).toBe("phone");
    expect(formFactorFromRecord({ device_type: "TABLET" })).toBe("tablet");
  });

  it("is null when the record says nothing", () => {
    expect(formFactorFromRecord({ kind: "ios", udid: "x", name: "iPad Pro" })).toBeNull();
    expect(formFactorFromRecord(null)).toBeNull();
    expect(formFactorFromRecord("tablet")).toBeNull();
  });
});

describe("resolveFormFactor", () => {
  it("the device name wins, even over a phone-shaped compatibility-mode run size", () => {
    // The reported bug: an iPhone-only app on the iPad reports its 390×844 window.
    expect(resolveFormFactor({ deviceName: "iPad Pro 13-inch (M5)", screenW: 390, screenH: 844 })).toBe("tablet");
    expect(resolveFormFactor({ deviceName: "iPhone 17 Pro", screenW: 2064, screenH: 2752 })).toBe("phone");
  });

  it("an iPhone Duo is a phone despite its squarer capture", () => {
    expect(resolveFormFactor({ deviceName: "iPhone Duo", screenW: 1398, screenH: 2034 })).toBe("phone");
  });

  it("falls back to the device record, then its name, then the capture's aspect", () => {
    expect(resolveFormFactor({ device: { kind: "android", form_factor: "tablet" } })).toBe("tablet");
    expect(resolveFormFactor({ device: { kind: "ios", udid: "u", name: "iPad Air 11-inch (M3)" } })).toBe("tablet");
    expect(resolveFormFactor({ screenW: 2064, screenH: 2752 })).toBe("tablet");
    expect(resolveFormFactor({ screenW: 402, screenH: 874 })).toBe("phone");
    expect(resolveFormFactor({})).toBe("phone");
  });
});

describe("resolveFrameStyle with tablets", () => {
  it("auto picks the iPad bezel for an iPad run and the Android tablet bezel for a tablet AVD", () => {
    expect(resolveFrameStyle("auto", "ios", "iPad Pro 13-inch (M5)")).toBe("ipad");
    expect(resolveFrameStyle("auto", "android", "Pixel_Tablet")).toBe("android-tablet");
    expect(resolveFrameStyle("auto", "android", "Samsung Galaxy Tab S9")).toBe("android-tablet");
  });

  it("auto falls back to the capture's aspect for a run that names no device", () => {
    expect(resolveFrameStyle("auto", "ios", null, { screenW: 2064, screenH: 2752 })).toBe("ipad");
    expect(resolveFrameStyle("auto", "ios", null, { screenW: 402, screenH: 874 })).toBe("iphone");
    expect(resolveFrameStyle("auto", "android", null, { screenW: 2560, screenH: 1600 })).toBe("android-tablet");
  });

  it("auto uses a stored form factor on the device record", () => {
    expect(resolveFrameStyle("auto", "android", "Some Device", { device: { form_factor: "tablet" } })).toBe(
      "android-tablet",
    );
  });

  it("phones, the Duo, web and desktop are unchanged", () => {
    expect(resolveFrameStyle("auto", "ios", "iPhone 17 Pro")).toBe("iphone");
    expect(resolveFrameStyle("auto", "android", "Pixel 9a")).toBe("android");
    expect(resolveFrameStyle("auto", "ios", "iPhone Duo")).toBe("iphone-duo");
    expect(resolveFrameStyle("auto", "web", "iPad Pro")).toBe("none");
    expect(resolveFrameStyle("auto", "desktop", "iPad Pro")).toBe("mac-window");
  });

  it("explicit tablet choices are honoured", () => {
    expect(resolveFrameStyle("ipad", "ios", "iPhone 17 Pro")).toBe("ipad");
    expect(resolveFrameStyle("android-tablet", "android", "Pixel 9a")).toBe("android-tablet");
    expect(resolveFrameStyle("none", "ios", "iPad Pro 13-inch (M5)")).toBe("none");
  });
});

describe("picker choices", () => {
  it("offers iPad and Android tablet beside the phones", () => {
    expect(DEVICE_FRAME_CHOICES).toEqual(["auto", "iphone", "android", "ipad", "android-tablet", "none"]);
    expect(DEVICE_FRAME_LABEL.android).toBe("Android phone");
    expect(DEVICE_FRAME_LABEL.ipad).toBe("iPad");
    expect(DEVICE_FRAME_LABEL["android-tablet"]).toBe("Android tablet");
  });

  it("labels the resolved Auto style", () => {
    expect(frameStyleLabel("ipad")).toBe("iPad");
    expect(frameStyleLabel("android-tablet")).toBe("Android tablet");
    expect(frameStyleLabel("iphone")).toBe("iPhone");
    expect(frameStyleLabel("iphone-duo")).toBe("iPhone Duo");
  });

  it("keeps tablet preferences apart from phone ones, phone keys unchanged", () => {
    expect(frameChoiceKey("ios")).toBe("orcha:qa-device-frame:ios");
    expect(frameChoiceKey("ios", "phone")).toBe("orcha:qa-device-frame:ios");
    expect(frameChoiceKey("ios", "tablet")).toBe("orcha:qa-device-frame:ios:tablet");
  });

  it("maps a phone style to its platform's tablet", () => {
    expect(tabletStyleFor("iphone")).toBe("ipad");
    expect(tabletStyleFor("android")).toBe("android-tablet");
    expect(tabletStyleFor("none")).toBe("none");
    expect(tabletStyleFor("iphone-duo")).toBe("iphone-duo");
  });
});

describe("resolveOrientation", () => {
  it("the capture's pixels win", () => {
    expect(resolveOrientation(2752, 2064, "portrait")).toBe("landscape");
    expect(resolveOrientation(2064, 2752, "landscape")).toBe("portrait");
  });

  it("the run's orientation applies while no size is known", () => {
    expect(resolveOrientation(null, null, "landscape")).toBe("landscape");
    expect(resolveOrientation(null, null, null)).toBe("portrait");
    expect(resolveOrientation(undefined, undefined)).toBe("portrait");
  });
});

describe("frameScreenSize", () => {
  it("the loaded frame wins over the run size", () => {
    expect(frameScreenSize({ style: "ipad", loaded: { w: 2064, h: 2752 }, screenW: 390, screenH: 844 })).toEqual({
      w: 2064,
      h: 2752,
    });
  });

  it("a tablet ignores a phone-shaped (compatibility-mode) run size until a frame loads", () => {
    expect(frameScreenSize({ style: "ipad", screenW: 390, screenH: 844 })).toEqual({ w: 2064, h: 2752 });
    expect(frameScreenSize({ style: "ipad", screenW: 1032, screenH: 1376 })).toEqual({ w: 1032, h: 1376 });
  });

  it("falls back per style, oriented by the run", () => {
    expect(frameScreenSize({ style: "ipad", runOrientation: "landscape" })).toEqual({ w: 2752, h: 2064 });
    expect(frameScreenSize({ style: "android-tablet" })).toEqual({ w: 1600, h: 2560 });
    expect(frameScreenSize({ style: "iphone" })).toEqual({ w: 402, h: 874 });
    expect(frameScreenSize({ style: "iphone", runOrientation: "landscape" })).toEqual({ w: 874, h: 402 });
  });

  it("a phone keeps its run size", () => {
    expect(frameScreenSize({ style: "iphone", screenW: 1206, screenH: 2622 })).toEqual({ w: 1206, h: 2622 });
  });

  it("tablet fallbacks swap for landscape", () => {
    expect(tabletFallbackSize("ipad")).toEqual({ w: 2064, h: 2752 });
    expect(tabletFallbackSize("android-tablet", "landscape")).toEqual({ w: 2560, h: 1600 });
  });
});

describe("tabletChromeGeometry", () => {
  const num = (s: string) => parseFloat(s);

  it("draws an even bezel: the same thickness in px on every edge", () => {
    const geo = tabletChromeGeometry("ipad", 2064, 2752);
    const [bw, bh] = geo.bodyAspect.split("/").map((n) => Number(n.trim()));
    // Padding % resolves against the body's width on every side.
    const padPx = (num(geo.bodyPad) / 100) * bw;
    expect(bw - 2 * padPx).toBeCloseTo(2064, 0);
    expect(bh - 2 * padPx).toBeCloseTo(2752, 0);
  });

  it("is thinner than any phone bezel and its corners come out circular", () => {
    const geo = tabletChromeGeometry("ipad", 2064, 2752);
    expect(num(geo.bodyPad)).toBeLessThan(4);
    const [rx, ry] = geo.bodyRadius.split("/").map(num);
    const [bw, bh] = geo.bodyAspect.split("/").map((n) => Number(n.trim()));
    expect((rx / 100) * bw).toBeCloseTo((ry / 100) * bh, 1);
  });

  it("portrait puts the camera on the right long edge, landscape on the top", () => {
    const p = tabletChromeGeometry("ipad", 2064, 2752);
    expect(p.camera.top).toBe("50%");
    expect(p.camera.right).toBeDefined();
    const l = tabletChromeGeometry("ipad", 2752, 2064);
    expect(l.camera.left).toBe("50%");
    expect(l.camera.right).toBeUndefined();
  });

  it("rotates the buttons with the body for landscape", () => {
    const p = tabletChromeGeometry("ipad", 2064, 2752);
    const l = tabletChromeGeometry("ipad", 2752, 2064);
    expect(p.buttons.map((b) => b.edge)).toEqual(["top", "right", "right"]);
    expect(l.buttons.map((b) => b.edge)).toEqual(["left", "top", "top"]);
    // The top button near the top-right corner ends near the top-left once turned.
    expect(l.buttons[0]).toEqual({ edge: "left", at: "16%", length: "8%" });
  });

  it("the Android tablet's bezel is thicker than the iPad's", () => {
    const ipad = tabletChromeGeometry("ipad", 1600, 2560);
    const android = tabletChromeGeometry("android-tablet", 1600, 2560);
    expect(num(android.bodyPad)).toBeGreaterThan(num(ipad.bodyPad));
  });
});
