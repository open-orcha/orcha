import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../../shell/Shell", () => ({ Shell: ({ children }: { children: React.ReactNode }) => <main>{children}</main> }));
vi.mock("../../state/SnapshotProvider", () => ({ useSnapshot: () => ({ cid: "project", identity: null, identityTrusted: false, identityPending: false }) }));
import { WorkflowsPage } from "./WorkflowsPage";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("does not call missing workflow routes, retry repeatedly, or treat actor selection as sign-in", async () => {
  const fetch = vi.fn(async (_url: RequestInfo | URL, _options?: RequestInit) => ({ ok: true, json: async () => ({ paths: {} }) }));
  vi.stubGlobal("fetch", fetch);
  render(<MemoryRouter initialEntries={["/workflows/new?cid=project"]}><WorkflowsPage /></MemoryRouter>);
  expect(await screen.findByText(/doesn’t support Workflows yet/)).toBeVisible();
  expect(screen.getByText(/Verified sign-in is required/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Save workflow" })).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe("/openapi.json");
});

it("treats malformed discovery as unknown and recovers only on an explicit check", async () => {
  const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({}) })
    .mockResolvedValueOnce({ ok: true, json: async () => ({ paths: { "/api/containers/{cid}/workflows": { get: {} } } }) });
  vi.stubGlobal("fetch", fetch);
  render(<MemoryRouter><WorkflowsPage /></MemoryRouter>);
  expect(await screen.findByText(/support could not be checked/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Check again" }));
  await waitFor(() => expect(screen.getByText(/cannot use this server’s Workflows features yet/)).toBeVisible());
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("link", { name: "Open tasks" })).toHaveAttribute("href", "/tasks?cid=project");
});
