/** Run tasks: what the card reads from a task's Quality data, and how strong each line's proof is. */
import { describe, expect, it } from "vitest";
import { filterTasks, parseTaskQuery } from "../../tasks/taskQuery";
import type { Task } from "../../../types";
import type { TaskQa } from "../qaApi";
import { FINISH_ALONE_LABEL, lineProof, readFinishDecision } from "./finishing";
import { isRunTaskRow, runTaskModel } from "./model";

const links = { worker_run: "/agents?agent=tess&changes=w1" };
const result = (o: Record<string, unknown> = {}) => ({ task_id: "t1", is_run_task: true, kind: "check", platform: "ios", outcome: "passed", summary: "All passed.", session_id: "s1", scenarios: [{ scenario_id: "sc1", name: "Sign in", verdict: "pass" }, { scenario_id: "sc2", name: "Reset", verdict: "fail", note: "Link 404s" }], lines: [], findings: [], drafts: [], screens_reached: 9, duration_seconds: 720, cost_usd: 1.25, device: { name: "iPhone 17 Pro" }, build: "1.4 (88)", agent: { id: "a1", alias: "tess" }, links, ...o });
const empty: TaskQa = { sessions: [], findings: [], scenarios: [], verdicts: [], requests: [] };
const qa = (o: Record<string, unknown> = {}, extra: Partial<TaskQa> = {}): TaskQa => ({ ...empty, is_run_task: true, run_result: result(o), ...extra });
const row = (description: string, id = "t1") => ({ id, description });

describe("run task", () => {
  it("the project's list or the task's skill line marks a run; ordinary work is not one", () => {
    expect(isRunTaskRow(row("Run /orcha-qa-check for this task on ios"))).toBe(true);
    expect(isRunTaskRow(row("A check run on ios, started by tess."), new Set(["t1"]))).toBe(true);
    expect(isRunTaskRow(row("Run the migration"))).toBe(false);
  });

  it("a task sent to Quality is a source, not a run", () => {
    expect(runTaskModel({ ...empty, is_run_task: false, run_result: result() })).toBeNull();
    expect(runTaskModel(null)).toBeNull();
  });

  it("reads outcome, verdicts and facts", () => {
    const m = runTaskModel(qa())!;
    expect(m).toMatchObject({ phase: "finished", what: "Check scenarios on iOS", summary: "All passed.", device: "iPhone 17 Pro", build: "1.4 (88)", screens: 9, cost: 1.25, minutes: 12, agent: "tess", workerRun: links.worker_run });
    expect(m.outcome.word).toBe("Passed");
    expect(m.scenarios.map((s) => [s.name, s.word, s.note])).toEqual([["Sign in", "Pass", null], ["Reset", "Fail", "Link 404s"]]);
  });

  it("a run that died is stopped with its reason, and is never called passed", () => {
    expect(runTaskModel(qa({ outcome: "stopped", reason: "The agent stopped responding.", summary: null }))).toMatchObject({ phase: "stopped", reason: "The agent stopped responding.", outcome: { word: "Could not finish" } });
    expect(runTaskModel(qa({ outcome: "blocked" }))).toMatchObject({ phase: "stopped", outcome: { word: "Blocked" } });
  });

  it("no run yet, or a session in line for a device, is waiting", () => {
    expect(runTaskModel(qa({ outcome: null }))).toMatchObject({ phase: "waiting", outcome: { word: "Waiting" } });
    const queued = qa({ outcome: "running" }, { sessions: [{ id: "s1", queued: true } as never] });
    expect(runTaskModel(queued)).toMatchObject({ phase: "waiting", outcome: { word: "Waiting" } });
    expect(runTaskModel(qa({ outcome: "running" }))).toMatchObject({ phase: "running", outcome: { word: "Running" } });
  });

  it("invents nothing a run did not report", () => {
    expect(runTaskModel(qa({ cost_usd: null, screens_reached: 0, device: null, build: null, agent: null }))).toMatchObject({ cost: null, screens: null, device: null, build: null, agent: null });
  });

  it("filters run tasks out of the list only when asked", () => {
    localStorage.clear();
    const rows = [{ id: "1", description: "A map run on web, started by tess." }, { id: "2", description: "Build it" }].map((t) => ({ title: "t", status: "ready", assignees: [], ...t })) as unknown as Task[];
    const ids = new Set(["1"]);
    expect(filterTasks(rows, parseTaskQuery(""), ids).map((t) => t.id)).toEqual(["1", "2"]);
    expect(filterTasks(rows, parseTaskQuery("?runs=hide"), ids).map((t) => t.id)).toEqual(["2"]);
  });
});

describe("proof", () => {
  it("keeps the option's name in one constant", () => {
    expect(FINISH_ALONE_LABEL).toBe("Finish by itself when everything is proven");
  });

  it("names where each line's proof came from", () => {
    expect(lineProof({ status: "proven", basis: "qa", strong: true })).toMatchObject({ word: "Quality", strength: "strong" });
    expect(lineProof({ status: "proven", basis: "tests", strong: true })).toMatchObject({ word: "Tests", strength: "strong" });
    expect(lineProof({ status: "proven", basis: "tests", strong: true, proof_source: "ci" })).toMatchObject({ word: "CI", strength: "strong" });
    expect(lineProof({ status: "proven", basis: "tests", strong: true, proof_source: "review" })).toMatchObject({ word: "Review", strength: "strong" });
  });

  it("a changed file is weaker than a verdict or a passing test", () => {
    expect(lineProof({ status: "proven", basis: "changes", strong: false })).toMatchObject({ word: "The file changed", strength: "weak" });
    expect(lineProof({ status: "proven", basis: "changes" })).toMatchObject({ strength: "weak" });
  });

  it("test files changed with the suite passing: the tests are the proof", () => {
    expect(lineProof({ status: "proven", basis: "changes", strong: true })).toMatchObject({ word: "Tests", strength: "strong" });
  });

  it("a line nobody proved needs a person, whatever sits near it", () => {
    for (const status of ["needs_human", "not_proven"]) expect(lineProof({ status, basis: "changes" })).toMatchObject({ word: "Needs a person", strength: "none" });
    expect(lineProof({ status: "proven", basis: "none" })).toMatchObject({ word: "Needs a person", strength: "none" });
  });

  it("reads the decision: each line with why, the other reasons once, in the tab's name", () => {
    expect(readFinishDecision(null)).toBeNull();
    const d = readFinishDecision({ decision: "person", turned_on_by_alias: "kedar", turned_on_at: "2026-11-05T10:00:00Z",
      reasons: [{ code: "line_weak", text: "1 line: only a changed file shows it." }, { code: "risk_flags", text: "1 risk flag on this change: migration." }, { code: "drafts", text: "A QA run left drafts." }],
      lines: [{ index: 1, text: "Sign-in works", status: "proven", strong: false, why: "weak", why_text: "only a changed file shows it, and that is not proof it works" }] })!;
    expect(d).toMatchObject({ finished: false, toPerson: true, enabled_by: "kedar" });
    expect(d.lines).toEqual([{ index: 1, text: "Sign-in works", reason: "Only a changed file shows it, and that is not proof it works." }]);
    expect(d.reasons).toEqual(["1 risk flag on this change: migration.", "A Quality run left drafts."]);
  });

  it("finished is finished", () => {
    expect(readFinishDecision({ decision: "finished", reasons: [], lines: [] })).toMatchObject({ finished: true, toPerson: false });
  });
});
