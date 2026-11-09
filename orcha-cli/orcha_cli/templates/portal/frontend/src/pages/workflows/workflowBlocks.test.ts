/** Quality workflows as blocks: what inserting one wires, and what removing one undoes. */
import { describe, expect, it } from "vitest";
import type { QaWorkflowBlock } from "../qa/requests/api";
import { toWireDraft } from "./WorkflowDraftSave";
import { blockPreview, blocksIn, insertBlock, removeBlock } from "./workflowBlocks";
import { draftProblems, emptyDraft, newDraftTask, type DraftTask, type WorkflowDraft } from "./workflowDraft";
import { addQaStep, editQaStep, routeRows, testedBy } from "./workflowQa";

/** As `GET C/workflow-blocks` serves them (`qa_blocks.py`). */
const NEXT_STEP = { client_key: "next", title: "Sum up", definition_of_done: "Say what was built and what QA proved.", assignee_id: null, depends_on: [] };
const CHECK_AND_FIX: QaWorkflowBlock = { key: "check_and_fix", name: "Check and fix", description: "Check, triage, fix until it passes.", tails: ["qa", "triage"], closing: NEXT_STEP, draft: {
  title: "Check and fix", goal: "It passes.",
  tasks: [
    { client_key: "qa", title: "Check", definition_of_done: "Every scenario has a verdict.", depends_on: ["build"], assignee_id: null,
      outcomes: [{ name: "pass", kind: "success" }, { name: "fail", kind: "failure" }],
      routes: [{ outcome: "pass", destination: "step", destination_task: "next" }, { outcome: "fail", destination: "step", destination_task: "triage" }], qa: { kind: "check" } },
    { client_key: "triage", title: "Triage", definition_of_done: "Every finding has a diagnosis.", depends_on: ["qa"], assignee_id: null,
      outcomes: [{ name: "fix", kind: "changes" }, { name: "clear", kind: "success" }, { name: "needs_person", kind: "custom" }],
      routes: [{ outcome: "fix", destination: "return", destination_task: "build" }, { outcome: "clear", destination: "exit_group" }, { outcome: "needs_person", destination: "ask_owner" }], qa: { kind: "triage" } },
  ],
  repeat_groups: [{ name: "Check and fix", member_tasks: ["build", "qa", "triage"], review_task: "triage", exit_outcome: "clear", max_rounds: 3 }],
} };
/** Its loop is its own: a draft goes back to the exploration, nothing goes back to the build. */
const EXPLORE: QaWorkflowBlock = { key: "explore_and_draft", name: "Explore and draft", description: "Walk the app, then draft scenarios.", tails: ["draft"], closing: null, draft: {
  tasks: [
    { client_key: "explore", title: "Explore", definition_of_done: "Walked.", depends_on: ["build"], outcomes: [{ name: "pass", kind: "success" }, { name: "fail", kind: "failure" }],
      routes: [{ outcome: "pass", destination: "step", destination_task: "draft" }, { outcome: "fail", destination: "step", destination_task: "draft" }], qa: { kind: "explore" } },
    { client_key: "draft", title: "Draft scenarios", definition_of_done: "Drafted.", depends_on: ["explore"], outcomes: [{ name: "pass", kind: "success" }, { name: "fail", kind: "failure" }],
      routes: [{ outcome: "pass", destination: "exit_group" }, { outcome: "fail", destination: "return", destination_task: "explore" }], qa: { kind: "draft" } },
  ],
  repeat_groups: [{ name: "Explore and draft", member_tasks: ["explore", "draft"], review_task: "draft", exit_outcome: "pass", max_rounds: 3 }],
} };

function named(...titles: string[]): WorkflowDraft {
  const tasks = titles.map((title) => ({ ...newDraftTask(), title }));
  tasks.forEach((t, i) => { if (i) t.dependsOn = [tasks[i - 1].key]; });
  return { ...emptyDraft(), name: "Release", goal: "Ship", tasks };
}
const step = (d: WorkflowDraft, title: string) => d.tasks.find((t) => t.title === title) as DraftTask;

