/**
 * Org chart v2: the empty-state default view (humans who receive escalations on
 * top, dashed preview lines — display only), the one-click "Everyone reports to
 * <owner>" (confirm dialog → one authorized PUT per change; disabled with the
 * reason for viewers), Approve / Decline on the proposed-hire card (the same
 * POST /api/agent-suggestions/{rid}/decide Needs you makes; gated), richer card
 * facts (open tasks, spend vs budget — "not metered" when unknown, reports),
 * the detail panel (manager chain, direct reports, Reports to…, Open agent,
 * full proposal) and keyboard navigation.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { mapSnapshot } from "../../api/client";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import type { AgentBudgetStatus } from "../agents/budget/budgetModel";
import {
  CARD_H, GHOST_H, buildOrgForest, directReports, layoutOrg, managerChain, openTaskCounts, pickOwner,
  reportingSuggestion, spatialNext, spendFact, withDefaultView, type OrgAuthority,
} from "./orgModel";
import type { HireGate } from "./orgActions";
import { OrgCanvas, OrgList, OrgPage } from "./OrgPage";

const TREE = {
  container: { id: "c1", name: "Acme", status: "active" },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle", member_role: "owner", reports_to: null },
    { id: "a1", alias: "lead", kind: "ai", role: "Tech lead", status: "working", reports_to: "h1", current_task: { task_id: "t1", title: "Plan the billing migration" } },
    { id: "a2", alias: "forge", kind: "ai", role: "Builder", status: "idle", reports_to: "a1" },
    { id: "a3", alias: "scout", kind: "ai", role: "Research", status: "awaiting_request", reports_to: "a1" },
    { id: "h2", alias: "vera", kind: "human", role: "Stakeholder", status: "idle", member_role: "viewer", reports_to: null },
    { id: "a4", alias: "loner", kind: "ai", role: "Docs", status: "idle", reports_to: null },
  ],
  tasks: [
    { id: "t1", title: "Plan the billing migration", status: "in_progress", assignees: ["lead"], message_summary: { count: 0, last: null } },
    { id: "t2", title: "Write the runbook", status: "pending", assignees: ["lead", "forge"], message_summary: { count: 0, last: null } },
    { id: "t3", title: "Old thing", status: "completed", assignees: ["lead"], message_summary: { count: 0, last: null } },
  ],
  requests: [
    { id: "r1", type: "task", status: "open", requester_id: "a1", target_id: "h1", payload: "need a DBA",
      detail: { proposed_alias: "dba", proposed_role: "Database admin — schema owner and migration reviewer for every service",
        rationale: "No one owns the schema; three migrations last week went in without review and one needed a hotfix.",
        proposed_prompt: "You own the database schema." } },
  ],
};
/** the same team with NO reporting lines */
const FLAT = { ...TREE, agents: TREE.agents.map((a) => ({ ...a, reports_to: null })) };
const snapOf = (raw: unknown) => mapSnapshot(structuredClone(raw) as never);

const KEDAR = { id: "h1", alias: "kedar", kind: "human" } as Agent;
const CAN: OrgAuthority = { can: true, human: KEDAR, pending: false, reason: null };
const VIEW: OrgAuthority = { can: false, human: null, pending: false, reason: "Your role is viewer (read-only)" };
const OPEN_GATE: HireGate = { approve: null, decline: null };

function wrap(node: React.ReactNode) {
  return render(<ToastProvider><MemoryRouter initialEntries={["/org"]}>{node}</MemoryRouter></ToastProvider>);
}
const card = (a: string) => document.querySelector<HTMLElement>(`[data-agent="${a}"]`)!;

