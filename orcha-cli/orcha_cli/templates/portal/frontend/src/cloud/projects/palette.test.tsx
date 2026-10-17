/**
 * D13 parity: ONE project → colour assignment shared by the sidebar order,
 * the header / ⌘K ProjectAvatar and the All projects table — identical colours
 * for the same project, unique colours across the list, and a CIRCLE (D7).
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paletteColor } from "../../components/primitives/Avatar";
import { ToastProvider } from "../../components/ui";
import { _resetProjectsForTests, refreshProjects } from "../../state/projects";
import { ProjectAvatar } from "./avatars";
import { _resetProjectPaletteForTests, projectPaletteSlots } from "./palette";
import { ProjectsPage } from "./ProjectsPage";

vi.mock("../../state/SnapshotProvider", () => ({
  useSnapshot: () => ({ snap: null, cid: "p2", multi: true, refresh: async () => {} }),
  actingHuman: () => null,
  setActingHuman: () => {},
}));
vi.mock("../../state/attention", () => ({ useAttention: () => ({ items: [], count: null, partial: false, followUps: [] }) }));

// names chosen so several hash to the same raw slot — assignPalette must separate them
const list = ["orcha-web", "billing-service", "mobile", "empty-sandbox", "legacy-marketing-site", "docs", "DP", "BS"]
  .map((name, i) => ({ id: "p" + (i + 1), name, status: "active", agents: 1, tasks: 0, needs_you: 0, member_count: 1 }));

beforeEach(() => {
  localStorage.clear();
  _resetProjectsForTests();
  _resetProjectPaletteForTests();
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (d: unknown) => ({ ok: true, status: 200, json: async () => d }) as unknown as Response;
    if (url === "/api/containers") return json({ containers: list });
    if (url === "/api/prefs") return json({ prefs: null });
    return json({});
  }) as unknown as typeof fetch;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); _resetProjectsForTests(); });

/** jsdom keeps hsl() on some elements and rgb() on others — compare normalized colours */
const norm = (c: string) => { const d = document.createElement("div"); d.style.color = c; return d.style.color; };

describe("project avatar palette (D13)", () => {
  it("slots are unique across the list and follow the sidebar order (pins first)", () => {
    const slots = projectPaletteSlots(list, null, [], []);
    expect(new Set(list.map((p) => slots.get(p.id))).size).toBe(list.length);
    // pinning reorders the list the same way the sidebar does → same map as orderProjects
    const pinned = projectPaletteSlots(list, null, ["p8"], []);
    expect(pinned.get("p8")).toBeDefined();
    expect(new Set(list.map((p) => pinned.get(p.id))).size).toBe(list.length);
  });

  it("a scoped project missing from the list is prepended (sidebar rule)", () => {
    const slots = projectPaletteSlots(list.slice(1), { id: "p1", name: "orcha-web" }, [], []);
    expect(slots.get("p1")).toBe(projectPaletteSlots(list, null, [], []).get("p1")); // first either way
  });

  it("ProjectAvatar (legacy callers) is round and uses the shared slot; All projects rows use the D14 icon", async () => {
    await refreshProjects();
    const slots = projectPaletteSlots(list, { id: "p2", name: null }, [], []);
    render(<>{list.map((p) => <ProjectAvatar key={p.id} name={p.name} seed={p.id} className={"t-" + p.id} />)}</>);
    const bgs = list.map((p) => {
      const el = document.querySelector<HTMLElement>(".t-" + p.id)!;
      expect(el).toHaveClass("proj-av");
      expect(el.dataset.palette).toBe(String(slots.get(p.id)));
      expect(norm(el.style.background)).toBe(norm(paletteColor(slots.get(p.id)!).background));
      return norm(el.style.background);
    });
    expect(new Set(bgs).size).toBe(list.length);
    cleanup();

    // D14: All projects rows no longer draw a palette circle — they show the project ICON
    render(<ToastProvider><MemoryRouter><ProjectsPage /></MemoryRouter></ToastProvider>);
    await screen.findByText("orcha-web");
    const row = document.querySelector<HTMLElement>('[data-proj-card="p3"] .prow-av')!;
    expect(row).toHaveClass("v2-picon");
    expect(row.textContent).toBe(""); // never initials
  });

  it("an explicit palette prop wins", () => {
    render(<ProjectAvatar name="x" seed="zz" palette={3} className="t-x" />);
    expect(document.querySelector(".t-x")).toHaveAttribute("data-palette", "3");
  });
});
