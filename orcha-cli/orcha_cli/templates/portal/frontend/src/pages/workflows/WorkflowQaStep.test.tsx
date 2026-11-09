/** Quality and Triage steps on screen: the draft's dialogs and Quality workflows, the marks on rows and graph, the step panel. */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { normalizeRequest } from "../qa/requests/api";
import { WorkflowDraftEditor } from "./WorkflowDraftEditor";
import { discardDraft, draftProblems, readDraft, type DraftScope } from "./workflowDraft";
import { WorkflowGraph } from "./WorkflowGraph";
import { qaMark, WorkflowQaStepPanel } from "./WorkflowQaStep";
import type { WorkflowTask } from "./workflowContract.generated";

// These tests cover Quality steps themselves, which are off in new workflows for now.
vi.mock("./workflowQa", async (load) => ({ ...(await load<typeof import("./workflowQa")>()), QUALITY_IN_WORKFLOWS: true }));

const scope: DraftScope = { origin: "https://orcha.example", project: "c1", identity: "kedar" };
const agents = [{ id: "a1", alias: "forge", role: "Builder" }, { id: "a2", alias: "tess", role: "QA" }];
const SCENARIOS = { scenarios: [{ id: "sc1", name: "Sign in", status: "validated", platform: "ios", criteria: [] }, { id: "sc2", name: "Old", status: "retired", platform: "ios", criteria: [] }] };

beforeEach(() => {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as Response;
    if (url.endsWith("/qa/workflow-blocks")) return json({ blocks: [{ key: "check_and_fix", name: "Check and fix", description: "Check the change. A pass ends the loop.", tails: ["qa"], closing: null, draft: {
      title: "Check and fix", goal: "A change that passes QA.",
      tasks: [{ client_key: "qa", title: "Check", assignee_id: null, depends_on: ["build"], outcomes: [{ name: "pass", kind: "success" }, { name: "fail", kind: "failure" }],
        routes: [{ outcome: "pass", destination: "exit_group" }, { outcome: "fail", destination: "return", destination_task: "build" }], qa: { kind: "explore", platform: "ios" } }],
      repeat_groups: [{ name: "Check and fix", member_tasks: ["build", "qa"], review_task: "qa", exit_outcome: "pass", max_rounds: 4 }] } }] });
    if (url.endsWith("/qa/settings")) return json({ agent_id: null, default_platform: "ios", trigger: "manual", on_fail: "report", max_rounds: 4 });
    if (url.endsWith("/qa/targets")) return json({ targets: [] });
    if (url.includes("/qa/scenarios")) return json(SCENARIOS);
    if (url.startsWith("/api/qa/requests/")) return json({ id: "r2", kind: "explore", status: "failed", round: 2, max_rounds: 3, platform: "ios", session_id: "s2", result: { summary: "Still broken", finding_ids: ["f1"], session_ids: ["s2"] }, findings: [{ id: "f1", session_id: "s2", severity: "major", title: "Pay button does nothing", status: "open", frame_ids: ["fr1"] }] });
    return json({});
  }) as unknown as typeof fetch;
});
afterEach(() => { cleanup(); discardDraft(scope); vi.restoreAllMocks(); });

