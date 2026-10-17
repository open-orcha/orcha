/**
 * Parity round 3 (e2e-permissions-34): the Agents gate callout never tells a
 * viewer (or a non-member) a plan awaits THEIR approval — they can never give
 * it. Neutral title + "View plan"; the owner keeps "your approval" / "Review plan".
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ToastProvider } from "../../components/ui";
import { extensions, type Identity } from "../../extensions";
import { SnapshotProvider, _setActingIdentity } from "../../state/SnapshotProvider";
import { AgentsPage } from "./AgentsPage";

const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const SNAP = () => ({
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan", last_wake_scan_at: new Date().toISOString(), runtime_served: true },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", status: "idle", member_role: "owner" },
    { id: "h3", alias: "vera", kind: "human", status: "idle", member_role: "viewer" },
    { id: "a1", alias: "forge", kind: "ai", role: "Builder", status: "idle", model: "claude-opus-5", effective_autonomy: "plan" },
  ],
  tasks: [
    { id: "11111111-aaaa-4bbb-8ccc-000000000001", title: "Plan-gated task", status: "in_progress", priority: 50, assignees: ["forge"], created_at: ago(60),
      plan_message: { body: "My plan", author_alias: "forge", at: ago(30) } },
  ],
  requests: [],
});
const jsonRes = (d: unknown, status = 200) => ({ ok: status < 400, status, json: async () => d }) as Response;

beforeEach(() => {
  localStorage.clear();
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return jsonRes(SNAP());
    if (url === "/api/models") return jsonRes({ models: [] });
    if (url.endsWith("/runs")) return jsonRes({ runs: [] });
    return jsonRes({});
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete extensions.identity;
  _setActingIdentity(null);
});

function mount() {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={["/agents?agent=forge"]}>
          <Routes><Route path="*" element={<AgentsPage />} /></Routes>
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}
const card = () => document.querySelector(".gatecard.attn") as HTMLElement | null;

describe("gate callout copy follows who can act (e2e-permissions-34)", () => {
  it("viewer: 'Plan awaiting approval' + 'View plan'", async () => {
    extensions.identity = async () => ({ agent_id: "h3", alias: "vera", member_role: "viewer" }) as Identity;
    mount();
    await waitFor(() => expect(card()?.querySelector(".ttl")?.textContent).toBe("Plan awaiting approval"));
    expect(card()!.textContent).toContain("View plan");
    expect(card()!.textContent).not.toContain("your approval");
    expect(card()!.textContent).not.toContain("Review plan");
  });
  it("owner: 'Plan awaiting your approval' + 'Review plan'", async () => {
    extensions.identity = async () => ({ agent_id: "h1", alias: "kedar", member_role: "owner" }) as Identity;
    mount();
    await waitFor(() => expect(card()?.querySelector(".ttl")?.textContent).toBe("Plan awaiting your approval"));
    expect(card()!.textContent).toContain("Review plan");
  });
});
