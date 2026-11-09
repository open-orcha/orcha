// @vitest-environment jsdom
/** The Screen atlas: the teaching empty state and Run check from Refresh atlas, the storyboard with
 * its badges, the filters kept in the URL, a screen's details (lightbox, why, before and after),
 * and screens filling in live as the atlas is read again. */
import { act, cleanup, fireEvent, render, screen as view, within } from "@testing-library/react";
import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toasts = vi.hoisted(() => ({ list: [] as { title: unknown }[] }));
vi.mock("../map/kit/toast", () => ({ useToast: () => ({ toast: (t: { title: unknown }) => toasts.list.push(t) }) }));
const api = vi.hoisted(() => ({ getAtlas: vi.fn() }));
vi.mock("./atlasApi", () => api);
const task = vi.hoisted(() => ({ createQaTask: vi.fn(async () => ({ task_id: "t1" })) }));
vi.mock("../runQa", async (actual) => ({ ...(await actual<typeof import("../runQa")>()), createQaTask: task.createQaTask }));
vi.mock("../../../state/SnapshotProvider", () => ({ useSnapshot: () => ({ snap: { agents: [{ id: "a1", alias: "qa-bot", kind: "ai", status: "active" }] } }) }));
vi.mock("../onboarding/use-live-devices", () => ({ useLiveDevices: () => ({ devices: [{ device: { kind: "ios", name: "iPhone 17 Pro", udid: "U1", state: "booted" }, online: true }], loading: false, available: true }), WEB_OPTIONS: [] }));

import { AtlasBoard } from "./atlas-board";
import folio from "./folio.fixture.json";
import juniper from "./juniper.fixture.json";
import { BADGE_MEANS, NO_FILTERS, type AtlasFilters } from "./model";
import { DeviceFrame } from "./screen-card";
import { PortRoot } from "../map/kit";
import type { QaNav } from "../QaPage";
import { parseAtlas, type Atlas } from "./types";

const ATLAS = parseAtlas(juniper);
const EMPTY = parseAtlas({ project_id: "p1", platforms: [], refresh: { state: "idle" } });

let url = new URLSearchParams();
const runQa = vi.fn();

function fakeNav(over: Partial<QaNav> = {}): QaNav {
  return {
    platform: "ios",
    goBack: () => undefined,
    get: (k) => url.get(k),
    set: (patch) => {
      for (const [k, v] of Object.entries(patch)) {
        if (v == null || v === "") url.delete(k);
        else url.set(k, v);
      }
    },
    nonce: 0,
    refresh: vi.fn(),
    runQa,
    auth: { can: true, reason: null, human: null } as unknown as QaNav["auth"],
    ...over,
  };
}

function tree(atlas: Atlas | null, filters: AtlasFilters = NO_FILTERS, screen: string | null = null, nav: QaNav = fakeNav()) {
  return createElement(MemoryRouter, null, createElement(PortRoot, { refresh: nav.refresh, children: createElement(AtlasBoard, { cid: "p1", nav, atlas, error: atlas ? null : "boom", filters, screen, since: null }) }));
}

function board(atlas: Atlas | null, filters: AtlasFilters = NO_FILTERS, screen: string | null = null, nav: QaNav = fakeNav()) {
  return render(tree(atlas, filters, screen, nav));
}

