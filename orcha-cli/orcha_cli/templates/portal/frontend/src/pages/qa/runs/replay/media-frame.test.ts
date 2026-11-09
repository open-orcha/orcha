import { describe, expect, it } from "vitest";
import { addressLabel, mediaFrameFor, posterFramePath } from "./media-frame";

describe("mediaFrameFor (platform -> frame)", () => {
  it("frames a web run in a browser window, whatever the bezel preference says", () => {
    expect(mediaFrameFor("web", "none")).toBe("browser");
    expect(mediaFrameFor("web", "iphone", { w: 1280, h: 800 })).toBe("browser");
  });

  it("frames a desktop app in a Mac window unless the viewer chose no frame", () => {
    expect(mediaFrameFor("desktop", "mac-window")).toBe("mac-window");
    expect(mediaFrameFor("desktop", "none")).toBe("none");
  });

  it("keeps phones in their own bezel", () => {
    expect(mediaFrameFor("ios", "iphone", { w: 1206, h: 2622 })).toBe("iphone");
    expect(mediaFrameFor("android", "android", { w: 1080, h: 2400 })).toBe("android");
    expect(mediaFrameFor("ios", "iphone-duo")).toBe("iphone-duo");
  });

  it("moves a tablet-shaped capture into the platform's tablet", () => {
    expect(mediaFrameFor("ios", "iphone", { w: 2064, h: 2752 })).toBe("ipad");
    expect(mediaFrameFor("android", "android", { w: 2560, h: 1600 })).toBe("android-tablet");
    expect(mediaFrameFor("ios", "ipad")).toBe("ipad");
  });
});

describe("addressLabel", () => {
  it("shows host and path without the scheme", () => {
    expect(addressLabel("https://shop.example.com/cart?x=1")).toBe("shop.example.com/cart?x=1");
    expect(addressLabel("http://127.0.0.1:8010/")).toBe("127.0.0.1:8010");
  });

  it("is null for nothing or a non-web address", () => {
    expect(addressLabel(null)).toBeNull();
    expect(addressLabel("com.apple.Preferences")).toBeNull();
    expect(addressLabel("file:///tmp/x")).toBeNull();
  });
});

describe("posterFramePath", () => {
  it("takes the first frame that was not withheld", () => {
    expect(posterFramePath([{ path: "a", withheld: true }, { path: "b" }])).toBe("b");
    expect(posterFramePath([])).toBeNull();
  });
});
