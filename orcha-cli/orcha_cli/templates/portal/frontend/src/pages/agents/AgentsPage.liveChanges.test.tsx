/**
 * Live changes entry points on the Agents page: the workspace header button (only
 * while a run is running → "Live changes", or the newest finished run captured a diff
 * → "View changes"; nothing otherwise), its real count badge, opening the panel
 * (?changes=<run id>), the board column entry for a WORKING agent, and ?changes=1.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { AgentsPage } from "./AgentsPage";

const now = new Date().toISOString();
const AID = "a1111111-1111-4111-8111-111111111111";
const RID = "r2222222-2222-4222-8222-222222222222";

const SNAP = (status: string) => ({
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle" },
    // the real snapshot names the running run (L13b: the board needs a run, not a bare status)
    { id: AID, alias: "forge", kind: "ai", role: "Builder", status, running_run: status === "working" ? { run_id: RID, started_at: now, lane: "work", lease_live: true } : null },
  ],
  tasks: [
    { id: "t1aaaaaa-1", title: "Wire the board", status: "in_progress", assignees: ["forge"], assignee: "forge", priority: 50, is_root: false, created_at: now, thread: [], runs: [] },
  ],
  requests: [],
});

const CHANGES = {
  available: true, running: true, run_status: "running", source: "live", root: "worktree", branch: "orcha/wk-a",
  base: { kind: "merge_base", ref: "origin/main", sha: "abc" }, shared_checkout: false,
  files: [{ path: "src/app.py", status: "M", additions: 40, deletions: 7 }, { path: "a.md", status: "??", additions: 2, deletions: 0 }, { path: "b.md", status: "??", additions: 0, deletions: 0 }],
  summary: { files: 3, additions: 42, deletions: 7 }, truncated: false, version: "v1", as_of: now,
};

const jsonRes = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response;
function stubFetch(status: string, runs: unknown[]) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return jsonRes(SNAP(status));
    if (url.includes("/changes/diff")) return jsonRes({ available: true, path: "src/app.py", diff: "", binary: false, truncated: false, source: "live" });
    if (url.includes("/changes")) return jsonRes(CHANGES);
    if (url === "/api/agents/" + AID + "/runs") return jsonRes({ runs });
    if (url.includes("/conversation")) return jsonRes({ conversation: null, turns: [] });
    return jsonRes({});
  }) as unknown as typeof fetch;
}
let lastLoc = "";
function Loc() {
  lastLoc = useLocation().search;
  return null;
}
function mount(path: string) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[path]}>
          <Loc />
          <Routes>
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="*" element={<div>elsewhere</div>} />
          </Routes>
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const running = { run_id: RID, status: "running", started_at: now, worktree: "/h/p/.orcha-worktrees/wk-a", base_cwd: "/h/p", branch: "orcha/wk-a" };

describe("Live changes entry points", () => {
  it("a running run: header button with the real counts; clicking opens the panel on that run", async () => {
    stubFetch("working", [running]);
    mount("/agents?agent=forge");
    const btn = await screen.findByRole("button", { name: "Live changes — 3 files +42 −7" }, { timeout: 3000 });
    fireEvent.click(btn);
    await waitFor(() => expect(lastLoc).toContain("changes=" + RID));
    expect(await screen.findByRole("complementary", { name: "Live changes — forge" })).toBeTruthy();
    expect(await screen.findByRole("option", { name: /src\/app\.py/ })).toBeTruthy();
  });

  it("no running run and no captured diff: no button at all", async () => {
    stubFetch("idle", [{ run_id: RID, status: "exited", started_at: now, ended_at: now, diff: null }]);
    mount("/agents?agent=forge");
    await screen.findAllByText("forge");
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByRole("button", { name: /Live changes|View changes/ })).toBeNull();
  });

  it("the newest finished run with a captured diff: View changes", async () => {
    stubFetch("idle", [{ run_id: RID, status: "exited", started_at: now, ended_at: now, diff: "diff --git a/a b/a\n" }]);
    mount("/agents?agent=forge");
    expect(await screen.findByRole("button", { name: /^View changes/ }, { timeout: 3000 })).toBeTruthy();
  });

  it("?changes=1 opens the panel on the run the button would open", async () => {
    stubFetch("working", [running]);
    mount("/agents?agent=forge&changes=1");
    expect(await screen.findByRole("complementary", { name: "Live changes — forge" }, { timeout: 3000 })).toBeTruthy();
  });

  it("board: a WORKING agent's column leads with a Live changes link; an idle one has none", async () => {
    stubFetch("working", [running]);
    mount("/agents?view=board");
    const link = await screen.findByRole("link", { name: "Live changes" }, { timeout: 3000 });
    expect(link.getAttribute("href")).toBe("/agents?agent=forge&changes=1");
    cleanup();
    stubFetch("idle", []);
    mount("/agents?view=board");
    await screen.findAllByText("Wire the board");
    expect(screen.queryByRole("link", { name: "Live changes" })).toBeNull();
  });

  it("L13b: a running run with NO checkout (worktree + base_cwd both null) offers no Live changes on the board", async () => {
    const snap = SNAP("working");
    (snap.agents[1] as Record<string, unknown>).running_run = { run_id: RID, started_at: now, lane: "work", lease_live: true, worktree: null, base_cwd: null };
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
      if (url.startsWith("/api/containers/c1")) return jsonRes(snap);
      return jsonRes({});
    }) as unknown as typeof fetch;
    mount("/agents?view=board");
    await screen.findAllByText("Wire the board");
    expect(screen.queryByRole("link", { name: "Live changes" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "More for forge" }));
    expect(screen.queryByRole("menuitem", { name: /Live changes/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /Runs/ })).toBeTruthy();
  });
});
