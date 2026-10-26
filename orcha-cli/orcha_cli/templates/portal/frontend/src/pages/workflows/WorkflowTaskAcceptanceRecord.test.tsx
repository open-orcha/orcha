import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowTaskAcceptanceRecord } from "./WorkflowTaskAcceptanceRecord";
import { WorkflowActions } from "./WorkflowActions";
import { exampleTask, exampleWorkflow, jsonResponse, writeCapability } from "./workflowTestFixtures";
import type { TaskAcceptance } from "./workflowContract.generated";
const acceptance: TaskAcceptance = {
  id: "acceptance", work_revision: 3, actor_id: "andrew", actor_alias: "Andrew", actor_kind: "ai",
  autonomy_at_acceptance: "on", autonomy_revision: 2, acceptance_source: "verification", evidence_set_id: "accepted-set",
  accepted_at: "2026-10-25T10:00:00Z",
  evidence_items: [{ item_id: "item", deliverable_id: "result", deliverable_version: 2, sha256: "a".repeat(64), source: "worker", storage_state: "readable",
    captured_by: "andrew", captured_by_alias: "Andrew", captured_by_kind: "ai" }],
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("shows recorded agent authority and exact files after current autonomy and evidence change", () => {
  render(<WorkflowTaskAcceptanceRecord task={exampleTask({ autonomy: "off", current_evidence_set_id: "newer-set", acceptance })} />);
  expect(screen.getByText(/Accepted by Andrew \(agent\) for work revision 3/)).toBeVisible();
  expect(screen.getByText(/Task autonomy ON at acceptance/)).toBeVisible();
  expect(screen.getByRole("link", { name: "Accepted evidence — version 2" })).toHaveAttribute("href", "/api/tasks/build/deliverables/result/versions/2/raw");
  expect(screen.getByText(/SHA-256/)).toHaveTextContent("a".repeat(64));
  expect(screen.queryByText(/newer-set/)).toBeNull();
});
it("does not claim an agent's recorded OFF acceptance is authorized", () => {
  render(<WorkflowTaskAcceptanceRecord task={exampleTask({ acceptance: { ...acceptance, autonomy_at_acceptance: "off" } })} />);
  expect(screen.getByText(/does not establish valid agent acceptance/)).toBeVisible();
  expect(screen.queryByText("Agent acceptance authorized by task autonomy.")).toBeNull();
});
it("distinguishes human acceptance and missing accepted files without substituting newer versions", () => {
  render(<WorkflowTaskAcceptanceRecord task={exampleTask({ acceptance: { ...acceptance, actor_id: "kedar", actor_alias: "Kedar", actor_kind: "human", autonomy_at_acceptance: "off",
    evidence_items: [{ ...acceptance.evidence_items[0], storage_state: "missing_after_restore" }] } })} />);
  expect(screen.getByText("Human acceptance.")).toBeVisible();
  expect(screen.getByText(/Accepted file missing after restore/)).toBeVisible();
  expect(screen.getByRole("link")).toHaveAttribute("href", "/api/tasks/build/deliverables/result/versions/2/raw");
});
it("shows immutable outside-result supplier attribution and same-person acceptance", () => {
  render(<WorkflowTaskAcceptanceRecord task={exampleTask({ acceptance: { ...acceptance, actor_id: "kedar", actor_alias: "Kedar", actor_kind: "human", evidence_items: [{ ...acceptance.evidence_items[0], source: "outside", captured_by: "kedar", captured_by_alias: "Kedar", captured_by_kind: "human" }] } })} />);
  expect(screen.getByText("Submitted by Kedar (verified).")).toBeVisible();
  expect(screen.getByText("Owner-supplied result, accepted by the same person.")).toBeVisible();
  expect(screen.queryByText(/supplier attribution is unavailable/)).toBeNull();
});
it("describes imported results as pre-existing work reviewed on import", () => {
  render(<WorkflowTaskAcceptanceRecord task={exampleTask({ acceptance: { ...acceptance, actor_id: "kedar", actor_alias: "Kedar", actor_kind: "human", acceptance_source: "import",
    evidence_items: [{ ...acceptance.evidence_items[0], kind: "import_result", source: "import", captured_by: "kedar", captured_by_alias: "Kedar", captured_by_kind: "human" }] } })} />);
  expect(screen.getByText("Completed before it joined this workflow; reviewed and accepted on import by Kedar.")).toBeVisible();
  expect(screen.queryByText(/Submitted by/)).toBeNull();
  expect(screen.queryByText(/Owner-supplied result/)).toBeNull();
});
it("fails closed when an older accepted item has no recorded source", () => {
  render(<WorkflowTaskAcceptanceRecord task={exampleTask({ acceptance: { ...acceptance, actor_kind: "human", evidence_items: [{ ...acceptance.evidence_items[0], source: undefined }] } })} />);
  expect(screen.getByText(/supplier attribution was not recorded/)).toBeVisible();
  expect(screen.getByText(/no supported recovery path/)).toBeVisible();
});
it("blocks Finish when required supplier attribution cannot be reviewed", async () => {
  const task = exampleTask({ status: "completed", acceptance: { ...acceptance, actor_kind: "human", evidence_items: [{ ...acceptance.evidence_items[0], source: "outside", captured_by: null, captured_by_alias: null, captured_by_kind: null }] } });
  const detail = exampleWorkflow({ tasks: [task], capability: writeCapability, evidence_capability: { available: true },
    available_actions: [{ action: "finish", enabled: true }], completion: { can_finish: true, blockers: [] },
    goal_accepted_revision: 1, objectives: [], progress: { accepted: 1, total: 1, percent: 100, withdrawn: 0, objectives_accepted: 0, objectives_total: 0 } });
  const writes: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") writes.push(url);
    return jsonResponse(url.endsWith("completion-check") ? detail.completion : detail);
  }));
  render(<MemoryRouter><WorkflowActions detail={detail} scope={{ origin: "https://orcha.example", project: "project", identity: "kedar" }} verified stale={false} onSaved={vi.fn()} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Finish checklist" }));
  await screen.findByText(/legacy acceptances do not record who submitted the result/);
  expect(screen.getByRole("button", { name: "Finish workflow" })).toBeDisabled(); expect(writes).toEqual([]);
});
it("keeps Finish available when the accepted outside result has immutable supplier attribution", async () => {
  const task = exampleTask({ status: "completed", acceptance: { ...acceptance, actor_id: "kedar", actor_alias: "Kedar", actor_kind: "human",
    evidence_items: [{ ...acceptance.evidence_items[0], source: "outside", captured_by: "kedar", captured_by_alias: "Kedar", captured_by_kind: "human" }] } });
  const detail = exampleWorkflow({ tasks: [task], capability: writeCapability, evidence_capability: { available: true },
    available_actions: [{ action: "finish", enabled: true }], completion: { can_finish: true, blockers: [] },
    goal_accepted_revision: 1, objectives: [], progress: { accepted: 1, total: 1, percent: 100, withdrawn: 0, objectives_accepted: 0, objectives_total: 0 } });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => jsonResponse(url.endsWith("completion-check") ? detail.completion : detail)));
  render(<MemoryRouter><WorkflowActions detail={detail} scope={{ origin: "https://orcha.example", project: "project", identity: "kedar" }} verified stale={false} onSaved={vi.fn()} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Finish checklist" }));
  expect(await screen.findByRole("button", { name: "Finish workflow" })).toBeEnabled();
  expect(screen.getByText("1 owner-supplied result accepted by the same person.")).toBeVisible();
  expect(screen.getByRole("button", { name: "View" })).toBeEnabled();
  expect(screen.queryByText(/legacy acceptances do not record who submitted the result/)).toBeNull();
});