describe("org v2 model", () => {
  it("no reporting lines: humans who receive escalations on top (owner first), the suggestion drawn as a dashed preview — nothing written", () => {
    const s = snapOf(FLAT);
    const f = buildOrgForest(s);
    expect(f.lines).toBe(0);
    const sug = reportingSuggestion(s, f, null)!;
    expect(sug.owner.alias).toBe("kedar");
    expect(sug.changes.map((a) => a.alias)).toEqual(["lead", "forge", "scout", "loner"]);
    const v = withDefaultView(f, sug);
    expect(v.roots.map((r) => r.agent.alias)).toEqual(["kedar"]);
    expect(v.roots[0].children.map((c) => c.agent.alias)).toEqual(["lead", "forge", "scout", "loner"]);
    expect(v.unassigned.map((a) => a.alias)).toEqual(["vera"]); // a viewer does not receive escalations
    expect(v.managerOf.size).toBe(0);
    expect(v.lines).toBe(0);
    const L = layoutOrg(v);
    expect(L.edges).toHaveLength(4);
    expect(L.edges.every((e) => e.preview)).toBe(true);
  });

  it("no suggestion once any line exists; the owner falls back to the acting human, then the first human who can act", () => {
    const s = snapOf(TREE);
    const f = buildOrgForest(s);
    expect(reportingSuggestion(s, f, "h1")).toBeNull();
    expect(withDefaultView(f, null)).toBe(f);
    const noOwner = snapOf({ ...FLAT, agents: FLAT.agents.map((a) => ({ ...a, member_role: a.member_role === "owner" ? "member" : a.member_role })).concat([{ id: "h3", alias: "ana", kind: "human", role: "", status: "idle", member_role: "member", reports_to: null }]) });
    expect(pickOwner(noOwner, "h3")!.alias).toBe("ana");
    expect(pickOwner(noOwner, null)!.alias).toBe("kedar");
  });

  it("manager chain (root first) and direct reports", () => {
    const s = snapOf(TREE);
    const f = buildOrgForest(s);
    const byId = new Map(s.agents.map((a) => [String(a.id), a]));
    expect(managerChain(f, byId, "a2").map((a) => a.alias)).toEqual(["kedar", "lead"]);
    expect(managerChain(f, byId, "h1")).toEqual([]);
    expect(directReports(s, f, "a1").map((a) => a.alias)).toEqual(["forge", "scout"]);
  });

  it("open task counts skip finished work", () => {
    const m = openTaskCounts(snapOf(TREE));
    expect(m.get("lead")).toBe(2);
    expect(m.get("forge")).toBe(1);
    expect(m.get("scout")).toBeUndefined();
  });

  it("spend vs budget is truthful: not metered when unknown, never $0 for unpriced runs", () => {
    const base = (over: Partial<AgentBudgetStatus>): AgentBudgetStatus => ({
      agent_id: "a1", alias: "lead", blocked_by: null, reason: null, state: "ok", usd_ratio: null, token_ratio: null,
      limits: { usd: null, tokens: null }, limits_reached: [], paused: false, updated_at: null,
      override: { active: false, granted_by: null, granted_at: null, note: null },
      usage: { spend_usd: 0, metered_runs: 0, unmetered_runs: 0, unmetered_tokens: 0, tokens: 0, runs: 0, in_flight_runs: 0 },
      ...over,
    });
    expect(spendFact(null, "loading")).toBeNull();
    expect(spendFact(null, "unsupported")!.text).toBe("not metered");
    expect(spendFact(null, "ready")!.text).toBe("not metered");
    expect(spendFact(base({ usage: { ...base({}).usage, unmetered_runs: 3, runs: 3 } }), "ready")!.text).toBe("not metered");
    expect(spendFact(base({ usage: { ...base({}).usage, spend_usd: 4.2, metered_runs: 2, runs: 2 } }), "ready")!.text).toBe("$4.20");
    const capped = spendFact(base({ limits: { usd: 50, tokens: null }, usd_ratio: 0.9, usage: { ...base({}).usage, spend_usd: 45, metered_runs: 5, runs: 5 } }), "ready")!;
    expect(capped).toMatchObject({ text: "$45.00 / $50", tone: "warn" });
    expect(spendFact(base({ limits: { usd: 50, tokens: null }, usd_ratio: 1.2, paused: true, reason: "Monthly budget reached", usage: { ...base({}).usage, spend_usd: 60, metered_runs: 5, runs: 5 } }), "ready"))
      .toMatchObject({ tone: "over", title: "Monthly budget reached" });
  });

  it("proposed-hire lane rows are tall enough for role + rationale + actions; arrow keys pick the nearest card", () => {
    const s = snapOf(TREE);
    const L = layoutOrg(buildOrgForest(s));
    expect(L.lanes.find((l) => l.key === "ghosts")!.h).toBeGreaterThanOrEqual(GHOST_H);
    expect(spatialNext(L.cards, "h1", "down")).toBe("a1");
    expect(spatialNext(L.cards, "a1", "up")).toBe("h1");
    expect(spatialNext(L.cards, "a2", "right")).toBe("a3");
    expect(spatialNext(L.cards, "h1", "up")).toBeNull();
    expect(CARD_H).toBeGreaterThan(76);
  });
});

