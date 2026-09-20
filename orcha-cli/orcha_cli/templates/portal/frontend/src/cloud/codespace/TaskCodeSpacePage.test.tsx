import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import type { Run } from "../../types";
import { TaskCodeSpacePage } from "./TaskCodeSpacePage";

const TASK = {
  id: "task-1",
  title: "Make verification honest",
  status: "needs_verification",
  priority: 10,
  assignees: ["forge"],
  assignee: "forge",
  description: "",
  definition_of_done: "Review the code",
  protocol: null,
  result: null,
  plan_decision: null,
  runs: [],
  runs_summary: null,
  is_root: false,
  created_by: "kedar",
  created_at: "2026-09-20T00:00:00Z",
  started_at: null,
  completed_at: null,
  message_summary: { count: 0, last: null },
  plan_message: null,
  thread: [],
};

const RUNS: Run[] = [
  {
    run_id: "run-latest-1234",
    status: "exited",
    branch: "orcha/task-review",
    snapshot_ref: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    diff: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new",
  },
  {
    run_id: "run-older-5678",
    status: "exited",
    branch: "orcha/older-review",
    snapshot_ref: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    diff: "",
  },
];

function json(data: unknown, status = 200): Response {
  return { ok: status < 300, status, json: async () => data } as Response;
}

let requestedUrls: string[] = [];
let runsPayload = RUNS;

beforeEach(() => {
  requestedUrls = [];
  runsPayload = RUNS;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 1; });
  window.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url === "/api/containers/c1") {
      return json({
        container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "pr" },
        agents: [], tasks: [TASK], requests: [],
      });
    }
    if (url === "/api/tasks/task-1/runs") return json({ task_id: "task-1", runs: runsPayload });
    if (url.startsWith("/api/containers/c1/runs/run-latest-1234/snapshot/tree")) {
      if (url.includes("path=src")) {
        return json({ ref: RUNS[0].snapshot_ref, path: "src", entries: [{ name: "a.ts", path: "src/a.ts", type: "file" }] });
      }
      return json({ ref: RUNS[0].snapshot_ref, path: "", entries: [{ name: "src", path: "src", type: "dir" }] });
    }
    if (url.startsWith("/api/containers/c1/runs/run-latest-1234/snapshot/file")) {
      return json({ ref: RUNS[0].snapshot_ref, path: "src/a.ts", size: 18, content: "export const a = 1;" });
    }
    return json({});
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

function mount(entry: string) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/code" element={<TaskCodeSpacePage />} />
            <Route path="/tasks" element={<div>Returned to task</div>} />
          </Routes>
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("TaskCodeSpacePage", () => {
  it("renders a shell-less full-window diff for the latest task run", async () => {
    mount("/code?task=task-1&view=diff");
    expect(await screen.findByRole("heading", { name: "Make verification honest" })).toBeInTheDocument();
    expect(document.querySelector("[data-task-code-space=true]")).toBeTruthy();
    expect(document.querySelector(".sidebar")).toBeNull();
    expect(screen.getByText("Changes vs main", { selector: "strong" })).toBeInTheDocument();
    expect(await screen.findByText("src/a.ts", { selector: ".dfv-path" })).toBeInTheDocument();
  });

  it("uses the selected run snapshot for the file tree and syntax-highlighted viewer", async () => {
    mount("/code?task=task-1&run=run-latest-1234&view=file&path=src%2Fa.ts");
    expect(await screen.findByText("src/a.ts", { selector: ".rb-file-path" })).toBeInTheDocument();
    expect(document.querySelector(".rb-code")).toBeTruthy();
    await waitFor(() => {
      expect(requestedUrls.some((url) => url.includes("/runs/run-latest-1234/snapshot/file"))).toBe(true);
      expect(requestedUrls.some((url) => url.includes("github/browse"))).toBe(false);
    });
  });

  it("does not fall back to a mutable branch for a legacy run", async () => {
    runsPayload = [{ ...RUNS[0], snapshot_ref: null }];
    mount("/code?task=task-1&run=run-latest-1234&view=file&path=src%2Fa.ts");
    expect(await screen.findByText("An immutable file snapshot is unavailable for this run.")).toBeInTheDocument();
    expect(requestedUrls.some((url) => url.includes("github/browse"))).toBe(false);
    expect(requestedUrls.some((url) => url.includes("/snapshot/"))).toBe(false);
  });

  it("Close returns to the stored task page and restores its scroll position", async () => {
    sessionStorage.setItem("orcha:task-code-space:origin", JSON.stringify({ href: "/tasks?task=task-1", scrollY: 420, taskId: "task-1" }));
    mount("/code?task=task-1&view=diff");
    fireEvent.click(await screen.findByRole("button", { name: "Close code space" }));
    expect(await screen.findByText("Returned to task")).toBeInTheDocument();
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 420 });
  });

  it("Escape returns to the originating task thread", async () => {
    sessionStorage.setItem("orcha:task-code-space:origin", JSON.stringify({ href: "/tasks?task=task-1", scrollY: 75, taskId: "task-1" }));
    mount("/code?task=task-1&view=diff");
    await screen.findByRole("heading", { name: "Make verification honest" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(await screen.findByText("Returned to task")).toBeInTheDocument();
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 75 });
  });

  it("ignores stale return state from a different task", async () => {
    sessionStorage.setItem("orcha:task-code-space:origin", JSON.stringify({ href: "/tasks?task=other-task", scrollY: 900, taskId: "other-task" }));
    mount("/code?task=task-1&view=diff");
    fireEvent.click(await screen.findByRole("button", { name: "Close code space" }));
    expect(await screen.findByText("Returned to task")).toBeInTheDocument();
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0 });
  });
});
