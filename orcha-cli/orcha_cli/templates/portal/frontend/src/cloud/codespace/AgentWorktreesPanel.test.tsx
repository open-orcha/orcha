/** GH #288 — Code Space › Changes › Agent worktrees: task worktrees with Bring in / Update. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { AgentWorktreesPanel, taskWorktrees } from "./AgentWorktreesPanel";
import type { WorktreeItem } from "../../pages/settings/AgentWorktreesSection";

const WT = "/Users/dev/acme/.orcha-worktrees";
const ITEMS: WorktreeItem[] = [
  { path: `${WT}/Atlas-1`, name: "Atlas-1", branch: "orcha/wk-Atlas-1", kind: "wake", agent: "Atlas", state: "clean" },
  { path: `${WT}/task-Atlas-eecc`, name: "task-Atlas-eecc", branch: "orcha/task-Atlas-eecc3b74-ed6", kind: "task", agent: "Atlas",
    task_id: "t1", task_title: "Prod QA run", state: "in-use" },
  { path: `${WT}/task-Probe-aaaa`, name: "task-Probe-aaaa", branch: "orcha/task-Probe-aaaa1111-1", kind: "task", agent: "Probe",
    task_id: "t2", task_title: "Docs", state: "has-output" },
  { path: `${WT}/stray`, name: "stray", branch: null, kind: null, agent: null, state: "not-quorate" },
];

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("taskWorktrees", () => {
  it("keeps task worktrees only, running ones last", () => {
    expect(taskWorktrees(ITEMS).map((i) => i.name)).toEqual(["task-Probe-aaaa", "task-Atlas-eecc"]);
    expect(taskWorktrees(null)).toEqual([]);
  });
});

describe("AgentWorktreesPanel", () => {
  it("lists the task worktrees; a running one is disabled with the reason", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const res = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
      if (url === "/api/containers/c1/agent-worktrees") return res({ settings: { auto_cleanup: true, grace_days: 7 }, actions: [], inventory: { host: "mac", scanned_at: "", items: ITEMS, reclaimable_bytes: 0, total_bytes: 0 } });
      if (url === "/api/containers") return res([{ id: "c1", status: "active" }]);
      return res({});
    }));
    render(<ToastProvider><SnapshotProvider><AgentWorktreesPanel cid="c1" writeBlock={null} /></SnapshotProvider></ToastProvider>);
    expect(await screen.findByText("Docs")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bring in task-Probe-aaaa" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Update task-Probe-aaaa from main" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "Bring in task-Atlas-eecc" })).toBeDisabled();
    expect(screen.queryByText("Atlas-1")).toBeNull();
  });

  it("a viewer's write block disables both actions", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const res = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
      if (url === "/api/containers/c1/agent-worktrees") return res({ settings: {}, actions: [], inventory: { items: ITEMS } });
      if (url === "/api/containers") return res([{ id: "c1", status: "active" }]);
      return res({});
    }));
    render(<ToastProvider><SnapshotProvider><AgentWorktreesPanel cid="c1" writeBlock="Viewers can't change the checkout" /></SnapshotProvider></ToastProvider>);
    expect(await screen.findByRole("button", { name: "Bring in task-Probe-aaaa" })).toBeDisabled();
  });
});