describe("org v2 chart", () => {
  afterEach(cleanup);

  it("empty state: a dashed preview under the owner and a confirmed one-click setup", async () => {
    const s = snapOf(FLAT);
    const onApply = vi.fn(async () => ({ ok: 4, failed: [] }));
    wrap(<OrgCanvas snap={s} forest={buildOrgForest(s)} auth={CAN} onSet={() => {}} onApply={onApply} />);
    expect(document.querySelectorAll(".org-edges path.is-preview")).toHaveLength(4);
    expect(document.querySelector('[data-edge="kedar>lead"]')!.hasAttribute("data-preview")).toBe(true);
    const region = screen.getByRole("region", { name: "Set up reporting lines" });
    fireEvent.click(within(region).getByRole("button", { name: "Everyone reports to kedar…" }));
    const dlg = await screen.findByRole("dialog", { name: "Everyone reports to kedar?" });
    const changes = within(dlg).getByRole("list", { name: "Changes" });
    expect([...changes.querySelectorAll("[data-change]")].map((li) => li.getAttribute("data-change"))).toEqual(["lead", "forge", "scout", "loner"]);
    expect(onApply).not.toHaveBeenCalled(); // nothing is written before the human confirms
    await act(async () => { fireEvent.click(within(dlg).getByRole("button", { name: "Apply 4 changes" })); });
    expect(onApply).toHaveBeenCalledTimes(1);
    expect((onApply.mock.calls[0] as unknown as [{ owner: Agent }])[0].owner.alias).toBe("kedar");
  });

  it("a viewer sees the setup disabled with the reason", () => {
    const s = snapOf(FLAT);
    wrap(<OrgCanvas snap={s} forest={buildOrgForest(s)} auth={VIEW} onSet={() => {}} />);
    const btn = screen.getByRole("button", { name: "Everyone reports to kedar…" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("title")).toBe("Your role is viewer (read-only)");
    expect(screen.getByText("Your role is viewer (read-only)")).toBeTruthy();
  });

  it("Approve / Decline on the proposed-hire card go through the confirm and the shared decision", async () => {
    const s = snapOf(TREE);
    const onDecide = vi.fn(async () => {});
    wrap(<OrgCanvas snap={s} forest={buildOrgForest(s)} auth={CAN} onSet={() => {}} gate={OPEN_GATE} onDecide={onDecide} />);
    const ghost = document.querySelector<HTMLElement>('[data-ghost="dba"]')!;
    // the essentials are on the card in full (clamped visually, full text on hover)
    expect(within(ghost).getByText(/Database admin — schema owner and migration reviewer for every service/)).toBeTruthy();
    expect(ghost.getAttribute("title")).toContain("three migrations last week");
    fireEvent.click(within(ghost).getByRole("button", { name: "Approve dba" }));
    const dlg = await screen.findByRole("dialog", { name: "Create agent “dba”?" });
    expect(screen.queryByTestId("org-panel")).toBeNull(); // the button did not also open the panel
    await act(async () => { fireEvent.click(within(dlg).getByRole("button", { name: "Create agent" })); });
    expect(onDecide).toHaveBeenCalledWith(expect.objectContaining({ requestId: "r1", alias: "dba" }), "create", undefined);

    fireEvent.click(within(ghost).getByRole("button", { name: "Decline dba" }));
    const dlg2 = await screen.findByRole("dialog", { name: "Refuse this suggestion?" });
    fireEvent.change(within(dlg2).getByLabelText("Reason (optional)"), { target: { value: "not now" } });
    await act(async () => { fireEvent.click(within(dlg2).getByRole("button", { name: "Refuse" })); });
    expect(onDecide).toHaveBeenLastCalledWith(expect.objectContaining({ requestId: "r1" }), "refuse", "not now");
  });

  it("a failed decision stays open with the server's reason", async () => {
    const s = snapOf(TREE);
    const onDecide = vi.fn(async () => { throw Object.assign(new Error("x → 409: alias 'dba' is taken"), { status: 409, detail: "alias 'dba' is taken" }); });
    wrap(<OrgCanvas snap={s} forest={buildOrgForest(s)} auth={CAN} onSet={() => {}} gate={OPEN_GATE} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve dba" }));
    const dlg = await screen.findByRole("dialog");
    await act(async () => { fireEvent.click(within(dlg).getByRole("button", { name: "Create agent" })); });
    expect(within(dlg).getByRole("alert").textContent).toContain("alias 'dba' is taken");
  });

  it("viewers see Approve / Decline disabled with the reason", () => {
    const s = snapOf(TREE);
    const onDecide = vi.fn();
    const gate: HireGate = { approve: "Your role is viewer (read-only)", decline: "Your role is viewer (read-only)" };
    wrap(<OrgCanvas snap={s} forest={buildOrgForest(s)} auth={VIEW} onSet={() => {}} gate={gate} onDecide={onDecide} />);
    for (const name of ["Approve dba", "Decline dba"]) {
      const b = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(b.disabled).toBe(true);
      expect(b.getAttribute("title")).toBe("Your role is viewer (read-only)");
    }
    // a member without manage_agents may decline but not approve
    cleanup();
    wrap(<OrgCanvas snap={s} forest={buildOrgForest(s)} auth={CAN} onSet={() => {}} gate={{ approve: "Requires the owner role or the manage_agents permission", decline: null }} onDecide={onDecide} />);
    expect((screen.getByRole("button", { name: "Approve dba" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Decline dba" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("cards carry status, current task, open tasks, spend and reports", () => {
    const s = snapOf(TREE);
    const budgets = new Map<string, AgentBudgetStatus>([["a1", {
      agent_id: "a1", alias: "lead", blocked_by: null, reason: null, state: "ok", usd_ratio: 0.1, token_ratio: null,
      limits: { usd: 50, tokens: null }, limits_reached: [], paused: false, updated_at: null,
      override: { active: false, granted_by: null, granted_at: null, note: null },
      usage: { spend_usd: 4.2, metered_runs: 2, unmetered_runs: 0, unmetered_tokens: 0, tokens: 100, runs: 2, in_flight_runs: 0 },
    }]]);
    wrap(<OrgCanvas snap={s} forest={buildOrgForest(s)} auth={CAN} onSet={() => {}} budgets={budgets} budgetsLoad="ready" />);
    const lead = within(card("lead"));
    expect(lead.getByText("Working")).toBeTruthy();
    expect(lead.getByText("Plan the billing migration")).toBeTruthy();
    expect(lead.getByLabelText("2 open tasks")).toHaveTextContent("2");
    expect(lead.getByText("$4.20 / $50")).toBeTruthy();
    expect(lead.getByTitle("2 direct reports")).toBeTruthy();
    expect(within(card("forge")).getByText("not metered")).toBeTruthy();
    // humans: no spend figure, their escalation role instead of a run status
    expect(within(card("kedar")).getByText("Receives escalations")).toBeTruthy();
    expect(within(card("kedar")).queryByText("not metered")).toBeNull();
    expect(within(card("kedar")).getByText("Human")).toBeTruthy();
    expect(lead.getByText("AI")).toBeTruthy();
  });

  it("click a card → panel with the manager chain, direct reports, Reports to… and Open agent; Escape closes", async () => {
    const s = snapOf(TREE);
    const onSet = vi.fn();
    wrap(<OrgCanvas snap={s} forest={buildOrgForest(s)} auth={CAN} onSet={onSet} />);
    fireEvent.click(card("forge"));
    let panel = screen.getByTestId("org-panel");
    const chain = within(panel).getByRole("region", { name: "Manager chain" });
    expect(within(chain).getAllByRole("button").map((b) => b.textContent)).toEqual(["kedar", "lead"]);
    expect(within(panel).getByRole("link", { name: /Open agent/ }).getAttribute("href")).toBe("/agents?agent=forge");
    fireEvent.change(within(panel).getByLabelText("Reports to"), { target: { value: "a3" } });
    expect(onSet).toHaveBeenCalledWith(expect.objectContaining({ alias: "forge" }), "a3");

    // walk up the chain to lead: its direct reports are listed
    fireEvent.click(within(chain).getByRole("button", { name: "lead" }));
    panel = screen.getByTestId("org-panel");
    expect(within(panel).getByRole("heading", { name: "lead" })).toBeTruthy();
    const reports = within(panel).getByRole("region", { name: "Direct reports" });
    expect(within(reports).getAllByRole("button").map((b) => b.getAttribute("data-row"))).toEqual(["forge", "scout"]);
    fireEvent.keyDown(within(panel).getByRole("heading", { name: "lead" }), { key: "Escape" });
    expect(screen.queryByTestId("org-panel")).toBeNull();
  });

  it("viewers: the panel's Reports to… is disabled with the reason", () => {
    const s = snapOf(TREE);
    wrap(<OrgCanvas snap={s} forest={buildOrgForest(s)} auth={VIEW} onSet={() => {}} />);
    fireEvent.click(card("scout"));
    const sel = within(screen.getByTestId("org-panel")).getByLabelText("Reports to") as HTMLSelectElement;
    expect(sel.disabled).toBe(true);
    expect(within(screen.getByTestId("org-panel")).getByText("Your role is viewer (read-only)")).toBeTruthy();
  });

  it("a proposed hire's panel shows the full proposal with Approve / Decline and the Needs you link", () => {
    const s = snapOf(TREE);
    wrap(<OrgCanvas snap={s} forest={buildOrgForest(s)} auth={CAN} onSet={() => {}} gate={OPEN_GATE} onDecide={vi.fn()} />);
    fireEvent.click(document.querySelector<HTMLElement>('[data-ghost="dba"]')!);
    const panel = within(screen.getByTestId("org-panel"));
    expect(panel.getByText("No one owns the schema; three migrations last week went in without review and one needed a hotfix.")).toBeTruthy();
    expect(panel.getByText("You own the database schema.")).toBeTruthy();
    expect(panel.getByRole("button", { name: "Approve dba" })).toBeTruthy();
    expect(panel.getByRole("link", { name: /Open in Needs you/ }).getAttribute("href")).toBe("/needs?item=" + encodeURIComponent("request:r1"));
  });

  it("keyboard: arrows move between cards, Enter opens the panel", () => {
    const s = snapOf(TREE);
    wrap(<OrgCanvas snap={s} forest={buildOrgForest(s)} auth={CAN} onSet={() => {}} />);
    card("kedar").focus();
    fireEvent.keyDown(card("kedar"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(card("lead"));
    fireEvent.keyDown(card("lead"), { key: "Enter" });
    expect(within(screen.getByTestId("org-panel")).getByRole("heading", { name: "lead" })).toBeTruthy();
  });

  it("390 list: the default view + setup, tap a row for the panel", () => {
    const s = snapOf(FLAT);
    wrap(<OrgList snap={s} forest={buildOrgForest(s)} auth={CAN} onSet={() => {}} />);
    expect(card("kedar").getAttribute("data-depth")).toBe("0");
    expect(card("lead").getAttribute("data-depth")).toBe("1");
    expect(card("lead").className).toContain("is-preview");
    expect(screen.getByRole("button", { name: "Everyone reports to kedar…" })).toBeTruthy();
    fireEvent.click(within(card("lead")).getByRole("button", { name: /lead, Tech lead — details/ }));
    expect(within(screen.getByTestId("org-panel")).getByRole("heading", { name: "lead" })).toBeTruthy();
  });
});

describe("OrgPage v2 (end to end, open build)", () => {
  let posts: { method: string; url: string; body: Record<string, unknown> }[] = [];
  let raw: unknown = FLAT;
  beforeEach(() => {
    posts = [];
    localStorage.clear();
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PUT" || init?.method === "POST") {
        posts.push({ method: init.method, url, body: JSON.parse(String(init.body)) });
        return { ok: true, status: 200, json: async () => ({}) } as Response;
      }
      if (url === "/api/containers") return { ok: true, status: 200, json: async () => [{ id: "c1", status: "active" }] } as Response;
      if (url.startsWith("/api/containers/c1/budgets")) return { ok: false, status: 404, json: async () => ({ detail: "Not Found" }) } as Response;
      // one human who can act (the viewer is dropped): the open build acts as them
      if (url.startsWith("/api/containers/c1")) {
        const r = structuredClone(raw) as typeof FLAT;
        return { ok: true, status: 200, json: async () => ({ ...r, agents: r.agents.filter((a) => a.alias !== "vera") }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  const mount = () => render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={["/org"]}>
          <Routes><Route path="/org" element={<OrgPage />} /></Routes>
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );

  it("Everyone reports to <owner>: one authorized PUT per agent, after the confirm", async () => {
    raw = FLAT;
    mount();
    const btn = await screen.findByRole("button", { name: "Everyone reports to kedar…" });
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(btn);
    const dlg = await screen.findByRole("dialog");
    expect(posts).toHaveLength(0);
    await act(async () => { fireEvent.click(within(dlg).getByRole("button", { name: "Apply 4 changes" })); });
    await waitFor(() => expect(posts).toHaveLength(4));
    expect(posts.map((p) => p.url)).toEqual(["a1", "a2", "a3", "a4"].map((id) => `/api/agents/${id}/reports-to`));
    expect(posts.every((p) => p.method === "PUT" && p.body.reports_to_agent_id === "h1" && p.body.actor_agent_id === "h1")).toBe(true);
    // budgets route missing → spend is "not metered", never $0
    expect(within(card("lead")).getByText("not metered")).toBeTruthy();
  });

  it("Approve on the card posts the same decision Needs you does, as the acting human", async () => {
    raw = TREE;
    mount();
    const approve = await screen.findByRole("button", { name: "Approve dba" });
    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(approve);
    const dlg = await screen.findByRole("dialog", { name: "Create agent “dba”?" });
    await act(async () => { fireEvent.click(within(dlg).getByRole("button", { name: "Create agent" })); });
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ method: "POST", url: "/api/agent-suggestions/r1/decide", body: { kind: "create", actor_agent_id: "h1" } });
  });
});
