/** Task detail's QA block: nothing for ordinary tasks; sessions, findings, drafts and checks when there is QA data. */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { TaskQaSection } from "./TaskQaSection";

function stub(res: { status: number; body: unknown }) {
  global.fetch = vi.fn(async () => ({ ok: res.status < 300, status: res.status, json: async () => res.body }) as Response) as unknown as typeof fetch;
}

function mount() {
  return render(<MemoryRouter><div data-testid="host"><TaskQaSection taskId="t1" /></div></MemoryRouter>);
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("TaskQaSection", () => {
  it("renders nothing when the task has no QA data", async () => {
    stub({ status: 200, body: { sessions: [], findings: [], scenarios: [], verdicts: [] } });
    mount();
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith("/api/tasks/t1/qa", expect.anything()));
    expect(screen.getByTestId("host")).toBeEmptyDOMElement();
  });

  it("renders nothing when the server has no QA routes (404)", async () => {
    stub({ status: 404, body: { detail: "Not Found" } });
    mount();
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.getByTestId("host")).toBeEmptyDOMElement();
  });

  it("says when the work finished by itself and who allowed it", async () => {
    stub({ status: 200, body: { sessions: [{ id: "s1", kind: "check", platform: "web", status: "done", started_at: "2026-11-04T10:00:00Z" }], findings: [], scenarios: [], verdicts: [],
      final_decision: { decision: "finished", turned_on_by_alias: "kedar", reasons: [], lines: [] } } });
    mount();
    const line = await screen.findByText("Finished by itself.");
    expect(line.parentElement?.textContent).toContain("Turned on by kedar");
  });

  it("links the task's sessions, findings, drafted scenarios and checks into Quality", async () => {
    stub({
      status: 200,
      body: {
        sessions: [{ id: "s1", kind: "explore", platform: "android", status: "done", goal: "Explore checkout", started_at: "2026-11-04T10:00:00Z" }],
        findings: [{ id: "f1", session_id: "s1", severity: "blocker", title: "Pay button does nothing", status: "open", frame_ids: [] }],
        scenarios: [{ id: "sc1", platform: "android", name: "Pay with a card", status: "draft", criteria: [] }],
        verdicts: [
          { id: "v1", session_id: "s1", scenario_id: "sc9", scenario_name: "Sign in", criterion_index: 0, verdict: "pass", frame_ids: [] },
          { id: "v2", session_id: "s1", scenario_id: "sc9", criterion_index: 1, verdict: "fail", frame_ids: [] },
        ],
      },
    });
    mount();
    const block = await screen.findByRole("region", { name: "QA" });
    expect(within(block).getByRole("link", { name: /Explore checkout/ }).getAttribute("href")).toBe("/qa?view=sessions&platform=android&session=s1");
    expect(within(block).getByText("Blocker")).toBeInTheDocument();
    expect(within(block).getByRole("link", { name: "Pay button does nothing" }).getAttribute("href")).toBe("/qa?view=sessions&platform=android&session=s1");
    expect(within(block).getByRole("link", { name: /Pay with a card/ }).getAttribute("href")).toBe("/qa?view=scenarios&platform=android&scenario=sc1");
    expect(within(block).getByText("1 pass · 1 fail")).toBeInTheDocument();
  });
});
