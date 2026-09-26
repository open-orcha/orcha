/**
 * ProjectSwitcher — the topbar dropdown port of the vanilla shell's project
 * switcher (app-shell.js @3046062; behavior pinned by the old
 * tests/portal/project_switcher.test.js): trigger names the CURRENT project,
 * menu rows come FRESH from GET /api/containers, the current row is marked and
 * a no-op, picking another is a full /?cid= navigation, "All projects" links
 * the hub, "New project" opens the shared house modal, and the switcher
 * renders on single-project stacks too (vanilla had no multi gate).
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { ProjectSwitcher } from "./ProjectSwitcher";

const CONTAINERS = [
  { id: "c1", name: "Website revamp", status: "active", agents: 3, needs_you: 2 },
  { id: "c2", name: "api-gateway", status: "active", agents: 1, needs_you: 0 },
  { id: "c3", name: "old-thing", status: "completed" },
];

const rawSnap = {
  container: { id: "c1", name: "Website revamp", status: "active", autonomy_level: "plan" },
  agents: [],
  tasks: [],
  requests: [],
};

function stubFetch(containers: unknown[] = CONTAINERS, opts?: { listFails?: boolean }) {
  const calls: string[] = [];
  const json = (data: unknown) =>
    ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url === "/api/containers") {
      // the switcher's own list fetch may be told to fail while the provider's
      // boot resolve (first call) succeeds
      if (opts?.listFails && calls.filter((u) => u === "/api/containers").length > 1) {
        return { ok: false, status: 500, json: async () => ({}) } as unknown as Response;
      }
      return json({ containers });
    }
    if (url.startsWith("/api/containers/")) return json(rawSnap);
    return json({});
  }) as unknown as typeof fetch;
  return calls;
}

function mount() {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <ProjectSwitcher />
      </SnapshotProvider>
    </ToastProvider>,
  );
}

async function openMenu() {
  const btn = (await screen.findByTitle(/switch project/)) as HTMLButtonElement;
  // wait for the snapshot so the trigger names the current project first
  await waitFor(() => expect(btn.title).toContain("Website revamp"));
  fireEvent.click(btn);
  return btn;
}

describe("ProjectSwitcher (vanilla app-shell switcher, topbar port)", () => {
  beforeEach(() => {
    localStorage.clear();
    // earlier mounts pin ?cid= into the jsdom URL (ensureCidInLocation);
    // reset so every test's provider boot resolves the cid from the list.
    history.replaceState(null, "", "/");
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("trigger names the CURRENT project with the status dot lit when active", async () => {
    stubFetch();
    mount();
    const btn = (await screen.findByTitle(/switch project/)) as HTMLButtonElement;
    await waitFor(() => expect(btn.title).toBe("Project: Website revamp — switch project"));
    expect(btn.querySelector(".pname")?.textContent).toBe("Website revamp");
    expect(btn.querySelector(".pdot")?.className).toContain("on");
    expect(btn.getAttribute("aria-haspopup")).toBe("true");
  });

  it("open → rows come FRESH from GET /api/containers; current marked with the check", async () => {
    const calls = stubFetch();
    mount();
    const before = calls.filter((u) => u === "/api/containers").length;
    await openMenu();
    await screen.findByText("api-gateway");
    // a second, fresh list fetch on open (the provider's boot resolve aside)
    expect(calls.filter((u) => u === "/api/containers").length).toBe(before + 1);
    const menu = document.getElementById("psFloat")!;
    const rows = Array.from(menu.querySelectorAll("[data-proj]"));
    expect(rows.map((r) => r.getAttribute("data-proj"))).toEqual(["c1", "c2", "c3"]);
    expect(rows[0].className).toContain(" on");    // current highlighted
    expect(rows[1].className).not.toContain(" on");
    expect(menu.querySelectorAll(".chk").length).toBe(1); // exactly one check
    // sub-label: status + live-agent count (singular/plural); status alone when absent
    expect(screen.getByText("active · 3 agents")).toBeInTheDocument();
    expect(screen.getByText("active · 1 agent")).toBeInTheDocument();
    expect(screen.getByText("completed")).toBeInTheDocument();
    // needs_you badge only where the API reports it
    expect(menu.querySelectorAll(".needs").length).toBe(1);
  });

  it("picking a project is a full ?cid= navigation; the current row is a no-op", async () => {
    stubFetch();
    mount();
    await openMenu();
    await screen.findByText("api-gateway");
    const menu = document.getElementById("psFloat")!;
    const rows = Array.from(menu.querySelectorAll("[data-proj]")) as HTMLAnchorElement[];
    // full href navigation — that IS project switching (hub Open parity)
    expect(rows.map((r) => r.getAttribute("href"))).toEqual(["/?cid=c1", "/?cid=c2", "/?cid=c3"]);
    // the CURRENT row prevents navigation but still closes the menu
    const ev = fireEvent.click(rows[0]);
    expect(ev).toBe(false); // defaultPrevented
    await waitFor(() => expect(document.getElementById("psFloat")).toBeNull());
  });

  it("'All projects' links the /projects hub", async () => {
    stubFetch();
    mount();
    await openMenu();
    await screen.findByText("All projects");
    const all = screen.getByText("All projects").closest("a")!;
    expect(all.getAttribute("href")).toBe("/projects");
  });

  it("'New project' closes the menu and opens the shared house modal", async () => {
    stubFetch();
    mount();
    await openMenu();
    fireEvent.click(await screen.findByText("New project"));
    expect(document.getElementById("psFloat")).toBeNull();
    expect(await screen.findByText("New project", { selector: "h3" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("e.g. api-gateway")).toBeInTheDocument();
  });

  it("still renders on a single-project stack (vanilla rule: no multi gate)", async () => {
    stubFetch([CONTAINERS[0]]);
    mount();
    const btn = await openMenu();
    expect(btn).toBeInTheDocument();
    await screen.findByText("All projects");
    const menu = document.getElementById("psFloat")!;
    expect(menu.querySelectorAll("[data-proj]").length).toBe(1);
  });

  it("Escape and outside-click close the menu", async () => {
    stubFetch();
    mount();
    await openMenu();
    await screen.findByText("api-gateway");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(document.getElementById("psFloat")).toBeNull());
    await openMenu();
    await screen.findByText("api-gateway");
    fireEvent.click(document.body);
    await waitFor(() => expect(document.getElementById("psFloat")).toBeNull());
  });

  it("a failed list fetch closes the menu and toasts danger", async () => {
    stubFetch(CONTAINERS, { listFails: true });
    mount();
    await openMenu();
    await waitFor(() => expect(document.getElementById("psFloat")).toBeNull());
    expect(await screen.findByText(/Could not load projects/)).toBeInTheDocument();
  });
});
