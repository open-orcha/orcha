// @vitest-environment jsdom
/** The Map's detail panel frame: docked, full screen and collapsed, Esc leaving full screen before
 * closing, picking a connection keeping the mode, foldable sections, what is remembered per viewer
 * (and that it all still works when storage throws), and where its tooltips go. */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppMapView } from "./app-map-view";
import { installFlowEnv, removeFlowEnv } from "./kit/testEnv";
import { withPage } from "./test-wrap";
import { DetailPanel } from "./detail-panel";
import { RENTALS_MAP_JSON } from "./fixture";
import { PANEL_MODE_KEY, PANEL_SECTIONS_KEY, placeTip, readClosedSections, readPanelMode } from "./panel-state";
import { parseAppMap } from "./types";

beforeEach(() => {
  localStorage.clear();
  installFlowEnv();
});
afterEach(() => {
  cleanup();
  removeFlowEnv();
});

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });

const map = parseAppMap(RENTALS_MAP_JSON);
const props = { map, region: null, onGo: vi.fn(), onRegion: vi.fn(), onClose: vi.fn() };
const panel = (c: HTMLElement) => c.querySelector<HTMLElement>("[data-map-panel]");
const modeOf = (c: HTMLElement) => panel(c)?.getAttribute("data-map-panel-mode");

/** Every access to localStorage throws, as in a private window with site data blocked. */
function breakStorage() {
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  });
}

describe("the panel's modes", () => {
  it("goes docked → full → docked, and says so on its control", () => {
    const { container } = render(withPage(createElement(DetailPanel, { ...props, selection: { kind: "node", id: "screen:listings" } })));
    expect(modeOf(container)).toBe("docked");
    const full = container.querySelector<HTMLElement>("[data-map-panel-full]")!;
    expect(full.getAttribute("aria-label")).toBe("Full screen");
    fireEvent.click(full);
    expect(modeOf(container)).toBe("full");
    expect(full.getAttribute("aria-label")).toBe("Exit full screen");
    // Two columns: the frame on the left, the sections on the right.
    expect(container.querySelector('[data-map-panel-col="left"] img')).not.toBeNull();
    expect(container.querySelector('[data-map-panel-col="right"] [data-map-section="facts"], [data-map-panel-col="right"] [data-map-section="covered"]')).not.toBeNull();
    fireEvent.click(full);
    expect(modeOf(container)).toBe("docked");
    expect(container.querySelector("[data-map-panel-columns]")).toBeNull();
    expect(localStorage.getItem(PANEL_MODE_KEY)).toBe("docked");
  });

  it("goes docked → collapsed → docked, the rail keeping the node's title and state", () => {
    const onClose = vi.fn();
    const { container } = render(withPage(createElement(DetailPanel, { ...props, onClose, selection: { kind: "node", id: "screen:listings" } })));
    fireEvent.click(container.querySelector("[data-map-panel-collapse]")!);
    expect(modeOf(container)).toBe("collapsed");
    expect(panel(container)?.getAttribute("data-map-panel")).toBe("screen:listings");
    const rail = container.querySelector<HTMLElement>("[data-map-panel-reopen]")!;
    expect(rail.getAttribute("aria-label")).toBe("Open the panel: Listings");
    expect(rail.querySelector("[data-map-panel-dot]")).not.toBeNull();
    expect(container.querySelector("[data-map-section]")).toBeNull();
    expect(localStorage.getItem(PANEL_MODE_KEY)).toBe("collapsed");
    fireEvent.click(rail);
    expect(modeOf(container)).toBe("docked");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("opens in the mode the viewer left it in", () => {
    localStorage.setItem(PANEL_MODE_KEY, "full");
    const { container } = render(withPage(createElement(DetailPanel, { ...props, selection: { kind: "node", id: "endpoint:GET /api/listings" } })));
    expect(modeOf(container)).toBe("full");
    // No frame: the facts and what covers it are the left column.
    expect(container.querySelector('[data-map-panel-col="left"] [data-map-section="facts"]')).not.toBeNull();
    expect(container.querySelector('[data-map-panel-col="right"] [data-map-section="evidence"]')).not.toBeNull();
  });

  it("still switches modes and folds sections when storage throws", () => {
    breakStorage();
    expect(readPanelMode()).toBe("docked");
    expect(readClosedSections().size).toBe(0);
    const { container } = render(withPage(createElement(DetailPanel, { ...props, selection: { kind: "node", id: "screen:listings" } })));
    expect(modeOf(container)).toBe("docked");
    fireEvent.click(container.querySelector("[data-map-panel-full]")!);
    expect(modeOf(container)).toBe("full");
    fireEvent.click(container.querySelector('[data-map-section-toggle="facts"]')!);
    expect(container.querySelector('[data-map-section="facts"]')?.getAttribute("data-open")).toBe("false");
  });
});

describe("the panel's sections", () => {
  it("fold and unfold from their header, and stay as the viewer left them", () => {
    const { container } = render(withPage(createElement(DetailPanel, { ...props, selection: { kind: "node", id: "screen:listings" } })));
    const toggle = container.querySelector<HTMLElement>('[data-map-section-toggle="evidence"]')!;
    const section = () => container.querySelector('[data-map-section="evidence"]')!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(section().getAttribute("data-open")).toBe("false");
    // The folded body is out of the tab order and the accessibility tree.
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)?.hasAttribute("inert")).toBe(true);
    expect(JSON.parse(localStorage.getItem(PANEL_SECTIONS_KEY)!)).toEqual(["evidence"]);

    // Another node's panel opens with the same section folded; the others stay open.
    cleanup();
    const other = render(withPage(createElement(DetailPanel, { ...props, selection: { kind: "node", id: "screen:saved" } })));
    expect(other.container.querySelector('[data-map-section="evidence"]')?.getAttribute("data-open")).toBe("false");
    expect(other.container.querySelector('[data-map-section="covered"]')?.getAttribute("data-open")).toBe("true");
    fireEvent.click(other.container.querySelector('[data-map-section-toggle="evidence"]')!);
    expect(other.container.querySelector('[data-map-section="evidence"]')?.getAttribute("data-open")).toBe("true");
    expect(JSON.parse(localStorage.getItem(PANEL_SECTIONS_KEY)!)).toEqual([]);
  });

  it("covers Facts, Covered by, Where this comes from, the connections and Stub its calls", () => {
    const { container } = render(withPage(createElement(DetailPanel, { ...props, selection: { kind: "node", id: "screen:listings" } })));
    const names = [...container.querySelectorAll("[data-map-section]")].map((e) => e.getAttribute("data-map-section"));
    expect(names).toEqual(expect.arrayContaining(["covered", "evidence", "links:Leads to", "links:Calls"]));
    const endpoint = render(withPage(createElement(DetailPanel, { ...props, selection: { kind: "node", id: "endpoint:GET /api/listings" } })));
    expect(endpoint.container.querySelector('[data-map-section="facts"]')).not.toBeNull();
    expect(endpoint.container.querySelector('[data-map-section="links:Called from"]')).not.toBeNull();
  });
});

