import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProjectWorktreeCleanup } from "./ProjectWorktreeCleanup";

const calls: Array<Record<string, unknown>> = [];
afterEach(() => { cleanup(); vi.unstubAllGlobals(); calls.length = 0; });
it("waits for a complete preview and confirms only its saved identifier", async () => {
  const result = { plan_id: "saved-preview", status: "ready", scanned: 1, total: 1,
    candidate_count: 1, candidate_bytes: 400, unknown_sizes: 0, removed: [],
    items: [{ name: "outside", path: "/tmp/review", state: "eligible", reason: "work saved first" }] };
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (body) calls.push(body);
    return { ok: true, status: 200, json: async () => ({ id: "action", status: "done", result }) };
  }));
  render(<ProjectWorktreeCleanup cid="project" humanId="owner" locked={false} />);
  expect(screen.queryByText("Save work and remove 1 folders")).toBeNull();
  fireEvent.click(screen.getByText("Preview project-wide cleanup"));
  fireEvent.click(await screen.findByText("Save work and remove 1 folders"));
  await waitFor(() => expect(calls[1]).toEqual({ phase: "execute", plan_id: "saved-preview", actor_agent_id: "owner" }));
});
it("keeps the action unavailable to a viewer", () => {
  render(<ProjectWorktreeCleanup cid="project" locked={true} />);
  expect(screen.getByRole("button", { name: "Preview project-wide cleanup" })).toBeDisabled();
});
