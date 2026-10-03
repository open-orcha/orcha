/**
 * Live changes — the client: changesTarget (button visibility), useRunChanges (polling
 * cadence, ?since=, pause while the tab is hidden, finished = one read), and the panel
 * (keeps the selected file across refreshes, empty / unavailable / final states, the
 * streamed-edit immediate re-scan, Open in Code). fetch is stubbed with the exact
 * payload shapes run_changes_routes.py returns; nothing else is mocked but the run
 * stream (a controllable list of classified events).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { LogEvent } from "../../lib/classify";

let streamLines: LogEvent[] = [];
vi.mock("../../hooks/useRunStream", () => ({
  useRunStream: (run: unknown) => (run ? streamLines : []),
}));

import { changedPaths, changesTarget, summaryText, useRunChanges, LIVE_POLL_MS, BADGE_POLL_MS, type RunChangedFile, type RunChangesPayload } from "./liveChanges";
import { LiveChangesButton, LiveChangesPanel } from "./LiveChangesPanel";
import type { WorkerRun } from "../activity/runModel";

const AID = "11111111-1111-4111-8111-111111111111";
const RID = "22222222-2222-4222-8222-222222222222";

const file = (path: string, status: RunChangedFile["status"] = "M", additions: number | null = 1, deletions: number | null = 0): RunChangedFile => ({ path, status, additions, deletions });

function payload(files: ReturnType<typeof file>[], over: Partial<RunChangesPayload> = {}): RunChangesPayload {
  return {
    available: true, running: true, run_status: "running", source: "live", root: "worktree",
    branch: "orcha/wk-a", base: { kind: "merge_base", ref: "origin/main", sha: "abc" }, shared_checkout: false,
    files, summary: {
      files: files.length,
      additions: files.reduce((n, f) => n + (f.additions || 0), 0),
      deletions: files.reduce((n, f) => n + (f.deletions || 0), 0),
    },
    truncated: false, version: "v" + files.map((f) => f.path + f.additions).join(","), as_of: "2026-09-29T10:00:00Z",
    ...over,
  };
}

const DIFF = "diff --git a/src/app.py b/src/app.py\n--- a/src/app.py\n+++ b/src/app.py\n@@ -1,2 +1,2 @@\n a = 1\n-b = 2\n+b = 3\n";

type Route = (url: string) => unknown;
let calls: string[] = [];
function stubFetch(changes: () => unknown, diff: Route = () => ({ available: true, path: "src/app.py", diff: DIFF, binary: false, truncated: false, source: "live" })) {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    const body = url.includes("/changes/diff") ? diff(url) : changes();
    return { ok: true, status: 200, json: async () => body } as Response;
  }));
}
const changeCalls = () => calls.filter((u) => !u.includes("/changes/diff"));

let hiddenFlag = false;
beforeEach(() => {
  streamLines = [];
  hiddenFlag = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hiddenFlag });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
};

const run = (over: Partial<WorkerRun> = {}): WorkerRun =>
  ({ run_id: RID, status: "running", worktree: "/host/p/.orcha-worktrees/wk-a", base_cwd: "/host/p", branch: "orcha/wk-a", ...over }) as WorkerRun;

/* ------------------------------------------------------------------ visibility */

describe("changesTarget (which run the button speaks for)", () => {
  it("a running run → Live changes", () => {
    const t = changesTarget([run(), run({ run_id: "x", status: "exited", diff: "diff --git a/a b/a" } as Partial<WorkerRun>)]);
    expect(t?.live).toBe(true);
    expect(t?.run.run_id).toBe(RID);
  });
  it("no running run → the newest finished run, only when it captured a real diff", () => {
    expect(changesTarget([run({ status: "exited", diff: "diff --git a/a b/a\n" } as Partial<WorkerRun>)])?.live).toBe(false);
    expect(changesTarget([run({ status: "exited", diff: "   " } as Partial<WorkerRun>)])).toBeNull();
    expect(changesTarget([run({ status: "exited" })])).toBeNull();
    expect(changesTarget([])).toBeNull();
    expect(changesTarget(null)).toBeNull();
  });
  it("the button names what it shows and carries the real counts once known", () => {
    const { rerender } = render(<LiveChangesButton live summary={null} onClick={() => {}} />);
    expect(screen.getByRole("button").textContent).toBe("Live changes");
    rerender(<LiveChangesButton live summary={{ files: 3, additions: 42, deletions: 7 }} onClick={() => {}} />);
    expect(screen.getByRole("button", { name: "Live changes — 3 files +42 −7" })).toBeTruthy();
    rerender(<LiveChangesButton live={false} summary={{ files: 1, additions: 2, deletions: 0 }} onClick={() => {}} />);
    expect(screen.getByRole("button").textContent).toContain("View changes");
    expect(summaryText({ files: 0, additions: 0, deletions: 0 })).toBe("");
  });
  it("changedPaths flags new and moved files only", () => {
    expect(changedPaths(null, [file("a")])).toEqual([]);
    expect(changedPaths([file("a"), file("b")], [file("a"), file("b", "M", 5), file("c")])).toEqual(["b", "c"]);
  });
});

