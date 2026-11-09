/** QA steps in a draft: the task they make, the loop back to the build, the preset, the wire shape. */
import { describe, expect, it } from "vitest";
import { draftProblems, emptyDraft, newDraftTask, type WorkflowDraft } from "./workflowDraft";
import { toWireDraft } from "./WorkflowDraftSave";
import { addQaStep, addTriageStep, draftReturns, editQaStep, editTriageStep, outcomeWord, qaStepWords, readWireSteps, removeStep, routeRows, setRoute, wireQa } from "./workflowQa";

function withBuild(): { draft: WorkflowDraft; key: string } {
  const build = { ...newDraftTask(), title: "Build checkout" };
  return { draft: { ...emptyDraft(), name: "Release", goal: "Ship", tasks: [build] }, key: build.key };
}
const input = (key: string | null, flexible = true) => ({ qa: { kind: "explore" as const, platform: "ios" as const, focus: "Checkout", minutes: 20 }, assignee: "tess", buildKey: key, maxRounds: 4, flexible });

describe("addQaStep", () => {
  it("adds a task for the QA agent that waits for the build and loops back on fail", () => {
    const { draft, key } = withBuild();
    const next = addQaStep(draft, input(key));
    const qa = next.draft.tasks.find((t) => t.key === next.key)!;
    expect(qa).toMatchObject({ title: "Quality: Checkout", assignee: "tess", dependsOn: [key], qa: { kind: "explore", platform: "ios" } });
    expect(qa.outcomes).toEqual([
      { name: "pass", kind: "success", destination: "exit_group" },
      { name: "fail", kind: "failure", destination: "return", destinationTask: key },
    ]);
    expect(next.draft.repeatGroups).toEqual([expect.objectContaining({ name: "Quality loop", members: [key, next.key], review: next.key, exitOutcome: "pass", maxRounds: 4 })]);
    expect(draftProblems(next.draft)).toEqual([]);
  });

  it("asks the owner on fail when there is no build step, and passes straight on", () => {
    const { draft } = withBuild();
    const next = addQaStep(draft, input(null));
    expect(next.draft.tasks.at(-1)!.outcomes).toEqual([
      { name: "pass", kind: "success", destination: "next" },
      { name: "fail", kind: "failure", destination: "ask_owner" },
    ]);
    expect(next.draft.repeatGroups).toBeUndefined();
    expect(draftProblems(next.draft)).toEqual([]);
  });

  it("leaves routing out on a server without outcomes", () => {
    const { draft, key } = withBuild();
    const next = addQaStep(draft, input(key, false));
    expect(next.draft.tasks.at(-1)!.outcomes).toBeUndefined();
    expect(next.draft.tasks.at(-1)!.qa).toBeDefined();
    expect(next.draft.repeatGroups).toBeUndefined();
  });

  it("never puts a step in two loops: a build already in one asks the owner", () => {
    const { draft, key } = withBuild();
    const first = addQaStep(draft, input(key));
    const second = addQaStep(first.draft, input(key));
    expect(second.draft.tasks.at(-1)!.outcomes?.[1]).toMatchObject({ destination: "ask_owner" });
    expect(second.draft.repeatGroups).toHaveLength(1);
  });
});

describe("editQaStep", () => {
  it("changes the step and its rounds, and keeps its loop's identity", () => {
    const { draft, key } = withBuild();
    const added = addQaStep(draft, input(key));
    const before = added.draft.repeatGroups![0];
    const next = editQaStep(added.draft, added.key, { ...input(key), qa: { kind: "check", scenarioIds: ["sc1"] }, maxRounds: 2 });
    expect(next.draft.tasks.find((t) => t.key === added.key)!.qa).toEqual({ kind: "check", scenarioIds: ["sc1"] });
    expect(next.draft.repeatGroups).toEqual([{ ...before, maxRounds: 2 }]);
  });
});

