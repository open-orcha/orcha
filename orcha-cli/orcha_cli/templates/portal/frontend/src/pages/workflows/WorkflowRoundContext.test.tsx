import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowRoundContext } from "./WorkflowRoundContext";
import { exampleTask, exampleWorkflow, jsonResponse } from "./workflowTestFixtures";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const write = exampleTask({ id: "write", title: "Write the post", repeat_group_id: "g", round: 2 });
const review = exampleTask({ id: "review", title: "Review the post", repeat_group_id: "g", round: 2,
  outcomes: [{ name: "Approved", kind: "success" }, { name: "Changes requested", kind: "changes" }],
  routes: [{ outcome: "Approved", destination: "exit_group", destination_task: null }, { outcome: "Changes requested", destination: "return", destination_task: "write" }] });
it("shows the round, the rule that ends it, what it must address and the earlier rounds", async () => {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => { urls.push(url); return jsonResponse({ task_id: "review", outcomes: review.outcomes, group: {
    name: "Draft and review", round: 2, max_rounds: 3, state: "open", review_step: "Review the post", is_review_step: true, exit_outcome: "Approved",
    this_round: { trigger: "return", outcome: "Changes requested", findings: [{ text: "Too long", severity: "major" }], note: "Cut it in half", owner_note: null },
    earlier_rounds: [{ round: 1, ended: "return", findings: [{ text: "Too long" }] }] } }); }));
  render(<WorkflowRoundContext detail={exampleWorkflow({ semantics_version: 2, tasks: [write, review] })} task={review} />);
  expect(await screen.findByText(/round 2 of 3\. It ends when this step reports “Approved”/)).toBeVisible();
  expect(screen.getByText("Sent back by the review with “Changes requested”.")).toBeVisible();
  expect(screen.getByText("major: Too long")).toBeVisible();
  expect(screen.getByText("Reviewer note: Cut it in half")).toBeVisible();
  expect(screen.getByText("Round 1, sent back: Too long")).toBeInTheDocument();
  expect(screen.getByText("“Changes requested”: goes back to Write the post for another round.")).toBeVisible();
  expect(screen.getByText("“Approved”: the loop ends.")).toBeVisible();
  expect(urls).toEqual(["/api/tasks/review/round-context"]);
});
it("reads nothing for a version-one step", () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const { container } = render(<WorkflowRoundContext detail={exampleWorkflow({ tasks: [exampleTask({})] })} task={exampleTask({})} />);
  expect(container).toBeEmptyDOMElement(); expect(fetch).not.toHaveBeenCalled();
});
