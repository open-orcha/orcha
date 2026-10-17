/**
 * Sidebar polish round 2 (linear-review-r2):
 *  - D13: nested agent avatars take the Agents board's palette slots (all
 *    agents, snapshot order) and project avatars the one shared project
 *    palette (shell/nav.ts) — identical and unique across surfaces;
 *  - presence parity: the nested agent label is agents/presence.ts's label,
 *    never a raw status the workspace header would contradict.
 */
import { cleanup, render, within } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui";
import { SnapshotProvider } from "../state/SnapshotProvider";
import { _resetProjectsForTests } from "../state/projects";
import { HomePage } from "../pages/home/HomePage";
import { actorKey, assignPalette, paletteColor, projectAvatarKey } from "../components/primitives/Avatar";
import { agentPresence } from "../pages/agents/presence";
import { agentPaletteSlots, projectPaletteSlots, sidebarProjectRows } from "./nav";
import type { Agent, Snapshot } from "../types";

const now = Date.now();
const iso = (ms: number) => new Date(now - ms).toISOString();
const AGENTS = [
  { id: "h1", alias: "kedar", kind: "human", status: "idle" },
  { id: "a0", alias: "docs-writer", kind: "ai", status: "idle" },
  { id: "a1", alias: "mira", kind: "ai", status: "working", last_active: iso(6_000), current_task: { task_id: "t2", title: "Ship login" } },
  { id: "a2", alias: "nova", kind: "ai", status: "blocked", last_active: iso(9_000) },
  { id: "a3", alias: "reviewer", kind: "ai", status: "awaiting_human", last_active: iso(12_000) },
];
function snapshot(scan: string | null = new Date().toISOString()) {
  return {
    container: { id: "c1", name: "Website", status: "active", autonomy_level: "plan", wakes_enabled: true, last_wake_scan_at: scan },
    agents: AGENTS, tasks: [], requests: [], task_total: 0, request_total: 0,
  };
}
const CONTAINERS = [
  { id: "c1", name: "Website", status: "active", needs_you: 0 },
  { id: "c2", name: "API service", status: "active", needs_you: 1 },
  { id: "c3", name: "Docs", status: "active", needs_you: 0 },
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
// the `background` shorthand: the palette tone is var()-driven (theme tokens), so
// the backgroundColor longhand reads "" (pending substitution) in jsdom and browsers
const bg = (el: Element | null) => (el as HTMLElement | null)?.style.background || "";
/** jsdom serialises hsl() as rgb(): normalise the expected colour the same way */
const norm = (c: string) => { const d = document.createElement("div"); d.style.background = c; return d.style.background; };

beforeEach(() => { localStorage.clear(); _resetProjectsForTests(); document.documentElement.removeAttribute("data-sidebar"); window.location.hash = ""; stub(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("D13 shared palettes (shell/nav.ts)", () => {
  it("agentPaletteSlots = the Agents board's assignment (all agents, snapshot order), unique", () => {
    const snap = snapshot() as unknown as Snapshot;
    const slots = agentPaletteSlots(snap);
    const board = assignPalette(AGENTS.map((a) => actorKey(a.alias)));
    expect([...slots.entries()]).toEqual([...board.entries()]);
    expect(new Set(slots.values()).size).toBe(AGENTS.length);
  });
  it("projectPaletteSlots follows the sidebar order, is unique, and keys by name + id", () => {
    const rows = sidebarProjectRows(CONTAINERS, "c1");
    const slots = projectPaletteSlots(rows);
    const m = assignPalette(rows.map((r) => projectAvatarKey(r.name || "", r.id)));
    for (const r of rows) expect(slots.get(r.id)).toBe(m.get(projectAvatarKey(r.name || "", r.id)));
    expect(new Set(slots.values()).size).toBe(rows.length);
  });
  it("the current project is prepended when the list lacks it (and uses its snapshot name)", () => {
    const rows = sidebarProjectRows(CONTAINERS.slice(1), "c1", "Website");
    expect(rows.map((r) => r.id)).toEqual(["c1", "c2", "c3"]);
    expect(projectPaletteSlots(rows, "c1", "Website").get("c1")).toBe(projectPaletteSlots(sidebarProjectRows(CONTAINERS, "c1")).get("c1"));
  });
});

describe("sidebar renders the shared palettes + shared presence", () => {
  it("nested agent avatars use the board's slots; projects show their icon (D14), never a coloured initials disc", async () => {
    mount();
    const live = await within(sidebar()).findByRole("list", { name: /^Live agents in / });
    const slots = agentPaletteSlots(snapshot() as unknown as Snapshot);
    for (const alias of ["mira", "nova", "reviewer"]) {
      const link = within(live).getByRole("link", { name: new RegExp("^" + alias + ",") });
      const want = paletteColor(slots.get(alias)!).background;
      expect(bg(link.querySelector(".v2-av")), alias).toBe(norm(want));
    }
    await within(sidebar()).findByRole("link", { name: /^API service,/ });
    for (const c of CONTAINERS) {
      expect(sidebar().querySelector(`[data-proj="${c.id}"] .v2-sb-pav`), c.name).toBeNull();
      expect(sidebar().querySelector(`[data-proj="${c.id}"] .v2-sb-picon`)!.getAttribute("data-icon"), c.name).toBe("default");
    }
  });

  it("each nested agent reads agentPresence()'s label — Blocked / Needs you, never a contradicting raw status", async () => {
    mount();
    const live = await within(sidebar()).findByRole("list", { name: /^Live agents in / });
    const snap = snapshot() as unknown as Snapshot;
    for (const a of AGENTS.filter((x) => ["mira", "nova", "reviewer"].includes(x.alias))) {
      const p = agentPresence(a as unknown as Agent, { snap });
      const link = within(live).getByRole("link", { name: new RegExp("^" + a.alias + ",") });
      expect(link.getAttribute("aria-label"), a.alias).toContain(p.label);
    }
    expect(within(live).getByRole("link", { name: /^nova,/ }).querySelector(".v2-sb-agent-task")!.textContent).toBe("blocked");
    expect(within(live).getByRole("link", { name: /^reviewer,/ }).querySelector(".v2-sb-agent-task")!.textContent).toBe("needs you");
  });

  it("a stale wake scan reads exactly what the workspace header reads", async () => {
    stub(snapshot(new Date(now - 60 * 60_000).toISOString()));
    mount();
    const live = await within(sidebar()).findByRole("list", { name: /^Live agents in / });
    const mira = within(live).getByRole("link", { name: /^mira,/ });
    // the SAME label the workspace header computes (presence.ts is the one source;
    // r3 made a running run read "Working" there with the scanner-offline reason in the tooltip)
    const snap = snapshot(new Date(now - 60 * 60_000).toISOString()) as unknown as Snapshot;
    const p = agentPresence(snap.agents.find((a) => a.alias === "mira")!, { snap });
    expect(mira.getAttribute("aria-label")).toBe(`mira, ${p.label}, Ship login`);
  });
});
