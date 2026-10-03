/**
 * QA finding 16: the shared attention selector (selectAttention over up to
 * 1000 tasks + 1000 requests) must run ONCE per sidebar render, in <Sidebar>,
 * never once per project row. Only the selected row uses the result.
 */
import { cleanup, render, waitFor, within } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../components/ui";
import { SnapshotProvider } from "../state/SnapshotProvider";
import { _resetProjectsForTests } from "../state/projects";
import { Sidebar } from "./Sidebar";

const callers: string[] = [];
vi.mock("../state/attention", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../state/attention")>();
  return {
    ...actual,
    useAttention: (...args: Parameters<typeof actual.useAttention>) => {
      callers.push(new Error().stack ?? "");
      return actual.useAttention(...args);
    },
  };
});

const CONTAINERS = Array.from({ length: 20 }, (_, i) => ({
  id: "c" + (i + 1), name: "Project " + (i + 1), status: "active", needs_you: i % 3,
}));

function stubFetch() {
  const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return json({ containers: CONTAINERS });
    if (url.startsWith("/api/containers/c1")) {
      return json({
        container: { id: "c1", name: "Project 1", status: "active", autonomy_level: "plan", wakes_enabled: true },
        agents: [{ id: "h1", alias: "kedar", kind: "human", status: "idle" }],
        tasks: [{ id: "t1", title: "Verify me", status: "needs_verification", assignees: [] }],
        requests: [],
        task_total: 1, request_total: 0,
      });
    }
    return json({});
  }) as unknown as typeof fetch;
}

describe("Sidebar computes attention once, not per project row", () => {
  beforeEach(() => { localStorage.clear(); _resetProjectsForTests(); callers.length = 0; stubFetch(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("20 projects listed → no useAttention() call originates from ProjectItem", async () => {
    render(
      <ToastProvider>
        <SnapshotProvider>
          <HashRouter>
            <Sidebar />
          </HashRouter>
        </SnapshotProvider>
      </ToastProvider>,
    );
    const sb = document.getElementById("sidebar") as HTMLElement;
    await within(sb).findByText("Project 20");
    await waitFor(() => expect(sb.querySelectorAll("[data-proj]").length).toBe(20));
    expect(callers.length).toBeGreaterThan(0);
    expect(callers.filter((s) => /\bProjectItem\b/.test(s))).toEqual([]);
    // every call comes from <Sidebar> itself (one per Sidebar render)
    expect(callers.every((s) => /\bSidebar\b/.test(s))).toBe(true);
  });
});
