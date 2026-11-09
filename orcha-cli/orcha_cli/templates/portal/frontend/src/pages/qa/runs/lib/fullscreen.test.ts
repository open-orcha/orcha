import { describe, expect, it, vi } from "vitest";
import {
  dropFromTopLayer,
  enterFullscreen,
  escapeLeavesExpanded,
  exitNativeFullscreen,
  fullscreenLabel,
  liftToTopLayer,
  modeAfterChange,
} from "./fullscreen";

describe("enterFullscreen", () => {
  it("uses the Fullscreen API when the document allows it", async () => {
    const requestFullscreen = vi.fn(() => Promise.resolve());
    expect(await enterFullscreen({ requestFullscreen }, { fullscreenEnabled: true })).toBe("native");
    expect(requestFullscreen).toHaveBeenCalledOnce();
  });

  it("expands in the page when the document does not allow full screen (the Mac app's WKWebView)", async () => {
    const requestFullscreen = vi.fn(() => Promise.resolve());
    expect(await enterFullscreen({ requestFullscreen }, { fullscreenEnabled: false })).toBe("expanded");
    expect(await enterFullscreen({ requestFullscreen }, {})).toBe("expanded");
    expect(requestFullscreen).not.toHaveBeenCalled();
  });

  it("expands when the element has no requestFullscreen", async () => {
    expect(await enterFullscreen({}, { fullscreenEnabled: true })).toBe("expanded");
  });

  it("expands when the request is refused or throws", async () => {
    const refused = vi.fn(() => Promise.reject(new TypeError("not allowed")));
    expect(await enterFullscreen({ requestFullscreen: refused }, { fullscreenEnabled: true })).toBe("expanded");
    const throws = vi.fn((): Promise<void> => {
      throw new Error("not supported");
    });
    expect(await enterFullscreen({ requestFullscreen: throws }, { fullscreenEnabled: true })).toBe("expanded");
  });
});

describe("exitNativeFullscreen", () => {
  it("exits only while something is full screen, and swallows a refusal", async () => {
    const exitFullscreen = vi.fn(() => Promise.reject(new Error("gone")));
    await exitNativeFullscreen({ fullscreenElement: null, exitFullscreen });
    expect(exitFullscreen).not.toHaveBeenCalled();
    await expect(exitNativeFullscreen({ fullscreenElement: {}, exitFullscreen })).resolves.toBeUndefined();
    expect(exitFullscreen).toHaveBeenCalledOnce();
  });
});

describe("modeAfterChange", () => {
  const el = {};
  it("is native while the element is the full screen element", () => {
    expect(modeAfterChange("off", el, { fullscreenElement: el })).toBe("native");
  });
  it("goes off when the browser leaves full screen", () => {
    expect(modeAfterChange("native", el, { fullscreenElement: null })).toBe("off");
  });
  it("keeps the expanded fallback and ignores another element's full screen", () => {
    expect(modeAfterChange("expanded", el, { fullscreenElement: null })).toBe("expanded");
    expect(modeAfterChange("off", el, { fullscreenElement: {} })).toBe("off");
    expect(modeAfterChange("off", null, { fullscreenElement: null })).toBe("off");
  });
});

describe("fullscreenLabel", () => {
  it("names the action the button takes", () => {
    expect(fullscreenLabel("off")).toBe("Full screen");
    expect(fullscreenLabel("native")).toBe("Exit full screen");
    expect(fullscreenLabel("expanded")).toBe("Exit full screen");
  });
});

describe("escapeLeavesExpanded", () => {
  it("leaves on an unhandled Escape", () => {
    expect(escapeLeavesExpanded({ key: "Escape", defaultPrevented: false })).toBe(true);
  });
  it("stays when the component used the Escape or for another key", () => {
    expect(escapeLeavesExpanded({ key: "Escape", defaultPrevented: true })).toBe(false);
    expect(escapeLeavesExpanded({ key: "f", defaultPrevented: false })).toBe(false);
  });
  it("leaves a dialog or menu open over the element its own Escape", () => {
    const inDialog = { closest: (sel: string) => (sel.includes("dialog") ? {} : null) };
    const plain = { closest: () => null };
    expect(escapeLeavesExpanded({ key: "Escape", defaultPrevented: false, target: inDialog })).toBe(false);
    expect(escapeLeavesExpanded({ key: "Escape", defaultPrevented: false, target: plain })).toBe(true);
  });
});

describe("top layer", () => {
  function fakeEl(opts: { popover?: boolean; showThrows?: boolean } = {}) {
    const attrs = new Map<string, string>();
    const state = { shown: false };
    return {
      attrs,
      state,
      setAttribute: (name: string, value: string) => void attrs.set(name, value),
      removeAttribute: (name: string) => void attrs.delete(name),
      ...(opts.popover === false
        ? {}
        : {
            showPopover: () => {
              if (opts.showThrows) throw new Error("not connected");
              state.shown = true;
            },
            hidePopover: () => {
              state.shown = false;
            },
          }),
    };
  }

  it("lifts into a manual popover and drops back out", () => {
    const el = fakeEl();
    expect(liftToTopLayer(el)).toBe(true);
    expect(el.attrs.get("popover")).toBe("manual");
    expect(el.state.shown).toBe(true);
    dropFromTopLayer(el);
    expect(el.state.shown).toBe(false);
    expect(el.attrs.has("popover")).toBe(false);
  });

  it("falls back to plain positioning without popovers or when showing fails", () => {
    expect(liftToTopLayer(fakeEl({ popover: false }))).toBe(false);
    const failing = fakeEl({ showThrows: true });
    expect(liftToTopLayer(failing)).toBe(false);
    expect(failing.attrs.has("popover")).toBe(false);
  });
});
