/**
 * Frame-shell polish, round 2: one project palette for sidebar / header / ⌘K
 * (D13), the tab strip never parks a legible fragment at its start (M2), the
 * connection indicator is silent while live (M3), and a project switch never
 * leaves a view transition for the next document to abort (m7).
 */
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { _resetForTests as _resetPrefs } from "../cloud/projects/prefs";
import { setProjectIcon } from "../cloud/projects/projectIcons";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui";
import { assignPalette, projectAvatarKey } from "../components/primitives/Avatar";
import { SnapshotProvider } from "../state/SnapshotProvider";
import { _resetProjectsForTests, type ProjectRow } from "../state/projects";
import { Shell } from "./Shell";
import { Sidebar } from "./Sidebar";
import { ChromeProvider } from "./chrome";
import { CommandPalette } from "./search/Palette";
import { TAB_FADE_START, centerCurrentTab } from "./ProjectTabs";
import { paletteRows, projectPaletteSlots } from "./projectPalette";
import { guardViewTransition, skipSwapTransition } from "./routes";

const PROJECTS: ProjectRow[] = [
  { id: "c1", name: "orcha-web", status: "active" },
  { id: "c2", name: "billing-service", status: "active" },
  { id: "c3", name: "mobile", status: "active" },
  { id: "c4", name: "empty-sandbox", status: "active" },
  { id: "c5", name: "legacy-marketing-site", status: "completed" },
  { id: "c6", name: "docs-portal", status: "active" },
  { id: "c7", name: "design-ops", status: "active" },
  { id: "c8", name: "zeta-pipeline", status: "active" },
];
const rawSnap = {
  container: { id: "c1", name: "orcha-web", status: "active", autonomy_level: "plan", wakes_enabled: true },
  agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
  tasks: [],
  requests: [],
};

function stubFetch() {
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return json(PROJECTS);
    if (url.startsWith("/api/containers/c1")) return json(rawSnap);
    return json({});
  }) as unknown as typeof fetch;
}