describe("insertBlock", () => {
  it("puts the steps after the chosen step and in front of what followed it", () => {
    const draft = named("Build", "Ship");
    const { draft: next, keys } = insertBlock(draft, CHECK_AND_FIX, { after: step(draft, "Build").key, assignees: { quality: "tess" } });
    expect(next.tasks.map((t) => t.title)).toEqual(["Build", "Check", "Triage", "Ship"]);
    expect(step(next, "Check")).toMatchObject({ dependsOn: [step(next, "Build").key], assignee: "tess", qa: { kind: "check" } });
    expect(step(next, "Ship").dependsOn.sort()).toEqual([step(next, "Check").key, step(next, "Triage").key].sort());
    expect(keys).toHaveLength(2);
    expect(draftProblems(next)).toEqual([]);
  });

  it("wires a fail back to the chosen build, a pass on to what follows, inside one loop named for the block", () => {
    const draft = named("Build", "Ship");
    const { draft: next } = insertBlock(draft, CHECK_AND_FIX, { after: step(draft, "Build").key });
    const [build, check, triage, ship] = ["Build", "Check", "Triage", "Ship"].map((t) => step(next, t));
    expect(check.outcomes).toEqual([
      { name: "pass", kind: "success", destination: "step", destinationTask: ship.key },
      { name: "fail", kind: "failure", destination: "step", destinationTask: triage.key },
    ]);
    expect(triage.outcomes?.[0]).toMatchObject({ name: "fix", destination: "return", destinationTask: build.key });
    expect(next.repeatGroups).toEqual([expect.objectContaining({ name: "Check and fix", members: [build.key, check.key, triage.key], review: triage.key, exitOutcome: "clear", maxRounds: 3 })]);
  });

  it("keeps a branch that led to what followed, now leading into the block", () => {
    const draft = named("Build", "Ship");
    const ship = step(draft, "Ship");
    const routed = { ...draft, tasks: draft.tasks.map((t) => (t.title === "Build" ? { ...t, outcomes: [{ name: "done", kind: "success" as const, destination: "step" as const, destinationTask: ship.key }] } : t)) };
    const { draft: next } = insertBlock(routed, EXPLORE, { after: step(routed, "Build").key });
    expect(step(next, "Build").outcomes?.[0].destinationTask).toBe(step(next, "Explore").key);
    expect(draftProblems(next)).toEqual([]);
  });

  it("brings its closing step when nothing follows, so a pass has somewhere to go", () => {
    const draft = named("Build");
    const { draft: next } = insertBlock(draft, CHECK_AND_FIX, { after: step(draft, "Build").key });
    expect(next.tasks.map((t) => t.title)).toEqual(["Build", "Check", "Triage", "Sum up"]);
    expect(step(next, "Check").outcomes?.[0]).toMatchObject({ destination: "step", destinationTask: step(next, "Sum up").key });
    expect(step(next, "Sum up").dependsOn).toEqual([step(next, "Check").key, step(next, "Triage").key]);
    expect(draftProblems(next)).toEqual([]);
  });

  it("brings a Build step along on an empty draft, and the workflow's name and goal", () => {
    const { draft: next } = insertBlock(emptyDraft(), CHECK_AND_FIX, { after: null, assignees: { build: "forge" } });
    expect(next.tasks.map((t) => t.title)).toEqual(["Build", "Check", "Triage", "Sum up"]);
    expect(step(next, "Build")).toMatchObject({ assignee: "forge", dependsOn: [] });
    expect(step(next, "Build").block).toBeUndefined();
    expect(next).toMatchObject({ name: "Check and fix", goal: "It passes." });
    expect(draftProblems(next)).toEqual([]);
  });

  it("a block with its own loop needs no build: it starts an empty draft with no Build step", () => {
    const { draft: next } = insertBlock(emptyDraft(), EXPLORE, { after: null });
    expect(next.tasks.map((t) => t.title)).toEqual(["Explore", "Draft scenarios"]);
    expect(step(next, "Explore").dependsOn).toEqual([]);
    expect(next.repeatGroups?.[0]).toMatchObject({ name: "Explore and draft", members: [step(next, "Explore").key, step(next, "Draft scenarios").key] });
  });

  it("never puts a step in two loops: with its build taken, a person decides instead", () => {
    const draft = named("Build");
    const first = addQaStep(draft, { qa: { kind: "explore" }, assignee: "", buildKey: step(draft, "Build").key, maxRounds: 3, flexible: true });
    const { draft: next } = insertBlock(first.draft, CHECK_AND_FIX, { after: step(draft, "Build").key });
    expect(next.repeatGroups).toHaveLength(1);
    expect(step(next, "Triage").outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ name: "fix", destination: "ask_owner" }), expect.objectContaining({ name: "clear", destination: "next" })]));
  });

  it("sends fixes to the real step above when added after a Quality step", () => {
    const draft = named("Build");
    const first = addQaStep(draft, { qa: { kind: "explore" }, assignee: "", buildKey: null, maxRounds: 3, flexible: true });
    const quality = first.draft.tasks.find((t) => t.qa)!;
    const withParent = { ...first.draft, tasks: first.draft.tasks.map((t) => (t.key === quality.key ? { ...t, dependsOn: [step(draft, "Build").key] } : t)) };
    const { draft: next } = insertBlock(withParent, CHECK_AND_FIX, { after: quality.key });
    expect(step(next, "Check").dependsOn).toEqual([quality.key]);
    expect(step(next, "Triage").outcomes?.[0].destinationTask).toBe(step(draft, "Build").key);
    expect(next.repeatGroups?.[0].members).toEqual([step(draft, "Build").key, quality.key, step(next, "Check").key, step(next, "Triage").key]);
  });

  it("keeps a block's own loop whatever the step before it is in", () => {
    const draft = named("Build");
    const first = addQaStep(draft, { qa: { kind: "explore" }, assignee: "", buildKey: step(draft, "Build").key, maxRounds: 3, flexible: true });
    const { draft: next } = insertBlock(first.draft, EXPLORE, { after: step(draft, "Build").key });
    expect(step(next, "Explore").dependsOn).toEqual([step(next, "Build").key]);
    expect(step(next, "Draft scenarios").dependsOn).toEqual([step(next, "Explore").key]);
    expect(next.repeatGroups).toHaveLength(2);
    expect(step(next, "Draft scenarios").outcomes?.[1]).toMatchObject({ destination: "return", destinationTask: step(next, "Explore").key });
  });

  it("two of one block get different loop names", () => {
    const draft = named("Build");
    const one = insertBlock(draft, EXPLORE, { after: step(draft, "Build").key }).draft;
    const two = insertBlock(one, EXPLORE, { after: one.tasks.at(-1)!.key }).draft;
    expect(two.repeatGroups?.map((g) => g.name)).toEqual(["Explore and draft", "Explore and draft 2"]);
  });

  it("labels every step with the block, and the wire carries the label", () => {
    const draft = named("Build");
    const { draft: next } = insertBlock(draft, EXPLORE, { after: step(draft, "Build").key });
    expect(blocksIn(next)).toEqual([expect.objectContaining({ name: "Explore and draft", steps: 2 })]);
    const wire = toWireDraft(next).tasks as { title: string; block?: unknown }[];
    expect(wire.map((t) => t.block)).toEqual([undefined, { key: "explore_and_draft", name: "Explore and draft" }, { key: "explore_and_draft", name: "Explore and draft" }]);
  });

  it("keeps a block's way back to a Quality step readable, and the steps in draft order on the wire", () => {
    const draft = named("Build");
    const { draft: next } = insertBlock(draft, EXPLORE, { after: step(draft, "Build").key });
    expect(routeRows(next, step(next, "Draft scenarios").key).find((r) => r.outcome === "fail")?.label).toBe("Back to Explore");
    expect(toWireDraft(next).tasks?.map((t) => t.priority)).toEqual([21, 22, 23]);
  });

  it("every step stays editable: a changed title survives", () => {
    const draft = named("Build");
    const { draft: next } = insertBlock(draft, EXPLORE, { after: step(draft, "Build").key });
    const edited = { ...next, tasks: next.tasks.map((t) => (t.title === "Explore" ? { ...t, title: "Explore checkout" } : t)) };
    expect(blocksIn(edited)[0].steps).toBe(2);
  });

  it("previews a block's own steps, with the rounds when it loops back", () => {
    expect(blockPreview(CHECK_AND_FIX)).toMatchObject({ rounds: 3, loopsBack: true });
    expect(blockPreview(CHECK_AND_FIX).steps.map((s) => [s.title, s.tone])).toEqual([["Check", "quality"], ["Triage", "triage"]]);
    expect(blockPreview(EXPLORE).loopsBack).toBe(false);
  });
});

