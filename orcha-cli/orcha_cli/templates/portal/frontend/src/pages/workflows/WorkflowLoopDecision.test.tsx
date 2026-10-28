import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowLoopDecision } from "./WorkflowLoopDecision";
import { exampleTask, exampleWorkflow, jsonResponse } from "./workflowTestFixtures";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const group = { id: "g1", name: "Draft and review", member_tasks: ["write", "build"], review_task: "build", exit_outcome: "Approved", max_rounds: 3, stall_rule: "findings_and_artifact", current_round: 3, state: "limit_reached" };
const task = exampleTask({ awaiting_loop_decision: "limit_reached", outcomes: [{ name: "Approved", kind: "success" }, { name: "Changes requested", kind: "changes" }] });

it("offers the limit choices with their consequences and sends the new round limit", async () => {
  const detail = exampleWorkflow({ repeat_groups: [group], tasks: [task] });
  const scope = { origin: "https://orcha.example", project: detail.container_id, identity: detail.owner_human_id };
  const calls: [string, RequestInit | undefined][] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { calls.push([url, init]); return jsonResponse(detail); }));
  render(<WorkflowLoopDecision detail={detail} task={task} scope={scope} stale={false} agents={[]} onSaved={vi.fn()} />);
  expect(screen.getByText("The loop reached its round limit")).toBeVisible();
  expect(screen.getByText(/round 3 of 3/)).toBeVisible();
  fireEvent.click(screen.getByLabelText(/Allow more rounds/));
  fireEvent.change(screen.getByLabelText("Most rounds"), { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: "Allow more rounds" }));
  await waitFor(() => expect(calls).toHaveLength(1));
  const [url, init] = calls[0];
  expect(url).toBe(`/api/workflows/${detail.id}/decisions`);
  expect(JSON.parse(String(init?.body))).toMatchObject({ kind: "raise_limit", task_id: task.id, new_max_rounds: 5, expected_revision: detail.revision });
});

it("tells people other than the owner who decides", () => {
  const detail = exampleWorkflow({ repeat_groups: [group], tasks: [task] });
  render(<WorkflowLoopDecision detail={detail} task={task} scope={{ origin: "o", project: detail.container_id, identity: "someone-else" }} stale={false} agents={[]} onSaved={vi.fn()} />);
  expect(screen.getByText(/The workflow owner decides what happens next/)).toBeVisible();
  expect(screen.queryByRole("button")).toBeNull();
});
