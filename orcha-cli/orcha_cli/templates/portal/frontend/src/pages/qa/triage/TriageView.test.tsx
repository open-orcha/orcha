/** The inbox mounted with no props: its groups, the diagnosis card, the duplicate link, the source. */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TriageView } from "./TriageView";

vi.mock("../../../state/SnapshotProvider", () => ({
  useSnapshot: () => ({ cid: "c1", snap: null }),
  useActingAuthority: () => ({ pending: false, readOnly: false, human: { id: "h1", kind: "human", alias: "hussein" }, reason: null }),
}));

const untriaged = { id: "f1", session_id: "s1", severity: "major", title: "Pay button does nothing", status: "open", created_at: "2026-11-05T10:00:00Z", frame_ids: [], request_id: "r1" };
const duplicate = { id: "f2", session_id: "s1", severity: "minor", severity_original: "major", title: "Pay is dead", status: "dismissed", created_at: "2026-11-05T10:00:00Z", frame_ids: [], duplicate_of: "f1",
  triage: { classification: "duplicate", action: "merged", root_cause: "Same tap handler." } };
const confirmed = { id: "f3", session_id: "s1", severity: "blocker", severity_original: "major", title: "Total is wrong", status: "open", created_at: "2026-11-05T10:00:00Z", frame_ids: [],
  triage: { classification: "product_bug", attempts: 3, reproductions: 3, rate: "fails 3 of 3", root_cause: "The cart keeps the old sum.", action: "confirmed" } };
const person = { id: "f4", session_id: "s1", severity: "major", title: "Refund copy is unclear", status: "open", created_at: "2026-11-05T10:00:00Z", frame_ids: [],
  triage: { classification: "product_bug", attempts: 3, reproductions: 3, needs_person: true, action: "confirmed" } };

let sent: { url: string; body: unknown }[] = [];
beforeEach(() => {
  sent = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) }) as Response;
    if (init?.method === "POST") { sent.push({ url, body: JSON.parse(String(init.body)) }); return json({}); }
    if (url.endsWith("/qa/triage")) return json({ untriaged: [untriaged], needs_person: [person], decided: [confirmed, duplicate] });
    if (url.startsWith("/api/qa/requests/r1")) return json({ id: "r1", kind: "explore", status: "failed", round: 2, max_rounds: 3, source_workflow_id: "w1", source_workflow_title: "Checkout", source_task_id: "t1", source_task_title: "Quality" });
    if (url.includes("/qa/requests")) return json({ requests: [] });
    return json({});
  }) as unknown as typeof fetch;
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const view = (at = "/qa?view=triage") => render(<MemoryRouter initialEntries={[at]}><TriageView /></MemoryRouter>);

describe("TriageView", () => {
  it("groups the inbox with no props", async () => {
    view();
    expect(within(await screen.findByRole("region", { name: "Untriaged" })).getByText("Pay button does nothing")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Needs a person" })).getByText("Refund copy is unclear")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Recently decided" })).getByText("fails 3 of 3")).toBeInTheDocument();
  });

  it("shows the diagnosis in plain words, severity before and after", async () => {
    view("/qa?view=triage&finding=f3");
    const card = await screen.findByRole("region", { name: "Triage" });
    expect(within(card).getByText("A real bug in the app. The agent made it happen again.")).toBeInTheDocument();
    expect(within(card).getByText("fails 3 of 3")).toBeInTheDocument();
    expect(within(card).getByText("The cart keeps the old sum.")).toBeInTheDocument();
    expect(within(card).getByLabelText("Severity changed from Major to Blocker")).toBeInTheDocument();
  });

  it("links a duplicate to the finding it repeats", async () => {
    view("/qa?view=triage&finding=f2");
    expect(await screen.findByRole("link", { name: "Open the finding it repeats" })).toHaveAttribute("href", "/qa?view=triage&finding=f1");
  });

  it("says which workflow step and round a finding came from", async () => {
    view("/qa?view=triage&finding=f1");
    const link = await screen.findByRole("link", { name: "Checkout" });
    expect(link.getAttribute("href")).toBe("/workflows/w1?cid=c1#workflow-task-t1");
    expect(link.parentElement).toHaveTextContent("Quality · Round 2 of 3");
  });

  it("marks not a bug only with a reason, then reads the inbox again", async () => {
    view("/qa?view=triage&finding=f1");
    fireEvent.click(await screen.findByRole("button", { name: "Mark as not a bug" }));
    const dialog = await screen.findByRole("dialog", { name: "Mark as not a bug?" });
    const save = within(dialog).getByRole("button", { name: "Mark as not a bug" });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Why it's not a bug"), { target: { value: "It is meant to wait for a card." } });
    fireEvent.click(save);
    await waitFor(() => expect(sent).toEqual([{ url: "/api/qa/findings/f1/not-a-bug", body: { reason: "It is meant to wait for a card.", actor_agent_id: "h1" } }]));
  });
});
