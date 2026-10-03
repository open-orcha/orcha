/**
 * Screen-quality round 1 — integration of the fixers' cross-file requests:
 * live-agent task only while working, one open-task count for header + tab,
 * the shared browse "token can't access" state, sticky failure toasts and the
 * notifier's honest header states.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { liveAgents } from "./liveAgents";
import { taskCountLabel } from "../pages/tasks/taskQuery";
import { BrowseErrorBody } from "../cloud/shared/browseTree";
import { ToastProvider, useToast } from "../components/ui";
import { notifierState } from "../lib/notifier";
import type { Agent, Snapshot, Task } from "../types";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const agent = (over: Partial<Agent>): Agent =>
  ({
    id: over.alias ?? "a", alias: "a", kind: "ai", status: "idle", model: null, last_active: null,
    current_task: null, active_run: null, ...over,
  }) as Agent;

describe("liveAgents task", () => {
  it("shows a task only for a working agent", () => {
    const snap = {
      agents: [
        agent({ alias: "idle-one", status: "idle", current_task: { task_id: "t1", title: "Stale task" } }),
        agent({ alias: "busy", status: "working", current_task: { task_id: "t2", title: "Real work" } }),
      ],
    } as unknown as Snapshot;
    const rows = liveAgents(snap);
    expect(rows.find((r) => r.alias === "idle-one")?.task).toBeNull();
    expect(rows.find((r) => r.alias === "busy")?.task).toBe("Real work");
  });
});

describe("taskCountLabel", () => {
  it("uses the shared open-work count when given, so header and tab agree", () => {
    const tasks = [{ status: "in_progress" }, { status: "pending" }, { status: "completed" }] as Task[];
    expect(taskCountLabel(tasks)).toBe("2 open · 3 total");
    expect(taskCountLabel(tasks, null, 1)).toBe("1 open · 3 total");
  });
});

describe("BrowseErrorBody", () => {
  it("renders a token-access state (not a rate limit) for no_access", () => {
    render(<BrowseErrorBody err={{ kind: "no_access", status: 403, detail: null }} what="Repository" />);
    expect(screen.getByText(/can't access this repository/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Check GitHub access/ })).toHaveAttribute("href", "/settings#tab=github-access");
    expect(screen.queryByText(/rate limit/i)).toBeNull();
  });
});

function Fire({ sticky }: { sticky: boolean }) {
  const toast = useToast();
  return <button type="button" onClick={() => toast("Couldn't start", "danger", sticky ? { sticky: true } : undefined)}>fire</button>;
}

describe("sticky toast", () => {
  it("stays until dismissed; a normal toast auto-hides", () => {
    vi.useFakeTimers();
    const { unmount } = render(<ToastProvider><Fire sticky /></ToastProvider>);
    fireEvent.click(screen.getByText("fire"));
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(document.querySelector(".toast.show")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(document.querySelector(".toast.show")).toBeNull();
    unmount();
    render(<ToastProvider><Fire sticky={false} /></ToastProvider>);
    fireEvent.click(screen.getByText("fire"));
    act(() => { vi.advanceTimersByTime(3_000); });
    expect(document.querySelector(".toast.show")).toBeNull();
  });
});

describe("notifierState (shared by Overview and the header)", () => {
  it("separates paused, running, not running and no wake service", () => {
    const now = Date.parse("2026-09-28T12:00:00Z");
    expect(notifierState({ wakes_enabled: false, last_wake_scan_at: null }, now)).toBe("paused");
    expect(notifierState({ wakes_enabled: true, last_wake_scan_at: "2026-09-28T11:59:30Z" }, now)).toBe("running");
    expect(notifierState({ wakes_enabled: true, last_wake_scan_at: "2026-09-28T11:00:00Z" }, now)).toBe("stale");
    expect(notifierState({ wakes_enabled: true, last_wake_scan_at: null }, now)).toBe("none");
  });
});

describe("projectAgents (D11)", () => {
  it("keeps working / needs-review / trouble agents, drops idle, caps with a +N count", async () => {
    const { projectAgents } = await import("./liveAgents");
    const now = Date.parse("2026-01-01T00:10:00Z");
    const ag = (alias: string, status: string, extra: object = {}) => ({ id: alias, alias, kind: "ai", status, last_active: "2026-01-01T00:09:00Z", ...extra });
    const snap = { agents: [
      ag("a", "idle"), ag("b", "working", { current_task: { task_id: "t", title: "Fix login" } }),
      ag("c", "awaiting_human"), ag("d", "blocked"), ag("e", "failed"), ag("h", "working", { kind: "human" }),
    ] } as never;
    const { rows, more } = projectAgents(snap, 3, () => "1m ago", now);
    expect(rows.map((r) => [r.alias, r.fragment])).toEqual([["b", "Fix login"], ["c", "needs review"], ["d", "blocked"]]);
    expect(more).toBe(1);
  });
});