async function addBlock() {
  fireEvent.click(await screen.findByRole("button", { name: "Add a Quality workflow" }));
  const dialog = await screen.findByRole("dialog", { name: "Add a Quality workflow" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Check and fix" }));
}

const editor = (flexible = true) => render(<MemoryRouter><WorkflowDraftEditor scope={scope} saveUnavailableReason="Not now" agents={agents} flexible={flexible} /></MemoryRouter>);

describe("draft editor", () => {
  it("adds a Quality workflow in one click, with the QA agent and rounds filled in", async () => {
    editor();
    await addBlock();
    await waitFor(() => expect(readDraft(scope).tasks).toHaveLength(2));
    const [build, qa] = readDraft(scope).tasks;
    expect(qa).toMatchObject({ assignee: "a2", dependsOn: [build.key] });
    expect(readDraft(scope).repeatGroups?.[0]).toMatchObject({ review: qa.key, maxRounds: 4 });
    expect(screen.queryByRole("dialog", { name: "Add a Quality workflow" })).toBeNull();
  });

  it("has no Quality workflows where the server has no loops", () => {
    editor(false);
    expect(screen.queryByRole("button", { name: "Add a Quality workflow" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add Quality step" })).toBeInTheDocument();
  });

  it("offers a triage step once there is a QA step, and it takes over the loop", async () => {
    editor();
    expect(screen.queryByRole("button", { name: "Add triage step" })).toBeNull();
    await addBlock();
    fireEvent.click(await screen.findByRole("button", { name: "Add triage step" }));
    const dialog = await screen.findByRole("dialog", { name: "Add triage step" });
    expect(within(dialog).getByText("Back to Build with only the confirmed findings")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add triage step" }));
    await waitFor(() => expect(readDraft(scope).tasks).toHaveLength(3));
    const [, qa, triage] = readDraft(scope).tasks;
    expect(triage).toMatchObject({ title: "Triage", assignee: "a2", qa: { kind: "triage" } });
    expect(qa.outcomes?.find((o) => o.name === "fail")).toMatchObject({ destination: "step", destinationTask: triage.key });
    expect(readDraft(scope).repeatGroups?.[0]).toMatchObject({ review: triage.key, exitOutcome: "clear" });
    expect(draftProblems(readDraft(scope))).toEqual([]);
  });

  it("adds a QA step: assignee defaults to the QA agent, tests the last step, sends failures back", async () => {
    editor();
    fireEvent.click(screen.getByRole("button", { name: "Add task summary" }));
    fireEvent.change(screen.getByLabelText("Task summary"), { target: { value: "Build it" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Quality step" }));
    const dialog = await screen.findByRole("dialog", { name: "Add Quality step" });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: /tess/ })).toBeInTheDocument());
    expect(within(dialog).getByText("Back to Build it with the findings")).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByLabelText("Most rounds")).toHaveValue(4));
    fireEvent.change(within(dialog).getByLabelText("Most rounds"), { target: { value: "2" } });
    fireEvent.change(within(dialog).getByLabelText(/Focus/), { target: { value: "Checkout" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add Quality step" }));
    await waitFor(() => expect(readDraft(scope).tasks).toHaveLength(2));
    const qa = readDraft(scope).tasks[1];
    expect(qa).toMatchObject({ title: "Quality: Checkout", assignee: "a2", qa: { kind: "explore", focus: "Checkout", minutes: 20 } });
    expect(readDraft(scope).repeatGroups?.[0].maxRounds).toBe(2);
    expect(screen.getByText("Explore · Default platform · Checkout · 20 min")).toBeInTheDocument();
  });

  it("picks approved scenarios and tags for a check step, and edits the step later", async () => {
    editor();
    fireEvent.click(screen.getByRole("button", { name: "Add Quality step" }));
    const dialog = await screen.findByRole("dialog", { name: "Add Quality step" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Check scenarios" }));
    fireEvent.click(await within(dialog).findByRole("checkbox", { name: "Sign in" }));
    expect(within(dialog).queryByRole("checkbox", { name: "Old" })).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(/Tags/), { target: { value: "auth, smoke, auth" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add Quality step" }));
    await waitFor(() => expect(readDraft(scope).tasks[0]?.qa).toMatchObject({ kind: "check", scenarioIds: ["sc1"], tags: ["auth", "smoke"], minutes: null }));
    fireEvent.click(screen.getByRole("button", { name: "Edit Quality step" }));
    const edit = await screen.findByRole("dialog", { name: "Edit Quality step" });
    expect(within(edit).getByLabelText(/Tags/)).toHaveValue("auth, smoke");
  });

  it("refuses minutes and rounds out of range", async () => {
    editor();
    fireEvent.click(screen.getByRole("button", { name: "Add task summary" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Quality step" }));
    const dialog = await screen.findByRole("dialog", { name: "Add Quality step" });
    fireEvent.change(within(dialog).getByLabelText("Minutes"), { target: { value: "1" } });
    expect(within(dialog).getByRole("button", { name: "Add Quality step" })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Minutes"), { target: { value: "20" } });
    fireEvent.change(within(dialog).getByLabelText("Most rounds"), { target: { value: "11" } });
    expect(within(dialog).getByRole("button", { name: "Add Quality step" })).toBeDisabled();
  });
});

const task = { id: "t1" } as WorkflowTask;
const req = (id: string, round: number, status: string, extra: Record<string, unknown> = {}) => normalizeRequest({ id, kind: "explore", status, round, max_rounds: 3, platform: "ios", created_at: `2026-11-05T1${round}:00:00Z`, ...extra });

describe("qaMark", () => {
  it("marks a step by its latest round; a plain step has no mark", () => {
    expect(qaMark(task, undefined)).toBeUndefined();
    expect(qaMark({ ...task, qa: { kind: "explore" } }, [])).toEqual({ word: "Quality step", tone: "neutral", kind: "quality" });
    expect(qaMark(task, [req("a", 1, "failed"), req("b", 2, "running")])).toEqual({ word: "Quality · Running · Round 2", tone: "warn", kind: "quality" });
    expect(qaMark(task, [req("a", 1, "passed")])).toEqual({ word: "Quality · Passed", tone: "ok", kind: "quality" });
  });
});

describe("a mark from an earlier round", () => {
  it("names its round and stops alarming, once the step moved on", () => {
    expect(qaMark({ ...task, round: 2 }, [req("a", 1, "failed")])).toEqual({ word: "Quality · Failed · Round 1", tone: "neutral", kind: "quality" });
    expect(qaMark(task, [req("a", 1, "failed")], 2)).toMatchObject({ word: "Quality · Failed · Round 1" });
  });
});

describe("a triage step", () => {
  const triage = (status: string, result: unknown) => req("t", 1, status, { kind: "triage", result });
  const rows = [
    { id: "f1", title: "Pay button does nothing", severity: "major", severity_original: "blocker", classification: "product_bug", rate: "fails 3 of 3", root_cause: "The handler is never bound", action: "confirmed" },
    { id: "f2", title: "Spinner lingers", severity: "minor", classification: "flaky", attempts: 3, reproductions: 1, action: "quarantined" },
  ];

  it("marks what it decided", () => {
    expect(qaMark(task, [triage("failed", { diagnoses: rows, confirmed_ids: ["f1"], decision: "fix" })])).toEqual({ word: "Triage · 1 of 2 confirmed", tone: "danger", kind: "triage" });
    expect(qaMark(task, [triage("passed", { diagnoses: rows, confirmed_ids: [] })])).toEqual({ word: "Triage · Clear", tone: "ok", kind: "triage" });
    expect(qaMark(task, [triage("blocked", { diagnoses: rows, confirmed_ids: [] })])).toEqual({ word: "Triage · Needs a person", tone: "warn", kind: "triage" });
    expect(qaMark(task, [req("t", 1, "running", { kind: "triage" })])).toEqual({ word: "Triage · Running", tone: "warn", kind: "triage" });
  });

  it("shows what it decided per finding in the step's panel", async () => {
    const row = triage("failed", { summary: "Triage of 2 findings: fix.", diagnoses: rows, confirmed_ids: ["f1"], decision: "fix" });
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ id: "t", kind: "triage", status: "failed", round: 1, result: { diagnoses: rows, confirmed_ids: ["f1"], decision: "fix" } }) }) as Response) as unknown as typeof fetch;
    render(<MemoryRouter><WorkflowQaStepPanel requests={[row]} nonce={0} /></MemoryRouter>);
    const list = await screen.findByRole("list", { name: "What triage decided" });
    expect(within(list).getByText("Product bug")).toBeInTheDocument();
    expect(within(list).getByText("fails 3 of 3")).toBeInTheDocument();
    expect(within(list).getByText("fails 1 of 3")).toBeInTheDocument();
    expect(within(list).getByText("The handler is never bound")).toBeInTheDocument();
    expect(screen.getByText(/What triage decided: goes to the fix/)).toBeInTheDocument();
  });
});

describe("routes in the dialogs", () => {
  it("shows them set already, and a menu changes one", async () => {
    editor();
    fireEvent.click(screen.getByRole("button", { name: "Add task summary" }));
    fireEvent.change(screen.getByLabelText("Task summary"), { target: { value: "Build it" } });
    fireEvent.click(screen.getByRole("button", { name: "Add Quality step" }));
    const dialog = await screen.findByRole("dialog", { name: "Add Quality step" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Back to Build it with the findings" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Stop and ask the owner" }));
    expect(within(dialog).queryByLabelText("Most rounds")).toBeNull(); // no way back, no loop to limit
    fireEvent.click(within(dialog).getByRole("button", { name: "Add Quality step" }));
    await waitFor(() => expect(readDraft(scope).tasks).toHaveLength(2));
    expect(readDraft(scope).tasks[1].outcomes?.find((o) => o.name === "fail")).toMatchObject({ destination: "ask_owner" });
    expect(readDraft(scope).repeatGroups).toEqual([]);
  });

  it("a step's card edits its route, and a triage step can be edited", async () => {
    editor();
    await addBlock();
    fireEvent.click(await screen.findByRole("button", { name: "Add triage step" }));
    const add = await screen.findByRole("dialog", { name: "Add triage step" });
    fireEvent.change(within(add).getByLabelText(/Focus/), { target: { value: "Payment" } });
    fireEvent.change(within(add).getByLabelText(/Minutes/), { target: { value: "30" } });
    fireEvent.click(within(add).getByRole("button", { name: "Add triage step" }));
    await waitFor(() => expect(readDraft(scope).tasks).toHaveLength(3));
    expect(readDraft(scope).tasks[2].qa).toMatchObject({ kind: "triage", focus: "Payment", minutes: 30 });
    fireEvent.click(screen.getByRole("button", { name: "Edit triage step" }));
    const edit = await screen.findByRole("dialog", { name: "Edit triage step" });
    expect(within(edit).getByLabelText(/Focus/)).toHaveValue("Payment");
    fireEvent.click(within(edit).getByRole("button", { name: "Cancel" }));
    const card = within(screen.getByRole("group", { name: "Task 3" }));
    expect(card.queryByLabelText("Outcome name")).toBeNull(); // these names are the server's, not a field
    fireEvent.click(card.getByRole("button", { name: "Back to Build with only the confirmed findings" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Stop and ask kedar" }).catch(() => screen.findByRole("menuitemradio", { name: "Stop and ask the owner" })));
    await waitFor(() => expect(readDraft(scope).repeatGroups).toEqual([]));
  });

  it("is one entry point: a line of words and a preview of the steps for each, naming Quality", async () => {
    editor();
    fireEvent.click(await screen.findByRole("button", { name: "Add a Quality workflow" }));
    const dialog = await screen.findByRole("dialog", { name: "Add a Quality workflow" });
    expect(within(dialog).getByRole("button", { name: "Check and fix" })).toHaveTextContent("Check the change.");
    expect(screen.queryByRole("group", { name: "Start from a preset" })).toBeNull();
  });

  it("groups the steps under the block, and removing it removes them together", async () => {
    editor();
    await addBlock();
    expect(await screen.findByRole("button", { name: "Remove Check and fix" })).toBeInTheDocument();
    expect(document.querySelectorAll("[data-block-step]").length).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove Check and fix" }));
    await waitFor(() => expect(readDraft(scope).tasks.map((t) => t.title)).toEqual(["Build"]));
    expect(readDraft(scope).repeatGroups).toEqual([]);
  });

  it("says what the project does about finishing, read-only", async () => {
    editor();
    fireEvent.click(await screen.findByRole("button", { name: "Add a Quality workflow" }));
    expect(await screen.findByText("A person verifies the work in this project.")).toBeInTheDocument();
  });
});

describe("graph", () => {
  it("draws the way back, and a round that took it stands out", () => {
    const tasks = [{ id: "b", title: "Build", status: "in_progress", label: "Working", assignee: "forge", dependsOn: [] },
      { id: "t", title: "Triage", status: "completed", label: "Accepted", assignee: "tess", dependsOn: ["b"], qa: { word: "Triage · 1 of 2 confirmed", tone: "danger" as const, kind: "triage" as const }, returns: [{ to: "b", label: "Round 1: 1 confirmed finding went back", active: true }] }];
    const { container } = render(<WorkflowGraph tasks={tasks} selected={null} onSelect={() => {}} />);
    expect(screen.getByText("Round 1: 1 confirmed finding went back")).toBeInTheDocument();
    expect(container.querySelector('[data-return="active"]')).not.toBeNull();
    expect(container.querySelector(".wf-gnode.is-triage")).not.toBeNull();
  });

  it("shows the mark on the node", () => {
    render(<WorkflowGraph tasks={[{ id: "t1", title: "QA", status: "in_progress", label: "Running", assignee: "tess", dependsOn: [], qa: { word: "Quality · Running · Round 2", tone: "warn", kind: "quality" } }]} selected={null} onSelect={() => {}} />);
    expect(screen.getByRole("button", { name: /Quality · Running · Round 2/ })).toHaveClass("is-qa");
  });
});

describe("a Quality workflow on the graph", () => {
  it("draws one labelled outline around its steps", () => {
    const block = { id: "b1", name: "Check and fix" };
    const tasks = [{ id: "b", title: "Build", status: "ready", label: "Ready", assignee: "forge", dependsOn: [] },
      { id: "c", title: "Check", status: "pending", label: "Pending", assignee: "tess", dependsOn: ["b"], block },
      { id: "t", title: "Triage", status: "pending", label: "Pending", assignee: "tess", dependsOn: ["c"], block }];
    const { container } = render(<WorkflowGraph tasks={tasks} selected={null} onSelect={() => {}} />);
    const outlines = container.querySelectorAll("[data-graph-block]");
    expect(outlines).toHaveLength(1);
    expect(outlines[0]).toHaveTextContent("Check and fix");
  });
});

describe("step panel", () => {
  const mount = (rows: ReturnType<typeof req>[]) => render(<MemoryRouter><WorkflowQaStepPanel requests={rows} nonce={0} /></MemoryRouter>);

  it("says what it will do before the step starts", () => {
    mount([]);
    expect(screen.getByText(/The request starts when the step does/)).toBeInTheDocument();
  });

  it("links the device while it runs", () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response) as unknown as typeof fetch;
    mount([req("r1", 1, "running", { session_id: "s1" })]);
    expect(screen.getByRole("link", { name: "Watch the device" }).getAttribute("href")).toBe("/qa?view=sessions&session=s1&sub=run");
  });

  it("shows findings and every round, each linking to its request", async () => {
    mount([req("r1", 1, "failed", { result: { finding_ids: ["x"] } }), req("r2", 2, "failed")]);
    expect(await screen.findByRole("link", { name: "Pay button does nothing" })).toBeInTheDocument();
    expect(screen.getByText("Still broken")).toBeInTheDocument();
    const rounds = screen.getByRole("list", { name: "Quality rounds" });
    expect(within(rounds).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/qa?view=requests&request=r1", "/qa?view=requests&request=r2"]);
    expect(rounds.textContent).toContain("1 finding");
    expect(screen.getByRole("link", { name: "Open the session" }).getAttribute("href")).toBe("/qa?view=sessions&session=s2");
  });
});
