/** Why a flow went back, as a person reads it: from requests and steps, never from a guess. */
import { describe, expect, it } from "vitest";
import { normalizeRequest } from "../qa/requests/api";
import type { WorkflowTask } from "./workflowContract.generated";
import { graphReturns, qualityRounds, roundsHeadline } from "./qualityRounds";

const step = (id: string, title: string, routes: unknown[] = [], reported: unknown = null) => ({ id, title, routes, reported_outcome: reported }) as unknown as WorkflowTask;
const tasks = (triageReported: unknown = { outcome: "fix", applied: true }) => [
  step("b", "Build"),
  step("q", "Quality", [{ outcome: "pass", destination: "step", destination_task: "n" }, { outcome: "fail", destination: "step", destination_task: "t" }], { outcome: "fail", applied: true }),
  step("t", "Triage", [{ outcome: "fix", destination: "return", destination_task: "b" }, { outcome: "clear", destination: "exit_group" }, { outcome: "needs_person", destination: "ask_owner" }], triageReported),
  step("n", "Next"),
];
const diagnoses = [
  { id: "f1", title: "The total ignores the discount", severity: "major", classification: "product_bug", rate: "fails 3 of 3", root_cause: "The cart keeps the old sum." },
  { id: "f2", title: "Pay sometimes spins", severity: "major", classification: "flaky", rate: "fails 1 of 3" },
];
const quality = (round: number, status: string, findings: unknown[] = []) => normalizeRequest({ id: `q${round}`, kind: "explore", source_task_id: "q", round, status, created_at: `2026-11-05T1${round}:00:00Z`, result: status === "running" ? null : { summary: "x", findings } });
const triage = (round: number, status = "failed") => normalizeRequest({ id: `t${round}`, kind: "triage", source_task_id: "t", round, status, created_at: `2026-11-05T1${round}:30:00Z`, result: { summary: "x", diagnoses, confirmed_ids: ["f1"] } });

describe("qualityRounds", () => {
  it("says why a round went back: only what triage confirmed, with its rate and cause", () => {
    const [r] = qualityRounds({ tasks: tasks() }, [quality(1, "failed", [{ id: "f1", title: "a" }, { id: "f2", title: "b" }]), triage(1)]);
    expect(r).toMatchObject({ round: 1, state: "back", headline: "Triage confirmed 1 of 2 findings", next: "Went back to Build", backTo: { id: "b", title: "Build" } });
    expect(r.findings).toEqual([{ id: "f1", title: "The total ignores the discount", severity: "major", rate: "fails 3 of 3", rootCause: "The cart keeps the old sum." }]);
    expect(roundsHeadline([r])).toBe("Triage confirmed 1 of 2 findings. Went back to Build.");
  });

  it("never says it went back before a person accepted the step", () => {
    const rounds = qualityRounds({ tasks: tasks({ outcome: "fix", applied: false }) }, [quality(1, "failed"), triage(1)]);
    expect(rounds[0]).toMatchObject({ state: "waiting", next: "Goes back to Build when a person accepts Triage" });
  });

  it("knows it went back when the step moved on, though the server cleared what it reported", () => {
    const t = tasks(null).map((x) => (x.id === "t" ? { ...x, round: 2 } : x));
    expect(qualityRounds({ tasks: t }, [quality(1, "failed"), triage(1)])[0]).toMatchObject({ state: "back", next: "Went back to Build" });
  });

  it("a later round means the earlier one was applied, and the running one says so", () => {
    const rounds = qualityRounds({ tasks: tasks({ outcome: "clear", applied: false }) }, [quality(1, "failed"), triage(1), quality(2, "running")]);
    expect(rounds.map((r) => r.state)).toEqual(["back", "running"]);
    expect(rounds[1].headline).toBe("Quality is running");
    expect(roundsHeadline(rounds)).toBe("Round 2: Quality is running, after round 1 went back to Build.");
  });

  it("leaves the way back on the graph once the loop passed, but no longer alarmed", () => {
    const t = tasks().map((x) => (x.id === "q" ? { ...x, reported_outcome: { outcome: "pass", applied: true } } : x));
    const rounds = qualityRounds({ tasks: t }, [quality(1, "failed"), triage(1), quality(2, "passed")]);
    expect(graphReturns(t[2], t, rounds)).toEqual([{ to: "b", active: false, label: "Round 1: 1 confirmed finding went back" }]);
  });

  it("a Quality step with no triage goes back with what it found", () => {
    const t = [step("b", "Build"), step("q", "Quality", [{ outcome: "fail", destination: "return", destination_task: "b" }], { outcome: "fail", applied: true })];
    const [r] = qualityRounds({ tasks: t }, [quality(1, "failed", [{ id: "f1", title: "Broken", severity: "major" }])]);
    expect(r).toMatchObject({ state: "back", headline: "Quality failed with 1 finding", findings: [{ title: "Broken", rate: null }] });
  });

  it("a pass and a blocked run read as themselves", () => {
    const passed = tasks().map((t) => (t.id === "q" ? { ...t, reported_outcome: { outcome: "pass", applied: true } } : t));
    expect(qualityRounds({ tasks: passed }, [quality(1, "passed")])[0]).toMatchObject({ state: "passed", headline: "Quality passed", backTo: null });
    expect(qualityRounds({ tasks: tasks() }, [quality(1, "passed")])[0]).toMatchObject({ state: "waiting", next: "Goes to Next when a person accepts Quality" });
    expect(qualityRounds({ tasks: tasks() }, [quality(1, "blocked")])[0]).toMatchObject({ state: "blocked", headline: "Quality could not test it" });
  });

  it("a judgement call waits for a person", () => {
    const blocked = normalizeRequest({ id: "t1", kind: "triage", source_task_id: "t", round: 1, status: "blocked", result: { summary: "x", diagnoses: [diagnoses[1]], confirmed_ids: [] } });
    expect(qualityRounds({ tasks: tasks() }, [quality(1, "failed"), blocked])[0]).toMatchObject({ state: "person", headline: "Triage needs a person to decide", backTo: null });
  });
});

describe("graphReturns", () => {
  it("marks the way back a round took, and names one that was never taken", () => {
    const t = tasks();
    const rounds = qualityRounds({ tasks: t }, [quality(1, "failed"), triage(1)]);
    expect(graphReturns(t[2], t, rounds)).toEqual([{ to: "b", active: true, label: "Round 1: 1 confirmed finding went back" }]);
    expect(graphReturns(t[2], t, [])).toEqual([{ to: "b", active: false, label: "Bugs confirmed: back to Build" }]);
    expect(graphReturns(t[1], t, rounds)).toEqual([]);
  });
});

describe("a Quality step its owner stopped", () => {
  it("says it waits for the owner, not that it will start", () => {
    const check = { ...step("q", "Check"), awaiting_owner_decision: "stopped_by_owner" } as WorkflowTask;
    const rounds = qualityRounds({ tasks: [check] }, [quality(2, "requested")]);
    expect(rounds.at(-1)).toMatchObject({ state: "person", headline: expect.stringContaining("waits for the owner") });
  });
});

describe("a Quality step that could not test", () => {
  it("says why in the agent's words", () => {
    const blocked = normalizeRequest({ id: "q1", kind: "check", source_task_id: "q", round: 1, status: "blocked", created_at: "2026-11-05T10:00:00Z",
      result: { lines: [{ index: 0, text: "x", verdict: "blocked", note: "No validated scenario exists for Android. The rest is detail." }] } });
    expect(qualityRounds({ tasks: tasks() }, [blocked])[0].headline).toBe("Quality could not test it: No validated scenario exists for Android");
  });
});
