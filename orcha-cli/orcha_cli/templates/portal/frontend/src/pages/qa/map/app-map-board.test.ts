// @vitest-environment jsdom
/** Map: the teaching empty state, a build followed to the end, the map's header and the detail
 * panel, Map the app's launch buttons and a crawl revealed live by polling. */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
const api = vi.hoisted(() => ({ sessions: [] as unknown[], map: null as unknown }));

vi.mock("./kit", async (real) => ({ ...(await real<typeof import("./kit")>()), useRouter: () => router }));
vi.mock("../qaApi", async (real) => ({
  ...(await real<typeof import("../qaApi")>()),
  listSessions: vi.fn(async () => api.sessions),
  getMap: vi.fn(async () => api.map),
}));
// The poll's map is the fixture's own shape here: `adapt.test.ts` covers the conversion.
vi.mock("./api", () => ({ getFullMap: vi.fn(async () => api.map) }));
vi.mock("./adapt", async () => {
  const { parseAppMap } = await import("./types");
  return { adaptMap: (raw: unknown) => parseAppMap(raw) };
});
// The canvas is React Flow, which needs a real layout engine; the board's states are tested here.
vi.mock("./app-map-view", () => ({
  AppMapView: ({ map, overlay, reveal }: { map: { nodes: unknown[] }; overlay: unknown; reveal?: { fresh: ReadonlySet<string>; follow: string | null } }) =>
    createElement(
      "div",
      { "data-testid": "canvas", "data-nodes": map.nodes.length, "data-revealed": reveal ? [...reveal.fresh].join(",") : undefined, "data-follow": reveal?.follow ?? undefined },
      overlay as never,
    ),
}));

import { AppMapBoard } from "./app-map-board";
import { DetailPanel } from "./detail-panel";
import { RENTALS_MAP_JSON } from "./fixture";
import { layoutScreens } from "./layout";
import { withPage } from "./test-wrap";
import { parseAppMap } from "./types";

const project = { id: "proj-rentals", platform: "ios" as const };
const empty = parseAppMap({ project_id: "proj-rentals", build: null, features: [], nodes: [], edges: [] });
const full = parseAppMap(RENTALS_MAP_JSON);
const run = vi.fn();

function board(map: typeof full | null, error: string | null = null, actions = {}) {
  return render(withPage(createElement(AppMapBoard, { project, map, error }) as ReactNode, { run, ...actions }));
}

