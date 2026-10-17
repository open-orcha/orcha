/**
 * Full-QA round 2 (org chart):
 *  - PS-33: an invited human who never signed in reads "Invited · not signed in",
 *    never "Receives escalations" (the backend never routes asks to them).
 *  - VD-09: an AI card reads the same presence as roster / board / sidebar — a
 *    running run (even lease-lapsed) with a stale awaiting_request reads Working.
 *  - B25: a budget-paused agent shows the "Budget paused" chip on its card and
 *    in the detail panel, with the reason as its title.
 */
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { mapSnapshot } from "../../api/client";
import { ToastProvider } from "../../components/ui";
import type { Agent } from "../../types";
import type { AgentBudgetStatus } from "../agents/budget/budgetModel";
import { agentPresence } from "../agents/presence";
import { buildOrgForest, liveStatusText, orgStatus, workSnippet, type OrgAuthority } from "./orgModel";
import { OrgCanvas } from "./OrgPage";

afterEach(cleanup);

const RAW = {
  container: { id: "c1", name: "Acme", status: "active", runtime_served: true },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", status: "idle", member_role: "owner", github_login: "kedar", reports_to: null },
    { id: "a1", alias: "pixel", kind: "ai", status: "awaiting_request", reports_to: "h1",
      running_run: { run_id: "r1", status: "running", lane: "work", lease_live: false, task_title: "Ship it" },
      current_task: { task_id: "t1", title: "Ship it" } },
    { id: "a2", alias: "scout", kind: "ai", status: "awaiting_request", reports_to: "h1" },
    { id: "a3", alias: "forge", kind: "ai", status: "idle", reports_to: "h1" },
  ],
  tasks: [], requests: [],
};
const snap = () => mapSnapshot(structuredClone(RAW) as never);
const KEDAR = { id: "h1", alias: "kedar", kind: "human" } as Agent;
const CAN: OrgAuthority = { can: true, human: KEDAR, pending: false, reason: null };
const card = (a: string) => document.querySelector<HTMLElement>(`[data-agent="${a}"]`)!;

describe("PS-33: pending invitee", () => {
  const base = { id: "h9", alias: "newbie-pending", kind: "human", member_role: "member", github_login: "newbie-pending" };
  it("never-signed-in member reads 'Invited · not signed in'", () => {
    expect(liveStatusText({ ...base, last_heartbeat_at: null } as unknown as Agent)).toBe("Invited · not signed in");
    expect(orgStatus({ ...base, last_heartbeat_at: null } as unknown as Agent).cls).toBe("invited");
  });
  it("signed-in member and open-build humans (no heartbeat field) still receive escalations", () => {
    expect(liveStatusText({ ...base, last_heartbeat_at: "2026-09-01T00:00:00Z" } as unknown as Agent)).toBe("Receives escalations");
    expect(liveStatusText({ id: "h2", alias: "x", kind: "human", member_role: "member" } as unknown as Agent)).toBe("Receives escalations");
  });
  it("viewer stays read-only", () => {
    expect(liveStatusText({ ...base, member_role: "viewer", last_heartbeat_at: null } as unknown as Agent)).toBe("Read-only");
  });
});

describe("VD-09: one status vocabulary", () => {
  it("org status matches agentPresence for every AI agent", () => {
    const s = snap();
    for (const a of s.agents.filter((x) => x.kind === "ai")) {
      expect(liveStatusText(a, s)).toBe(agentPresence(a, { snap: s }).label);
    }
    const pixel = s.agents.find((a) => a.alias === "pixel")!;
    expect(liveStatusText(pixel, s)).toBe("Working");
    expect(workSnippet(pixel, s)).toBe("Ship it");
    const scout = s.agents.find((a) => a.alias === "scout")!;
    expect(liveStatusText(scout, s)).toBe("Waiting");
    expect(workSnippet(scout, s)).toBe("Waiting on a request");
  });
  it("the card shows Working for the lease-lapsed running run", () => {
    const s = snap();
    render(<ToastProvider><MemoryRouter><OrgCanvas snap={s} forest={buildOrgForest(s)} auth={CAN} onSet={() => {}} budgetsLoad="ready" /></MemoryRouter></ToastProvider>);
    expect(within(card("pixel")).getByText("Working")).toBeTruthy();
    expect(card("pixel").querySelector(".org-card-status")!.className).toContain("s-working");
  });
});

describe("B25: budget-paused chip on the org card and panel", () => {
  it("renders the chip with the reason title", () => {
    const s = snap();
    const budgets = new Map<string, AgentBudgetStatus>([["a3", {
      agent_id: "a3", alias: "forge", blocked_by: "agent", reason: "forge reached its $0.00 monthly budget", state: "exceeded",
      usd_ratio: 1, token_ratio: null, limits: { usd: 0, tokens: null }, limits_reached: ["usd"], paused: true, updated_at: null,
      override: { active: false, granted_by: null, granted_at: null, note: null },
      usage: { spend_usd: 1, metered_runs: 1, unmetered_runs: 0, unmetered_tokens: 0, tokens: 10, runs: 1, in_flight_runs: 0 },
    } as unknown as AgentBudgetStatus]]);
    render(<ToastProvider><MemoryRouter><OrgCanvas snap={s} forest={buildOrgForest(s)} auth={CAN} onSet={() => {}} budgets={budgets} budgetsLoad="ready" /></MemoryRouter></ToastProvider>);
    const chip = within(card("forge")).getByText("Budget paused");
    expect(chip.closest("[title]")!.getAttribute("title")).toContain("monthly budget");
    expect(within(card("scout")).queryByText("Budget paused")).toBeNull();
    fireEvent.click(card("forge"));
    const panel = document.querySelector(".org-p-status");
    expect(panel).toBeTruthy();
    expect(panel!.textContent).toContain("Budget paused");
  });
});
