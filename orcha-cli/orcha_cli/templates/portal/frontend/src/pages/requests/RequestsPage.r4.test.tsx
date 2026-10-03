/**
 * Linear polish round 4 (/requests + the RequestDetail Needs-you embeds):
 *  - after "Answer sent", a fresh snapshot that still says "open" keeps the detail on
 *    "Answered · syncing…" with no second Answer (R2 #9); the status moving clears it;
 *  - a project with no requests shows only the centred empty state (no pills / tools);
 *  - JSON-encoded string payloads (the backend stores payload as TEXT) read as fields;
 *  - the escalation event names its actor; the rail drops a Status row the card states.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { RequestsPage, _resetPendingAnswers, markAnswerPending, pendingAnswer } from "./RequestsPage";
import { payloadText, payloadTitle, requestTitle } from "./requestPayload";
import type { OrchaRequest } from "../../types";

const iso = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const baseRaw = () => ({
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [
    { id: "a1", alias: "forge", kind: "ai", status: "working" },
    { id: "a2", alias: "mira", kind: "ai", status: "idle" },
    { id: "h1", alias: "kedar", kind: "human", status: "idle" },
  ],
  tasks: [],
  requests: [
    { id: "r1", type: "question", status: "open", priority: 1, requester_id: "a1", target_id: "h1", created_at: iso(-60), payload: "Ship on Friday?" },
    { id: "r2", type: "task", status: "escalated", escalated: true, priority: 1, requester_id: "a2", target_id: null, created_at: iso(-30),
      payload: JSON.stringify({ summary: "Blocked on missing credentials for the review sandbox", task_id: "t9" }) },
  ],
});

let RAW: Record<string, unknown> = baseRaw();
let posts: string[] = [];
let snapFetches = 0;
beforeEach(() => {
  RAW = baseRaw();
  posts = [];
  snapFetches = 0;
  window.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") { posts.push(url); return { ok: true, status: 200, json: async () => ({}) } as Response; }
    if (url === "/api/containers") return { ok: true, status: 200, json: async () => [{ id: "c1", status: "active" }] } as Response;
    if (url.startsWith("/api/containers/c1")) { snapFetches++; return { ok: true, status: 200, json: async () => RAW } as Response; }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }));
});
afterEach(() => { _resetPendingAnswers(); cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

function mount(path = "/requests") {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[path]}>
          <RequestsPage />
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}
const detail = () => document.querySelector("#detailMain") as HTMLElement;

describe("answered · syncing survives a snapshot that hasn't caught up", () => {
  it("a fresh snapshot still saying 'open' keeps 'Answered · syncing…' and no Answer button", async () => {
    mount("/requests?req=r1");
    fireEvent.click(await within(await waitFor(() => { expect(detail()).toBeTruthy(); return detail(); })).findByRole("button", { name: /^Answer$/ }));
    fireEvent.change(await screen.findByRole("textbox", { name: /Your answer to forge/ }), { target: { value: "Yes, Friday." } });
    const before = snapFetches;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send answer" })); });
    await waitFor(() => expect(posts).toContain("/api/requests/r1/respond"));
    // the refresh after the POST lands — and the (lagging) backend still says "open"
    await waitFor(() => expect(snapFetches).toBeGreaterThan(before));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(within(detail()).getByRole("region", { name: "Answered · syncing…" })).toBeInTheDocument();
    expect(within(detail()).queryByRole("button", { name: /^Answer$/ })).toBeNull();
  });

  it("pure: kept while the snapshot says open, cleared once the status moves or the TTL passes", () => {
    const r = { id: "rx", status: "open" } as OrchaRequest;
    markAnswerPending("rx", "done", 1_000);
    expect(pendingAnswer(r, 2_000)?.text).toBe("done");
    expect(pendingAnswer({ ...r } as OrchaRequest, 30_000)?.text).toBe("done"); // a new snapshot object, still open
    expect(pendingAnswer({ ...r, status: "answered" } as OrchaRequest, 31_000)).toBeNull();
    expect(pendingAnswer(r, 32_000)).toBeNull(); // cleared for good once the status moved
    markAnswerPending("rx", "again", 0);
    expect(pendingAnswer(r, 61_001)).toBeNull();
  });
});

describe("empty project", () => {
  it("no requests at all: only the centred empty state — no pills, search, filter or sort", async () => {
    RAW = { ...baseRaw(), requests: [] };
    mount("/requests");
    expect(await screen.findByText("No requests yet")).toBeInTheDocument();
    expect(document.querySelector(".rq-listhead")).toBeNull();
    expect(screen.queryByRole("button", { name: "Search requests" })).toBeNull();
    expect(document.querySelector(".rq-empty.is-none .v2-empty")).toBeTruthy();
  });
});

describe("JSON-string payloads (payload is TEXT server-side)", () => {
  const s = JSON.stringify({ summary: "Reviewer blocked on missing credentials", task_id: "t9" });
  it("title / text / detail title read the headline field — never '{\"summary\"…'", () => {
    expect(payloadTitle(s)).toBe("Reviewer blocked on missing credentials");
    expect(payloadText(s)).toBe("Reviewer blocked on missing credentials");
    expect(requestTitle(s)).toBe("Reviewer blocked on missing credentials");
    expect(payloadText("{not json")).toBe("{not json");
  });

  it("row + detail render the fields, not raw JSON", async () => {
    mount("/requests?req=r2");
    await waitFor(() => expect(detail()?.querySelector(".rq-dtitle")?.textContent).toBe("Blocked on missing credentials for the review sandbox"));
    expect(document.querySelector('.qrow[data-id="r2"]')?.textContent).not.toContain("{");
    expect(detail().textContent).not.toContain('{"summary"');
    // wave-4: a task_id field is labelled "Task" (never "Task id")
    expect(within(detail()).getByText("Task")).toBeInTheDocument();
    expect(within(detail()).queryByText("Task id")).toBeNull();
  });
});

describe("escalation: actor, and the status stated once", () => {
  it("the timeline names who escalated; the rail has no Status row next to 'Escalated to you'", async () => {
    mount("/requests?req=r2");
    const card = await waitFor(() => within(detail()).getByRole("region", { name: "Escalated to you" }));
    expect(card).toBeInTheDocument();
    const act = within(detail()).getByRole("list", { name: "Request activity" });
    expect(act.textContent).toMatch(/mira\s*escalated to\s*a human/);
    const rail = detail().querySelector(".rq-rail") as HTMLElement;
    expect(within(rail).queryByText("Status")).toBeNull();
  });

  it("an open request still states its status once in the rail", async () => {
    mount("/requests?req=r1");
    await waitFor(() => within(detail()).getByRole("region", { name: "forge asks you" }));
    expect(within(detail().querySelector(".rq-rail") as HTMLElement).getByText("Status")).toBeInTheDocument();
  });
});
