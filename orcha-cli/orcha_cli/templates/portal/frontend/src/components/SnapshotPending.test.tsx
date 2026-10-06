/** QA: disconnected ≠ loading — a failed FIRST load is an error state with Retry, not an endless skeleton. */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SnapshotProvider } from "../state/SnapshotProvider";
import { SnapshotPending } from "./SnapshotPending";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("SnapshotPending", () => {
  it("shows a skeleton while loading, then the unavailable state when the backend fails", async () => {
    let fail: (() => void) | null = null;
    global.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/containers") return Promise.resolve({ ok: true, status: 200, json: async () => [{ id: "c1" }] } as Response);
      if (!url.startsWith("/api/containers/c1")) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response);
      return new Promise<Response>((res) => { fail = () => res({ ok: false, status: 503, json: async () => ({}) } as Response); });
    }) as unknown as typeof fetch;
    render(<SnapshotProvider pollMs={60_000}><SnapshotPending label="Loading tasks" what="tasks" /></SnapshotProvider>);
    expect(screen.getByRole("status", { name: "Loading tasks" })).toBeInTheDocument();
    await waitFor(() => expect(fail).not.toBeNull());
    fail!();
    expect(await screen.findByText("Couldn't load tasks")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading tasks" })).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
