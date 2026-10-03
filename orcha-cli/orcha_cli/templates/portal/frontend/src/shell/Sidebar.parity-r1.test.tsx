/**
 * Parity round 1 — sidebar fixes (compare-r1 + wave-4 review):
 *  · e2e-permissions-7 / SG-09: "Change icon…" is disabled, with the reason, for
 *    a viewer / a member without manage_autonomy (current project from the live
 *    identity, another project from its own /api/me); owners keep it.
 *  · IF-RAIL-COLLAPSE: the rail toggle mirrors into the server prefs bag, and a
 *    server bag applied after mount never leaves the toggle out of sync.
 *  · SH-077 / SH-123 / not-found: a membership 403, an unknown project (404) or
 *    zero projects is not "identity unknown (offline)"; no phantom
 *    "Project unavailable" row for a cid the loaded list doesn't contain.
 *  · D14 tree: another project probes its primary checkout on hover and shows a
 *    caret (closed by default) instead of never having a tree.
 *  · D13: the footer's acting human takes the roster palette slot.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui";
import { SnapshotProvider } from "../state/SnapshotProvider";
import { _resetProjectsForTests } from "../state/projects";
import { HomePage } from "../pages/home/HomePage";
import * as prefs from "../cloud/projects/prefs";
import { extensions, type Identity } from "../extensions";
import { _resetTreeCachesForTests, noSnapReason } from "./Sidebar";
import { sidebarProjectRows, agentPaletteSlots } from "./nav";
import { actorKey, paletteColor } from "../components/primitives/Avatar";
import type { Snapshot } from "../types";

const AGENTS = [
  { id: "h1", alias: "kedar", kind: "human", status: "idle", member_role: "owner" },
  { id: "a1", alias: "mira", kind: "ai", status: "working", current_task: { task_id: "t1", title: "Ship login" } },
];
function snapshot() {
  return {
    container: { id: "c1", name: "Website", status: "active", autonomy_level: "plan", wakes_enabled: true, last_wake_scan_at: new Date().toISOString() },
    agents: AGENTS, tasks: [], requests: [], task_total: 0, request_total: 0,
  };
}
const CONTAINERS = [
  { id: "c1", name: "Website", status: "active", needs_you: 0 },
  { id: "c2", name: "API service", status: "active", needs_you: 0, github_repo: "acme/api" },
];

let calls: { url: string; method: string; body?: string }[] = [];
type Opts = { snapStatus?: number; containers?: typeof CONTAINERS; meC2?: unknown; prefs?: Record<string, string> | null; c2Branch?: boolean };
function stub(o: Opts = {}) {
  const json = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
  calls = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method || "GET", body: init?.body as string | undefined });
    if (url === "/api/containers") return json({ containers: o.containers ?? CONTAINERS });
    if (url === "/api/prefs") return json({ prefs: o.prefs === undefined ? null : o.prefs });
    if (url === "/api/me?cid=c2") return json(o.meC2 ?? { identity: null, trusted: false });
    if (url === "/api/containers/c2/code/worktree/branch") return json(o.c2Branch ? { available: true, branch: "develop", remote: "git@github.com:acme/api.git" } : { available: false });
    if (url.startsWith("/api/containers/c2/github/pulls")) return json({ pulls: [] });
    if (url.startsWith("/api/containers/c1/code/") || url.startsWith("/api/agents/")) return json({ available: false, runs: [] });
    if (url.startsWith("/api/containers/c1")) return o.snapStatus ? json({ detail: "not a member of this project" }, o.snapStatus) : json(snapshot());
    return json({});
  }) as unknown as typeof fetch;
}
const mount = () => render(<ToastProvider><SnapshotProvider><HashRouter><HomePage /></HashRouter></SnapshotProvider></ToastProvider>);
const sidebar = () => document.getElementById("sidebar") as HTMLElement;
const savedIdentity = extensions.identity;
const savedTrusted = extensions.identityTrusted;

beforeEach(() => {
  localStorage.clear();
  _resetProjectsForTests();
  _resetTreeCachesForTests();
  prefs._resetForTests();
  document.documentElement.removeAttribute("data-sidebar");
  window.history.replaceState(null, "", "/"); // a scoped ?cid= from an earlier case must not leak
  window.location.hash = "";
});
afterEach(() => {
  cleanup();
  extensions.identity = savedIdentity;
  extensions.identityTrusted = savedTrusted;
  vi.restoreAllMocks();
});

async function openMenu(name: string) {
  fireEvent.click(await within(sidebar()).findByRole("button", { name: `${name} actions` }));
  return screen.findByRole("menuitem", { name: /Change icon/ });
}

describe("Change icon… is gated like PUT /icon (owner / manage_autonomy)", () => {
  it("viewer on the current project: disabled with the reason, the picker never opens", async () => {
    extensions.identity = async () => ({ agent_id: "h1", alias: "kedar", member_role: "viewer" }) as Identity;
    extensions.identityTrusted = () => true;
    stub();
    mount();
    await within(sidebar()).findByText(/view-only/);
    const item = await openMenu("Website");
    await waitFor(() => expect(item.getAttribute("aria-disabled")).toBe("true"));
    expect(item.getAttribute("title")).toMatch(/viewer/i);
    fireEvent.click(item);
    expect(screen.queryByRole("dialog", { name: /Change icon/ })).toBeNull();
  });

  it("member without manage_autonomy: disabled; owner: enabled", async () => {
    extensions.identity = async () => ({ agent_id: "h1", alias: "kedar", member_role: "member", grants: ["manage_keys"] }) as Identity;
    extensions.identityTrusted = () => true;
    stub();
    mount();
    await within(sidebar()).findByText("kedar");
    const item = await openMenu("Website");
    await waitFor(() => expect(item.getAttribute("aria-disabled")).toBe("true"));
    expect(item.getAttribute("title")).toMatch(/Autonomy permission/);
    cleanup();

    extensions.identity = async () => ({ agent_id: "h1", alias: "kedar", member_role: "owner" }) as Identity;
    stub();
    mount();
    await within(sidebar()).findByText("kedar");
    const ok = await openMenu("Website");
    expect(ok.getAttribute("aria-disabled")).toBeNull();
  });

  it("another project asks ITS /api/me: a viewer there gets the item disabled", async () => {
    stub({ meC2: { identity: { agent_id: "x", alias: "kedar", member_role: "viewer" }, trusted: true } });
    mount();
    const item = await openMenu("API service");
    await waitFor(() => expect(item.getAttribute("aria-disabled")).toBe("true"));
    expect(calls.some((c) => c.url === "/api/me?cid=c2")).toBe(true);
  });
});

describe("rail collapse persists for signed-in users (IF-RAIL-COLLAPSE)", () => {
  it("toggling mirrors the choice into PUT /api/prefs", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      stub({ prefs: { sidebar: "expanded" } });
      await prefs.sync();
      mount();
      const btn = await within(sidebar()).findByRole("button", { name: "Collapse sidebar" });
      act(() => { fireEvent.click(btn); });
      expect(document.documentElement.getAttribute("data-sidebar")).toBe("collapsed");
      await act(async () => { vi.advanceTimersByTime(1000); });
      const put = calls.find((c) => c.url === "/api/prefs" && c.method === "PUT");
      expect(put).toBeTruthy();
      expect(JSON.parse(put!.body!).prefs.sidebar).toBe("collapsed");
    } finally { vi.useRealTimers(); }
  });

  it("a server bag applied after mount re-syncs the toggle with <html data-sidebar>", async () => {
    localStorage.setItem("orcha:sidebar", "collapsed");
    stub({ prefs: { sidebar: "expanded" } });
    mount();
    await within(sidebar()).findByRole("button", { name: "Expand sidebar" });
    await act(async () => { await prefs.sync(); });
    expect(document.documentElement.hasAttribute("data-sidebar")).toBe(false);
    const btn = await within(sidebar()).findByRole("button", { name: "Collapse sidebar" });
    expect(btn.getAttribute("aria-expanded")).toBe("true");
  });

  it("self-host (no server prefs): no PUT is ever sent", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      stub({ prefs: null });
      await prefs.sync();
      mount();
      act(() => { fireEvent.click(within(sidebar()).getByRole("button", { name: "Collapse sidebar" })); });
      await act(async () => { vi.advanceTimersByTime(1000); });
      expect(calls.some((c) => c.url === "/api/prefs" && c.method === "PUT")).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});

describe("no snapshot ≠ offline (SH-077 / SH-123 / not found)", () => {
  it("noSnapReason tells a 403 / 404 / zero projects apart from an outage", () => {
    const base = { snap: null, cid: "c1", connection: "offline", identityTrusted: false, hasIdentity: false };
    expect(noSnapReason({ ...base, error: "/api/containers/c1 → 403: not a member" })).toBe("not-member");
    expect(noSnapReason({ ...base, error: "/api/containers/c1 → 404" })).toBe("not-found");
    expect(noSnapReason({ ...base, cid: null, error: "no container found" })).toBe("no-project");
    expect(noSnapReason({ ...base, error: "Failed to fetch" })).toBe("offline");
    expect(noSnapReason({ ...base, error: "/api/containers/c1 → 502" })).toBe("offline");
    expect(noSnapReason({ ...base, error: null, identityTrusted: true, connection: "polling" })).toBe("not-member");
    expect(noSnapReason({ ...base, snap: {}, error: "x → 403" })).toBeNull();
    expect(noSnapReason({ ...base, cid: null, error: null })).toBeNull(); // still resolving
  });

  it("a signed-in non-member (snapshot 403): the footer says so, never 'offline', and no phantom row", async () => {
    stub({ snapStatus: 403, containers: [CONTAINERS[1]] });
    window.history.replaceState(null, "", "/?cid=c1");
    mount();
    await within(sidebar()).findByText("not a member");
    expect(within(sidebar()).queryByText(/offline/)).toBeNull();
    await within(sidebar()).findByRole("link", { name: /^API service,/ });
    expect(sidebar().querySelector('[data-proj="c1"]')).toBeNull();
    expect(within(sidebar()).queryByText("Project unavailable")).toBeNull();
  });

  it("zero projects (e.g. a signed-in non-member on /projects): 'no project open' + an empty-list note, never 'offline'", async () => {
    stub({ containers: [] });
    mount();
    await within(sidebar()).findByText("no project open");
    expect(within(sidebar()).getByText("No projects you're a member of")).toBeTruthy();
    expect(within(sidebar()).queryByText(/offline/)).toBeNull();
  });

  it("sidebarProjectRows: an unknown cid is only prepended when the snapshot proved it exists", () => {
    const list = [{ id: "c2", name: "API service" }];
    expect(sidebarProjectRows(list, "c1").map((r) => r.id)).toEqual(["c2"]);
    expect(sidebarProjectRows(list, "c1", "Website").map((r) => r.id)).toEqual(["c1", "c2"]);
    expect(sidebarProjectRows(null, "c1").map((r) => r.id)).toEqual(["c1"]); // list not loaded yet
  });
});

describe("D14: other projects get their tree too", () => {
  it("hovering another project probes its primary checkout; the caret appears, closed by default", async () => {
    stub({ c2Branch: true });
    mount();
    const link = await within(sidebar()).findByRole("link", { name: /^API service,/ });
    const li = link.closest("li")!;
    expect(calls.some((c) => c.url === "/api/containers/c2/code/worktree/branch")).toBe(false); // no background fan-out
    fireEvent.pointerEnter(li);
    const caret = await within(li as HTMLElement).findByRole("button", { name: "Show branches in API service" });
    expect(caret.getAttribute("aria-expanded")).toBe("false");
    expect(within(sidebar()).queryByRole("list", { name: "Branches in API service" })).toBeNull();
    act(() => { fireEvent.click(caret); });
    const tree = await within(sidebar()).findByRole("list", { name: "Branches in API service" });
    expect(tree.querySelector(".v2-sb-br-name")!.textContent).toBe("develop");
    expect(tree.querySelector(".v2-sb-br-repo")).toBeNull(); // = the project's own repo
  });
});

describe("D13: the footer's acting human uses the roster palette slot", () => {
  it("the avatar colour equals the Agents board slot for that alias", async () => {
    stub();
    mount();
    await within(sidebar()).findByText("kedar");
    const slot = agentPaletteSlots(snapshot() as unknown as Snapshot).get(actorKey("kedar"))!;
    const av = sidebar().querySelector(".v2-sb-acct .v2-av") as HTMLElement;
    const d = document.createElement("div");
    // shorthand: the tone is var()-driven, so the longhand reads "" until substitution
    d.style.background = paletteColor(slot).background;
    expect(av.style.background).toBe(d.style.background);
  });
});

describe("pairing from the project ⋯ menu moves focus into the dialog", () => {
  it("focus lands on the dialog's Close; closing returns it to the ⋯ button", async () => {
    stub();
    mount();
    const more = await within(sidebar()).findByRole("button", { name: "API service actions" });
    fireEvent.click(more);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Pair phone/ }));
    const dlg = await screen.findByRole("dialog", { name: "Pair your phone" });
    await waitFor(() => expect(dlg.contains(document.activeElement)).toBe(true));
    fireEvent.click(within(dlg).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.activeElement).toBe(more));
  });
});