/* ------------------------------------------------------------------ polling */

describe("useRunChanges (polling)", () => {
  it("polls every ~1.5 s while the panel is open, rides ?since=, and keeps the payload on unchanged", async () => {
    vi.useFakeTimers();
    let n = 0;
    const first = payload([file("src/app.py", "M", 1, 1)]);
    stubFetch(() => (n++ === 0 ? first : { unchanged: true, version: first.version, running: true, as_of: "x" }));
    const { result } = renderHook(() => useRunChanges(AID, RID, { live: true, active: true }));
    await flush();
    expect(result.current.payload?.files.map((f) => f.path)).toEqual(["src/app.py"]);
    expect(changeCalls()[0]).toBe(`/api/agents/${AID}/runs/${RID}/changes`);
    await act(async () => { vi.advanceTimersByTime(LIVE_POLL_MS); });
    await flush();
    expect(changeCalls()).toHaveLength(2);
    expect(changeCalls()[1]).toContain("?since=" + encodeURIComponent(first.version!));
    expect(result.current.payload).toBe(first); // unchanged poll never replaces the payload
  });

  it("pauses while the browser tab is hidden and resumes on visibility", async () => {
    vi.useFakeTimers();
    stubFetch(() => payload([]));
    renderHook(() => useRunChanges(AID, RID, { live: true, active: true }));
    await flush();
    expect(changeCalls()).toHaveLength(1);
    hiddenFlag = true;
    await act(async () => { vi.advanceTimersByTime(LIVE_POLL_MS * 4); });
    await flush();
    expect(changeCalls()).toHaveLength(1);
    hiddenFlag = false;
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await flush();
    expect(changeCalls()).toHaveLength(2);
  });

  it("closed panel = slow badge refresh; finished run = one read; no run = no requests", async () => {
    vi.useFakeTimers();
    stubFetch(() => payload([]));
    const { rerender, unmount } = renderHook((p: { live: boolean; active: boolean; rid: string | null }) => useRunChanges(AID, p.rid, p), {
      initialProps: { live: true, active: false, rid: RID as string | null },
    });
    await flush();
    await act(async () => { vi.advanceTimersByTime(LIVE_POLL_MS * 2); });
    expect(changeCalls()).toHaveLength(1);
    await act(async () => { vi.advanceTimersByTime(BADGE_POLL_MS); });
    await flush();
    expect(changeCalls()).toHaveLength(2);
    rerender({ live: false, active: true, rid: RID });
    await flush();
    const after = changeCalls().length;
    await act(async () => { vi.advanceTimersByTime(BADGE_POLL_MS * 3); });
    expect(changeCalls().length).toBe(after);
    unmount();
    calls = [];
    renderHook(() => useRunChanges(AID, null, { live: true, active: true }));
    await act(async () => { vi.advanceTimersByTime(BADGE_POLL_MS); });
    expect(calls).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ panel */

function Harness({ live = true, r = run(), active = true }: { live?: boolean; r?: WorkerRun; active?: boolean }) {
  const state = useRunChanges(AID, RID, { live, active });
  return (
    <MemoryRouter>
      <LiveChangesPanel agentAlias="Atlas" agentId={AID} run={r} live={live} state={state} onClose={() => {}} />
    </MemoryRouter>
  );
}

describe("LiveChangesPanel", () => {
  it("lists files, shows the first file's diff, and keeps the SELECTED file across refreshes", async () => {
    vi.useFakeTimers();
    let files = [file("a.md", "??", 3, 0), file("src/app.py", "M", 1, 1)];
    stubFetch(() => payload(files));
    render(<Harness />);
    await flush();
    await flush();
    expect(screen.getByText(/Live · updated/)).toBeTruthy();
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      expect.stringContaining("a.md"), expect.stringContaining("src/app.py"),
    ]);
    fireEvent.click(screen.getByRole("option", { name: /src\/app\.py/ }));
    await flush();
    expect(screen.getByRole("option", { name: /src\/app\.py/ }).getAttribute("aria-selected")).toBe("true");
    // the agent adds a file that sorts first — the selection must not jump
    files = [file("0-new.md", "??", 1, 0), ...files];
    await act(async () => { vi.advanceTimersByTime(LIVE_POLL_MS); });
    await flush();
    await flush();
    expect(screen.getAllByRole("option")).toHaveLength(3);
    expect(screen.getByRole("option", { name: /src\/app\.py/ }).getAttribute("aria-selected")).toBe("true");
    // the new file flashes
    expect(screen.getByRole("option", { name: /0-new\.md/ }).className).toContain("is-fresh");
    const diffCalls = calls.filter((u) => u.includes("/changes/diff"));
    expect(diffCalls[diffCalls.length - 1]).toContain("path=src%2Fapp.py");
    // Open in Code at that file on the run's branch
    const link = screen.getByRole("link", { name: "Open in Code" });
    expect(link.getAttribute("href")).toBe("/code?path=src%2Fapp.py&ref=orcha%2Fwk-a");
    // an untracked file was never committed on the branch: no (dead) Open in Code link
    fireEvent.click(screen.getByRole("option", { name: /0-new\.md/ }));
    await flush();
    expect(screen.queryByRole("link", { name: "Open in Code" })).toBeNull();
  });

  it("empty state is truthful while the agent has not written anything yet", async () => {
    stubFetch(() => payload([]));
    render(<Harness />);
    await flush();
    expect(screen.getByText("No file changes yet")).toBeTruthy();
    expect(screen.getByText(/Atlas is reading or running commands/)).toBeTruthy();
  });

  it("unavailable shows the backend's reason", async () => {
    stubFetch(() => ({ available: false, reason: "not_reachable", detail: "the run's checkout no longer exists (worktree removed?)", running: true, files: [], summary: { files: 0, additions: 0, deletions: 0 }, version: "u" }));
    render(<Harness />);
    await flush();
    expect(screen.getByText("Changes unavailable")).toBeTruthy();
    expect(screen.getByText("the run's checkout no longer exists (worktree removed?)")).toBeTruthy();
  });

  it("a finished run reads as Final changes from the captured diff", async () => {
    stubFetch(() => payload([file("src/app.py", "M", 1, 1)], { running: false, run_status: "exited", source: "captured", base: { kind: "captured", ref: "origin/main", sha: null } }));
    render(<Harness live={false} r={run({ status: "exited", ended_at: new Date().toISOString() } as Partial<WorkerRun>)} />);
    await flush();
    await flush();
    expect(screen.getByRole("complementary", { name: "Final changes — Atlas" })).toBeTruthy();
    expect(screen.queryByText(/Live · updated/)).toBeNull();
    expect(screen.getByText(/1 file \+1 −1/)).toBeTruthy();
    // the title already says "Final changes" — the meta line states only when (D12: once)
    expect(screen.getByText(/^Run ended /)).toBeTruthy();
    expect(screen.queryByText(/Final changes ·/)).toBeNull();
  });

  it("a new streamed Edit event re-scans immediately and marks the file as being edited", async () => {
    vi.useFakeTimers();
    stubFetch(() => payload([file("src/app.py", "M", 1, 1)]));
    streamLines = [{ type: "tool", label: "Edit", text: "Edit", detail: JSON.stringify({ file_path: "/host/p/.orcha-worktrees/wk-a/src/app.py", old_string: "b = 2", new_string: "b = 3" }) }];
    const { rerender } = render(<Harness />);
    await flush();
    await flush();
    const before = changeCalls().length;
    streamLines = [...streamLines, { type: "tool", label: "Edit", text: "Edit", detail: JSON.stringify({ file_path: "/host/p/.orcha-worktrees/wk-a/src/app.py", old_string: "a = 1", new_string: "a = 9" }) }];
    rerender(<Harness />);
    await flush();
    expect(changeCalls().length).toBe(before + 1); // no wait for the next 1.5 s tick
    expect(screen.getByText("editing")).toBeTruthy();
  });

  it("shared base checkout is labelled honestly", async () => {
    stubFetch(() => payload([file("README.md")], { root: "base", shared_checkout: true, base: { kind: "head", ref: "HEAD", sha: "h" }, branch: "main" }));
    render(<Harness r={run({ worktree: null })} />);
    await flush();
    expect(screen.getByText(/Main checkout — may include edits not made by this run/)).toBeTruthy();
  });
});
