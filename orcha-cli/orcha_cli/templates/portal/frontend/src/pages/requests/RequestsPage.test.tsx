/**
 * RequestsPage tests — stubbed fetch (containers + snapshot), real
 * SnapshotProvider/ToastProvider, MemoryRouter for the hash-router search.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { RequestsPage, _resetPendingAnswers } from "./RequestsPage";

/* ---- raw backend snapshot (mapSnapshot input shape) ---------------------- */
const rawSnapshot = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [
    { id: "a1", alias: "forge", kind: "ai", status: "idle" },
    { id: "h1", alias: "kedar", kind: "human", status: "idle" },
  ],
  tasks: [],
  requests: [
    {
      id: "r1", type: "question", status: "open", priority: 30,
      requester_id: "a1", target_id: null, payload: "Need a decision on X",
      created_at: "2026-08-01T00:00:00Z",
    },
    {
      id: "r2", type: "review", status: "answered", priority: 50,
      requester_id: "a1", target_id: "h1", payload: "Second request payload",
      response: "Looks good", created_at: "2026-08-02T00:00:00Z",
      responded_at: "2026-08-02T01:00:00Z",
    },
    {
      id: "r3", type: "question", status: "open", priority: 40,
      requester_id: "h1", target_id: "a1", payload: "Is the build green?",
      created_at: "2026-08-03T00:00:00Z",
    },
  ],
};

const jsonRes = (data: unknown): Response =>
  ({ ok: true, status: 200, json: async () => data }) as Response;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (url.startsWith("/api/containers/c1")) return jsonRes(rawSnapshot);
    return jsonRes({});
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => { _resetPendingAnswers();
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function mount(initialPath = "/requests") {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <RequestsPage />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

describe("RequestsPage", () => {
  it("renders the request list from the snapshot", async () => {
    const { container } = mount();
    await waitFor(() => {
      expect(container.querySelectorAll(".qrow").length).toBe(3);
    });
    // D12: no "N open · M total" header fragment — the pills carry the counts
    expect(screen.queryByText("2 open · 3 total")).toBeNull();
    expect(screen.getByRole("radio", { name: /^Open\s*2/ })).toBeInTheDocument();
    expect(screen.getAllByText("Need a decision on X").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Second request payload").length).toBeGreaterThan(0);
    // first open request auto-selected → its detail (actions) is shown
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^Answer$/ })).toBeInTheDocument();
    });
  });

  it("honors the ?req= deep link and selects that request", async () => {
    const { container } = mount("/requests?req=r2");
    await waitFor(() => {
      const sel = container.querySelector(".qrow.is-selected");
      expect(sel).not.toBeNull();
      expect(sel!.textContent).toContain("Second request payload");
    });
    // detail shows r2's payload as the title (not repeated below) and its answer block
    const detail = container.querySelector("#detailMain")!;
    expect(detail.querySelector(".wk-dtitle")!.textContent).toBe("Second request payload");
    expect(detail.querySelector(".payload")).toBeNull();
    expect(detail.querySelector(".answer")!.textContent).toContain("Looks good");
  });

  it("answering posts the exact respond body with the acting human id", async () => {
    mount();
    // r1 (open, to human) is auto-selected; acting human = kedar (h1)
    const answerBtn = await screen.findByRole("button", { name: /^Answer$/ });
    fireEvent.click(answerBtn);
    const box = await screen.findByPlaceholderText(/Type your answer — forge sees it verbatim/);
    fireEvent.change(box, { target: { value: "Approved — ship it." } });
    fireEvent.click(screen.getByRole("button", { name: /Send answer/ }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]) => String(u).includes("/respond"));
      expect(call).toBeTruthy();
      const [url, init] = call as [string, RequestInit];
      expect(url).toBe("/api/requests/r1/respond");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({
        responder_agent_id: "h1",
        response: "Approved — ship it.",
      });
    });
  });

  it("nudge posts the exact body and toasts on nudged:true", async () => {
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
      if (url.startsWith("/api/containers/c1")) return jsonRes(rawSnapshot);
      if (url === "/api/requests/r3/nudge" && init?.method === "POST") {
        return jsonRes({ request_id: "r3", status: "open", nudged: true, nudged_role: "target", nudged_agent_id: "a1" });
      }
      return jsonRes({});
    });
    vi.stubGlobal("fetch", fetchMock);

    mount("/requests?req=r3");
    const nudgeBtn = await screen.findByRole("button", { name: /Nudge/ });
    fireEvent.click(nudgeBtn);
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u]) => String(u).includes("/nudge"));
      expect(call).toBeTruthy();
      const [url, init] = call as [string, RequestInit];
      expect(url).toBe("/api/requests/r3/nudge");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({ actor_agent_id: "h1" });
    });
    expect(await screen.findByText(/Nudge sent/)).toBeInTheDocument();
  });

  it("nudge with nudged:false is a clean no-op toast — never changes request state", async () => {
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
      if (url.startsWith("/api/containers/c1")) return jsonRes(rawSnapshot);
      if (url === "/api/requests/r3/nudge" && init?.method === "POST") {
        return jsonRes({ request_id: "r3", status: "open", nudged: false, nudged_role: "target", nudged_agent_id: null, reason: "a human owns the next action — nothing to wake" });
      }
      return jsonRes({});
    });
    vi.stubGlobal("fetch", fetchMock);

    mount("/requests?req=r3");
    const nudgeBtn = await screen.findByRole("button", { name: /Nudge/ });
    fireEvent.click(nudgeBtn);
    expect(await screen.findByText(/Nothing to wake/)).toBeInTheDocument();
    // no state mutation happened client-side: the open-only Escalate action is still offered (in ⋯)
    fireEvent.click(screen.getByRole("button", { name: "More request actions" }));
    expect(await screen.findByRole("menuitem", { name: /Escalate to human/ })).toBeInTheDocument();
  });

  it("nudge 409 surfaces the not-actionable detail from the server", async () => {
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
      if (url.startsWith("/api/containers/c1")) return jsonRes(rawSnapshot);
      if (url === "/api/requests/r3/nudge" && init?.method === "POST") {
        return {
          ok: false,
          status: 409,
          json: async () => ({ detail: "nothing to nudge: request is 'closed'" }),
        } as Response;
      }
      return jsonRes({});
    });
    vi.stubGlobal("fetch", fetchMock);

    mount("/requests?req=r3");
    const nudgeBtn = await screen.findByRole("button", { name: /Nudge/ });
    fireEvent.click(nudgeBtn);
    expect(await screen.findByText(/nothing to nudge: request is 'closed'/)).toBeInTheDocument();
  });

  it("does not offer Nudge when the next action is yours (request addressed to you)", async () => {
    mount("/requests?req=r1");
    await screen.findByRole("button", { name: /^Answer$/ });
    expect(screen.queryByRole("button", { name: /Nudge/ })).toBeNull();
  });
});