describe("readWireSteps", () => {
  const PRESET = {
    title: "Build, QA, fix", goal: "A change that passes QA.", execution_mode: "serial", semantics_version: 2,
    tasks: [
      { client_key: "build", title: "Build", description: "", definition_of_done: "The change is built and ready to test.", assignee_id: null, priority: 10, depends_on: [] },
      { client_key: "qa", title: "QA", description: "", definition_of_done: "The change does what it should on the device.", assignee_id: "tess", priority: 20, depends_on: ["build"],
        outcomes: [{ name: "pass", kind: "success" }, { name: "fail", kind: "failure" }],
        routes: [{ outcome: "pass", destination: "exit_group" }, { outcome: "fail", destination: "return", destination_task: "build" }],
        qa: { kind: "explore", platform: "web" } },
    ],
    repeat_groups: [{ name: "Build and QA", member_tasks: ["build", "qa"], review_task: "qa", exit_outcome: "pass", max_rounds: 3 }],
  };

  const read = () => {
    const { tasks, groups } = readWireSteps(PRESET, (k) => `new-${k}`);
    return { ...emptyDraft(), name: "Release", goal: "Ship", tasks, repeatGroups: groups };
  };

  it("becomes valid steps with the draft's keys, naming Quality", () => {
    const draft = read();
    const [build, qa] = draft.tasks;
    expect(qa).toMatchObject({ title: "Quality", assignee: "tess", dependsOn: [build.key], qa: { kind: "explore", platform: "web" } });
    expect(qa.outcomes).toEqual([{ name: "pass", kind: "success", destination: "exit_group" }, { name: "fail", kind: "failure", destination: "return", destinationTask: build.key }]);
    expect(draft.repeatGroups?.[0]).toMatchObject({ name: "Build and Quality", members: [build.key, qa.key], review: qa.key, exitOutcome: "pass", maxRounds: 3 });
    expect(draftProblems(draft)).toEqual([]);
  });

  it("round-trips to the wire", () => {
    const wire = toWireDraft(read());
    expect(wire.repeat_groups).toHaveLength(1);
    expect(wire.tasks?.[1].qa).toEqual({ kind: "explore", platform: "web" });
  });
});

describe("addTriageStep", () => {
  it("moves the loop to triage: a fail goes to it, a pass skips it, fix goes back to the build", () => {
    const { draft, key } = withBuild();
    const qa = addQaStep(draft, input(key));
    const next = addTriageStep(qa.draft, { assignee: "tess", qaKey: qa.key, maxRounds: 3, flexible: true });
    const step = next.draft.tasks.find((t) => t.key === qa.key)!;
    expect(step.outcomes).toEqual([{ name: "pass", kind: "success", destination: "stop" }, { name: "fail", kind: "failure", destination: "step", destinationTask: next.key }]);
    expect(next.draft.tasks.find((t) => t.key === next.key)!.outcomes).toEqual([
      { name: "fix", kind: "changes", destination: "return", destinationTask: key },
      { name: "clear", kind: "success", destination: "exit_group" },
      { name: "needs_person", kind: "custom", destination: "ask_owner" },
    ]);
    expect(next.draft.repeatGroups).toEqual([expect.objectContaining({ members: [key, qa.key, next.key], review: next.key, exitOutcome: "clear", maxRounds: 3 })]);
    expect(draftProblems(next.draft)).toEqual([]);
  });

  it("a pass goes on to what came after QA, which now waits for triage too", () => {
    const { draft, key } = withBuild();
    const qa = addQaStep(draft, input(key));
    const after = { ...newDraftTask(), title: "Release", dependsOn: [qa.key] };
    const next = addTriageStep({ ...qa.draft, tasks: [...qa.draft.tasks, after] }, { assignee: "", qaKey: qa.key, maxRounds: 3, flexible: true });
    expect(next.draft.tasks.find((t) => t.key === qa.key)!.outcomes?.[0]).toEqual({ name: "pass", kind: "success", destination: "step", destinationTask: after.key });
    expect(next.draft.tasks.find((t) => t.key === after.key)!.dependsOn).toEqual([qa.key, next.key]);
    expect(draftProblems(next.draft)).toEqual([]);
  });
});

describe("the wire", () => {
  it("sends only what was chosen", () => {
    expect(wireQa({ kind: "check", platform: null, scenarioIds: [], tags: ["a"], focus: "  ", minutes: null })).toEqual({ kind: "check", tags: ["a"] });
    expect(wireQa({ kind: "explore", platform: "ios", scenarioIds: ["s"], focus: " x ", minutes: 15 })).toEqual({ kind: "explore", platform: "ios", scenario_ids: ["s"], focus: "x", minutes: 15 });
  });

  it("puts `qa`, outcomes, routes and the loop on the draft", () => {
    const { draft, key } = withBuild();
    const next = addQaStep(draft, input(key));
    const wire = toWireDraft(next.draft);
    const qa = wire.tasks!.find((t) => t.client_key === next.key)! as unknown as { qa: unknown; routes: unknown[] };
    expect(qa.qa).toEqual({ kind: "explore", platform: "ios", focus: "Checkout", minutes: 20 });
    expect(qa.routes).toEqual([{ outcome: "pass", destination: "exit_group", destination_task: null }, { outcome: "fail", destination: "return", destination_task: key }]);
    expect(wire.repeat_groups).toEqual([{ name: "Quality loop", member_tasks: [key, next.key], review_task: next.key, exit_outcome: "pass", max_rounds: 4 }]);
    expect(wire.tasks!.find((t) => t.client_key === key)).not.toHaveProperty("qa");
  });
});

