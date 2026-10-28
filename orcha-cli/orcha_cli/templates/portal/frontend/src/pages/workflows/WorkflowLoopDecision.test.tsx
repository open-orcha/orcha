import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { WorkflowLoopDecision, WorkflowLoopDecisionPrompt, WorkflowOwnerBar } from "./WorkflowLoopDecision";
import { WorkflowHeader } from "./WorkflowHeader";
import { pathDecider, WorkflowWhyPath } from "./WorkflowRouteSummary";
import { WorkflowTaskInspector } from "./WorkflowTaskInspector";
import { exampleTask, exampleWorkflow, jsonResponse } from "./workflowTestFixtures";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const group = { id: "g1", name: "Draft and review", member_tasks: ["write", "build"], review_task: "build", exit_outcome: "Approved", max_rounds: 3, stall_rule: "findings_and_artifact", current_round: 3, state: "limit_reached" };
const task = exampleTask({ awaiting_loop_decision: "limit_reached", repeat_group_id: "g1", outcomes: [{ name: "Approved", kind: "success" }, { name: "Changes requested", kind: "changes" }],
  reported_outcome: { outcome: "Changes requested", findings: [{ text: "Claims no sign-up but the beta needs an invite" }] } });
const roundContext = (id: string, earlier: { round: number; findings: { text: string }[] }[], previous: { text: string }[]) => ({
  task_id: id, outcomes: [], group: { name: "Draft and review", round: 3, max_rounds: 3, state: "limit_reached", is_review_step: true, exit_outcome: "Approved",
    this_round: { trigger: "return", outcome: "Changes requested", findings: previous }, earlier_rounds: earlier } });

it("asks what happens at the limit with what is still open and numbered choices, and sends the new round limit (x04)", async () => {
  const detail = exampleWorkflow({ repeat_groups: [group], tasks: [task] });
  const scope = { origin: "https://orcha.example", project: detail.container_id, identity: detail.owner_human_id };
  const calls: [string, RequestInit | undefined][] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/round-context")) return jsonResponse(roundContext(task.id, [{ round: 2, findings: [{ text: "Claims no sign-up but the beta needs an invite" }, { text: "Old screenshot" }] }], [{ text: "Claims  no sign-up but the beta needs an invite" }]));
    calls.push([url, init]); return jsonResponse(detail);
  }));
  const onClose = vi.fn();
  render(<WorkflowLoopDecision detail={detail} task={task} scope={scope} stale={false} agents={[]} onSaved={vi.fn()} onClose={onClose} />);
  const dialog = screen.getByRole("dialog", { name: "The loop reached its limit. What should happen?" });
  expect(dialog).toHaveTextContent("Draft and review · 3 of 3 rounds used · last outcome: Changes requested (round 3) · 1 unresolved finding");
  expect(screen.getByText("Still open after round 3")).toBeVisible();
  expect(await screen.findByText(/raised in rounds 1, 2 and 3/)).toBeVisible();
  expect(screen.getByText(/1 earlier finding was resolved along the way/)).toBeVisible();
  expect(screen.getByLabelText(/Allow 2 more rounds \(new maximum 5, 3 used\)/)).toBeChecked();
  fireEvent.change(screen.getByLabelText("More rounds"), { target: { value: "1" } });
  expect(screen.getByLabelText(/Allow 1 more round \(new maximum 4, 3 used\)/)).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Allow 1 more round" }));
  await waitFor(() => expect(calls).toHaveLength(1));
  const [url, init] = calls[0];
  expect(url).toBe(`/api/workflows/${detail.id}/decisions`);
  expect(JSON.parse(String(init?.body))).toMatchObject({ kind: "raise_limit", task_id: task.id, new_max_rounds: 4, expected_revision: detail.revision });
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});

it("sets the stalled rounds side by side and marks the findings that came back unchanged (x05)", async () => {
  const stalled = { ...task, awaiting_loop_decision: "stalled" as const };
  const detail = exampleWorkflow({ repeat_groups: [{ ...group, state: "stalled" }], tasks: [stalled] });
  const scope = { origin: "https://orcha.example", project: detail.container_id, identity: detail.owner_human_id };
  vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(roundContext(task.id, [], [{ text: "Claims no sign-up but the beta needs an invite" }]))));
  render(<WorkflowLoopDecision detail={detail} task={stalled} scope={scope} stale={false} agents={[]} onSaved={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByRole("dialog", { name: "The loop stopped making progress. What should happen?" })).toBeVisible();
  expect(screen.getByText("Why Orcha paused: rounds 2 and 3 side by side")).toBeVisible();
  expect(await screen.findByText("unchanged")).toBeVisible();
  expect(screen.getByLabelText(/Resume with guidance for the worker/)).toBeChecked();
  expect(screen.getByRole("button", { name: "Resume round 4" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Note to the worker"), { target: { value: "Say invite-only beta." } });
  expect(screen.getByRole("button", { name: "Resume round 4" })).toBeEnabled();
});

it("tells people other than the owner who decides", () => {
  const detail = exampleWorkflow({ repeat_groups: [group], tasks: [task] });
  render(<WorkflowLoopDecisionPrompt detail={detail} task={task} viewer="someone-else" onDecide={vi.fn()} />);
  expect(screen.getByText(/The workflow owner decides what happens next/)).toBeVisible();
  expect(screen.queryByRole("button")).toBeNull();
});

it("shows a refused decision's save status once, in the dialog", async () => {
  const detail = exampleWorkflow({ repeat_groups: [group], tasks: [task] });
  const scope = { origin: "https://orcha.example", project: detail.container_id, identity: detail.owner_human_id };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).endsWith("/round-context") ? jsonResponse(roundContext(task.id, [], []))
    : jsonResponse({ detail: { code: "revision_conflict", message: "The workflow changed. Refresh and decide again." } }, 409)));
  render(<WorkflowLoopDecision detail={detail} task={task} scope={scope} stale={false} agents={[]} onSaved={vi.fn()} onClose={vi.fn()} />);
  fireEvent.click(screen.getByLabelText(/Stop the loop/));
  fireEvent.click(screen.getByRole("button", { name: "Stop the loop" }));
  expect(await screen.findByText("The workflow changed. Refresh and decide again.")).toBeVisible();
  expect(screen.getAllByLabelText("Save status")).toHaveLength(1);
});

