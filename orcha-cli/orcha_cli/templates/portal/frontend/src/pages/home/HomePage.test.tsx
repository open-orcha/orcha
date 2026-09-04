/**
 * HomePage — action-queue behavior (#367 autonomy gating) and the human-gated
 * verify endpoint contract. fetch is stubbed; snapshot flows through the real
 * SnapshotProvider + mapSnapshot, matching foundation.test.ts style.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HashRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { HomePage } from "./HomePage";

interface Call { url: string; method: string; body: unknown }

const rawSnap = (autonomy: string) => ({
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: autonomy },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", status: "idle" },
    { id: "a1", alias: "forge", kind: "ai", status: "working", model: "claude" },
  ],
  tasks: [
    {
      id: "t1", title: "Ship the feature", status: "needs_verification",
      assignees: ["forge"], definition_of_done: "It works end to end",
      created_at: "2026-08-01T00:00:00Z", started_at: "2026-08-01T00:00:00Z",
    },
  ],
  requests: [],
});

function stubFetch(autonomy: string): Call[] {
  const calls: Call[] = [];
  const json = (data: unknown) =>
    ({ ok: true, status: 200, json: async () => data }) as unknown as Response;
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method || "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url === "/api/containers") return json([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return json(rawSnap(autonomy));
    return json({});
  }) as unknown as typeof fetch;
  return calls;
}

function mount() {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <HashRouter>
          <HomePage />
        </HashRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("HomePage action queue (#367 autonomy gating)", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("renders a needs_verification task as a verify card at autonomy 'plan'", async () => {
    stubFetch("plan");
    mount();
    expect(await screen.findByText("Verify task")).toBeInTheDocument();
    expect(screen.getAllByText("Ship the feature").length).toBeGreaterThan(0);
    expect(document.getElementById("aqBadge")).toHaveTextContent("1");
  });

  it("renders a needs_verification task as a verify card at autonomy 'pr'", async () => {
    stubFetch("pr");
    mount();
    expect(await screen.findByText("Verify task")).toBeInTheDocument();
  });

  it("hides the verify card at autonomy 'full'", async () => {
    stubFetch("full");
    mount();
    expect(await screen.findByText("✓ Nothing needs you right now.")).toBeInTheDocument();
    expect(screen.queryByText("Verify task")).not.toBeInTheDocument();
    expect(document.getElementById("aqBadge")).toHaveTextContent("0");
  });
});

describe("HomePage gate actions (human-gated verify contract)", () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("Accept posts approve:true with the acting human's id", async () => {
    const calls = stubFetch("plan");
    mount();
    await screen.findByText("Verify task");
    fireEvent.click(screen.getByRole("button", { name: /Accept/ }));
    await waitFor(() => {
      const v = calls.find((c) => c.url === "/api/tasks/t1/verify");
      expect(v).toBeTruthy();
      expect(v!.method).toBe("POST");
      expect(v!.body).toEqual({ approve: true, actor_agent_id: "h1" }); // feedback omitted on approve
    });
    // acted-suppression: the card disappears without waiting for the next poll
    await waitFor(() => expect(screen.queryByText("Verify task")).not.toBeInTheDocument());
  });

  it("Reject requires a typed reason, then posts approve:false with feedback", async () => {
    const calls = stubFetch("plan");
    mount();
    await screen.findByText("Verify task");
    fireEvent.click(screen.getByRole("button", { name: "Reject…" }));
    const submit = screen.getByRole("button", { name: "Submit rejection" });
    expect(submit).toBeDisabled(); // reason is required (.gate .reason flow)
    fireEvent.change(screen.getByPlaceholderText("What needs fixing? (required)"), {
      target: { value: "needs work" },
    });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => {
      const v = calls.find((c) => c.url === "/api/tasks/t1/verify");
      expect(v).toBeTruthy();
      expect(v!.body).toEqual({ approve: false, actor_agent_id: "h1", feedback: "needs work" });
    });
  });
});
