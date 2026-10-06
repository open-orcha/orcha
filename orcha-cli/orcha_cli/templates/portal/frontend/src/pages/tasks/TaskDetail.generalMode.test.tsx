/**
 * Task detail — project mode wording (lib/projectMode.ts `modeWords`): a General
 * project's verify view never says "Code changes" / "No code diff"; a Code
 * project keeps today's wording.
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { resetProjectModeCache } from "../../lib/projectMode";
import { TasksPage } from "./TasksPage";

const SNAP = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", status: "idle" },
    { id: "a1", alias: "forge", kind: "ai", status: "working" },
  ],
  tasks: [{
    id: "t1aaaaaa", title: "Verify me", status: "needs_verification", priority: 10, assignees: ["forge"],
    created_by_agent_id: "h1", created_at: "2026-08-01T00:00:00Z", definition_of_done: "DoD",
    message_summary: { count: 0, last: null }, result: "I did the thing",
  }],
  requests: [],
};
const RUN_OK = { run_id: "r1", status: "completed", exit_code: 0, started_at: "2026-08-01T00:00:00Z", ended_at: "2026-08-01T00:05:00Z" };
const DIFF = "diff --git a/x.md b/x.md\n--- a/x.md\n+++ b/x.md\n@@ -1 +1 @@\n-a\n+b\n";

let MODE = "code";
let RUNS: unknown[] = [];
const jsonRes = (data: unknown, status = 200) => ({ ok: status < 300, status, json: async () => data }) as Response;

beforeEach(() => {
  resetProjectModeCache();
  MODE = "code";
  RUNS = [];
  window.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.endsWith("/project-profile")) {
      return jsonRes({ container_id: "c1", mode: MODE, dod_presets: [], template_key: null, template_name: null, last_applied_at: null });
    }
    if (url.startsWith("/api/containers/c1")) return jsonRes(SNAP);
    if (/\/messages$/.test(url)) return jsonRes({ messages: [] });
    if (/\/runs$/.test(url)) return jsonRes(RUNS);
    return jsonRes({});
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetProjectModeCache();
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* jsdom */ }
});

function renderPage(entry: string) {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[entry]}>
          <TasksPage />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

const summary = () => document.querySelector("#gate-t1aaaaaa .td-ev-diff summary")?.textContent;
const evLine = () => (document.querySelector("#gate-t1aaaaaa .td-ev-line") as HTMLElement | null)?.textContent ?? "";

describe("verify view wording follows the project mode", () => {
  it("General mode: the run diff reads 'Changes', never 'Code changes'", async () => {
    MODE = "general";
    RUNS = [{ ...RUN_OK, diff: DIFF }];
    renderPage("/tasks?task=t1aaaaaa&full=1");
    await waitFor(() => expect(summary()).toBe("Changes"));
    expect(document.body.textContent).not.toContain("Code changes");
  });

  it("General mode: no diff reads 'No file changes', never 'No code diff'", async () => {
    MODE = "general";
    RUNS = [RUN_OK];
    renderPage("/tasks?task=t1aaaaaa");
    await waitFor(() => expect(evLine()).toContain("No file changes"));
    expect(document.body.textContent).not.toContain("No code diff");
  });

  it("Code mode keeps 'Code changes' and 'No code diff'", async () => {
    RUNS = [{ ...RUN_OK, diff: DIFF }];
    renderPage("/tasks?task=t1aaaaaa&full=1");
    await waitFor(() => expect(summary()).toBe("Code changes"));
    cleanup();
    RUNS = [RUN_OK];
    renderPage("/tasks?task=t1aaaaaa");
    await waitFor(() => expect(evLine()).toContain("No code diff"));
  });
});