beforeEach(() => {
  toasts.list = [];
  url = new URLSearchParams();
  runQa.mockReset();
  task.createQaTask.mockClear();
  api.getAtlas.mockReset();
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AtlasBoard on a mixed stack", () => {
  it("names three areas a row leads to, the rest behind +N more, and one count per row", () => {
    const { container } = board(parseAtlas(folio));
    const library = container.querySelector<HTMLElement>('[data-atlas-area="library"]')!;
    const leads = library.querySelector<HTMLElement>("[data-atlas-leads]")!;
    expect(leads.querySelectorAll("button:not([data-atlas-leads-more])")).toHaveLength(3);
    const more = leads.querySelector<HTMLButtonElement>("[data-atlas-leads-more]")!;
    expect(more.textContent).toBe("+1 more");
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(leads.querySelector("[data-atlas-leads-popover]")!.querySelectorAll("button")).toHaveLength(4);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(leads.querySelector("[data-atlas-leads-popover]")).toBeNull();
    // The account area's "3 screens: overview" is the code map's count: one count only.
    const account = container.querySelector<HTMLElement>('[data-atlas-area="account"]')!;
    expect(account.textContent).not.toContain("overview");
    expect(account.querySelector("[data-atlas-area-count]")!.textContent).toBe("2 screens · 2 seen live");
  });

  it("shows the frames a running pass is capturing and how far it is", () => {
    const a = parseAtlas({ ...folio, refresh: { ...folio.refresh, state: "running", note: "Mapping the app", targets: ["screen:search", "screen:library"], platform: "ios" } });
    const { container } = board(a);
    const shimmer = [...container.querySelectorAll<HTMLElement>("[data-capturing]")];
    expect(shimmer).toHaveLength(1);
    expect(shimmer[0].getAttribute("data-platform")).toBe("ios");
    expect(shimmer[0].closest("[data-atlas-card]")!.textContent).toContain("Search");
    expect(shimmer[0].textContent).toContain("Capturing");
    expect(container.querySelector("[data-atlas-filling-count]")!.textContent).toBe("1 of 2 main areas captured");
  });

  it("draws an iPad-first app's iOS in iPad frames and says what it does not know", () => {
    const { container } = board(parseAtlas(folio));
    const reader = container.querySelector<HTMLElement>('[data-atlas-card="screen:reader"], [data-atlas-card="screen:/read/*"]')!;
    expect(reader.querySelector('[data-platform="android"]')!.getAttribute("data-atlas-frame")).toBe("unknown");
    expect(reader.querySelector('[data-platform="android"]')!.textContent).toBe("No Android match found");
    // The reader's iPad look is on its side: an iPad on its side (#438), fitted into the upright
    // iPad column, so the shot fills its own frame.
    expect(reader.querySelector('[data-platform="ios"]')!.getAttribute("data-device")).toBe("tabletWide");
    expect(reader.querySelector('[data-platform="ios"]')!.closest("[data-atlas-slot]")!.getAttribute("data-atlas-slot")).toBe("tablet");
    expect(reader.querySelector('[data-platform="ios"]')!.getAttribute("data-fit")).toBe("cover");
    // Every other iOS screen of an iPad-first app is an upright iPad.
    const library = container.querySelector<HTMLElement>('[data-atlas-card="screen:library"]');
    if (library) expect(library.querySelector('[data-platform="ios"]')!.getAttribute("data-device")).toBe("tablet");
    // One screen reads differently where seen live; one is only not in the web code: said apart.
    expect(container.querySelector('[data-atlas-count="differ"]')!.textContent).toBe("1differs");
    expect(container.querySelector('[data-atlas-count="missing"]')!.textContent).toBe("1not on every platform");
  });
});

