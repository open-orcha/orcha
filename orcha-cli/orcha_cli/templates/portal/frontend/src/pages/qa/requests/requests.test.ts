/** The rules of a handoff: tolerant reads, the task's lines, the QA agent, proved lines, rounds. */
import { describe, expect, it } from "vitest";
import { cleanBuild, normalizeRequest, normalizeSettings } from "./api";
import { linesOf } from "./lines";
import { dodLines, isOpenRequest, linesTally, provedLines, qaAgentOf, roundsOf } from "./model";
import { requestFor, sourceWords } from "./RequestSource";
import { requestStatusWord, requestTitle } from "./words";

describe("normalizeRequest", () => {
  it("reads null JSON columns as empty and never invents a result", () => {
    const r = normalizeRequest({ id: "r1", kind: "check", status: "requested", acceptance: null, scenario_ids: null, tags: null, result: null, build: null });
    expect(r).toMatchObject({ id: "r1", acceptance: [], scenario_ids: [], tags: [], result: null, build: null, on_fail: "report", round: 1 });
  });

  it("reads acceptance lines as strings or objects, and verdicts by line_index", () => {
    const r = normalizeRequest({
      id: "r2", kind: "explore", status: "failed", acceptance: ["Sign in works", { text: "Reset email arrives" }],
      result: { summary: "One line failed", lines: [{ line_index: 1, verdict: "fail", note: "Nothing arrived", frame_ids: ["f1"], session_id: "s1" }], finding_ids: ["x"], session_ids: ["s1"] },
    });
    expect(r.acceptance).toEqual(["Sign in works", "Reset email arrives"]);
    expect(r.result?.lines[0]).toMatchObject({ index: 1, text: "Reset email arrives", verdict: "fail", frame_ids: ["f1"] });
    expect(r.session_id).toBe("s1");
  });

  it("shows verdicts as they land, before the result is rolled up", () => {
    const r = normalizeRequest({ id: "r4", kind: "explore", status: "running", acceptance: ["A", "B"], result: null,
      line_verdicts: [{ line_index: 1, verdict: "fail", frame_ids: [] }, { line_index: 1, verdict: "pass", frame_ids: ["f"] }] });
    expect(linesOf(r).map((l) => l.verdict)).toEqual([null, "pass"]);
  });

  it("takes the request out of the `{request, qa_task_id}` envelope", () => {
    expect(normalizeRequest({ request: { id: "r3", kind: "map" }, qa_task_id: "t9" })).toMatchObject({ id: "r3", kind: "map", qa_task_id: "t9" });
  });
});

describe("normalizeSettings", () => {
  it("falls back to manual, report and three rounds, and clamps rounds to 1 to 10", () => {
    expect(normalizeSettings(null)).toEqual({ agent_id: null, agent_alias: null, agent_source: "none", default_platform: null, trigger: "manual", on_fail: "report", max_rounds: 3, auto_triage: "off", max_per_run: 2, finish_when_proven: false, finish_enabled_by: null, finish_enabled_at: null });
    expect(normalizeSettings({ max_rounds: 99, trigger: "always", on_fail: "reopen" })).toMatchObject({ max_rounds: 10, trigger: "always", on_fail: "reopen" });
    expect(normalizeSettings({ max_rounds: 0, trigger: "whenever" })).toMatchObject({ max_rounds: 1, trigger: "manual" });
  });
});

describe("cleanBuild", () => {
  it("keeps only what was filled in", () => {
    expect(cleanBuild({ branch: "  feat/a ", commit: "", notes: "   " })).toEqual({ branch: "feat/a" });
    expect(cleanBuild({ branch: "" })).toBeNull();
  });
});

describe("dodLines", () => {
  it("takes the lines out of a list and drops blanks, headings and checkbox marks", () => {
    expect(dodLines("## Done when\n- Sign in works\n* [x] Reset email arrives\n\n1. Logs clean\nPlain line")).toEqual(["Sign in works", "Reset email arrives", "Logs clean", "Plain line"]);
    expect(dodLines(null)).toEqual([]);
  });
});

