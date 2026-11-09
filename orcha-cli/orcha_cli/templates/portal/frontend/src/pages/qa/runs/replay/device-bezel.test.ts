// @vitest-environment jsdom
import { createElement as h } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { DeviceBezel, DeviceFrameSelect, TabletBezel } from "./device-bezel";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const shot = h("img", { alt: "shot", "data-shot": "" });

function frame(container: HTMLElement) {
  return container.querySelector("[data-device-frame]") as HTMLElement;
}

describe("DeviceBezel", () => {
  it("draws the iPad bezel, portrait, for a 3:4 iPad screen", () => {
    const { container } = render(h(DeviceBezel, { style: "ipad", aspect: "2064 / 2752", children: shot }));
    const f = frame(container);
    expect(f.dataset.deviceFrame).toBe("ipad");
    expect(f.dataset.device).toBe("tablet");
    expect(f.dataset.deviceOrientation).toBe("portrait");
    // The screenshot keeps its own aspect: the bezel never rotates or squeezes it.
    const scr = container.querySelector("[data-tablet-screen]") as HTMLElement;
    expect(scr.style.aspectRatio).toBe("2064 / 2752");
    expect(scr.querySelector("[data-shot]")).toBeTruthy();
    expect(container.querySelector("[data-tablet-camera]")).toBeTruthy();
  });

  it("turns the bezel, not the image, for a landscape capture", () => {
    const { container } = render(h(DeviceBezel, { style: "ipad", aspect: "2752 / 2064", children: shot }));
    const f = frame(container);
    expect(f.dataset.deviceOrientation).toBe("landscape");
    const scr = container.querySelector("[data-tablet-screen]") as HTMLElement;
    expect(scr.style.aspectRatio).toBe("2752 / 2064");
    expect(scr.style.transform).toBe("");
  });

  it("draws the Android tablet bezel", () => {
    const { container } = render(h(DeviceBezel, { style: "android-tablet", aspect: "2560 / 1600", children: shot }));
    expect(frame(container).dataset.deviceFrame).toBe("android-tablet");
    expect(frame(container).dataset.deviceOrientation).toBe("landscape");
  });

  it("never draws phone hardware around a tablet-shaped screen", () => {
    const ios = render(h(DeviceBezel, { style: "iphone", aspect: "2064 / 2752", children: shot }));
    expect(frame(ios.container).dataset.deviceFrame).toBe("ipad");
    cleanup();
    const android = render(h(DeviceBezel, { style: "android", aspect: "1600 / 2560", children: shot }));
    expect(frame(android.container).dataset.deviceFrame).toBe("android-tablet");
  });

  it("keeps the phone bezels for phone screens, landscape included", () => {
    const p = render(h(DeviceBezel, { style: "iphone", aspect: "402 / 874", children: shot }));
    expect(frame(p.container).dataset.deviceFrame).toBe("iphone");
    expect(frame(p.container).dataset.deviceOrientation).toBe("portrait");
    cleanup();
    const l = render(h(DeviceBezel, { style: "iphone", aspect: "874 / 402", children: shot }));
    expect(frame(l.container).dataset.deviceFrame).toBe("iphone");
    expect(frame(l.container).dataset.deviceOrientation).toBe("landscape");
    cleanup();
    const a = render(h(DeviceBezel, { style: "android", aspect: "1080 / 2424", children: shot }));
    expect(frame(a.container).dataset.deviceFrame).toBe("android");
  });

  it("'none' stays a plain slab, the Duo keeps its own bezel", () => {
    const n = render(h(DeviceBezel, { style: "none", aspect: "2064 / 2752", children: shot }));
    expect(frame(n.container).dataset.deviceFrame).toBe("none");
    cleanup();
    const d = render(h(DeviceBezel, { style: "iphone-duo", aspect: "1398 / 2034", children: shot }));
    expect(frame(d.container).dataset.deviceFrame).toMatch(/^duo-/);
  });
});

describe("TabletBezel", () => {
  it("caps its height by the whole body, bezel included", () => {
    const { container } = render(h(TabletBezel, { style: "ipad", aspect: "2064 / 2752", reserve: 100, children: shot }));
    const f = frame(container);
    expect(f.style.maxWidth).toContain("100dvh - 100px");
    expect(f.className).toContain("max-w-[760px]");
  });

  it("is wider in landscape", () => {
    const { container } = render(h(TabletBezel, { style: "ipad", aspect: "2752 / 2064", children: shot }));
    expect(frame(container).className).toContain("max-w-[980px]");
  });
});

describe("DeviceFrameSelect", () => {
  it("shows Auto (iPad) for an iPad run, even with a compatibility-mode run size", () => {
    render(
      h(DeviceFrameSelect, {
        kind: "ios",
        deviceName: "iPad Pro 13-inch (M5)",
        hints: { screenW: 390, screenH: 844 },
      }),
    );
    const select = document.querySelector("[data-device-frame-select]") as HTMLElement;
    expect(select.dataset.deviceFrameAuto).toBe("ipad");
    expect(screen.getByRole("combobox", { name: "Device frame" }).textContent).toContain("Auto (iPad)");
  });

  it("shows Auto (iPhone) for a phone run and Auto (Android tablet) for a tablet AVD", () => {
    render(h(DeviceFrameSelect, { kind: "ios", deviceName: "iPhone 17 Pro" }));
    expect(screen.getByRole("combobox", { name: "Device frame" }).textContent).toContain("Auto (iPhone)");
    cleanup();
    render(h(DeviceFrameSelect, { kind: "android", deviceName: "Pixel_Tablet" }));
    expect(screen.getByRole("combobox", { name: "Device frame" }).textContent).toContain("Auto (Android tablet)");
  });

  it("renders nothing for web", () => {
    const { container } = render(h(DeviceFrameSelect, { kind: "web", deviceName: "iPad" }));
    expect(container.innerHTML).toBe("");
  });
});

