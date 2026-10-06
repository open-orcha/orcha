/**
 * Org chart: the forest built from `agent.reports_to` (roots, the Unassigned
 * lane, loop-safety), the tidy-tree layout, who may edit (owner / manage_agents;
 * viewers read-only with the reason), ghost cards for pending agent
 * suggestions (agents never create agents), the 390 px indented list, and the
 * page end to end (PUT on edit). Org chart v2 (panel, setup, approve on the
 * card) is covered in OrgV2.test.tsx.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { mapSnapshot } from "../../api/client";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider, type ActingAuthority } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import { projectSections } from "../../shell/nav";
import { routeTable } from "../../shell/routes";
import {
  CARD_H, CARD_W, GAP_Y, ORG_GRANT_REASON, buildOrgForest, canReportTo, descendantsOf, flattenForest, layoutOrg,
  managerCandidates, orgAuthority, type OrgAuthority,
} from "./orgModel";
import { OrgCanvas, OrgList, OrgPage } from "./OrgPage";

const RAW = {
  container: { id: "c1", name: "Acme", status: "active" },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle", member_role: "owner", reports_to: null },
    { id: "a1", alias: "lead", kind: "ai", role: "Tech lead", status: "working", reports_to: "h1", current_task: { task_id: "t1", title: "Plan the billing migration" } },
    { id: "a2", alias: "forge", kind: "ai", role: "Builder", status: "idle", reports_to: "a1" },
    { id: "a3", alias: "scout", kind: "ai", role: "Research", status: "awaiting_request", reports_to: "a1" },
    { id: "h2", alias: "vera", kind: "human", role: "Stakeholder", status: "idle", member_role: "viewer", reports_to: null },
    { id: "a4", alias: "loner", kind: "ai", role: "Docs", status: "idle", reports_to: null },
  ],
  tasks: [{ id: "t1", title: "Plan the billing migration", status: "in_progress", assignees: ["lead"], message_summary: { count: 0, last: null } }],
  requests: [
    { id: "r1", type: "task", status: "open", requester_id: "a1", target_id: "h1", payload: "need a DBA",
      detail: { proposed_alias: "dba", proposed_role: "Database admin", rationale: "No one owns the schema." } },
    { id: "r2", type: "info", status: "open", requester_id: "a2", target_id: "h1", payload: "q", detail: null },
    { id: "r3", type: "task", status: "closed", requester_id: "a3", target_id: "h1", payload: "old",
      detail: { proposed_alias: "old-hire", proposed_role: "x" } },
  ],
};
const snap = () => mapSnapshot(structuredClone(RAW));
const CAN: OrgAuthority = { can: true, human: { id: "h1", alias: "kedar", kind: "human" } as Agent, pending: false, reason: null };
const VIEW: OrgAuthority = { can: false, human: null, pending: false, reason: "Your role is viewer (read-only)" };

describe("org model", () => {
  it("builds roots, nested reports and the Unassigned lane from reports_to", () => {
    const f = buildOrgForest(snap());
    expect(f.roots.map((r) => r.agent.alias)).toEqual(["kedar"]);
    expect(f.roots[0].children.map((c) => c.agent.alias)).toEqual(["lead"]);
    expect(f.roots[0].children[0].children.map((c) => c.agent.alias)).toEqual(["forge", "scout"]);
    // no manager and no reports → Unassigned (humans first)
    expect(f.unassigned.map((a) => a.alias)).toEqual(["vera", "loner"]);
    expect(f.lines).toBe(3);
  });

  it("drops a manager that is not in the live roster (retired) and breaks loops", () => {
    const s = snap();
    s.agents.find((a) => a.alias === "loner")!.reports_to = "gone-id";
    s.agents.find((a) => a.alias === "kedar")!.reports_to = "a2"; // kedar → forge → lead → kedar
    const f = buildOrgForest(s);
    expect(f.managerGone.has("a4")).toBe(true);
    expect(f.unassigned.map((a) => a.alias)).toContain("loner");
    // exactly one root survives the loop and every agent still appears once
    const all = [...flattenForest(f).map((r) => r.agent.alias), ...f.unassigned.map((a) => a.alias)];
    expect(all.sort()).toEqual(["forge", "kedar", "lead", "loner", "scout", "vera"]);
  });

  it("applies optimistic overrides", () => {
    const f = buildOrgForest(snap(), { a4: "h1", a1: null });
    expect(f.roots.map((r) => r.agent.alias).sort()).toEqual(["kedar", "lead"]);
    expect(f.roots.find((r) => r.agent.alias === "kedar")!.children.map((c) => c.agent.alias)).toEqual(["loner"]);
  });

  it("refuses moves that would make a loop", () => {
    const f = buildOrgForest(snap());
    expect([...descendantsOf(f, "h1")].sort()).toEqual(["a1", "a2", "a3"]);
    expect(canReportTo(f, "h1", "a2")).toBe(false); // kedar under his own report
    expect(canReportTo(f, "a1", "a1")).toBe(false);
    expect(canReportTo(f, "a2", "a3")).toBe(true);
    expect(managerCandidates(snap(), f, "a1").map((a) => a.alias)).toEqual(["kedar", "vera", "loner"]);
  });

  it("only OPEN agent suggestions become ghost cards, linking to Needs you", () => {
    const f = buildOrgForest(snap());
    expect(f.ghosts).toHaveLength(1);
    expect(f.ghosts[0]).toMatchObject({ alias: "dba", role: "Database admin", proposedBy: "lead", waitingOn: "kedar" });
    expect(f.ghosts[0].href).toBe("/needs?item=" + encodeURIComponent("request:r1"));
  });

  it("lays parents centred over their reports with elbow connectors, lanes below the tree", () => {
    const f = buildOrgForest(snap());
    const L = layoutOrg(f);
    const at = (id: string) => L.cards.find((c) => c.id === id)!;
    expect(at("a1").y - at("h1").y).toBe(CARD_H + GAP_Y);
    // lead sits centred over forge + scout
    const mid = (at("a2").x + at("a3").x + CARD_W) / 2;
    expect(at("a1").x + CARD_W / 2).toBeCloseTo(mid);
    expect(L.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["h1>a1", "a1>a2", "a1>a3"]);
    const lanes = L.lanes.map((l) => l.key);
    expect(lanes).toEqual(["unassigned", "ghosts"]);
    expect(L.lanes[0].y).toBeGreaterThan(at("a2").y + CARD_H);
    expect(L.ghosts.map((g) => g.id)).toEqual(["r1"]);
  });

  it("the 390 list is a pre-order walk with depth", () => {
    expect(flattenForest(buildOrgForest(snap())).map((r) => `${r.depth}:${r.agent.alias}`)).toEqual(["0:kedar", "1:lead", "2:forge", "2:scout"]);
  });
});

describe("who may edit", () => {
  const acting = (over: Partial<ActingAuthority> = {}): ActingAuthority => ({ human: { id: "h1", alias: "kedar", kind: "human" } as Agent, readOnly: false, pending: false, reason: null, ...over });
  it("owner or manage_agents may; a member without it, a viewer and nobody-acting may not (with the reason)", () => {
    expect(orgAuthority(acting(), { member_role: "owner" }).can).toBe(true);
    expect(orgAuthority(acting(), { member_role: "member", grants: ["manage_agents"] }).can).toBe(true);
    expect(orgAuthority(acting(), { member_role: "member", grants: ["manage_keys"] })).toMatchObject({ can: false, reason: ORG_GRANT_REASON });
    expect(orgAuthority(acting({ human: null, readOnly: true, reason: "Your role is viewer (read-only)" }), { member_role: "viewer" }))
      .toMatchObject({ can: false, reason: "Your role is viewer (read-only)" });
    expect(orgAuthority(acting(), null).can).toBe(true); // open build: the acting human
    expect(orgAuthority(acting({ pending: true, human: null }), null)).toMatchObject({ can: false, pending: true });
  });
});

function wrap(node: React.ReactNode) {
  return render(<ToastProvider><MemoryRouter initialEntries={["/org"]}>{node}</MemoryRouter></ToastProvider>);
}

describe("chart", () => {
  afterEach(cleanup);

  it("renders cards, connectors, the Unassigned lane and a ghost card", () => {
    const s = snap();
    wrap(<OrgCanvas snap={s} forest={buildOrgForest(s)} auth={CAN} onSet={() => {}} />);
    for (const a of ["kedar", "lead", "forge", "scout", "vera", "loner"]) expect(document.querySelector(`[data-agent="${a}"]`)).not.toBeNull();
    expect(document.querySelectorAll(".org-edges path")).toHaveLength(3);
    expect(document.querySelector('[data-edge="lead>forge"]')).not.toBeNull();
    expect(screen.getByText("Unassigned")).toBeTruthy();
    const ghost = document.querySelector<HTMLElement>('[data-ghost="dba"]')!;
    expect(ghost).not.toBeNull();
    expect(ghost.getAttribute("aria-label")).toContain("Proposed hire dba, Database admin");
    expect(ghost.className).toContain("org-ghost");
    expect(screen.getByText(/Agents can't create agents/)).toBeTruthy();
    // current task snippet on the working agent; waiting state on scout
    expect(within(document.querySelector<HTMLElement>('[data-agent="lead"]')!).getByText("Plan the billing migration")).toBeTruthy();
    expect(within(document.querySelector<HTMLElement>('[data-agent="scout"]')!).getByText("Waiting")).toBeTruthy();
  });

  it("an editor drags a card onto a manager (valid targets only) or picks from Reports to…", async () => {
    const s = snap();
    const onSet = vi.fn();
    wrap(<OrgCanvas snap={s} forest={buildOrgForest(s)} auth={CAN} onSet={onSet} />);
    const card = (a: string) => document.querySelector<HTMLElement>(`[data-agent="${a}"]`)!;
    expect(card("loner").getAttribute("draggable")).toBe("true");
    const dt = { setData: vi.fn(), effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(card("loner"), { dataTransfer: dt });
    fireEvent.dragOver(card("forge"), { dataTransfer: dt });
    expect(card("forge").className).toContain("is-drop-ok");
    fireEvent.drop(card("forge"), { dataTransfer: dt });
    expect(onSet).toHaveBeenCalledWith(expect.objectContaining({ alias: "loner" }), "a2");

    // kedar can't go under his own report
    onSet.mockClear();
    fireEvent.dragStart(card("kedar"), { dataTransfer: dt });
    expect(card("lead").className).toContain("is-drop-no");
    fireEvent.drop(card("lead"), { dataTransfer: dt });
    expect(onSet).not.toHaveBeenCalled();
    fireEvent.dragEnd(card("kedar"));

    // menu path
    fireEvent.click(within(card("scout")).getByRole("button", { name: "Actions for scout" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Reports to/ }));
    const pick = await screen.findByRole("menuitemradio", { name: /^loner/ });
    fireEvent.click(pick);
    expect(onSet).toHaveBeenCalledWith(expect.objectContaining({ alias: "scout" }), "a4");
  });

  it("a viewer sees the chart read-only: nothing draggable, Reports to… disabled with the reason", async () => {
    const s = snap();
    const onSet = vi.fn();
    wrap(<OrgCanvas snap={s} forest={buildOrgForest(s)} auth={VIEW} onSet={onSet} />);
    const scout = document.querySelector<HTMLElement>('[data-agent="scout"]')!;
    expect(scout.getAttribute("draggable")).toBe("false");
    fireEvent.click(within(scout).getByRole("button", { name: "Actions for scout" }));
    const item = await screen.findByRole("menuitem", { name: /Reports to/ });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.getAttribute("title")).toBe("Your role is viewer (read-only)");
    fireEvent.click(item);
    expect(screen.queryByRole("menuitemradio")).toBeNull();
    expect(onSet).not.toHaveBeenCalled();
  });

  it("390: an indented list with Unassigned and Proposed hires sections", () => {
    const s = snap();
    wrap(<OrgList snap={s} forest={buildOrgForest(s)} auth={CAN} onSet={() => {}} />);
    const depth = (a: string) => document.querySelector(`[data-agent="${a}"]`)!.getAttribute("data-depth");
    expect(depth("kedar")).toBe("0");
    expect(depth("lead")).toBe("1");
    expect(depth("forge")).toBe("2");
    expect(screen.getByRole("region", { name: "Unassigned" })).toBeTruthy();
    const hires = screen.getByRole("region", { name: "Proposed hires" });
    // Approve / Decline sit on the proposed hire itself (the Needs you link lives in its detail panel)
    expect(within(hires).getByRole("button", { name: "Approve dba" })).toBeTruthy();
    expect(within(hires).getByRole("button", { name: "Decline dba" })).toBeTruthy();
  });
});

describe("OrgPage (end to end, open build)", () => {
  let puts: { url: string; body: Record<string, unknown> }[] = [];
  beforeEach(() => {
    puts = [];
    localStorage.clear();
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        puts.push({ url, body });
        return { ok: true, status: 200, json: async () => ({ agent_id: "a4", reports_to_agent_id: body.reports_to_agent_id, chain: [] }) } as Response;
      }
      if (url === "/api/containers") return { ok: true, status: 200, json: async () => [{ id: "c1", status: "active" }] } as Response;
      // one human: the open build acts as them without a picker
      if (url.startsWith("/api/containers/c1")) return { ok: true, status: 200, json: async () => ({ ...RAW, agents: RAW.agents.filter((a) => a.alias !== "vera") }) } as Response;
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("the Org tab sits after Agents and /org is routed", () => {
    const keys = projectSections().map((s) => s.key);
    expect(keys.indexOf("org")).toBe(keys.indexOf("agents") + 1);
    expect(projectSections().find((s) => s.key === "org")!.href).toBe("/org");
    expect(routeTable().some((r) => r.path === "/org")).toBe(true);
  });

  it("renders the chart and saves an edit with the acting human", async () => {
    let loc = "";
    function Probe() { loc = useLocation().pathname; return null; }
    render(
      <ToastProvider>
        <SnapshotProvider>
          <MemoryRouter initialEntries={["/org"]}>
            <Probe />
            <Routes><Route path="/org" element={<OrgPage />} /><Route path="*" element={<div>elsewhere</div>} /></Routes>
          </MemoryRouter>
        </SnapshotProvider>
      </ToastProvider>,
    );
    await waitFor(() => expect(document.querySelector('[data-agent="loner"]')).not.toBeNull());
    expect(screen.getByText(/5 people · 3 reporting lines · 1 proposed hire/)).toBeTruthy();
    const loner = document.querySelector<HTMLElement>('[data-agent="loner"]')!;
    fireEvent.click(within(loner).getByRole("button", { name: "Actions for loner" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Reports to/ }));
    const pick = await screen.findByRole("menuitemradio", { name: /^lead/ });
    await act(async () => { fireEvent.click(pick); });
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0].url).toBe("/api/agents/a4/reports-to");
    expect(puts[0].body).toEqual({ reports_to_agent_id: "a1", actor_agent_id: "h1" });
    expect(loc).toBe("/org");
  });
});