describe("AtlasBoard", () => {
  it("teaches what the atlas is on an empty project and starts a map pass from its dialog", async () => {
    const { container } = board(EMPTY);
    expect(container.querySelector("[data-atlas-empty]")).not.toBeNull();
    expect(view.getByText("See every screen at a glance")).toBeTruthy();
    // The scene that shows it working: four steps, a storyboard of six screens with one honest unknown.
    const scene = container.querySelector<HTMLElement>("[data-atlas-scene]")!;
    expect(scene.querySelectorAll("[data-scene=caption]")).toHaveLength(4);
    expect(scene.querySelectorAll("[data-scene=fly-y]")).toHaveLength(6);
    expect(scene.textContent).toContain("Not matched yet");
    // Without the Web Animations API (or under reduced motion) it stands finished, never hidden.
    expect(scene.hasAttribute("data-wait")).toBe(false);
    const button = container.querySelector<HTMLButtonElement>("[data-atlas-refresh]")!;
    expect(button.textContent).toBe("Map the main screens"); // no price
    fireEvent.click(button);
    const dialog = container.ownerDocument.querySelector("[data-atlas-pass=refresh]") as HTMLElement;
    expect(dialog.textContent).toContain("Default lets the agent pick");
    fireEvent.click(container.ownerDocument.querySelector('[data-atlas-refresh-start="ios"]')!);
    await act(async () => {});
    expect(task.createQaTask).toHaveBeenCalledTimes(1);
    const body = (task.createQaTask.mock.calls[0] as unknown[])[1] as { title: string; description: string; assignee_alias: string };
    expect(body.title).toBe("Refresh the screen atlas on iOS");
    expect(body.description).toContain("--minutes 3 --pass overview");
    expect(body.assignee_alias).toBe("qa-bot");
    expect(toasts.list[0].title).toBe("Refreshing the atlas");
  });

  it("keeps a map pass to the people who may start one", () => {
    const { container } = board(EMPTY, NO_FILTERS, null, fakeNav({ auth: { can: false, reason: "Only a person can start QA work", human: null } as unknown as QaNav["auth"] }));
    const button = container.querySelector<HTMLButtonElement>("[data-atlas-refresh]")!;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(runQa).not.toHaveBeenCalled();
  });

  it("shows each area as a row of screens with their platforms side by side and a badge", () => {
    const { container } = board(ATLAS);
    const areas = [...container.querySelectorAll("[data-atlas-area]")].map((a) => a.getAttribute("data-atlas-area"));
    expect(areas).toEqual(ATLAS.areas.map((a) => a.key));
    const detail = container.querySelector('[data-atlas-card="screen:/products/*"]')!;
    expect(detail.querySelectorAll("[data-atlas-frame=shot]")).toHaveLength(3);
    expect(detail.querySelector("[data-atlas-badge]")?.getAttribute("data-atlas-badge")).toBe("minor");
    expect(detail.getAttribute("aria-label")).toContain("Android says “Add to bag”");
    const reviews = container.querySelector('[data-atlas-card="screen:/products/*/reviews"]')!;
    expect(reviews.querySelectorAll("[data-atlas-frame=absent]")).toHaveLength(2);
    const done = container.querySelector('[data-atlas-card="screen:/checkout/done"]')!;
    expect(done.querySelectorAll("[data-atlas-frame=wire]")).toHaveLength(3);
    expect(container.querySelector('[data-atlas-card="screen:cart"]')?.getAttribute("data-changed")).toBe("true");
    expect(container.querySelectorAll("[data-atlas-arrows] path[d]").length).toBeGreaterThan(3);
  });

  it("explains a badge on hover and to a screen reader, and Escape puts the tip away", () => {
    vi.useFakeTimers();
    try {
      const { container } = board(ATLAS);
      const card = container.querySelector<HTMLElement>('[data-atlas-card="screen:/products/*"]')!;
      // A screen reader hears the meaning with the card, whether or not the tip is shown.
      const said = container.ownerDocument.getElementById(card.getAttribute("aria-describedby")!)!;
      expect(said.textContent).toBe(`Minor differences: ${BADGE_MEANS.minor}`);
      const badge = card.querySelector<HTMLElement>("[data-atlas-badge]")!;
      fireEvent.mouseEnter(badge);
      expect(document.querySelector("[data-atlas-tip]")).toBeNull(); // a pointer passing over does not flash it
      act(() => {
        vi.advanceTimersByTime(300);
      });
      const tip = document.querySelector<HTMLElement>("[data-atlas-tip]")!;
      expect(tip.parentElement).toBe(document.body); // out of the card, which paints inside itself
      expect(tip.querySelector("[data-atlas-tip-means]")!.textContent).toBe(BADGE_MEANS.minor);
      fireEvent.keyDown(document, { key: "Escape" });
      expect(document.querySelector("[data-atlas-tip]")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("explains the badge of an open screen inside its dialog, and the badge never takes the first focus", () => {
    const { container } = board(ATLAS, NO_FILTERS, "screen:cart");
    const dialog = container.ownerDocument.querySelector("dialog[open]") as HTMLDialogElement;
    const badge = dialog.querySelector<HTMLElement>("h2 [data-atlas-badge]")!;
    expect(badge.tabIndex).toBe(0);
    expect(badge.hasAttribute("data-dialog-skip-focus")).toBe(true);
    expect(container.ownerDocument.getElementById(badge.getAttribute("aria-describedby")!)!.textContent).toContain(BADGE_MEANS[ATLAS.screens.find((s) => s.id === "screen:cart")!.similarity!.badge]);
    vi.useFakeTimers();
    try {
      fireEvent.mouseEnter(badge);
      act(() => {
        vi.advanceTimersByTime(300);
      });
      // In the dialog (top layer), not under it in the body.
      expect(dialog.querySelector("[data-atlas-tip]")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the filters in the URL and narrows the storyboard", () => {
    const { container } = board(ATLAS);
    fireEvent.click(container.querySelector('[data-atlas-filter="differs"]')!);
    expect(url.toString()).toBe("filter=differs");
    expect(container.querySelectorAll("[data-atlas-card]")).toHaveLength(7);
    fireEvent.click(container.querySelector('[data-atlas-filter="platform:ios"]')!);
    fireEvent.click(container.querySelector('[data-atlas-filter="platform:android"]')!);
    expect(url.get("platforms")).toBe("ios,android");
    // Only the phones' columns on each card now, and only what differs between them.
    expect(container.querySelector('[data-atlas-card="screen:cart"]')!.querySelectorAll("[data-atlas-frame]")).toHaveLength(2);
    expect(container.querySelectorAll("[data-atlas-card]")).toHaveLength(5);
    fireEvent.change(container.querySelector("[data-atlas-search]")!, { target: { value: "zzz" } });
    expect(container.querySelector("[data-atlas-none]")).not.toBeNull();
    fireEvent.click(container.querySelector("[data-atlas-clear]")!);
    expect(container.querySelectorAll("[data-atlas-card]")).toHaveLength(15);
    fireEvent.click(container.querySelector('[data-atlas-filter="arrows"]')!);
    expect(container.querySelector("[data-atlas-arrows]")).toBeNull();
    expect(url.toString()).toBe("arrows=0");
  });

  it("leaves the QA page's own parameters alone", () => {
    url = new URLSearchParams("view=map&sub=atlas&platform=android");
    const { container } = board(ATLAS);
    fireEvent.click(container.querySelector('[data-atlas-filter="platform:ios"]')!);
    expect(url.toString()).toBe("view=map&sub=atlas&platform=android&platforms=ios");
  });

  it("opens a screen's details from the URL: why, states, the before and after, and the lightbox", () => {
    const { container } = board(ATLAS, NO_FILTERS, "screen:cart");
    const panel = container.ownerDocument.querySelector('[data-atlas-detail="screen:cart"]') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(within(panel).getByText("iOS and Web say “Checkout”, Android says “Proceed to checkout”")).toBeTruthy();
    expect(panel.querySelectorAll("[data-atlas-compare]")).toHaveLength(2);
    const range = panel.querySelector<HTMLInputElement>("[data-atlas-compare-range]")!;
    fireEvent.change(range, { target: { value: "20" } });
    expect(range.getAttribute("aria-valuetext")).toBe("80% Build 1.5.0, 20% Build 1.4.0");
    expect(panel.querySelector("[data-atlas-map-link]")?.getAttribute("href")).toBe(`/qa?view=map&screen=${encodeURIComponent(ATLAS.screens.find((x) => x.id === "screen:cart")!.variants.ios!.node)}`);
    fireEvent.click(panel.querySelector('[data-atlas-detail-frame="ios"]')!);
    expect(container.ownerDocument.querySelector("[data-atlas-lightbox]")).not.toBeNull();
    expect(url.toString()).toBe("screen=screen%3Acart");
  });

  it("expands a screen's details to the full window and back: the button, F, and Esc before it closes (A1)", () => {
    window.sessionStorage.removeItem("orcha:atlas:detail-expanded");
    const { container } = board(ATLAS, NO_FILTERS, "screen:cart");
    const doc = container.ownerDocument;
    const panel = () => doc.querySelector('[data-atlas-detail="screen:cart"]') as HTMLElement;
    const expand = () => doc.querySelector<HTMLButtonElement>("[data-atlas-detail-expand]")!;
    const dialog = panel().closest("dialog")!;
    expect(panel().getAttribute("data-atlas-detail-mode")).toBe("panel");
    expect(expand().getAttribute("aria-label")).toBe("Expand to the full window");
    expect(expand().getAttribute("aria-keyshortcuts")).toBe("F");
    fireEvent.click(expand());
    expect(panel().getAttribute("data-atlas-detail-mode")).toBe("full");
    expect(expand().getAttribute("aria-label")).toBe("Collapse to the side panel");
    expect(window.sessionStorage.getItem("orcha:atlas:detail-expanded")).toBe("1");
    // Esc collapses first; the details stay open.
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(panel()).not.toBeNull();
    expect(panel().getAttribute("data-atlas-detail-mode")).toBe("panel");
    // F toggles, but not while typing in a field.
    fireEvent.keyDown(window, { key: "f" });
    expect(panel().getAttribute("data-atlas-detail-mode")).toBe("full");
    const field = doc.createElement("input");
    panel().appendChild(field);
    fireEvent.keyDown(field, { key: "f" });
    expect(panel().getAttribute("data-atlas-detail-mode")).toBe("full");
    fireEvent.keyDown(window, { key: "F" });
    expect(panel().getAttribute("data-atlas-detail-mode")).toBe("panel");
    // Collapsed, Esc closes.
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(doc.querySelector('[data-atlas-detail="screen:cart"]')).toBeNull();
  });

  it("steps to the previous and next screen with the arrow keys, as the buttons do, but not on a slider", () => {
    const { container } = board(ATLAS, NO_FILTERS, "screen:cart");
    const doc = container.ownerDocument;
    const open = () => doc.querySelector<HTMLElement>("[data-atlas-detail]")?.getAttribute("data-atlas-detail");
    const next = doc.querySelector<HTMLButtonElement>("[data-atlas-detail-next]")!;
    expect(next.getAttribute("aria-keyshortcuts")).toBe("ArrowRight");
    const after = next.getAttribute("aria-label")!.replace("Next screen: ", "");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(open()).not.toBe("screen:cart");
    expect(doc.querySelector("dialog h2")?.textContent).toContain(after);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(open()).toBe("screen:cart");
    // On the before and after's slider the arrows move the slider, not the screen.
    const range = doc.querySelector<HTMLInputElement>("[data-atlas-compare-range]")!;
    fireEvent.keyDown(range, { key: "ArrowRight" });
    expect(open()).toBe("screen:cart");
  });

  it("fills in a platform's unseen screens only on a click: the header chip, a card's frame and the details (A2)", async () => {
    const nav = fakeNav();
    const { container, rerender } = board(ATLAS, NO_FILTERS, "screen:help", nav);
    const doc = container.ownerDocument;
    const chip = doc.querySelector<HTMLButtonElement>('[data-atlas-fill="android"]')!;
    expect(chip.textContent).toBe("Fill in Android · 3 screens not seen"); // no price
    expect(chip.getAttribute("title")).toContain("Embodent opens the app on Android and visits those 3 screens, about 10 minutes.");
    expect(runQa).not.toHaveBeenCalled(); // nothing starts by itself
    // The details say which platform it is not seen on, and offer the same.
    const panel = doc.querySelector('[data-atlas-detail="screen:help"]') as HTMLElement;
    expect(panel.querySelector('[data-atlas-detail-fill="android"]')).not.toBeNull();
    // A card with a not-seen frame offers it beside itself.
    expect(doc.querySelector('[data-atlas-card="screen:help"] + [data-atlas-card-fill]')?.textContent).toMatch(/^Fill in /);
    // The dialog says what it visits and asks which device; nothing starts until its button.
    fireEvent.click(chip);
    expect(doc.querySelector('[data-atlas-fill-device="android"]')).not.toBeNull();
    expect(task.createQaTask).not.toHaveBeenCalled();
    fireEvent.click(doc.querySelector('[data-atlas-fill-start="android"]')!);
    await act(async () => {});
    const body = (task.createQaTask.mock.calls[0] as unknown[])[1] as { title: string; description: string };
    expect(body.title).toBe("Fill in Android: 3 screens not seen");
    expect(body.description).toContain("on android --minutes 10 --pass deeper");
    expect(doc.querySelector('[data-atlas-fill-device="android"]')).toBeNull();
    void rerender;
    void nav;
  });

  it("opens the screen a card names and follows a move to the next one", () => {
    const { container } = board(ATLAS);
    fireEvent.click(container.querySelector('[data-atlas-card="screen:cart"]')!);
    const panel = container.ownerDocument.querySelector('[data-atlas-detail="screen:cart"]') as HTMLElement;
    fireEvent.click(within(panel).getByText("Shipping"));
    expect(container.ownerDocument.querySelector('[data-atlas-detail="screen:shipping"]')).not.toBeNull();
  });

  it("fills in live: a new look read again develops in", async () => {
    const nav = fakeNav();
    const { container, rerender } = board(ATLAS, NO_FILTERS, null, nav);
    const next = structuredClone(juniper) as { screens: { id: string; never_seen: boolean; variants: Record<string, unknown> }[] };
    const done = next.screens.find((s) => s.id === "screen:/checkout/done")!;
    done.variants.ios = { ...(next.screens[0].variants.ios as object), node: "screen:order-confirmed" };
    done.never_seen = false;
    api.getAtlas.mockResolvedValue(next);
    await act(async () => {
      rerender(tree(ATLAS, NO_FILTERS, null, { ...nav, nonce: 1 }));
    });
    expect(api.getAtlas).toHaveBeenCalledWith("p1", null);
    const card = container.querySelector('[data-atlas-card="screen:/checkout/done"]')!;
    expect(card.querySelectorAll("[data-atlas-frame=shot]")).toHaveLength(1);
    expect(card.querySelector("img")?.className).toMatch(/fresh/);
  });

  it("reads the atlas every few seconds while a pass fills it in", async () => {
    vi.useFakeTimers();
    try {
      api.getAtlas.mockResolvedValue({ ...folio, refresh: { state: "running", note: "Mapping the app" } });
      board(parseAtlas({ ...folio, refresh: { state: "running", note: "Mapping the app" } }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6100);
      });
      expect(api.getAtlas).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says how many screens it holds, how it counts them beside the App map and Coverage, and splits them in one bar", () => {
    const { container } = board(ATLAS);
    const header = container.querySelector<HTMLElement>("[data-atlas-header]")!;
    expect(header.querySelector('[data-atlas-count="screens"]')!.textContent).toBe("15screens");
    const counted = header.querySelector<HTMLElement>("[data-atlas-counted] button")!;
    expect(counted.textContent).toBe("Each counted once across iOS, Android and Web");
    // The note squares it with the per-platform count, said to a screen reader with the line.
    expect(container.ownerDocument.getElementById(counted.getAttribute("aria-describedby")!)!.textContent).toContain("The App map and Coverage count each platform's own screen apart: 28 in all.");
    const bar = header.querySelector<HTMLElement>("[data-atlas-bar]")!;
    expect([...bar.querySelectorAll("[data-atlas-bar-part]")].map((p) => p.getAttribute("data-atlas-bar-part"))).toEqual(["same", "differs", "missing", "unchecked"]);
    expect(bar.getAttribute("aria-label")).toBe("15 screens: 6 the same, 4 differ, 3 not on every platform, 2 not compared yet");
    // Each platform's counts, then (3 or more screens not seen there) its Fill in.
    expect([...header.querySelectorAll("[data-atlas-platform-sum]")].map((p) => p.textContent)).toEqual([
      "iOS14 screens · 11 seenFill in iOS · 3 screens not seen",
      "Android13 screens · 10 seenFill in Android · 3 screens not seen",
      "Web14 screens · 12 seen",
    ]);
  });

  it("plays the app as a tour, area by area, and steps with the keys", async () => {
    vi.useFakeTimers();
    try {
      const { container } = board(ATLAS);
      fireEvent.click(container.querySelector("[data-atlas-play]")!);
      const tour = container.ownerDocument.querySelector<HTMLDialogElement>("[data-atlas-play-tour]")!;
      expect(tour.hasAttribute("open")).toBe(true);
      const words = () => tour.querySelector("[data-atlas-play-words]")!.textContent;
      expect(words()).toBe("Browse: 2 of 2 screens seen live.");
      // Playing: the title card holds, then the camera moves on to the first screen.
      await act(async () => {
        vi.advanceTimersByTime(1800);
      });
      expect(words()).toBe("Screen 1 of 12: Home, in Browse.");
      fireEvent.click(tour.querySelector("[data-atlas-play-toggle]")!);
      expect(tour.querySelector("[data-atlas-play-toggle]")!.getAttribute("aria-label")).toBe("Play");
      fireEvent.keyDown(tour, { key: "ArrowRight" });
      expect(words()).toBe("Screen 2 of 12: Search, in Browse. Tap Search.");
      fireEvent.keyDown(tour, { key: "End" });
      expect(words()).toBe("The end of the tour: 12 screens in 4 areas.");
      expect(tour.querySelector("[data-atlas-play-again]")).not.toBeNull();
      fireEvent.click(tour.querySelector("[data-atlas-play-close]")!);
      expect(container.ownerDocument.querySelector("[data-atlas-play-tour]")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens a screen from the tour", () => {
    const { container } = board(ATLAS);
    fireEvent.click(container.querySelector("[data-atlas-play]")!);
    const tour = container.ownerDocument.querySelector<HTMLDialogElement>("[data-atlas-play-tour]")!;
    fireEvent.keyDown(tour, { key: "ArrowRight" });
    fireEvent.click(tour.querySelector("[data-atlas-play-open]")!);
    expect(container.ownerDocument.querySelector("[data-atlas-play-tour]")).toBeNull();
    expect(container.ownerDocument.querySelector('[data-atlas-detail="screen:/"]')).not.toBeNull();
  });

  it("lands a refresh it watched: what it saw, the screens that got a new screenshot, and lights them", async () => {
    const running = parseAtlas({ ...folio, refresh: { ...folio.refresh, state: "running", note: "Mapping the app", targets: ["screen:library", "screen:search"], platform: "ios" } });
    const nav = fakeNav();
    const { container, rerender } = board(running, NO_FILTERS, null, nav);
    expect(container.querySelector("[data-atlas-filling]")).not.toBeNull();
    const next = structuredClone(folio) as unknown as { screens: { id: string; variants: Record<string, unknown> }[]; refresh: Record<string, unknown> };
    const search = next.screens.find((s) => s.id === "screen:search")!;
    search.variants.ios = { ...(next.screens[0].variants.ios as object), node: "screen:search" };
    api.getAtlas.mockResolvedValue({ ...next, refresh: { ...next.refresh, state: "done", note: "2 of 2 main areas seen" } });
    await act(async () => {
      rerender(tree(running, NO_FILTERS, null, { ...nav, nonce: 1 }));
    });
    expect(container.querySelector("[data-atlas-filling]")).toBeNull();
    const landed = container.querySelector<HTMLElement>("[data-atlas-landed]")!;
    expect(landed.textContent).toContain("2 of 2 main areas seen · 1 screen got a new screenshot");
    fireEvent.click(landed.querySelector("[data-atlas-landed-show]")!);
    expect(container.querySelector('[data-atlas-card="screen:search"]')!.getAttribute("data-glow")).toBe("true");
    fireEvent.click(landed.querySelector("[data-atlas-landed-close]")!);
    expect(container.querySelector("[data-atlas-landed]")).toBeNull();
  });

  it("compares each pair of platforms in the details: how alike, the words that differ, a wipe between two phones", () => {
    const { container } = board(ATLAS, NO_FILTERS, "screen:cart");
    const panel = container.ownerDocument.querySelector('[data-atlas-detail="screen:cart"]') as HTMLElement;
    expect([...panel.querySelectorAll("[data-atlas-pair]")].map((p) => p.getAttribute("data-atlas-pair"))).toEqual(["ios-android", "ios-web", "android-web"]);
    expect(panel.querySelector('[data-atlas-pair="ios-android"]')!.textContent).toContain("69% alike");
    // Only the two phones are one kind of device: one wipe, and the before and afters stay two.
    expect(panel.querySelectorAll("[data-atlas-wipe]")).toHaveLength(1);
    expect(panel.querySelectorAll("[data-atlas-compare]")).toHaveLength(2);
    // What a reason quotes is marked for the eye; a screen reader hears the sentence whole.
    const reason = panel.querySelector("[data-atlas-reasons] li")!;
    expect(reason.querySelectorAll("mark").length).toBeGreaterThan(0);
    expect(reason.querySelector(".sr-only")!.textContent).toBe("iOS and Web say “Checkout”, Android says “Proceed to checkout”");
  });

  it("drags the wipe from its round grip as well as its line: the picture takes the pointer, not the handle over it", () => {
    // This jsdom has no PointerEvent, and without one a test event carries no button or clientX.
    vi.stubGlobal("PointerEvent", MouseEvent);
    const { container } = board(ATLAS, NO_FILTERS, "screen:cart");
    const wipe = container.ownerDocument.querySelector("[data-atlas-wipe]") as HTMLElement;
    const range = wipe.querySelector<HTMLInputElement>("[data-atlas-wipe-range]")!;
    vi.spyOn(wipe, "getBoundingClientRect").mockReturnValue({ left: 100, width: 400, top: 0, height: 800, right: 500, bottom: 800, x: 100, y: 0, toJSON: () => ({}) });
    // A press on the grip lands on the picture and moves the cut to the pointer, then follows it.
    const grip = wipe.querySelector("svg")!;
    fireEvent.pointerDown(grip, { button: 0, clientX: 300, pointerId: 1 });
    expect(range.value).toBe("50");
    fireEvent.pointerMove(wipe, { clientX: 180, pointerId: 1 });
    expect(range.value).toBe("20");
    fireEvent.pointerUp(wipe, { clientX: 180, pointerId: 1 });
    // Once let go, a pointer passing over moves nothing.
    fireEvent.pointerMove(wipe, { clientX: 460, pointerId: 1 });
    expect(range.value).toBe("20");
  });

  it("says when the atlas could not be read", () => {
    const { container } = board(null);
    expect(container.querySelector("[data-atlas-load-error]")?.textContent).toContain("boom");
  });
});

describe("DeviceFrame", () => {
  it("shows a screenshot whole that loaded before the page hydrated (no load event reached React)", () => {
    const proto = HTMLImageElement.prototype;
    const complete = vi.spyOn(proto, "complete", "get").mockReturnValue(true);
    const width = vi.spyOn(proto, "naturalWidth", "get").mockReturnValue(1206);
    const height = vi.spyOn(proto, "naturalHeight", "get").mockReturnValue(2622);
    try {
      // A phone's shot in an iPad's frame: never cropped.
      const { container } = render(createElement(DeviceFrame, { platform: "ios", kind: "tablet", src: "/f/move-book.jpg", name: "Move book" }));
      expect(container.querySelector("[data-atlas-frame]")?.getAttribute("data-fit")).toBe("contain");
      cleanup();
      // An iPad's shot in an iPad's frame fills it.
      width.mockReturnValue(2064);
      height.mockReturnValue(2752);
      const again = render(createElement(DeviceFrame, { platform: "ios", kind: "tablet", src: "/f/library.jpg", name: "Library" }));
      expect(again.container.querySelector("[data-atlas-frame]")?.getAttribute("data-fit")).toBe("cover");
    } finally {
      [complete, width, height].forEach((s) => s.mockRestore());
    }
  });
});
