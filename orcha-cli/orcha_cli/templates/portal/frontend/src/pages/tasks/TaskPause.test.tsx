import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Task } from "../../types";
import { TaskPauseControl, TaskPausedChip } from "./TaskPause";

const refresh = vi.fn();
const toast = vi.fn();
vi.mock("../../state/SnapshotProvider", () => ({
  useSnapshot: () => ({ refresh }),
  useActingAuthority: () => ({ human: { id: "kedar", kind: "human" } }),
}));
vi.mock("../../components/ui", () => ({ useToast: () => toast }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); refresh.mockReset(); toast.mockReset(); });

const task = (extra: Partial<Task> = {}) => ({ id: "t1", status: "in_progress", is_root: false, ...extra }) as Task;
const paused = { paused_at: new Date(Date.now() - 5 * 60_000).toISOString(), paused_by_alias: "Kedar", paused_reason: "Waiting on legal" };

it("shows who paused the task, and why on hover; nothing when not paused", () => {
  const { container } = render(<TaskPausedChip t={task(paused)} />);
  const chip = screen.getByText(/Paused by Kedar/);
  expect(chip).toBeVisible();
  expect(container.querySelector("[title]")?.getAttribute("title")).toMatch(/Reason: Waiting on legal/);
  cleanup();
  const empty = render(<TaskPausedChip t={task()} />);
  expect(empty.container.textContent).toBe("");
});

it("pauses an open task as the acting person and reports a stopped run", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ paused: true, changed: true, stopped_runs: ["r1"] })));
  vi.stubGlobal("fetch", fetch);
  render(<TaskPauseControl t={task()} />);
  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  await waitFor(() => expect(refresh).toHaveBeenCalled());
  expect(fetch).toHaveBeenCalledWith("/api/tasks/t1/pause", expect.objectContaining({ method: "POST", body: JSON.stringify({ actor_agent_id: "kedar" }) }));
  expect(toast).toHaveBeenCalledWith(expect.stringMatching(/asked to stop and save/), "ok");
});

it("resumes a paused task, and hides the control on finished or root tasks", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ paused: false, changed: true })));
  vi.stubGlobal("fetch", fetch);
  render(<TaskPauseControl t={task(paused)} />);
  fireEvent.click(screen.getByRole("button", { name: "Resume" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/tasks/t1/resume", expect.anything()));
  cleanup();
  expect(render(<TaskPauseControl t={task({ status: "completed" })} />).container.textContent).toBe("");
  cleanup();
  expect(render(<TaskPauseControl t={task({ is_root: true })} />).container.textContent).toBe("");
});
