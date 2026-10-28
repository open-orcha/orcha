import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { WorkflowLoopGroup, WorkflowTaskRow, WorkflowTaskRows } from "./WorkflowTaskRows";
import { exampleTask } from "./workflowTestFixtures";
afterEach(cleanup);

const row = (patch: Parameters<typeof exampleTask>[0], loop?: Parameters<typeof WorkflowTaskRow>[0]["loop"]) =>
  render(<WorkflowTaskRows label="Workflow tasks"><WorkflowTaskRow task={exampleTask(patch)} selected={false} onSelect={() => {}} assignees={[]}
    actorName={() => "Someone"} menuItems={[]} loop={loop} /></WorkflowTaskRows>);
const group = (patch: Partial<Parameters<typeof WorkflowLoopGroup>[0]["group"]> = {}) => ({ name: "Draft and review", current_round: 2, max_rounds: 5, exit_outcome: "Passed", state: "open", ...patch });

it("shows a repeat-group step's round on its sub-line and a waiting decision in words", () => {
  row({ awaiting_loop_decision: "limit_reached", display_state: { label: "Accepted · round limit reached, waiting for the owner", release_available: false, release_available_at: null, warning: null, list_warning: false } },
    { round: 3 });
  expect(screen.getByText(/^Round 3 · Accepted · round limit reached, waiting for the owner/)).toBeVisible();
  expect(screen.getByText("Decision needed")).toBeVisible();
});

it("brackets a loop's rows under a header with the round, round dots, exit rule and who decides (x03)", () => {
  render(<WorkflowTaskRows label="Workflow tasks"><WorkflowLoopGroup group={group()} reviewTitle="Review the post" ownerName="Kedar">
    <WorkflowTaskRow task={exampleTask({})} selected={false} onSelect={() => {}} assignees={[]} actorName={() => "Someone"} menuItems={[]} loop={{ round: 2 }} />
  </WorkflowLoopGroup></WorkflowTaskRows>);
  const loop = screen.getByRole("group", { name: "Draft and review, round 2 of 5" });
  expect(within(loop).getByRole("option")).toBeVisible();
  expect(within(loop).getByText("exits when Review the post reports Passed")).toBeVisible();
  expect(within(loop).getByText("then asks Kedar")).toBeVisible();
  const dots = within(loop).getByRole("img", { name: "Round 2 of 5" }).querySelectorAll(".wf-rnd");
  expect([...dots].map((d) => d.className)).toEqual(["wf-rnd is-done", "wf-rnd is-now", "wf-rnd", "wf-rnd", "wf-rnd"]);
});

it("marks a paused loop's current round and says why", () => {
  render(<WorkflowLoopGroup group={group({ current_round: 5, state: "limit_reached" })} ownerName="Kedar"><span /></WorkflowLoopGroup>);
  expect(screen.getByText("Round limit reached")).toBeVisible();
  expect(screen.getByRole("img", { name: "Round 5 of 5" }).querySelectorAll(".wf-rnd")[4]).toHaveClass("is-stop");
});

it("crosses out a step that was not selected and keeps version-1 rows unchanged", () => {
  row({ route_state: "not_selected" });
  expect(screen.getByRole("option")).toHaveClass("wf-notsel");
  cleanup();
  row({});
  expect(screen.getByRole("option")).not.toHaveClass("wf-notsel");
  expect(screen.queryByText(/^Round /)).toBeNull();
  expect(screen.queryByText("Decision needed")).toBeNull();
});

it("shows a loop that has not opened yet as not started, with no round lit (round 0)", () => {
  render(<WorkflowTaskRows label="Workflow tasks"><WorkflowLoopGroup group={group({ current_round: 0 })} reviewTitle="Review the post" ownerName="Kedar">
    <WorkflowTaskRow task={exampleTask({})} selected={false} onSelect={() => {}} assignees={[]} actorName={() => "Someone"} menuItems={[]} loop={{ round: 0 }} />
  </WorkflowLoopGroup></WorkflowTaskRows>);
  const loop = screen.getByRole("group", { name: "Draft and review, not started · up to 5 rounds" });
  const dots = within(loop).getByRole("img", { name: "Not started · up to 5 rounds" }).querySelectorAll(".wf-rnd");
  expect([...dots].map((d) => d.className)).toEqual(Array(5).fill("wf-rnd"));
  expect(within(loop).queryByText(/^Round 0/)).toBeNull();
});
