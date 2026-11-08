import { describe, expect, it } from "vitest";
import { splitFrame } from "./drafting-split";
import { fitWidth } from "./live-device-peek";

describe("splitFrame", () => {
  it("draws phones for iOS and Android, a window for web and desktop", () => {
    expect(splitFrame("ios")).toBe("phone");
    expect(splitFrame("android")).toBe("phone");
    expect(splitFrame("web")).toBe("browser");
    expect(splitFrame("desktop")).toBe("browser");
    expect(splitFrame(null)).toBe("phone");
  });
});

describe("fitWidth", () => {
  it("derives a phone's width from the container's height and the screen's aspect", () => {
    // 402 x 874: the screen is 2.1741 times taller than wide, plus the bezel's 0.08.
    expect(fitWidth(true, "402 / 874")).toBe("min(100%, calc(100cqh / 2.2541))");
  });

  it("falls back to a generic phone aspect for an unreadable one", () => {
    expect(fitWidth(true, "nope")).toBe(`min(100%, calc(100cqh / ${(19.5 / 9 + 0.08).toFixed(4)}))`);
  });

  it("fits a browser window under its title bar", () => {
    expect(fitWidth(false, "16 / 10")).toBe("min(100%, calc((100cqh - 22px) * 16 / 10))");
  });
});