describe("removeBlock", () => {
  it("takes its steps out together and joins what they sat between", () => {
    const draft = named("Build", "Ship");
    const { draft: next } = insertBlock(draft, CHECK_AND_FIX, { after: step(draft, "Build").key });
    const gone = removeBlock(next, blocksIn(next)[0].id);
    expect(gone.tasks.map((t) => t.title)).toEqual(["Build", "Ship"]);
    expect(step(gone, "Ship").dependsOn).toEqual([step(gone, "Build").key]);
    expect(gone.repeatGroups).toEqual([]);
    expect(draftProblems(gone)).toEqual([]);
  });

  it("restores a branch that led into it", () => {
    const draft = named("Build", "Ship");
    const ship = step(draft, "Ship");
    const routed = { ...draft, tasks: draft.tasks.map((t) => (t.title === "Build" ? { ...t, outcomes: [{ name: "done", kind: "success" as const, destination: "step" as const, destinationTask: ship.key }] } : t)) };
    const { draft: next } = insertBlock(routed, EXPLORE, { after: step(routed, "Build").key });
    const gone = removeBlock(next, blocksIn(next)[0].id);
    expect(step(gone, "Build").outcomes?.[0]).toMatchObject({ destination: "step", destinationTask: ship.key });
  });

  it("leaves another block alone", () => {
    const draft = named("Build");
    const one = insertBlock(draft, EXPLORE, { after: step(draft, "Build").key }).draft;
    const two = insertBlock(one, EXPLORE, { after: one.tasks.at(-1)!.key }).draft;
    const [first] = blocksIn(two);
    const gone = removeBlock(two, first.id);
    expect(gone.tasks).toHaveLength(3);
    expect(gone.tasks[1].dependsOn).toEqual([gone.tasks[0].key]);
  });
});