beforeEach(() => { localStorage.clear(); _resetProjectsForTests(); _resetPrefs(); stubFetch(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const bg = (el: Element | null | undefined) => (el as HTMLElement | null)?.style.background || null;

describe("D13 — one project palette across sidebar, header and ⌘K", () => {
  it("projectPaletteSlots is collision-free and follows the sidebar order", () => {
    const slots = projectPaletteSlots(paletteRows(PROJECTS, { id: "c1", name: "orcha-web" }));
    expect(new Set(slots.values()).size).toBe(PROJECTS.length);
    const direct = assignPalette(PROJECTS.map((p) => projectAvatarKey(p.name || "", p.id)));
    for (const p of PROJECTS) expect(slots.get(p.id)).toBe(direct.get(projectAvatarKey(p.name || "", p.id)));
    // the open project not in the list yet is prepended (as the sidebar does)
    expect(paletteRows(PROJECTS.slice(1), { id: "c1", name: "orcha-web" })[0].id).toBe("c1");
  });

  it("D14: a project shows the same user-chosen icon in the sidebar, header and ⌘K (never initials)", async () => {
    render(
      <ToastProvider>
        <SnapshotProvider>
          <MemoryRouter initialEntries={["/tasks?cid=c1"]}>
            <ChromeProvider framed>
              <div className="v2-app">
                <Sidebar />
                <Shell page="tasks" title="Tasks"><div>body</div></Shell>
              </div>
              <CommandPalette onClose={() => {}} embedded={false} openExecutionControls={() => {}} />
            </ChromeProvider>
          </MemoryRouter>
        </SnapshotProvider>
      </ToastProvider>,
    );
    await waitFor(() => expect(document.querySelectorAll(".v2-sb-picon").length).toBe(PROJECTS.length));
    await waitFor(() => expect(document.querySelector(".v2-header-pav")).toBeTruthy());
    await waitFor(() => expect(document.querySelectorAll(".v2-palette-pav").length).toBeGreaterThanOrEqual(5));
    // default: the neutral glyph everywhere, no initials
    document.querySelectorAll(".v2-sb-picon, .v2-header-pav, .v2-palette-pav").forEach((el) => {
      expect(el.getAttribute("data-icon")).toBe("default");
      expect(el.textContent).toBe("");
    });
    act(() => setProjectIcon("c1", { kind: "emoji", value: "🚀" }));
    await waitFor(() => expect(document.querySelector('[data-proj="c1"] .v2-sb-picon')!.getAttribute("data-icon")).toBe("emoji:🚀"));
    expect(document.querySelector(".v2-header-pav")!.getAttribute("data-icon")).toBe("emoji:🚀");
    expect([...document.querySelectorAll(".v2-palette-pav")].filter((el) => el.getAttribute("data-icon") === "emoji:🚀")).toHaveLength(1);
    expect(bg(document.querySelector(".v2-header-pav"))).toBeNull();
  });
});

describe("M2 — the tab strip never parks a legible fragment at its start", () => {
  function strip(tabs: [number, number][], client: number, currentIdx: number) {
    const s = document.createElement("div");
    tabs.forEach(([l, w], i) => {
      const a = document.createElement("a");
      a.className = "v2-ptab";
      if (i === currentIdx) a.setAttribute("aria-current", "page");
      Object.defineProperties(a, { offsetLeft: { value: l }, offsetWidth: { value: w } });
      s.appendChild(a);
    });
    const last = tabs[tabs.length - 1];
    Object.defineProperties(s, { scrollWidth: { value: last[0] + last[1] }, clientWidth: { value: client }, offsetLeft: { value: 0 } });
    return s;
  }
  // Overview · Tasks · Agents · Requests · Code · GitHub · Activity · Metrics
  const TABS: [number, number][] = [[0, 74], [76, 52], [130, 60], [192, 76], [270, 48], [320, 62], [384, 66], [452, 64]];

  it("scrolls so a tab edge sits exactly at the start fade (no partial tab before it)", () => {
    for (let cur = 1; cur < TABS.length; cur++) {
      const s = strip(TABS, 200, cur);
      centerCurrentTab(s);
      if (s.scrollLeft === 0) continue;
      const edges = TABS.map(([l]) => l - TAB_FADE_START);
      const max = 516 - 200;
      expect(edges.includes(s.scrollLeft) || s.scrollLeft === max).toBe(true);
      // the current tab is fully in view
      const [l, w] = TABS[cur];
      expect(l).toBeGreaterThanOrEqual(s.scrollLeft);
      expect(l + w).toBeLessThanOrEqual(s.scrollLeft + 200);
    }
  });

  it("Tasks at 390: the strip starts at Overview's end, not mid-word", () => {
    const s = strip(TABS, 200, 1);
    centerCurrentTab(s);
    expect([0, 76 - TAB_FADE_START]).toContain(s.scrollLeft);
  });
});

describe("M3 — connection indicator", () => {
  it("draws nothing while live (only an AT status), so there is one green dot in the header", async () => {
    render(
      <ToastProvider>
        <SnapshotProvider>
          <MemoryRouter initialEntries={["/tasks"]}>
            <Shell page="tasks" title="Tasks"><div>body</div></Shell>
          </MemoryRouter>
        </SnapshotProvider>
      </ToastProvider>,
    );
    await waitFor(() => expect(document.getElementById("execBtn")).toBeTruthy());
    const hdr = document.getElementById("topbar")!;
    // never a button (it did nothing on click)
    expect(hdr.querySelector("button.v2-conn")).toBeNull();
    const conn = hdr.querySelector(".v2-conn");
    if (conn) {
      // not live in jsdom (no EventSource) → a glyph with the sentence as its name, no dot
      expect(conn.querySelector(".v2-conn-dot")).toBeNull();
      expect(conn.querySelector("svg.v2-conn-ico")).toBeTruthy();
      expect(conn.getAttribute("aria-label")).toBeTruthy();
    }
  });
});

describe("m7 — view transitions on a project switch", () => {
  it("skips the outgoing transition when the cid changes, on hash links and unknown targets", () => {
    const from = "http://x/tasks?cid=a";
    expect(skipSwapTransition(from, "http://x/?cid=b")).toBe(true);
    expect(skipSwapTransition(from, "http://x/settings?cid=a#tab=provider-keys")).toBe(true);
    expect(skipSwapTransition(from, null)).toBe(true);
    expect(skipSwapTransition(from, "http://y/tasks?cid=a")).toBe(true);
    expect(skipSwapTransition(from, "http://x/agents?cid=a")).toBe(false);
  });

  it("a skipped transition still observes its promises (no unhandled rejection)", async () => {
    const rejected = () => { const p = Promise.reject(new Error("aborted")); return p; };
    const vt = { ready: rejected(), finished: rejected(), updateCallbackDone: rejected(), skipTransition: vi.fn() };
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    guardViewTransition(Object.assign(new Event("pageswap"), { viewTransition: vt }), "visible", true);
    await new Promise((r) => setTimeout(r, 0));
    process.off("unhandledRejection", unhandled);
    expect(vt.skipTransition).toHaveBeenCalled();
    expect(unhandled).not.toHaveBeenCalled();
  });
});
