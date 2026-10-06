/**
 * QA regressions for /needs:
 *  - #10 the optimistic `acted` suppression is pruned once the snapshot
 *    confirms the decision, so a re-raised verification (same key) shows again.
 *  - #14 a failed FIRST load is an error state with Retry, not "Loading…".
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { _resetProjectsForTests } from "../../state/projects";
import { NeedsPage, _resetNeedsHistory } from "./NeedsPage";

const base = { assignees: ["forge"], created_by_agent_id: "h1", definition_of_done: "It works", message_summary: { count: 1, last: null } };
let SNAP: Record<string, unknown>;
let snapStatus = 200;
const jsonRes = (data: unknown, status = 200) => ({ ok: status < 300, status, json: async () => data }) as Response;
const t2 = (status: string) => ({ ...base, id: "t2", title: "Verify me", status, priority: 20, created_at: "2026-08-02T00:00:00Z", result: "Done it" });

beforeEach(() => {
  _resetNeedsHistory();
  _resetProjectsForTests();
  snapStatus = 200;
  SNAP = {
    container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
    agents: [
      { id: "h1", alias: "kedar", kind: "human", status: "idle", member_role: "owner" },
      { id: "a1", alias: "forge", kind: "ai", status: "working" },
    ],
    tasks: [t2("needs_verification")],
    requests: [],
  };
  window.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return jsonRes([{ id: "c1", name: "Orcha", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return snapStatus === 200 ? jsonRes(SNAP) : jsonRes({ detail: "down" }, snapStatus);
    if (/\/runs$/.test(url)) return jsonRes([]);
    return jsonRes({ ok: true });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

const mount = (entry = "/needs") =>
  render(
    <ToastProvider>
      <SnapshotProvider pollMs={40}>
        <MemoryRouter initialEntries={[entry]}>
          <NeedsPage />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
const row = () => document.querySelector('[data-id="verify:t2"]');

describe("NeedsPage QA", () => {
  it("#10 a rejected verification that is resubmitted reappears in the queue", async () => {
    mount("/needs?item=verify:t2");
    await waitFor(() => expect(document.querySelector("#gate-t2")).toBeTruthy());
    fireEvent.click(document.querySelector('#gate-t2 [data-act="reject"]')!);
    fireEvent.change(document.querySelector("#rt-t2")!, { target: { value: "not done" } });
    fireEvent.click(document.querySelector("#cr-t2")!);
    // optimistic hide
    await waitFor(() => expect(row()).toBeNull());
    // snapshot confirms (task back in progress) → suppression pruned
    SNAP = { ...SNAP, tasks: [t2("in_progress")] };
    await new Promise((r) => setTimeout(r, 200));
    expect(row()).toBeNull();
    // agent resubmits: same key verify:t2 must show again
    SNAP = { ...SNAP, tasks: [t2("needs_verification")] };
    await waitFor(() => expect(row()).toBeTruthy(), { timeout: 2000 });
  });

  it("#14 a failed first load shows an unavailable state with Retry, not an endless skeleton", async () => {
    snapStatus = 503;
    mount();
    expect(await screen.findByText("Couldn't load decisions", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading decisions" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Retry" }).length).toBeGreaterThan(0); // the shell stale bar may add its own
  });
});
