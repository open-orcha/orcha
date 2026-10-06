/**
 * Agent limit — Needs you / Requests (both render RequestDetail → SuggestionDecision):
 * "Create agent" refused at the project's cap shows the plain sentence (never the raw
 * "/api/agent-suggestions/<id>/decide → 409"), a link to Settings → Execution, and Retry.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider, useSnapshot } from "../../state/SnapshotProvider";
import type { OrchaRequest } from "../../types";
import { RequestDetail, _resetPendingAnswers } from "./RequestsPage";

const RAW = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan", max_auto_agents: 3, auto_agents_in_use: 3 },
  agents: [
    { id: "a1", alias: "forge", kind: "ai", status: "idle" },
    { id: "h1", alias: "kedar", kind: "human", status: "idle" },
  ],
  tasks: [],
  requests: [
    { id: "r1", type: "task", status: "open", priority: 30, requester_id: "a1", target_id: "h1", payload: "need a scout", created_at: "2026-08-01T00:00:00Z" },
  ],
};
const CAP_DETAIL = "this project already has 3 suggested agents (the limit is 3). Reassign the work to an existing agent, or retire an agent created from a suggestion.";
let decideCalls = 0;
let capped = true;

beforeEach(() => {
  decideCalls = 0;
  capped = true;
  window.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response;
    if (url === "/api/containers") return ok([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return ok(RAW);
    if (url === "/api/agent-suggestions/r1/decide") {
      decideCalls++;
      if (capped) return { ok: false, status: 409, statusText: "Conflict", json: async () => ({ detail: CAP_DETAIL }) } as Response;
      return ok({ kind: "create" });
    }
    return ok({});
  }));
});
afterEach(() => { _resetPendingAnswers(); cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

function Harness() {
  const { snap } = useSnapshot();
  if (!snap) return null;
  const r = { ...snap.requests[0], detail: { proposed_alias: "scout", proposed_role: "research", proposed_prompt: "p", rationale: "r" } } as OrchaRequest;
  return <RequestDetail r={r} onSelect={() => {}} />;
}

describe("Create agent at the agent limit", () => {
  it("shows the friendly cap sentence + Settings link, keeps Retry, never the raw path", async () => {
    render(<ToastProvider><SnapshotProvider><MemoryRouter><Harness /></MemoryRouter></SnapshotProvider></ToastProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /Create agent…/ }));
    const dialog = await screen.findByRole("dialog");
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Create agent" })); });
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("This project allows up to 3 suggested agents and already has 3. Raise the limit in Settings → Execution, or reassign this work to an existing agent.");
    expect(dialog.textContent).not.toMatch(/\/api\/agent-suggestions|→ 409|\(409\)/);
    expect(within(alert).getByRole("link", { name: /Open Settings → Execution/ }).getAttribute("href")).toBe("/settings#tab=execution");
    // Retry re-sends the same decision
    capped = false;
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "Retry" })); });
    await waitFor(() => expect(decideCalls).toBe(2));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