describe("the map view with the panel", () => {
  async function openListings() {
    // A 1400 x 900 canvas: the camera stays close enough that the screen cards stay on the map.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 1400, bottom: 900, width: 1400, height: 900, toJSON() {} } as DOMRect);
    const view = render(withPage(createElement(AppMapView, { map: parseAppMap(RENTALS_MAP_JSON) })));
    await settle();
    fireEvent.click(view.container.querySelector('[data-map-screen="listings"]')!);
    await settle();
    expect(panel(view.container)?.getAttribute("data-map-panel")).toBe("screen:listings");
    return view;
  }

  it("Esc leaves full screen first, then closes the panel", async () => {
    const { container } = await openListings();
    fireEvent.click(container.querySelector("[data-map-panel-full]")!);
    expect(modeOf(container)).toBe("full");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(modeOf(container)).toBe("docked");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(panel(container)).toBeNull();
  });

  it("the frame opens full size in the app's lightbox, and Esc closes the lightbox before the panel", async () => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    };
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { container } = await openListings();
    fireEvent.click(container.querySelector("[data-map-panel-full]")!);
    // A button, not a link that leaves the app for a localhost URL in the browser.
    const frame = container.querySelector<HTMLElement>("[data-map-frame]")!;
    expect(frame.tagName).toBe("BUTTON");
    expect(container.querySelector('[data-map-panel] a[target="_blank"]')).toBeNull();
    fireEvent.click(frame);
    const lightbox = () => container.querySelector<HTMLDialogElement>("dialog:has([data-map-frame-lightbox])");
    expect(lightbox()?.open).toBe(true);
    expect(lightbox()!.querySelector("img")?.getAttribute("src")).toBe("/api/artifacts/runs/run-2041/frames/listings.png");
    expect(open).not.toHaveBeenCalled();
    // Esc in the lightbox closes it; the panel stays, still full screen.
    fireEvent.keyDown(lightbox()!, { key: "Escape" });
    expect(lightbox()?.open).toBe(false);
    expect(modeOf(container)).toBe("full");
    // Then the panel's own order: full screen, then closed.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(modeOf(container)).toBe("docked");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(panel(container)).toBeNull();
  });

  it("Esc closes a collapsed panel", async () => {
    const { container } = await openListings();
    fireEvent.click(container.querySelector("[data-map-panel-collapse]")!);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(panel(container)).toBeNull();
  });

  it("picking a connection while full screen goes there and stays full screen", async () => {
    const { container } = await openListings();
    fireEvent.click(container.querySelector("[data-map-panel-full]")!);
    fireEvent.click(container.querySelector('[data-map-connection="endpoint:GET /api/listings"]')!);
    await settle();
    expect(panel(container)?.getAttribute("data-map-panel")).toBe("endpoint:GET /api/listings");
    expect(modeOf(container)).toBe("full");
    // Its "Called from" row goes back to the screen, still full screen.
    fireEvent.click(container.querySelector('[data-map-section="links:Called from"] [data-map-connection="screen:listings"]')!);
    await settle();
    expect(panel(container)?.getAttribute("data-map-panel")).toBe("screen:listings");
    expect(modeOf(container)).toBe("full");
  });

  it("picking another node on the map keeps a collapsed panel collapsed", async () => {
    const { container } = await openListings();
    fireEvent.click(container.querySelector("[data-map-panel-collapse]")!);
    fireEvent.click(container.querySelector('[data-map-screen="saved"]')!);
    await settle();
    expect(panel(container)?.getAttribute("data-map-panel")).toBe("screen:saved");
    expect(modeOf(container)).toBe("collapsed");
  });
});

