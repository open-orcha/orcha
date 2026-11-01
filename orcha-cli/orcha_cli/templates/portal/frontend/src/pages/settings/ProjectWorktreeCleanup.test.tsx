import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProjectWorktreeCleanup } from "./ProjectWorktreeCleanup";

const calls: Array<Record<string, unknown>> = [];
const response = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
async function startPreview() {
  const button = screen.getByRole("button", { name: "Preview project-wide cleanup" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); calls.length = 0; });
it("waits for a complete preview and confirms only its saved identifier", async () => {
  const result = { plan_id: "saved-preview", status: "ready", scanned: 1, total: 1,
    candidate_count: 1, candidate_bytes: 400, unknown_sizes: 0, removed: [],
    items: [{ name: "outside", path: "/tmp/review", state: "eligible", reason: "work saved first" }] };
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (!init?.body && _url.endsWith("/cleanup")) return response({ actions: [] });
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (body) calls.push(body);
    return { ok: true, status: 200, json: async () => ({ id: "action", status: "done", result }) };
  }));
  render(<ProjectWorktreeCleanup cid="project" humanId="owner" locked={false} />);
  expect(screen.queryByText("Save work and remove 1 folders")).toBeNull();
  await startPreview();
  fireEvent.click(await screen.findByText("Save work and remove 1 folders"));
  await waitFor(() => expect(calls[1]).toEqual({ phase: "execute", plan_id: "saved-preview", actor_agent_id: "owner" }));
});
it("keeps the action unavailable to a viewer", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => response({ actions: [] })));
  render(<ProjectWorktreeCleanup cid="project" locked={true} />);
  await waitFor(() => expect(screen.queryByText("Loading saved cleanup…")).toBeNull());
  expect(screen.getByRole("button", { name: "Preview project-wide cleanup" })).toBeDisabled();
});

it.each(["preview", "execute"])("retries a failed %s using its original plan", async (phase) => {
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (!init?.body && _url.endsWith("/cleanup")) return response({ actions: [] });
    if (init?.body) calls.push(JSON.parse(String(init.body)));
    return { ok: true, status: 200, json: async () => ({ id: "failed-action", status: "failed",
      result: null, error: "The host stopped", options: { phase, plan_id: "original-plan" } }) };
  }));
  render(<ProjectWorktreeCleanup cid="project" humanId="owner" locked={false} />);
  await startPreview();
  fireEvent.click(await screen.findByText("Retry interrupted cleanup"));
  await waitFor(() => expect(calls[1]).toEqual({ phase, plan_id: "original-plan", actor_agent_id: "owner" }));
});

it.each(["preview", "execute"])("restores the original failed %s after reopening settings", async (phase) => {
  const failed = { id: "failed-action", status: "failed", result: null,
    options: { phase, plan_id: "original-plan" }, error: "The host stopped" };
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    if (!init?.body) return response({ actions: [failed] });
    calls.push(JSON.parse(String(init.body)));
    return response(failed);
  });
  vi.stubGlobal("fetch", fetcher);
  const first = render(<ProjectWorktreeCleanup cid="project" humanId="owner" locked={false} />);
  await screen.findByText("Retry interrupted cleanup");
  first.unmount();
  render(<ProjectWorktreeCleanup cid="project" humanId="owner" locked={false} />);
  fireEvent.click(await screen.findByText("Retry interrupted cleanup"));
  await waitFor(() => expect(calls).toEqual([{ phase, plan_id: "original-plan", actor_agent_id: "owner" }]));
  expect(fetcher.mock.calls.filter(([, init]) => !init?.body)).toHaveLength(2);
});

it("resumes polling a saved running attempt without creating a new plan", async () => {
  const running = { id: "running-action", status: "claimed", result: null,
    options: { phase: "execute", plan_id: "original-plan" } };
  const fetcher = vi.fn(async (url: string) => response(url.endsWith("/cleanup")
    ? { actions: [running] } : { ...running, status: "failed", error: "The host stopped" }));
  vi.stubGlobal("fetch", fetcher);
  render(<ProjectWorktreeCleanup cid="project" humanId="owner" locked={false} />);
  await screen.findByText("Retry interrupted cleanup");
  expect(fetcher).toHaveBeenCalledWith("/api/containers/project/agent-worktrees/actions/running-action");
  expect(screen.getByRole("button", { name: "Preview project-wide cleanup" })).toBeDisabled();
});

it("keeps new previews disabled until saved state can be read", async () => {
  let unavailable = true;
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (unavailable) throw new Error("offline");
    return response({ actions: [] });
  }));
  render(<ProjectWorktreeCleanup cid="project" humanId="owner" locked={false} />);
  await screen.findByText("Reload saved cleanup");
  expect(screen.getByRole("button", { name: "Preview project-wide cleanup" })).toBeDisabled();
  unavailable = false;
  fireEvent.click(screen.getByText("Reload saved cleanup"));
  await waitFor(() => expect(screen.getByRole("button", { name: "Preview project-wide cleanup" })).toBeEnabled());
});

it.each([{}, { actions: null }])("keeps cleanup unavailable when saved state is malformed: %j", async (data) => {
  const fetcher = vi.fn(async () => response(data));
  vi.stubGlobal("fetch", fetcher);
  render(<ProjectWorktreeCleanup cid="project" humanId="owner" locked={false} />);
  await screen.findByText("Reload saved cleanup");
  const preview = screen.getByRole("button", { name: "Preview project-wide cleanup" });
  expect(preview).toBeDisabled();
  fireEvent.click(preview);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("keeps multiple saved plans accessible and forgets them when the project changes", async () => {
  const failed = (plan_id: string) => ({ id: plan_id, status: "failed", result: null,
    options: { phase: "execute", plan_id } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.body) { calls.push(JSON.parse(String(init.body))); return response(failed("older")); }
    return response({ actions: url.includes("/project/") ? [failed("newer"), failed("older")] : [] });
  }));
  const view = render(<ProjectWorktreeCleanup cid="project" humanId="owner" locked={false} />);
  fireEvent.change(await screen.findByLabelText("Saved cleanup"), { target: { value: "older" } });
  fireEvent.click(screen.getByText("Retry interrupted cleanup"));
  await waitFor(() => expect(calls[0].plan_id).toBe("older"));
  view.rerender(<ProjectWorktreeCleanup cid="other" humanId="owner" locked={false} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Preview project-wide cleanup" })).toBeEnabled());
  expect(screen.queryByText("Retry interrupted cleanup")).toBeNull();
});