describe("words", () => {
  it("reads as plain language", () => {
    expect(qaStepWords({ kind: "explore", platform: "android", minutes: 20 })).toBe("Explore · Android · 20 min");
    expect(qaStepWords({ kind: "check", scenarioIds: ["a", "b"], tags: ["auth"] })).toBe("Check scenarios · Default platform · 2 scenarios · tagged auth");
  });
});

describe("routing a step", () => {
  const triaged = () => {
    const { draft, key } = withBuild();
    const qa = addQaStep(draft, input(key));
    const triage = addTriageStep(qa.draft, { assignee: "tess", qaKey: qa.key, maxRounds: 3, flexible: true });
    return { draft: triage.draft, build: key, qa: qa.key, triage: triage.key };
  };

  it("says each route in plain words and offers only what the server allows", () => {
    const { draft, key } = withBuild();
    const qa = addQaStep(draft, input(key));
    const [pass, fail] = routeRows(qa.draft, qa.key, "Hussein");
    expect(pass).toMatchObject({ outcome: "pass", label: "The loop ends and the next steps proceed" });
    expect(pass.choices.map((c) => c.value)).toEqual(["exit_group", "stop"]); // the exit outcome must lead out
    expect(fail).toMatchObject({ outcome: "fail", label: "Back to Build checkout with the findings" });
    expect(fail.choices.map((c) => c.label)).toContain("Stop and ask Hussein");
    expect(outcomeWord("needs_person")).toBe("A judgement call");
  });

  it("drops the loop with its last way back, and makes one with the first", () => {
    const { draft, key } = withBuild();
    const qa = addQaStep(draft, input(key));
    const off = setRoute(qa.draft, qa.key, "fail", "ask_owner");
    expect(off.repeatGroups).toEqual([]);
    expect(off.tasks[1].outcomes).toEqual([{ name: "pass", kind: "success", destination: "next" }, { name: "fail", kind: "failure", destination: "ask_owner" }]);
    expect(draftProblems(off)).toEqual([]);
    const on = setRoute(off, qa.key, "fail", `return:${key}`, 4);
    expect(on.repeatGroups).toEqual([expect.objectContaining({ members: [key, qa.key], review: qa.key, exitOutcome: "pass", maxRounds: 4 })]);
    expect(on.tasks[1].outcomes?.[0]).toMatchObject({ name: "pass", destination: "exit_group" });
    expect(draftProblems(on)).toEqual([]);
  });

  it("keeps Triage's route when its Quality step is edited, and applies a changed route", () => {
    const { draft, qa, triage } = triaged();
    const edited = editQaStep(draft, qa, { ...input(null), qa: { kind: "check" }, maxRounds: 5, routes: { fail: "ask_owner" } });
    expect(edited.draft.tasks.find((t) => t.key === qa)!.outcomes?.find((o) => o.name === "fail")).toMatchObject({ destination: "ask_owner" });
    expect(edited.draft.repeatGroups?.[0]).toMatchObject({ review: triage, maxRounds: 5 });
    const kept = editQaStep(draft, qa, { ...input(null), qa: { kind: "check" }, maxRounds: 3 });
    expect(kept.draft.tasks.find((t) => t.key === qa)!.outcomes?.find((o) => o.name === "fail")).toMatchObject({ destination: "step", destinationTask: triage });
    expect(draftProblems(kept.draft)).toEqual([]);
  });

  it("edits a Triage step's fields and its rounds", () => {
    const { draft, qa, triage } = triaged();
    const next = editTriageStep(draft, triage, { assignee: "ann", qaKey: qa, maxRounds: 2, flexible: true, platform: "web", focus: " Payment ", minutes: 30 });
    expect(next.draft.tasks.find((t) => t.key === triage)).toMatchObject({ assignee: "ann", qa: { kind: "triage", platform: "web", focus: "Payment", minutes: 30 } });
    expect(next.draft.repeatGroups?.[0].maxRounds).toBe(2);
  });

  it("removing a step that reviews a loop removes the loop, so nothing is left half-wired", () => {
    const { draft, qa, triage } = triaged();
    const next = removeStep(draft, triage);
    expect(next.repeatGroups).toEqual([]);
    expect(next.tasks.find((t) => t.key === qa)!.outcomes?.find((o) => o.name === "fail")).toEqual({ name: "fail", kind: "failure", destination: "next" });
    expect(draftProblems(next)).toEqual([]);
  });

  it("marks a draft's ways back for the graph", () => {
    const { draft, triage } = triaged();
    expect(draftReturns(draft.tasks.find((t) => t.key === triage)!, draft.tasks)).toEqual([{ to: draft.tasks[0].key, label: "Bugs confirmed: back to Build checkout" }]);
  });
});
