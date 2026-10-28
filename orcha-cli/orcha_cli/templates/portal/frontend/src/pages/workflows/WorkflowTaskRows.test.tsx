import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { WorkflowTaskRow, WorkflowTaskRows } from "./WorkflowTaskRows";
import { exampleTask } from "./workflowTestFixtures";
afterEach(cleanup);

const row = (patch: Parameters<typeof exampleTask>[0], loop?: Parameters<typeof WorkflowTaskRow>[0]["loop"]) =>
  render(<WorkflowTaskRows label="Workflow tasks"><WorkflowTaskRow task={exampleTask(patch)} selected={false} onSelect={() => {}} assignees={[]}
    actorName={() => "Someone"} menuItems={[]} loop={loop} /></WorkflowTaskRows>);

it("shows a repeat-group step's round and a waiting decision in words", () => {
  row({ awaiting_loop_decision: "limit_reached", display_state: { label: "Accepted · round limit reached, waiting for the owner", release_available: false, release_available_at: null, warning: null, list_warning: false } },
    { name: "Draft and review", round: 3, max: 3 });
  expect(screen.getByText("Round 3 of 3").closest("[title]")).toHaveAttribute("title", "Repeat group: Draft and review");
  expect(screen.getByText("Decision needed")).toBeVisible();
  expect(screen.getByText("Accepted · round limit reached, waiting for the owner")).toBeVisible();
});

it("draws the loop bracket on member rows and names the exit rule", () => {
  row({}, { name: "Draft and review", round: 2, max: 5, edge: "first", exit: "Ends when Review reports “Approved”." });
  expect(screen.getByRole("option")).toHaveClass("wf-loop", "is-loop-first");
  expect(screen.getByText("Round 2 of 5").closest("[title]")).toHaveAttribute("title", "Repeat group: Draft and review. Ends when Review reports “Approved”.");
});

it("keeps version-1 rows unchanged", () => {
  row({});
  expect(screen.getByRole("option")).not.toHaveClass("wf-loop");
  expect(screen.queryByText(/^Round /)).toBeNull();
  expect(screen.queryByText("Decision needed")).toBeNull();
});
