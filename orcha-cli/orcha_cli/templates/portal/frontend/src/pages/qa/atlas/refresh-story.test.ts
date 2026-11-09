// @vitest-environment jsdom
/** Refresh atlas as a story: the stage a pass is at, read from what it writes; the screenshots it
 * has taken; and the landing when it ends. */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import folio from "./folio.fixture.json";
import { capturedShots, frameSigs, landingOf, passStage, RefreshLanded, RefreshStory } from "./refresh-story";
import { parseAtlas, type AtlasRefresh } from "./types";

afterEach(cleanup);

const running = (note: string | null, extra: Partial<AtlasRefresh> = {}) =>
  parseAtlas({ ...folio, refresh: { ...folio.refresh, state: "running", note, targets: ["screen:library", "screen:search", "screen:/clubs"], platform: "ios", ...extra } });

describe("passStage", () => {
  it("reads the stage from the pass's own notes", () => {
    expect(passStage({ state: "running", note: null })).toBe("queued");
    expect(passStage({ state: "running", note: "Queued: a high-level map of 6 main areas, about 3 minutes" })).toBe("queued");
    expect(passStage({ state: "pending", note: "Starting the high-level map pass" })).toBe("queued");
    expect(passStage({ state: "running", note: "Waiting for a device" })).toBe("device");
    // The app compiling before any device shows it (#454) is that stage too, never "capturing".
    expect(passStage({ state: "running", note: "Building the app" })).toBe("device");
    expect(passStage({ state: "running", note: "Mapping the app" })).toBe("capturing");
    // A screenshot that landed is capturing, whatever the note says; an unknown note while running too.
    expect(passStage({ state: "running", note: "Waiting for a device" }, 1)).toBe("capturing");
    expect(passStage({ state: "running", note: "Something new" })).toBe("capturing");
  });
});

describe("RefreshStory", () => {
  it("lights the stages it has reached, says how far it is and shows what it has captured", () => {
    const a = running("Mapping the app");
    const { container } = render(createElement(RefreshStory, { atlas: a, refresh: a.refresh, seen: 9, total: 10, progress: { seen: 2, total: 3 }, onJump: vi.fn() }));
    const band = container.querySelector<HTMLElement>("[data-atlas-filling]")!;
    expect(band.getAttribute("role")).toBe("status");
    expect(band.getAttribute("aria-live")).toBe("polite");
    expect(band.getAttribute("data-stage")).toBe("capturing");
    const stages = [...band.querySelectorAll("li")].map((li) => [li.textContent, li.getAttribute("data-state")]);
    expect(stages).toEqual([
      ["Queued", "done"],
      ["On a device", "done"],
      ["Capturing", "now"],
      ["Done", "next"],
    ]);
    expect(band.querySelector("[aria-current=step]")!.textContent).toBe("Capturing");
    expect(container.querySelector("[data-atlas-filling-count]")!.textContent).toBe("2 of 3 main areas captured");
    expect(container.querySelector("[data-atlas-filling-note]")!.textContent).toBe("Capturing the main areas");
    // The two targets with an iOS screenshot, as thumbnails that open their cards.
    const shots = [...container.querySelectorAll<HTMLElement>("[data-atlas-filling-shot]")];
    expect(shots.map((s) => s.getAttribute("data-atlas-filling-shot"))).toEqual(["screen:library", "screen:/clubs"]);
  });

  it("is queued before any device and says the pass's own words", () => {
    const a = running("Queued: a high-level map of 3 main areas, about 3 minutes");
    const { container } = render(createElement(RefreshStory, { atlas: a, refresh: a.refresh, seen: 0, total: 0, progress: { seen: 0, total: 3 } }));
    expect(container.querySelector("[data-atlas-filling]")!.getAttribute("data-stage")).toBe("queued");
    expect(container.querySelector("[data-atlas-filling-note]")!.textContent).toBe("Queued: a high-level map of 3 main areas, about 3 minutes");
    expect(capturedShots(parseAtlas(folio))).toEqual([]);
  });
});

describe("landing", () => {
  it("says how a watched pass ended and which screens got a new screenshot", () => {
    const before = frameSigs(running("Mapping the app"));
    const json = structuredClone(folio) as unknown as { screens: { id: string; variants: Record<string, unknown> }[]; refresh: Record<string, unknown> };
    const search = json.screens.find((s) => s.id === "screen:search")!;
    search.variants.ios = { ...(json.screens[0].variants.ios as object), node: "screen:search" };
    const done = parseAtlas({ ...json, refresh: { ...json.refresh, state: "done", note: "3 of 3 main areas seen" } });
    const landing = landingOf(done, before)!;
    expect(landing).toMatchObject({ state: "done", note: "3 of 3 main areas seen", gained: ["screen:search"] });
    // Still running: no landing yet.
    expect(landingOf(running("Mapping the app"), before)).toBeNull();

    const onShow = vi.fn();
    const onClose = vi.fn();
    const { container } = render(createElement(RefreshLanded, { landing, names: new Map([["screen:search", "Search"]]), onShow, onClose }));
    const band = container.querySelector<HTMLElement>("[data-atlas-landed]")!;
    expect(band.textContent).toContain("The atlas is refreshed");
    expect(band.textContent).toContain("3 of 3 main areas seen · 1 screen got a new screenshot");
    fireEvent.click(container.querySelector("[data-atlas-landed-show]")!);
    expect(onShow).toHaveBeenCalled();
    fireEvent.click(container.querySelector("[data-atlas-landed-close]")!);
    expect(onClose).toHaveBeenCalled();
  });

  it("says plainly when the pass failed", () => {
    const failed = parseAtlas({ ...folio, refresh: { ...folio.refresh, state: "failed", note: "The device could not start" } });
    const landing = landingOf(failed, frameSigs(failed))!;
    const { container } = render(createElement(RefreshLanded, { landing, names: new Map(), onShow: vi.fn(), onClose: vi.fn() }));
    expect(container.textContent).toContain("The refresh stopped");
    expect(container.textContent).toContain("The device could not start");
    expect(container.querySelector("[data-atlas-landed-show]")).toBeNull();
  });
});
