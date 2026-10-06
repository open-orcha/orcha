/**
 * Linear polish round 1 (/requests):
 *  - "Escalated" pill = actually escalated requests only; "Task requests" pill hidden when none.
 *  - The decision card is titled by who owns the NEXT action ("Your move" only for you,
 *    else "Waiting on maria" / "Answered · waiting on frontend-dev"); never "Nothing needed".
 *  - Nudge names its target ("Nudge forge").
 *  - Title = first sentence (capped); the body never repeats it (object payloads too).
 *  - One id (no "#"), quiet task link, bucket-only priority, distinct toolbar icons.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import type { Agent, OrchaRequest } from "../../types";
import { RequestsPage, filterKeyOf, requestMatches, requestNextStep, _resetPendingAnswers } from "./RequestsPage";
import { payloadAfterTitle, requestTitle } from "./requestPayload";
import { listCss } from "./requestsCss";

const iso = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const LONG = "Should the billing migration run during business hours, or wait for the Saturday 02:00 UTC window? Month-end invoicing overlaps the weekday option.";
const RAW = {
  container: { id: "c1", name: "Orcha", status: "active", autonomy_level: "plan" },
  agents: [
    { id: "a1", alias: "forge", kind: "ai", status: "working" },
    { id: "a2", alias: "mira", kind: "ai", status: "idle" },
    { id: "h1", alias: "kedar", kind: "human", status: "idle" },
    { id: "h2", alias: "maria", kind: "human", status: "idle" },
  ],
  tasks: [{ id: "t1", title: "Billing plan", status: "in_progress", assignees: [], priority: 2 }],
  requests: [
    { id: "r1", type: "question", status: "open", priority: 1, requester_id: "a1", target_id: "h1", created_at: iso(-60),
      payload: { question: LONG }, task_link: { task_id: "t1", title: "Billing plan", status: "in_progress" } },
    { id: "r2", type: "handoff", status: "answered", priority: 100, requester_id: "a1", target_id: "a2", created_at: iso(-50),
      payload: "API shape for /metrics", response: "Done", responded_at: iso(-40) },
    { id: "r3", type: "question", status: "open", priority: 100, requester_id: "a2", target_id: "h2", created_at: iso(-40),
      payload: "Maria: can you confirm the copy tone?" },
    { id: "r4", type: "info", status: "escalated", priority: 100, requester_id: "a1", target_id: "a2", created_at: iso(-30),
      payload: "Staging is blocked on the TLS cert. Renew it?" },
    { id: "r5", type: "question", status: "closed", priority: 100, requester_id: "a2", target_id: "h1", created_at: iso(-900),
      payload: "Old question" },
  ],
};

beforeEach(() => {
  window.scrollTo = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/containers") return { ok: true, status: 200, json: async () => [{ id: "c1", status: "active" }] } as Response;
    if (url.startsWith("/api/containers/c1")) return { ok: true, status: 200, json: async () => RAW } as Response;
    return { ok: true, status: 200, json: async () => ({ nudged: true }) } as Response;
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
const rowIds = () => Array.from(document.querySelectorAll(".qrow")).map((r) => r.getAttribute("data-id"));

describe("filters", () => {
  it("REQ-013: 'To a human' restores the old Escalations set — every request to a human, plus escalations", () => {
    const base = { id: "x", type: "question", from: "forge", to: "human", payload: "p", requester_id: "a1", target_id: "h1" };
    const snap = { agents: RAW.agents, requests: [], tasks: [] } as never;
    expect(requestMatches(snap, { ...base, status: "open" } as unknown as OrchaRequest, "human", "")).toBe(true);
    expect(requestMatches(snap, { ...base, status: "closed" } as unknown as OrchaRequest, "human", "")).toBe(true);
    // AI → AI is not to a human… unless it was escalated (legacy status)
    const ai = { ...base, to: "mira", target_id: "a2" };
    expect(requestMatches(snap, { ...ai, status: "open" } as unknown as OrchaRequest, "human", "")).toBe(false);
    expect(requestMatches(snap, { ...ai, status: "escalated" } as unknown as OrchaRequest, "human", "")).toBe(true);
    // the old ?filter=escalated key is the same filter
    expect(filterKeyOf("escalated")).toBe("human");
  });

  it("pills read 'To a human 4' (old ?filter=escalated links land there); no 'Tasks' pill when the project has none", async () => {
    mount("/requests?filter=escalated");
    await waitFor(() => expect(rowIds().sort()).toEqual(["r1", "r3", "r4", "r5"]));
    expect(screen.getByRole("radio", { name: /^To a human\s*4/ })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: /^Tasks/ })).toBeNull();
  });

  it("Direction and Sort buttons use distinct icons", async () => {
    mount();
    await waitFor(() => expect(rowIds().length).toBeGreaterThan(0));
    const dirIco = screen.getByRole("button", { name: /^Direction:/ }).innerHTML;
    const sortIco = screen.getByRole("button", { name: /^Sort:/ }).innerHTML;
    expect(dirIco).not.toBe(sortIco);
  });
});

describe("decision card — titled by who owns the next action", () => {
  const h = { id: "h1", alias: "kedar", kind: "human" } as Agent;
  const snap = { agents: RAW.agents, requests: [], tasks: [] } as never;
  const req = (o: Partial<OrchaRequest>) => ({ id: "q", type: "question", status: "open", from: "forge", to: "mira", requester_id: "a1", target_id: "a2", payload: "p", ...o }) as OrchaRequest;

  it("pure: you / waiting on target / answered · waiting on requester / escalated", () => {
    expect(requestNextStep(snap, req({ to: "kedar", target_id: "h1" }), h)).toMatchObject({ mine: true, title: "forge asks you" });
    // the card names the decision by request type (Linear's triage card), never a vague "Your move"
    expect(requestNextStep(snap, req({ to: "kedar", target_id: "h1", type: "review" }), h)).toMatchObject({ mine: true, title: "Review requested from you" });
    expect(requestNextStep(snap, req({ to: "kedar", target_id: "h1", type: "handoff" }), h)).toMatchObject({ mine: true, title: "Handoff to you" });
    expect(requestNextStep(snap, req({ to: "kedar", target_id: "h1", type: "task" }), h)).toMatchObject({ mine: true, title: "forge asks you to take a task" });
    expect(requestNextStep(snap, req({}), h)).toMatchObject({ mine: false, title: "Waiting on mira" });
    expect(requestNextStep(snap, req({ status: "answered" }), h)).toMatchObject({ mine: false, title: "Answered · waiting on forge" });
    // your own question came back: who answered + what is left (never a bare "Your move")
    // a question: "<who> answered" (Resolve is primary); a WORK request keeps "convert or close"
    expect(requestNextStep(snap, req({ status: "answered", from: "kedar", requester_id: "h1" }), h)).toMatchObject({ mine: true, title: "mira answered" });
    expect(requestNextStep(snap, req({ status: "answered", from: "kedar", requester_id: "h1", type: "task" }), h)).toMatchObject({ mine: true, title: "mira answered — convert or close" });
    expect(requestNextStep(snap, req({ to: "kedar", target_id: "h1", escalated: true }), h)).toMatchObject({ mine: true, title: "Escalated to you" });
    // legacy "escalated" is counted as yours by Needs you — the card must agree (never "waiting on X")
    expect(requestNextStep(snap, req({ status: "escalated" }), h)).toMatchObject({ mine: true, title: "Escalated to you" });
    expect(requestNextStep(snap, req({ status: "escalated" }), null)).toMatchObject({ mine: false, title: "Escalated · waiting on mira" });
  });

  it("agent-to-agent handoff: 'Answered · waiting on forge' with 'Nudge forge' — never 'Your move' / 'Nothing needed'", async () => {
    mount("/requests?req=r2");
    const card = await waitFor(() => within(detail()).getByRole("region", { name: "Answered · waiting on forge" }));
    expect(card.textContent).not.toMatch(/Your move|Nothing needed/);
    expect(within(card).getByRole("button", { name: "Nudge forge" })).toBeInTheDocument();
    expect(within(card).getByRole("img", { name: /forge picks up the answer/ })).toBeInTheDocument();
  });

  it("a request to another human: 'Waiting on maria' with only Close…", async () => {
    mount("/requests?req=r3");
    const card = await waitFor(() => within(detail()).getByRole("region", { name: "Waiting on maria" }));
    expect(within(card).getAllByRole("button").map((b) => b.textContent)).toEqual(["Close…"]);
    expect(detail().textContent).not.toContain("Nothing needed");
  });

  it("a legacy escalated request is 'Escalated to you' (as Needs counts it) with Close… only — never 'waiting on'", async () => {
    mount("/requests?req=r4");
    const card = await waitFor(() => within(detail()).getByRole("region", { name: "Escalated to you" }));
    expect(within(card).queryByRole("button", { name: /^Answer$/ })).toBeNull();
    expect(within(card).getAllByRole("button").map((b) => b.textContent)).toEqual(["Close…"]);
    expect(within(card).getByRole("img", { name: /can't be answered in this state/ })).toBeInTheDocument();
    expect(detail().textContent).not.toMatch(/Nothing needed|Your move|waiting on/);
  });
});

describe("detail — facts once", () => {
  it("title is the first sentence; the body carries only the rest (object payload)", async () => {
    mount("/requests?req=r1");
    await waitFor(() => expect(detail()?.querySelector(".wk-dtitle")?.textContent).toBe("Should the billing migration run during business hours, or wait for the Saturday 02:00 UTC window?"));
    const body = detail().querySelector(".payload") as HTMLElement;
    expect(body.textContent).toContain("Month-end invoicing overlaps the weekday option.");
    expect(body.textContent).not.toContain("Should the billing migration");
    // flow line has no duplicate "to you" marker
    expect(detail().querySelector(".rq-flowline")?.textContent).not.toMatch(/to you/);
  });

  it("id once, without '#'; priority shows the bucket only; the task link is quiet (glyph + short id + title)", async () => {
    mount("/requests?req=r1");
    await waitFor(() => expect(detail()?.querySelector(".rq-bar .wk-id")).toBeTruthy());
    expect(detail().querySelector(".rq-bar .wk-id")?.textContent).not.toContain("#");
    expect(detail().querySelectorAll(".wk-id")).toHaveLength(1);
    const rail = within(detail()).getByRole("complementary", { name: "Request details" });
    expect(rail.textContent).toContain("Urgent");
    expect(rail.textContent).not.toMatch(/Urgent\s*1\b/);
    const link = rail.querySelector("a.rq-tasklink") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/tasks?task=t1");
    expect(link.querySelector(".v2-si")).toBeTruthy();
    expect(link.querySelector(".rq-tasklink-t")?.textContent).toBe("Billing plan");
    expect(link.className).not.toContain("dlink");
  });

  it("row avatars carry the agent presence dot and the AI kind (D7)", async () => {
    mount();
    await waitFor(() => expect(rowIds().length).toBeGreaterThan(0));
    const av = document.querySelector('.qrow[data-id="r1"] .rq-av .v2-av') as HTMLElement;
    expect(av.outerHTML).toMatch(/Working|working|live/);
  });

  it("list-only state caps the inbox width (no 1170px rows)", () => {
    expect(listCss).toMatch(/\.rq-page:not\(\.has-detail\):not\(\.is-empty\) \.rq-listbody \{ max-width: 760px; \}/);
  });

  it("closing the detail keeps the list", async () => {
    mount("/requests?req=r2");
    await waitFor(() => expect(detail()).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    await waitFor(() => expect(detail()).toBeNull());
    expect(rowIds().length).toBe(5);
  });
});

describe("requestTitle / payloadAfterTitle", () => {
  it("caps a long single sentence with an ellipsis and leaves the body whole", () => {
    const long = "word ".repeat(40).trim();
    const t = requestTitle(long);
    expect(t.length).toBeLessThanOrEqual(100);
    expect(t.endsWith("…")).toBe(true);
    expect(payloadAfterTitle(long, t)).toBeNull();
  });
  it("strips the title from strings and object headline fields", () => {
    expect(payloadAfterTitle("Should we ship on Friday? Train is full.", "Should we ship on Friday?")).toEqual({ value: "Train is full.", empty: false });
    expect(payloadAfterTitle("Ship it?", "Ship it?")).toEqual({ value: "", empty: true });
    expect(payloadAfterTitle({ question: "Should we ship on Friday? Train is full.", env: "prod" }, "Should we ship on Friday?")).toEqual({ value: { question: "Train is full.", env: "prod" }, empty: false });
    expect(payloadAfterTitle({ summary: "API shape" }, "API shape")).toEqual({ value: {}, empty: true });
  });
});
