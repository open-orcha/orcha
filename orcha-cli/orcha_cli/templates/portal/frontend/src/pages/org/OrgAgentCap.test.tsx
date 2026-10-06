/**
 * Agent limit — Org chart: Approve on the proposed-hire card AND in the detail panel,
 * refused at the project's cap, shows the plain sentence (never the raw decide path /
 * status), the Settings → Execution link when the approver may raise it, and Retry.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mapSnapshot } from "../../api/client";
import { ToastProvider } from "../../components/ui";
import type { Agent } from "../../types";
import { buildOrgForest, type OrgAuthority } from "./orgModel";
import type { HireGate } from "./orgActions";
import { OrgCanvas } from "./OrgPage";

const RAW = {
  container: { id: "c1", name: "Acme", status: "active", max_auto_agents: 3, auto_agents_in_use: 3 },
  agents: [
    { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle", member_role: "owner", reports_to: null },
    { id: "a1", alias: "lead", kind: "ai", role: "Tech lead", status: "idle", reports_to: "h1" },
  ],
  tasks: [],
  requests: [
    { id: "r1", type: "task", status: "open", requester_id: "a1", target_id: "h1", payload: "need a DBA",
      detail: { proposed_alias: "dba", proposed_role: "Database admin", rationale: "No one owns the schema.", proposed_prompt: "p" } },
  ],
};
const snap = () => mapSnapshot(structuredClone(RAW) as never);
const KEDAR = { id: "h1", alias: "kedar", kind: "human" } as Agent;
const CAN: OrgAuthority = { can: true, human: KEDAR, pending: false, reason: null };
const OPEN: HireGate = { approve: null, decline: null };
const capErr = () => Object.assign(
  new Error("/api/agent-suggestions/r1/decide → 409: this project already has 3 suggested agents (the limit is 3). Reassign the work to an existing agent, or retire an agent created from a suggestion."),
  { status: 409, detail: "this project already has 3 suggested agents (the limit is 3). Reassign the work to an existing agent, or retire an agent created from a suggestion." },
);
const MSG = "This project allows up to 3 suggested agents and already has 3. Raise the limit in Settings → Execution, or reassign this work to an existing agent.";

function mount(onDecide: () => Promise<void>) {
  const s = snap();
  return render(
    <ToastProvider><MemoryRouter initialEntries={["/org"]}>
      <OrgCanvas snap={s} forest={buildOrgForest(s)} auth={CAN} onSet={() => {}} gate={OPEN} onDecide={onDecide} />
    </MemoryRouter></ToastProvider>,
  );
}

async function approveAndExpectCap(scope: HTMLElement, onDecide: ReturnType<typeof vi.fn>) {
  fireEvent.click(within(scope).getByRole("button", { name: "Approve dba" }));
  const dlg = await screen.findByRole("dialog", { name: "Create agent “dba”?" });
  await act(async () => { fireEvent.click(within(dlg).getByRole("button", { name: "Create agent" })); });
  const alert = within(dlg).getByRole("alert");
  expect(alert.textContent).toContain(MSG);
  expect(dlg.textContent).not.toMatch(/\/api\/agent-suggestions|→ 409|\(409\)/);
  expect(within(alert).getByRole("link", { name: /Open Settings → Execution/ }).getAttribute("href")).toBe("/settings#tab=execution");
  // Retry is still there and re-sends the decision
  await act(async () => { fireEvent.click(within(dlg).getByRole("button", { name: "Retry" })); });
  expect(onDecide).toHaveBeenCalledTimes(2);
}

afterEach(cleanup);

describe("Approve at the agent limit", () => {
  it("on the ghost card", async () => {
    const onDecide = vi.fn(async () => { throw capErr(); });
    mount(onDecide);
    await approveAndExpectCap(document.querySelector<HTMLElement>('[data-ghost="dba"]')!, onDecide);
  });

  it("in the detail panel", async () => {
    const onDecide = vi.fn(async () => { throw capErr(); });
    mount(onDecide);
    fireEvent.click(document.querySelector<HTMLElement>('[data-ghost="dba"]')!);
    const panel = await screen.findByTestId("org-panel");
    await approveAndExpectCap(panel, onDecide);
  });
});