it("opens the decision from the task inspector and shows its save status once", async () => {
  const detail = exampleWorkflow({ repeat_groups: [group], tasks: [task] });
  const scope = { origin: "https://orcha.example", project: detail.container_id, identity: detail.owner_human_id };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => String(url).endsWith("/decisions")
    ? jsonResponse({ detail: { code: "revision_conflict", message: "The workflow changed. Refresh and decide again." } }, 409)
    : jsonResponse({ detail: { code: "not_found", message: "Not found" } }, 404)));
  render(<MemoryRouter><WorkflowTaskInspector detail={detail} task={task} cid={detail.container_id} scope={scope} verified stale={false} agents={[]}
    actorName={(id) => id} onSaved={vi.fn()} onClose={vi.fn()} onExpand={vi.fn()} request={null} onRequest={vi.fn()} reviewRequest={null} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Decide…" }));
  fireEvent.click(screen.getByLabelText(/Stop the loop/));
  fireEvent.click(screen.getByRole("button", { name: "Stop the loop" }));
  expect(await screen.findByText("The workflow changed. Refresh and decide again.")).toBeVisible();
  expect(screen.getAllByLabelText("Save status")).toHaveLength(1);
});

it("puts a Needs-you bar across the page for the owner and a waiting note for everyone else (x04)", () => {
  const limited = { ...task, repeat_group_id: "g1", reported_outcome: { outcome: "Changes requested" } };
  const detail = exampleWorkflow({ repeat_groups: [group], tasks: [limited] });
  const onDecide = vi.fn();
  render(<WorkflowOwnerBar detail={detail} viewer={detail.owner_human_id} ownerName="Kedar" onDecide={onDecide} />);
  expect(screen.getByRole("status")).toHaveTextContent("Needs you. “Draft and review” used all 3 rounds and the last review reported “Changes requested”. No round 4 was started.");
  fireEvent.click(screen.getByRole("button", { name: "Decide…" }));
  expect(onDecide).toHaveBeenCalledWith(limited.id);
  cleanup();
  render(<WorkflowOwnerBar detail={detail} viewer="someone-else" ownerName="Kedar" onDecide={onDecide} />);
  expect(screen.getByRole("status")).toHaveTextContent(/^Waiting for Kedar\./);
  expect(screen.queryByRole("button", { name: "Decide…" })).toBeNull();
  cleanup();
  const { container } = render(<WorkflowOwnerBar detail={exampleWorkflow({ tasks: [exampleTask({})] })} viewer="x" ownerName="Kedar" onDecide={onDecide} />);
  expect(container).toBeEmptyDOMElement();
});

it("shows the running loop's round and the agent turns used in the workflow header (x03, x11)", () => {
  const running = { ...group, current_round: 2, max_rounds: 5, state: "running" };
  const detail = exampleWorkflow({ semantics_version: 2, repeat_groups: [running], tasks: [exampleTask({})], turn_allowance: 40, turns_used: 7 });
  render(<MemoryRouter><WorkflowHeader detail={detail} ownerName="Kedar" verified stale={false} frozen={false} onAction={vi.fn()} onRefresh={vi.fn()} refreshing={false} primaryHidden={false} /></MemoryRouter>);
  expect(screen.getByText(/· round 2 of 5/)).toBeVisible();
  expect(screen.getByText("agent turns 7 of 40")).toBeVisible();
  cleanup();
  render(<MemoryRouter><WorkflowHeader detail={exampleWorkflow({ tasks: [exampleTask({})] })} ownerName="Kedar" verified stale={false} frozen={false} onAction={vi.fn()} onRefresh={vi.fn()} refreshing={false} primaryHidden={false} /></MemoryRouter>);
  expect(screen.queryByText(/agent turns/)).toBeNull();
  expect(screen.queryByText(/· round \d/)).toBeNull();
});

it("explains why a path was chosen and which steps were not selected (x07)", () => {
  const review = exampleTask({ id: "review", title: "Review the request", status: "completed",
    routes: [{ outcome: "Ready to draft", destination: "step", destination_task: "draft" }, { outcome: "Research needed", destination: "step", destination_task: "research" }],
    reported_outcome: { outcome: "Ready to draft", applied: true } });
  const draft = exampleTask({ id: "draft", title: "Draft the proposal", depends_on: ["review"] });
  const research = exampleTask({ id: "research", title: "Research the market", depends_on: ["review"], route_state: "not_selected" });
  const detail = exampleWorkflow({ semantics_version: 2, tasks: [review, draft, research] });
  expect(pathDecider(detail, research)?.id).toBe("review");
  render(<WorkflowWhyPath detail={detail} task={draft} />);
  const why = screen.getByRole("region", { name: "Why this path" });
  expect(why).toHaveTextContent("Deciding stepReview the request");
  expect(why).toHaveTextContent("Ready to draft → Draft the proposal");
  expect(why).toHaveTextContent("Research needed → Research the market");
  expect(why).toHaveTextContent("Not selectedResearch the market · neither failed nor accepted");
  cleanup();
  const { container } = render(<WorkflowWhyPath detail={exampleWorkflow({ tasks: [review, draft] })} task={draft} />);
  expect(container).toBeEmptyDOMElement();
});