beforeEach(() => {
  vi.useFakeTimers();
  api.sessions = [];
  api.map = null;
  router.refresh.mockClear();
  run.mockClear();
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("AppMapBoard", () => {
  it("teaches the three sources and starts a map session from the empty state", async () => {
    const { container, getByText } = board(empty);
    expect(container.querySelector("[data-app-map-empty]")).toBeTruthy();
    expect([...container.querySelectorAll("[data-source]")].map((e) => e.getAttribute("data-source"))).toEqual(["code", "tests", "live"]);
    expect(getByText("Build the map")).toBeTruthy();
    fireEvent.click(container.querySelector("[data-app-map-build]")!);
    expect(run).toHaveBeenCalledWith("map");
  });

  it("disables starting work for anyone who may not, with the reason", () => {
    const { container } = board(empty, null, { can: false, reason: "Only a person can start QA work" });
    expect(container.querySelector<HTMLButtonElement>("[data-app-map-build]")?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>("[data-map-the-app]")?.disabled).toBe(true);
    fireEvent.click(container.querySelector("[data-app-map-build]")!);
    expect(run).not.toHaveBeenCalled();
  });

  it("follows a build already running when the page opens, and says when it failed", async () => {
    const running = { ...empty, build: { id: "build-8", status: "running" as const, started_at: null, finished_at: null, error: null } };
    const { container } = board(running);
    expect(container.querySelector("[data-app-map-building]")).toBeTruthy();
    // The code is read first; the tests wait their turn.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(container.querySelector('[data-step="code"]')?.getAttribute("data-step-state")).toBe("active");
    expect(container.querySelector('[data-step="tests"]')?.getAttribute("data-step-state")).toBe("pending");

    api.map = { project_id: "proj-rentals", nodes: [], edges: [], features: [], build: { id: "build-8", status: "failed", error: "The repository at /Users/mary/rentals could not be read." } };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(container.querySelector("[data-app-map-error]")?.textContent).toContain("could not be read");
    expect(container.querySelector("[data-app-map-build]")?.textContent).toBe("Try again");
    expect(router.refresh).toHaveBeenCalled();
  });

  it("shows the counts, each source's last read and Rebuild over the canvas", async () => {
    const { container } = board(full);
    const counts = container.querySelector("[data-map-counts]")!.textContent!;
    expect(counts).toContain("4features");
    expect(counts).toContain("5seen");
    expect(counts).toContain("4declared");
    expect(counts).toContain("2blocked");
    expect(counts).toContain("6endpoints");
    expect(container.querySelector('[data-map-source="live"]')?.textContent).toContain("12 runs");
    expect(container.querySelector('[data-testid="canvas"]')?.getAttribute("data-nodes")).toBe("23");

    fireEvent.click(container.querySelector("[data-app-map-rebuild]")!);
    expect(run).toHaveBeenCalledWith("map");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  });

  it("shows the rebuilding card over the canvas while a build runs", () => {
    const { container } = board({ ...full, build: { id: "b", status: "running", started_at: null, finished_at: null, error: null } });
    expect(container.querySelector("[data-app-map-rebuilding]")).toBeTruthy();
  });

  it("explains a map that could not be read and offers to try again", () => {
    const { container, getByText } = board(null, "The server said no.");
    expect(container.querySelector("[data-app-map-load-error]")?.textContent).toContain("The server said no.");
    fireEvent.click(getByText("Try again"));
    expect(router.refresh).toHaveBeenCalled();
  });
});

describe("Map the app on the Map page", () => {
  const running = {
    id: "run-crawl",
    kind: "map",
    platform: "ios",
    status: "running",
    budget_minutes: 20,
    started_at: "2026-10-21T09:00:00Z",
  };

  it("opens Run check on a map session from the header and the empty state", () => {
    const header = board(full);
    fireEvent.click(header.container.querySelector("[data-map-header] [data-map-the-app]")!);
    expect(run).toHaveBeenCalledWith("map");
    cleanup();
    const blank = board(empty);
    expect(blank.container.querySelector("[data-app-map-empty] [data-map-the-app]")).toBeTruthy();
    expect(blank.container.querySelector("[data-app-map-build]")).toBeTruthy(); // beside Build the map
  });

  it("shows the live chip while a map session runs and reveals the screens it reaches", async () => {
    vi.setSystemTime(new Date("2026-10-21T09:13:48Z"));
    api.sessions = [running];
    api.map = RENTALS_MAP_JSON;
    const { container } = board(full);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const chip = container.querySelector("[data-map-crawl-chip]")!;
    expect(chip.textContent).toContain("Map the app · 0 screens seen · 6:12 left");
    expect(container.querySelector("[data-map-crawl-link]")?.getAttribute("href")).toBe("/qa?view=sessions&platform=ios&session=run-crawl");

    // The crawl reaches Map search: the next read reveals the screen and the camera follows.
    api.map = {
      ...RENTALS_MAP_JSON,
      nodes: RENTALS_MAP_JSON.nodes.map((n) =>
        n.key === "map-search" ? { ...n, state: "seen", evidence: { code: [], tests: [], live: { runs: 1, last_run_id: "run-crawl", last_seen_at: "2026-10-21T09:13:40Z" } } } : n,
      ),
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    const canvas = container.querySelector('[data-testid="canvas"]')!;
    expect(canvas.getAttribute("data-revealed")).toBe("screen:map-search");
    expect(canvas.getAttribute("data-follow")).toBe("screen:map-search");
    expect(container.querySelector("[data-map-crawl-chip]")?.textContent).toContain("1 screen seen");

    // Follow off: the camera stays; the pulse fades after a moment.
    fireEvent.click(container.querySelector("[data-map-follow]")!);
    expect(container.querySelector("[data-map-follow]")?.getAttribute("aria-pressed")).toBe("false");
    expect(canvas.getAttribute("data-follow")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2600);
    });
    expect(canvas.getAttribute("data-revealed")).toBe("");

    // The session ends: the page reads the finished map.
    api.sessions = [];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(container.querySelector("[data-map-crawl-chip]")).toBeNull();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("leaves a session of another platform or kind alone", async () => {
    api.sessions = [{ ...running, platform: "web" }, { ...running, kind: "explore" }, { ...running, status: "done" }];
    const { container } = board(full);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.querySelector("[data-map-crawl-chip]")).toBeNull();
  });

  it("says it is mapping over an empty map while the crawl starts", async () => {
    api.sessions = [running];
    api.map = { project_id: "proj-rentals", nodes: [], edges: [], features: [] };
    const { container } = board(empty);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.querySelector("[data-app-map-note]")?.textContent).toContain("Mapping the app now");
    expect(container.querySelector("[data-map-crawl-chip]")).toBeTruthy();
  });
});

describe("DetailPanel", () => {
  const regions = layoutScreens(full).regions;
  const panel = (selection: Parameters<typeof DetailPanel>[0]["selection"]) =>
    render(
      withPage(
        createElement(DetailPanel, {
          map: full,
          selection,
          region: selection.kind === "region" ? (regions.find((r) => r.key === selection.key) ?? null) : null,
          onGo: () => {},
          onRegion: () => {},
          onClose: () => {},
        }),
        { run },
      ),
    );

  it("gives a seen screen's every source: file and line, test and framework, runs and the last run", () => {
    const { container } = panel({ kind: "node", id: "screen:listing-detail" });
    expect(container.querySelector('[data-map-evidence="code"]')?.textContent).toContain("ios/Rentals/Views/ListingDetailView.swift:12");
    expect(container.querySelector('[data-map-evidence="tests"]')?.textContent).toContain("testBookViewingFromListing");
    expect(container.querySelector('[data-map-evidence="tests"]')?.textContent).toContain("xcuitest");
    expect(container.querySelector('[data-map-evidence="live"]')?.textContent).toContain("Seen in 7 runs");
    expect(container.querySelector("[data-map-last-run]")?.getAttribute("href")).toBe("/qa?view=sessions&platform=ios&session=run-2041");
    expect(container.querySelector("[data-map-why-not-seen]")).toBeNull();
    expect(container.querySelector('[data-map-connection="screen:book-viewing"]')).toBeTruthy();
  });

  it("says why a blocked screen was not seen, and explores or drafts it through Run check", () => {
    const { container } = panel({ kind: "node", id: "screen:my-viewings" });
    expect(container.querySelector("[data-map-why-not-seen]")?.textContent).toContain("Needs sign-in");
    fireEvent.click(container.querySelector("[data-map-explore-node]")!);
    expect(run.mock.calls[0][0]).toBe("explore");
  });

  it("lists a feature's screens and drafts for it through Run check", () => {
    const { container } = panel({ kind: "region", key: "viewings" });
    expect(container.textContent).toContain("1 of 3 screens seen, 1 blocked.");
    fireEvent.click(container.querySelector('[data-map-draft-from-seen="feature"]')!);
    expect(run).toHaveBeenCalledWith("draft", expect.any(String));
  });
});
