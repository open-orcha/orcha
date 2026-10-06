/**
 * V2 persistent project sidebar (docs/orcha-v2-architecture.md §8) mounted
 * through a real page (HomePage → Shell), against a stubbed backend.
 *
 * Back-compat kept from the pre-V2 rail: localStorage "orcha:sidebar"
 * ("collapsed" | "expanded") + <html data-sidebar="collapsed">.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui";
import { SnapshotProvider } from "../state/SnapshotProvider";
import { _resetProjectsForTests } from "../state/projects";
import { HomePage } from "../pages/home/HomePage";

const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

function rawSnapshot(extra: Record<string, unknown> = {}) {
  return {
    container: { id: "c1", name: "Website", status: "active", autonomy_level: "plan", wakes_enabled: true },
    agents: [
      { id: "h1", alias: "kedar", kind: "human", status: "idle" },
      { id: "a1", alias: "Atlas", kind: "ai", status: "idle", last_active: iso(60 * 60_000) },
      { id: "a2", alias: "Mira", kind: "ai", status: "working", last_active: iso(10_000), current_task: { task_id: "t2", title: "Ship login" } },
      { id: "a3", alias: "Nova", kind: "ai", status: "idle", last_active: iso(30_000) },
      { id: "a4", alias: "Orion", kind: "ai", status: "idle", last_active: iso(5 * 60_000) },
      { id: "a5", alias: "Pax", kind: "ai", status: "idle", last_active: iso(6 * 60_000) },
      { id: "a6", alias: "Quill", kind: "ai", status: "idle", last_active: iso(7 * 60_000) },
    ],
    tasks: [
      { id: "t1", title: "Verify me", status: "needs_verification", assignees: ["Atlas"] },
      { id: "t2", title: "Ship login", status: "in_progress", assignees: ["Mira"] },
    ],
    requests: [
      { id: "r1", type: "info", status: "open", requester_id: "a1", target_id: null, payload: "Which port?" },
      { id: "r2", type: "info", status: "escalated", requester_id: "a2", target_id: "a1", payload: "Stuck" },
    ],
    task_total: 2,
    request_total: 2,
    // authoritative OPEN-WORK totals — must NOT be read as attention (GAP-01)
    task_open_total: 40,
    request_open_total: 9,
    ...extra,
  };
}

const CONTAINERS = [
  { id: "c1", name: "Website", status: "active", needs_you: 2 },
  { id: "c2", name: "API service", status: "active", needs_you: 1 },
  { id: "c3", name: "Legacy", status: "archived" }, // needs_you missing → unavailable
];

function stubFetch(snapExtra: Record<string, unknown> = {}) {
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return json({ containers: CONTAINERS });
    if (url.startsWith("/api/containers/c1")) return json(rawSnapshot(snapExtra));
    return json({});
  }) as unknown as typeof fetch;
}

function mount() {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <HashRouter>
          <HomePage />
        </HashRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

// jsdom has no PointerEvent: without it fireEvent.pointer* drops clientX/pointerId
if (typeof window.PointerEvent === "undefined") {
  class PE extends MouseEvent {
    pointerId: number; pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType ?? "mouse"; }
  }
  (window as unknown as { PointerEvent: typeof PE }).PointerEvent = PE;
}

const sidebar = () => document.getElementById("sidebar") as HTMLElement;
const toggle = () => screen.getByRole("button", { name: /collapse sidebar|expand sidebar/i });

describe("V2 sidebar — collapse / resize prefs", () => {
  beforeEach(() => {
    localStorage.clear();
    _resetProjectsForTests();
    document.documentElement.removeAttribute("data-sidebar");
    document.documentElement.style.removeProperty("--v2-sidebar-w");
    document.documentElement.style.removeProperty("--v2-sidebar-user-w");
    stubFetch();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    document.documentElement.removeAttribute("data-sidebar");
  });

  it("defaults expanded: no attribute, collapse button present", async () => {
    mount();
    await waitFor(() => expect(toggle()).toBeInTheDocument());
    expect(document.documentElement.getAttribute("data-sidebar")).toBeNull();
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeInTheDocument();
  });

  it("collapse/expand persists the legacy key and <html data-sidebar>", async () => {
    mount();
    await waitFor(() => expect(toggle()).toBeInTheDocument());
    fireEvent.click(toggle());
    expect(document.documentElement.getAttribute("data-sidebar")).toBe("collapsed");
    expect(localStorage.getItem("orcha:sidebar")).toBe("collapsed");
    fireEvent.click(toggle());
    expect(document.documentElement.getAttribute("data-sidebar")).toBeNull();
    expect(localStorage.getItem("orcha:sidebar")).toBe("expanded");
  });

  it("restores the collapsed rail: icons + project avatars only, labeled, no section children (D1)", async () => {
    localStorage.setItem("orcha:sidebar", "collapsed");
    mount();
    await waitFor(() => expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument());
    // projects are avatar links with a full accessible name (name, status, count)
    const web = await within(sidebar()).findByRole("link", { name: /^Website, Active, 3 decisions waiting on you, current project$/ });
    // D14: the project icon (default neutral glyph, never initials)
    const icon = web.querySelector(".v2-sb-picon")!;
    expect(icon.getAttribute("data-icon")).toBe("default");
    expect(icon.textContent).toBe("");
    // the rail badge is a 6 px dot; the number lives in the name
    const dot = web.querySelector(".v2-picon-badge")!;
    expect(dot.textContent).toBe("");
    expect(dot.getAttribute("data-count")).toBe("3");
    // no per-project section links in the sidebar
    expect(within(sidebar()).queryByRole("link", { name: /^tasks$/i })).toBeNull();
    expect(sidebar().querySelector(".v2-sb-children")).toBeNull();
    // footer destinations keep an accessible name in the rail
    expect(within(sidebar()).getByRole("link", { name: "All projects" })).toHaveAttribute("href", "#/projects");
  });

  it("the collapsed rail is never overridden by the user's dragged width", async () => {
    localStorage.setItem("orcha:v2:sidebarWidth", "320");
    mount();
    const handle = await screen.findByRole("separator", { name: "Resize sidebar" });
    expect(handle).toHaveAttribute("aria-valuenow", "320");
    const st = document.documentElement.style;
    expect(st.getPropertyValue("--v2-sidebar-user-w")).toBe("320px");
    // the width the CSS rail rule has to beat is NOT set inline any more
    expect(st.getPropertyValue("--v2-sidebar-w")).toBe("");
    fireEvent.click(toggle());
    expect(document.documentElement.getAttribute("data-sidebar")).toBe("collapsed");
    expect(st.getPropertyValue("--v2-sidebar-w")).toBe("");
  });

  it("a pointer drag always ends (pointercancel) — no sidebar following the cursor afterwards", async () => {
    mount();
    const handle = await screen.findByRole("separator", { name: "Resize sidebar" });
    fireEvent.pointerDown(handle, { button: 0, clientX: 264, pointerId: 1 });
    expect(document.body.classList.contains("v2-resizing")).toBe(true);
    fireEvent.pointerMove(handle, { clientX: 300, pointerId: 1, buttons: 1 }); // 264 + 36
    expect(handle).toHaveAttribute("aria-valuenow", "300");
    fireEvent.pointerCancel(handle, { pointerId: 1 });
    expect(document.body.classList.contains("v2-resizing")).toBe(false);
    fireEvent.pointerMove(handle, { clientX: 340, pointerId: 1, buttons: 0 });
    expect(handle).toHaveAttribute("aria-valuenow", "300");
    expect(localStorage.getItem("orcha:v2:sidebarWidth")).toBe("300");
  });

  it("keyboard resize clamps to 200–360 px and persists orcha:v2:sidebarWidth", async () => {
    mount();
    const handle = await screen.findByRole("separator", { name: "Resize sidebar" });
    expect(handle).toHaveAttribute("aria-valuenow", "264"); // D14 default
    fireEvent.keyDown(handle, { key: "End" });
    expect(handle).toHaveAttribute("aria-valuenow", "360");
    expect(localStorage.getItem("orcha:v2:sidebarWidth")).toBe("360");
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    expect(handle).toHaveAttribute("aria-valuenow", "360"); // clamped
    fireEvent.keyDown(handle, { key: "Home" });
    expect(handle).toHaveAttribute("aria-valuenow", "200");
    expect(document.documentElement.style.getPropertyValue("--v2-sidebar-user-w")).toBe("200px");
  });
});

describe("V2 sidebar — Needs you, projects, live agents", () => {
  beforeEach(() => {
    localStorage.clear();
    _resetProjectsForTests();
    document.documentElement.removeAttribute("data-sidebar");
    stubFetch();
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("Needs you counts attention entities from the shared selector, not open-work totals", async () => {
    mount();
    // 1 verify + 1 open-to-human request + 1 escalated request = 3 (not 40 + 9)
    const needs = await within(sidebar()).findByRole("link", { name: /3 decisions waiting on you in Website/ });
    expect(needs.textContent).toContain("3");
    // /needs is D's page; until it exists the entry keeps the pre-V2 target (Overview queue)
    expect(needs.getAttribute("href")).toMatch(/^#\/(needs)?$/);
  });

  it("before the first snapshot the Needs you count is unknown (renders no number, never 0)", async () => {
    global.fetch = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch; // never resolves
    mount();
    const needs = await within(sidebar()).findByRole("link", { name: /Needs you — loading/ });
    expect(needs.querySelector(".v2-sb-needs-n")).toBeNull();
  });

  it("lists projects from /api/containers; other rows show the server's list measure, missing = unavailable", async () => {
    mount();
    await within(sidebar()).findByText("API service");
    const api = sidebar().querySelector('[data-proj="c2"]') as HTMLElement;
    expect(api.querySelector("a.v2-sb-proj-link")!.getAttribute("aria-label")).toMatch(/1 decision waiting on you/);
    const legacy = sidebar().querySelector('[data-proj="c3"]') as HTMLElement;
    expect(legacy.querySelector(".v2-sb-attn.is-unknown")).toBeTruthy();
    // switching is a full ?cid= navigation that drops entity params
    const link = api.querySelector("a.v2-sb-proj-link") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toContain("cid=c2");
  });

  it("D1: the sidebar never repeats project sections; the selected project row opens its Overview", async () => {
    mount();
    const sel = await waitFor(() => {
      const el = sidebar().querySelector('[data-proj="c1"]') as HTMLElement;
      expect(el).toBeTruthy();
      return el;
    });
    expect(within(sel).queryByRole("list", { name: /sections/ })).toBeNull();
    for (const label of ["Overview", "Tasks", "Agents", "Requests", "Code", "GitHub", "Activity", "Metrics"]) {
      expect(within(sidebar()).queryByRole("link", { name: new RegExp("^" + label + "\\b") })).toBeNull();
    }
    const link = sel.querySelector("a.v2-sb-proj-link") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("#/");
    expect(link.getAttribute("aria-label")).toBe("Website, Active, 3 decisions waiting on you, current project");
    expect(link.getAttribute("aria-current")).toBe("page"); // on Overview
    // the other rows: one link each → that project's Overview (full ?cid= switch)
    const api = sidebar().querySelector('[data-proj="c2"] a.v2-sb-proj-link') as HTMLAnchorElement;
    await waitFor(() => expect(api.getAttribute("aria-label")).toMatch(/^API service, Active, 1 decision waiting on you/));
    expect(api.getAttribute("href")).toMatch(/^\/\?cid=c2$/);
  });

  it("counts are capped at 99+ and a missing measure renders no bare dash", async () => {
    const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/containers") return json({ containers: [...CONTAINERS, { id: "c9", name: "Support", status: "active", needs_you: 128 }] });
      if (url.startsWith("/api/containers/c1")) return json(rawSnapshot());
      return json({});
    }) as unknown as typeof fetch;
    mount();
    await within(sidebar()).findByText("Support");
    const sup = sidebar().querySelector('[data-proj="c9"]') as HTMLElement;
    expect(sup.querySelector(".v2-sb-attn")!.textContent).toBe("99+");
    expect(sup.querySelector("a")!.getAttribute("aria-label")).toMatch(/128 decisions waiting on you/);
    const legacy = sidebar().querySelector('[data-proj="c3"]') as HTMLElement;
    expect(legacy.querySelector(".v2-sb-attn")!.textContent).toBe("");
  });

  it("Needs you is the current row (aria-current=page) on /needs", async () => {
    window.location.hash = "#/needs";
    mount();
    const needs = await within(sidebar()).findByRole("link", { name: /decisions waiting on you in Website/ });
    await waitFor(() => expect(needs.getAttribute("aria-current")).toBe("page"));
    expect(needs.className).toContain("is-current");
    window.location.hash = "";
  });

  it("D11 live agents under the project: only working / review / trouble agents, capped at 3 with +N more", async () => {
    mount();
    const live = await within(sidebar()).findByRole("list", { name: /^Live agents in / });
    const rows = within(live).getAllByRole("link");
    // Mira works; Nova/Orion/Pax/Quill are idle → hidden (never an idle roster)
    expect(rows.map((r) => r.querySelector(".v2-sb-agent-name")?.textContent)).toEqual(["Mira"]);
    expect(rows[0].getAttribute("href")).toBe("#/agents?agent=Mira&tab=conversation");
    expect(rows[0].textContent).toContain("Ship login");
    expect(within(live).queryByText(/more$/)).toBeNull();
  });

  it("pin + move are local-only and reorder the list", async () => {
    mount();
    await within(sidebar()).findByText("Legacy");
    const order = () => Array.from(sidebar().querySelectorAll(".v2-sb-proj")).map((li) => li.getAttribute("data-proj"));
    expect(order()).toEqual(["c1", "c2", "c3"]);
    fireEvent.click(within(sidebar()).getByRole("button", { name: "Legacy actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Add to favorites/ }));
    await waitFor(() => expect(order()).toEqual(["c3", "c1", "c2"]));
    expect(JSON.parse(localStorage.getItem("orcha:v2:pinnedProjects")!)).toEqual(["c3"]);
    fireEvent.click(within(sidebar()).getByRole("button", { name: "API service actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Move up/ }));
    await waitFor(() => expect(order()).toEqual(["c3", "c2", "c1"]));
    // no backend write for pin/order
    const writes = (global.fetch as unknown as { mock: { calls: [RequestInfo, RequestInit?][] } }).mock.calls.filter(([, init]) => init && init.method && init.method !== "GET");
    expect(writes).toEqual([]);
  });

  it("project list failure shows a retry and still lists the current project", async () => {
    const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
    // ?cid= in the URL: scope resolves without the list, so the ONLY
    // /api/containers call is the sidebar's own — and it fails.
    window.history.replaceState(null, "", "/?cid=c1");
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/containers") return { ok: false, status: 503, json: async () => ({}) } as unknown as Response;
      if (url.startsWith("/api/containers/c1")) return json(rawSnapshot());
      return json({});
    }) as unknown as typeof fetch;
    mount();
    await within(sidebar()).findByText(/Project list unavailable/);
    expect(await within(sidebar()).findByText("Website")).toBeInTheDocument();
    expect(within(sidebar()).getByRole("button", { name: "Retry" })).toBeInTheDocument();
    window.history.replaceState(null, "", "/");
  });
});