describe("qaAgentOf", () => {
  const forge = { id: "a1", alias: "forge", role: "Builder" };
  const tess = { id: "a2", alias: "tess", role: "QA engineer" };
  it("uses the setting, then the only agent whose role says QA", () => {
    expect(qaAgentOf([forge, tess], { agent_id: "a1" })).toBe(forge);
    expect(qaAgentOf([forge, tess], { agent_id: null })).toBe(tess);
  });
  it("never guesses among several, or from a word that only contains the letters", () => {
    expect(qaAgentOf([tess, { id: "a3", alias: "kai", role: "QA lead" }], null)).toBeNull();
    expect(qaAgentOf([{ id: "a4", alias: "q", role: "Aqua designer" }], null)).toBeNull();
  });
});

const line = (index: number, text: string, verdict: "pass" | "fail", frames: string[] = []) => ({ index, text, verdict, note: null, frame_ids: frames, session_id: "s1" });
const base = normalizeRequest({ id: "r", kind: "explore", status: "passed", acceptance: ["A", "B"] });
const result = (lines: ReturnType<typeof line>[]) => ({ summary: null, lines, scenarios: [], finding_ids: [], draft_ids: [], session_ids: [], findings: [], diagnoses: [], confirmed_ids: [], decision: null });

describe("provedLines and linesOf", () => {
  it("keeps each line once with its newest verdict", () => {
    const first = { ...base, id: "old", created_at: "2026-11-05T10:00:00Z", result: result([line(0, "A", "fail"), line(1, "B", "pass")]) };
    const second = { ...base, id: "new", created_at: "2026-11-05T11:00:00Z", result: result([line(0, "A", "pass", ["f"])]) };
    expect(provedLines([first, second]).map((l) => [l.text, l.verdict, l.request.id])).toEqual([["A", "pass", "new"], ["B", "pass", "old"]]);
  });

  it("shows unchecked lines as such, and a verdict on an unlisted line anyway", () => {
    const r = { ...base, result: result([line(0, "A", "pass"), line(7, "Extra", "fail")]) };
    expect(linesOf(r).map((l) => [l.text, l.verdict])).toEqual([["A", "pass"], ["B", null], ["Extra", "fail"]]);
    expect(linesTally(r)).toBe("1 of 2 lines passed");
  });
});

describe("rounds, status and words", () => {
  it("orders rounds and tells open from finished", () => {
    expect(roundsOf([{ ...base, id: "b", round: 2 }, { ...base, id: "a", round: 1 }]).map((r) => r.id)).toEqual(["a", "b"]);
    expect(isOpenRequest({ status: "running" })).toBe(true);
    expect(isOpenRequest({ status: "passed" })).toBe(false);
  });

  it("speaks plainly, never a raw enum", () => {
    expect(requestStatusWord("requested")).toBe("Waiting");
    expect(requestTitle({ focus: " Checkout ", kind: "explore", platform: "ios" })).toBe("Checkout");
    expect(requestTitle({ focus: null, kind: "check", platform: "web" })).toBe("Check scenarios on Web");
    expect(sourceWords({ source_task_title: null, source_workflow_title: "Release", source_task_id: "t1", source_workflow_id: "w1" }, "Fix login")).toBe("Fix login · Release");
    expect(sourceWords({ source_task_title: null, source_workflow_title: null, source_task_id: null, source_workflow_id: null })).toBe("From Quality");
  });
});

describe("requestFor", () => {
  const r1 = { ...base, id: "r1", session_id: "s1", qa_task_id: "q1", source_task_id: "t1" };
  const r2 = { ...base, id: "r2", session_id: "s2", qa_task_id: "q2", source_task_id: "t2" };
  it("finds the request by its id, then session, then task", () => {
    expect(requestFor([r1, r2], { requestId: "r2" })).toBe(r2);
    expect(requestFor([r1, r2], { sessionId: "s1" })).toBe(r1);
    expect(requestFor([r1, r2], { taskId: "q2" })).toBe(r2);
    expect(requestFor([r1, r2], { sessionId: "nope" })).toBeNull();
  });
});
