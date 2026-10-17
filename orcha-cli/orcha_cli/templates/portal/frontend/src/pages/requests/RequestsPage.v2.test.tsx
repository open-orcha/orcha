/**
 * V2 Requests: filter/search in the URL, exact status + direction, chain
 * navigation, failed actions keep typed input (answer, convert, close), and
 * the agent-suggestion decision (PI-10) when the request carries the
 * backend's `detail.proposed_alias` marker.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider, useSnapshot } from "../../state/SnapshotProvider";
import type { OrchaRequest } from "../../types";
import { RequestDetail, RequestsPage, requestMatches, suggestionOf, _resetPendingAnswers } from "./RequestsPage";

const RAW = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [
    { id: "a1", alias: "forge", kind: "ai", status: "idle" },
    { id: "a2", alias: "mira", kind: "ai", status: "idle" },
    { id: "h1", alias: "kedar", kind: "human", status: "idle" },
  ],
  tasks: [],
  requests: [
    { id: "r1", type: "question", status: "open", priority: 30, requester_id: "a1", target_id: "h1", payload: "Which database?", created_at: "2026-08-01T00:00:00Z" },
    { id: "r2", type: "task", status: "answered", priority: 10, requester_id: "h1", target_id: "a1", payload: "Build the parser", response: "Done — see PR", created_at: "2026-08-02T00:00:00Z", responded_at: "2026-08-02T02:00:00Z", expires_at: "2026-09-01T00:00:00Z" },
    { id: "r3", type: "question", status: "open", priority: 50, requester_id: "a2", target_id: "a1", payload: "Child of r2", parent_request_id: "r2", chain_depth: 1, created_at: "2026-08-03T00:00:00Z" },
  ],
};

let fail: Record<string, number> = {};
let calls: { url: string; body: unknown }[] = [];
let loc = { search: "" };

beforeEach(() => {
  fail = {};
  calls = [];
  window.scrollTo = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init && typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url, body });
      if (url === "/api/containers") return { ok: true, status: 200, json: async () => [{ id: "c1", status: "active" }] } as Response;
      if (url.startsWith("/api/containers/c1")) return { ok: true, status: 200, json: async () => RAW } as Response;
      const key = Object.keys(fail).find((k) => url.endsWith(k));
      if (key) return { ok: false, status: fail[key], statusText: "err", json: async () => ({ detail: "server says no" }), text: async () => JSON.stringify({ detail: "server says no" }) } as Response;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }),
  );
});
afterEach(() => { _resetPendingAnswers();
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function Probe() {
  loc = { search: useLocation().search };
  return null;
}
function mount(path = "/requests") {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[path]}>
          <RequestsPage />
          <Probe />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}
const rowIds = () => Array.from(document.querySelectorAll(".qrow")).map((r) => r.getAttribute("data-id"));

describe("RequestsPage V2", () => {
  it("filter persists as ?filter= and search as ?q=", async () => {
    mount();
    await waitFor(() => expect(rowIds()).toHaveLength(3));
    // wave-4: the type filter lives in the filter menu (a fifth pill overflowed the list head)
    expect(screen.queryByRole("radio", { name: /^Tasks/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Direction:/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Task requests only/ }));
    await waitFor(() => expect(rowIds()).toEqual(["r2"]));
    expect(new URLSearchParams(loc.search).get("filter")).toBe("task");
    // while selected it shows as a pill, so the active filter is visible
    expect(screen.getByRole("radio", { name: /^Tasks/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /^All/ }));
    fireEvent.click(screen.getByRole("button", { name: "Search requests" }));
    fireEvent.change(await screen.findByRole("searchbox", { name: "Search requests" }), { target: { value: "database" } });
    await waitFor(() => expect(new URLSearchParams(loc.search).get("q")).toBe("database"));
    expect(rowIds()).toEqual(["r1"]);
  });

  it("detail shows exact status, direction and the full field set", async () => {
    mount("/requests?req=r2");
    const detail = await waitFor(() => {
      const d = document.querySelector("#detailMain");
      expect(d).toBeTruthy();
      return d as HTMLElement;
    });
    expect(detail.querySelector('[data-status="answered"]')?.textContent).toContain("Answered");
    // direction reads from the flow line itself ("you → forge"), never a second "from you" marker
    expect(detail.querySelector(".rq-flowline")?.textContent).toMatch(/you.*forge/);
    expect(detail.querySelector(".rq-flowline")?.textContent).not.toContain("from you");
    expect(detail.textContent).toContain("Responded");
    expect(detail.textContent).toContain("Expires");
    // chain: r2 has child r3 — clicking selects it
    fireEvent.click(within(detail).getByRole("button", { name: /mira → forge/ }));
    await waitFor(() => expect(new URLSearchParams(loc.search).get("req")).toBe("r3"));
  });

  it("a failed answer keeps the typed text and shows why", async () => {
    fail = { "/respond": 409 };
    mount("/requests?req=r1");
    fireEvent.click(await screen.findByRole("button", { name: /^Answer$/ }));
    fireEvent.change(await screen.findByPlaceholderText(/forge sees it verbatim/), { target: { value: "Postgres" } });
    fireEvent.click(screen.getByRole("button", { name: /Send answer/ }));
    expect(await screen.findByText(/Answer not sent/)).toBeInTheDocument();
    expect((document.querySelector("#ansIn") as HTMLTextAreaElement).value).toBe("Postgres");
  });

  it("a failed convert keeps the modal open with the typed fields", async () => {
    fail = { "/convert-to-task": 403 };
    mount("/requests?req=r2");
    fireEvent.click(await screen.findByRole("button", { name: /Convert to task/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByPlaceholderText("When is this task done?"), { target: { value: "Parser merged" } });
    fireEvent.click(within(dialog).getByText("Create task"));
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toContain("Not converted"));
    expect((within(dialog).getByPlaceholderText("When is this task done?") as HTMLTextAreaElement).value).toBe("Parser merged");
    const c = calls.find((x) => x.url === "/api/requests/r2/convert-to-task");
    expect(c?.body).toMatchObject({ requester_agent_id: "h1", definition_of_done: "Parser merged", assignee_alias: "forge" });
  });

  it("close without a reason on someone else's request explains the 422", async () => {
    fail = { "/close": 422 };
    mount("/requests?req=r3");
    fireEvent.click(await screen.findByRole("button", { name: /Close…/ }));
    const dialog = await screen.findByRole("dialog");
    // r2: disabled client-side until a reason is typed (the server gate stays the enforcer)
    expect(within(dialog).getByRole("button", { name: "Close request" })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "  x " } });
    fireEvent.click(within(dialog).getByText("Close request"));
    await waitFor(() => expect(within(dialog).getByRole("alert").textContent).toContain("A reason is required"));
  });
});

describe("requestMatches / suggestionOf", () => {
  it("Escalations filter includes status=escalated", () => {
    const r = { id: "x", type: "q", status: "escalated", from: "forge", to: "mira", payload: "p", requester_id: "a1", target_id: "a2" } as unknown as OrchaRequest;
    expect(requestMatches(null, r, "escalated", "")).toBe(true);
  });
  it("suggestionOf reads the backend's proposed_alias marker only", () => {
    expect(suggestionOf({ detail: { proposed_alias: "scout", proposed_role: "research" } } as unknown as OrchaRequest)?.proposed_alias).toBe("scout");
    expect(suggestionOf({ detail: { title: "t" } } as unknown as OrchaRequest)).toBeNull();
    expect(suggestionOf({} as OrchaRequest)).toBeNull();
  });
});

describe("agent-suggestion decision (PI-10)", () => {
  function Harness() {
    const { snap } = useSnapshot();
    if (!snap) return null;
    const r = {
      ...snap.requests[0],
      detail: { proposed_alias: "scout", proposed_role: "research", proposed_prompt: "Find things", rationale: "Nobody researches" },
    } as OrchaRequest;
    return <RequestDetail r={r} onSelect={() => {}} />;
  }
  it("create posts the human decision to /api/agent-suggestions/{rid}/decide", async () => {
    render(
      <ToastProvider>
        <SnapshotProvider>
          <MemoryRouter>
            <Harness />
          </MemoryRouter>
        </SnapshotProvider>
      </ToastProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Create agent…/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("scout");
    fireEvent.click(within(dialog).getByText("Create agent"));
    await waitFor(() => {
      const c = calls.find((x) => x.url === "/api/agent-suggestions/r1/decide");
      expect(c?.body).toEqual({ kind: "create", actor_agent_id: "h1" });
    });
  });
});
