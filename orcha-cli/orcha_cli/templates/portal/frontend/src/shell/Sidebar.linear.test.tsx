/**
 * Linear sidebar (D1/D5/D7): workspace switcher, circular Search/Compose,
 * Favorites (local pins), collapsible sections, "[" rail toggle, compact
 * live agents with round avatars, Tooltip shortcut keycaps.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui";
import { Tooltip } from "../components/primitives/Tooltip";
import { SnapshotProvider } from "../state/SnapshotProvider";
import { _resetProjectsForTests } from "../state/projects";
import { HomePage } from "../pages/home/HomePage";
import { SB_SECTIONS_KEY } from "./Sidebar";

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

function snapshot(agents?: unknown[]) {
  return {
    // a fresh wake scan: a host runtime serves the project (presence would otherwise read "No runtime")
    container: { id: "c1", name: "Website", status: "active", autonomy_level: "plan", wakes_enabled: true, last_wake_scan_at: new Date().toISOString() },
    agents: agents ?? [
      { id: "h1", alias: "kedar", kind: "human", status: "idle" },
      { id: "a2", alias: "Mira", kind: "ai", status: "working", last_active: iso(10_000), current_task: { task_id: "t2", title: "Ship login" } },
      { id: "a3", alias: "Nova", kind: "ai", status: "idle", last_active: iso(5 * 60_000) },
    ],
    tasks: [{ id: "t2", title: "Ship login", status: "in_progress", assignees: ["Mira"] }],
    requests: [],
    task_total: 1, request_total: 0,
  };
}
const CONTAINERS = [
  { id: "c1", name: "Website", status: "active", needs_you: 0 },
  { id: "c2", name: "API service", status: "active", needs_you: 1 },
  { id: "c3", name: "Legacy", status: "archived", needs_you: 0 },
];
function stub(snap = snapshot()) {
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return json({ containers: CONTAINERS });
    if (url.startsWith("/api/containers/c1")) return json(snap);
    return json({});
  }) as unknown as typeof fetch;
}
const mount = () => render(<ToastProvider><SnapshotProvider><HashRouter><HomePage /></HashRouter></SnapshotProvider></ToastProvider>);
const sidebar = () => document.getElementById("sidebar") as HTMLElement;

beforeEach(() => {
  localStorage.clear();
  _resetProjectsForTests();
  document.documentElement.removeAttribute("data-sidebar");
  window.location.hash = "";
  stub();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); document.documentElement.removeAttribute("data-sidebar"); window.location.hash = ""; });

describe("Linear sidebar — top row", () => {
  it("workspace switcher menu carries the acting identity, All projects, New project, Settings, Help and the rail toggle", async () => {
    mount();
    const sw = await within(sidebar()).findByRole("button", { name: "Embodent workspace menu" });
    fireEvent.click(sw);
    const menu = await screen.findByRole("menu", { name: "Embodent workspace" });
    const labels = within(menu).getAllByRole("menuitem").map((m) => m.textContent);
    for (const l of ["All projects", "New project…", "Settings", "Help & docs", "Collapse sidebar"]) {
      expect(labels.some((t) => t?.includes(l)), l).toBe(true);
    }
    // identity line is informational (disabled), never an action
    const who = within(menu).getAllByRole("menuitem")[0];
    expect(who.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Collapse sidebar/ }));
    expect(document.documentElement.getAttribute("data-sidebar")).toBe("collapsed");
  });

  it("Search is a circular button that opens the palette; Compose is New task, or disabled with the reason", async () => {
    mount();
    const search = await within(sidebar()).findByRole("button", { name: "Search" });
    expect(search.classList.contains("v2-sb-circle")).toBe(true);
    const compose = await within(sidebar()).findByRole("button", { name: /^New task/ });
    expect(compose.classList.contains("v2-sb-circle")).toBe(true);
    await waitFor(() => expect(compose.getAttribute("aria-label")).not.toMatch(/Resolving/));
    if (compose.getAttribute("aria-disabled") === "true") {
      // blocked: the label says why, and clicking does nothing
      expect(compose.getAttribute("aria-label")).toMatch(/^New task — .+/);
      fireEvent.click(compose);
      expect(window.location.hash).not.toContain("new=1");
    } else {
      expect(compose.getAttribute("aria-label")).toBe("New task in Website");
      fireEvent.click(compose);
      // the Shell composer opens over the current route (no navigation to /tasks)
      expect(await screen.findByRole("dialog", {}, { timeout: 5000 })).toBeInTheDocument();
      expect(window.location.hash).not.toContain("new=1");
    }
  });

  it("Compose never impersonates: no human on the project → disabled with a reason", async () => {
    stub(snapshot([{ id: "a2", alias: "Mira", kind: "ai", status: "idle" }]));
    mount();
    const compose = await within(sidebar()).findByRole("button", { name: /^New task/ });
    await waitFor(() => expect(compose.getAttribute("aria-disabled")).toBe("true"));
    expect(compose.getAttribute("aria-label")).toMatch(/^New task — /);
    fireEvent.click(compose);
    expect(window.location.hash).not.toContain("new=1");
  });
});

describe("Linear sidebar — sections", () => {
  it("pinned projects move into Favorites (listed once), and unpinning moves them back", async () => {
    localStorage.setItem("orcha:v2:pinnedProjects", JSON.stringify(["c3"]));
    mount();
    const fav = await within(sidebar()).findByRole("list", { name: "Favorite projects" });
    expect(within(fav).getByText("Legacy")).toBeInTheDocument();
    const projects = within(sidebar()).getByRole("list", { name: "Projects" });
    expect(within(projects).queryByText("Legacy")).toBeNull();
    expect(sidebar().querySelectorAll('[data-proj="c3"]')).toHaveLength(1);
    fireEvent.click(within(sidebar()).getByRole("button", { name: "Legacy actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Remove from favorites/ }));
    await waitFor(() => expect(within(sidebar()).queryByRole("list", { name: "Favorite projects" })).toBeNull());
    expect(within(within(sidebar()).getByRole("list", { name: "Projects" })).getByText("Legacy")).toBeInTheDocument();
  });

  it("section headers collapse their rows and remember it", async () => {
    mount();
    await within(sidebar()).findByText("API service");
    const head = within(sidebar()).getByRole("button", { name: "Projects" });
    expect(head).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(head);
    expect(head).toHaveAttribute("aria-expanded", "false");
    expect(within(sidebar()).queryByRole("list", { name: "Projects" })).toBeNull();
    expect(JSON.parse(localStorage.getItem(SB_SECTIONS_KEY)!)).toEqual({ projects: true });
    // New project stays reachable while the section is collapsed
    expect(within(sidebar()).getByRole("button", { name: "New project" })).toBeInTheDocument();
  });

  it("D11: live agents nest under their project row — status glyph + 16px round avatar, one fragment, idle agents hidden", async () => {
    mount();
    const live = await within(sidebar()).findByRole("list", { name: /^Live agents in / });
    // nested inside the selected project's <li>, not a standalone section
    expect(live.closest(".v2-sb-proj")?.getAttribute("data-proj")).toBe("c1");
    expect(within(sidebar()).queryByRole("button", { name: "Live agents" })).toBeNull();
    const links = within(live).getAllByRole("link");
    expect(links).toHaveLength(1); // Nova is idle → not shown
    const [mira] = links;
    expect(mira.getAttribute("aria-label")).toMatch(/^Mira, Working, Ship login/);
    const av = mira.querySelector(".v2-av") as HTMLElement;
    expect(av.className).toContain("v2-av-16");
    expect(av.getAttribute("aria-hidden")).toBe("true"); // name printed next to it
    // D14: the status is the D8 glyph before the avatar (not repeated as an avatar badge)
    expect(mira.querySelector(".v2-sb-agent-glyph")).toBeTruthy();
    expect(mira.querySelector(".v2-av-badge")).toBeNull();
    expect(mira.querySelector(".v2-sb-agent-task")!.textContent).toBe("Ship login");
  });

  it("D11: the project's agent disclosure collapses and is remembered", async () => {
    mount();
    await within(sidebar()).findByRole("list", { name: /^Live agents in / });
    const caret = within(sidebar()).getByRole("button", { name: /^Hide live agents in / });
    expect(caret).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(caret);
    expect(within(sidebar()).queryByRole("list", { name: /^Live agents in / })).toBeNull();
    expect(JSON.parse(localStorage.getItem("orcha:v2:sbProjAgents")!)).toEqual({ c1: true });
  });
});

describe("Linear sidebar — rail", () => {
  it("'[' toggles the rail, but never while typing", async () => {
    mount();
    await within(sidebar()).findByRole("button", { name: "Collapse sidebar" });
    fireEvent.keyDown(document.body, { key: "[" });
    expect(document.documentElement.getAttribute("data-sidebar")).toBe("collapsed");
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "[" });
    expect(document.documentElement.getAttribute("data-sidebar")).toBe("collapsed");
    input.remove();
    fireEvent.keyDown(document.body, { key: "[" });
    expect(document.documentElement.getAttribute("data-sidebar")).toBeNull();
  });

  it("the rail keeps Search, Compose, Needs you and project icons (D14, never initials)", async () => {
    localStorage.setItem("orcha:sidebar", "collapsed");
    mount();
    await within(sidebar()).findByRole("button", { name: "Expand sidebar" });
    expect(within(sidebar()).getByRole("button", { name: "Search" })).toBeInTheDocument();
    expect(within(sidebar()).getByRole("button", { name: /^New task/ })).toBeInTheDocument();
    const api = await waitFor(() => {
      const el = sidebar().querySelector('[data-proj="c2"] .v2-sb-picon') as HTMLElement;
      expect(el).toBeTruthy();
      return el;
    });
    expect(api.getAttribute("data-icon")).toBe("default");
    expect(api.textContent).not.toMatch(/^AS/);
    expect(sidebar().querySelector(".v2-sb-proj-name")).toBeNull();
  });
});

describe("Tooltip shortcut", () => {
  it("renders the keycap after the label and announces it", () => {
    render(<Tooltip label="Search" shortcut="⌘K" delay={0}><button type="button">S</button></Tooltip>);
    act(() => { screen.getByRole("button", { name: "S" }).focus(); });
    const tip = screen.getByRole("tooltip");
    expect(tip.querySelector("kbd")!.textContent).toBe("⌘K");
    expect(tip.textContent).toBe("Search, shortcut ⌘K");
  });
});