describe("changing a step that came from a block", () => {
  it("keeps the block's wiring and never makes a cycle", () => {
    const start = { ...emptyDraft(), tasks: [{ ...newDraftTask(), title: "Report" }] };
    const block: QaWorkflowBlock = {
      key: "map_the_app", name: "Map the app", description: "", tails: ["coverage"], closing: null,
      draft: { tasks: [
        { client_key: "map", title: "Map", depends_on: ["build"], qa: { kind: "map" }, outcomes: [{ name: "pass", kind: "success" }, { name: "fail", kind: "failure" }], routes: [{ outcome: "pass", destination: "step", destination_task: "coverage" }, { outcome: "fail", destination: "ask_owner" }] },
        { client_key: "coverage", title: "Coverage summary", depends_on: ["map"], outcomes: [{ name: "complete", kind: "success" }, { name: "gaps", kind: "changes" }], routes: [{ outcome: "complete", destination: "exit_group" }, { outcome: "gaps", destination: "return", destination_task: "map" }] },
      ], repeat_groups: [{ name: "Map the app", member_tasks: ["map", "coverage"], review_task: "coverage", exit_outcome: "complete", max_rounds: 3 }] },
    } as unknown as QaWorkflowBlock;
    const { draft } = insertBlock(start, block, { after: start.tasks[0].key });
    const map = draft.tasks.find((t) => t.title === "Map")!;
    expect(testedBy(draft, map.key)).toBe(start.tasks[0].key);
    const next = editQaStep(draft, map.key, { qa: { kind: "map", platform: "ios", scenarioIds: [], tags: [], focus: "Guest only", minutes: 5 }, assignee: "", buildKey: testedBy(draft, map.key), maxRounds: 3, flexible: true }).draft;
    expect(next.tasks.find((t) => t.title === "Map")).toMatchObject({ dependsOn: map.dependsOn, outcomes: map.outcomes, qa: { focus: "Guest only" } });
    expect(next.repeatGroups).toEqual(draft.repeatGroups);
  });
});