describe("the panel's tooltips", () => {
  it("Draft tests explains itself in a placed tooltip, not a native one over the rows above", () => {
    const { container } = render(withPage(createElement(DetailPanel, { ...props, selection: { kind: "node", id: "endpoint:GET /api/listings" } })));
    const draft = container.querySelector<HTMLElement>("[data-map-covered-by] [data-map-draft-action] button")!;
    expect(draft.hasAttribute("title")).toBe(false);
    fireEvent.mouseEnter(draft);
    const tip = document.querySelector<HTMLElement>("[data-map-tip]")!;
    expect(tip.getAttribute("role")).toBe("tooltip");
    expect(tip.textContent).toMatch(/^(Drafting reads what is known here|An explorer goes there)/);
    expect(draft.getAttribute("aria-describedby")).toBe(tip.id);
    expect(tip.dataset.side).toBeTruthy();
    fireEvent.mouseLeave(draft);
    expect(document.querySelector("[data-map-tip]")).toBeNull();
  });

  it("the header controls carry their names and tooltips", () => {
    const { container } = render(withPage(createElement(DetailPanel, { ...props, selection: { kind: "node", id: "screen:listings" } })));
    const labels = [...container.querySelectorAll("[data-map-panel-controls] button")].map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Full screen", "Collapse the panel", "Close"]);
    fireEvent.focus(container.querySelector('[aria-label="Close"]')!);
    expect(document.querySelector("[data-map-tip]")?.textContent).toBe("Close (Esc)");
  });
});

describe("placeTip", () => {
  const viewport = { width: 1440, height: 900 };
  const tip = { width: 260, height: 44 };

  it("goes beside the docked panel, over the canvas, level with its trigger", () => {
    const panelBox = { left: 1048, top: 100, width: 380, height: 780 };
    const at = placeTip({ left: 1064, top: 600, width: 110, height: 28 }, tip, viewport, panelBox);
    expect(at.side).toBe("beside-panel");
    expect(at.left + tip.width).toBeLessThanOrEqual(panelBox.left);
    expect(at.top).toBe(600 + 14 - 22);
  });

  it("goes beside the trigger when the panel fills the canvas, else below it, never above unless it must", () => {
    expect(placeTip({ left: 800, top: 400, width: 110, height: 28 }, tip, viewport, null).side).toBe("right");
    // No room to its right: below it.
    const below = placeTip({ left: 1300, top: 40, width: 28, height: 28 }, tip, viewport, null);
    expect(below).toEqual({ left: 1440 - 260 - 8, top: 76, side: "below" });
    // At the bottom of the window: above it, inside the viewport.
    const above = placeTip({ left: 1300, top: 870, width: 28, height: 28 }, tip, viewport, null);
    expect(above.side).toBe("above");
    expect(above.top).toBe(870 - 8 - 44);
  });

  it("a tall tip never goes beside its trigger, where it would cover the rows around it", () => {
    expect(placeTip({ left: 800, top: 400, width: 110, height: 28 }, { width: 260, height: 90 }, viewport, null).side).toBe("below");
  });
});
