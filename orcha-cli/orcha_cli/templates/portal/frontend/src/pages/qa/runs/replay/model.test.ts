import { describe, expect, it } from "vitest";
import type { Finding, Step } from "../types";
import { actionToStepSeq, buildReplayModel, deepLinkStepSeq, evidenceStepSeq, findingReproActions, type LinkStep } from "./model";

// The run behind #190: screen steps interleaved between the actions, so action 5 (the empty-form
// submit) is recorded step 9, while recorded step 5 is an unrelated counter tap.
const steps: Pick<Step, "seq" | "kind">[] = [
  { seq: 1, kind: "launch" },
  { seq: 2, kind: "screen" },
  { seq: 3, kind: "tap" },
  { seq: 4, kind: "screen" },
  { seq: 5, kind: "tap" }, // the counter
  { seq: 6, kind: "screen" },
  { seq: 7, kind: "type" },
  { seq: 8, kind: "screen" },
  { seq: 9, kind: "tap" }, // submit: action 5
  { seq: 10, kind: "screen" },
];

describe("deepLinkStepSeq", () => {
  it("maps ?action=N to the Nth action's recorded step, skipping screen steps", () => {
    expect(deepLinkStepSeq(steps, { action: 5 })).toBe(9);
    expect(deepLinkStepSeq(steps, { action: 1 })).toBe(1);
  });

  it("keeps ?step=N as the recorded step it names", () => {
    expect(deepLinkStepSeq(steps, { step: 5 })).toBe(5);
    expect(deepLinkStepSeq(steps, { step: 5, action: 5 })).toBe(5);
  });

  it("clamps an action past the end to the last action and reads steps in seq order", () => {
    expect(deepLinkStepSeq([...steps].reverse(), { action: 99 })).toBe(9);
  });

  it("is null with neither parameter, or an action on a run with no steps", () => {
    expect(deepLinkStepSeq(steps, {})).toBeNull();
    expect(deepLinkStepSeq([], { action: 3 })).toBeNull();
  });
});

// Run 2d33762d (#190 reopened): this agent wrote raw step numbers as repro steps. F1 "Add one
// increments by 2" says step 3 (the screen after the Add one tap, seq 2) and F2 "Empty contact form
// reports success" says step 8 (the screen after the submit tap, seq 7). Read as action numbers they
// opened seq 5 (Reset) and seq 15 (typing a name), both after the evidence was captured.
const st = (seq: number, kind: string): LinkStep => ({ seq, kind: kind as Step["kind"] });
const ev = (seq: number, evidenceSeq: number): LinkStep => ({ seq, kind: "evidence", args: { seq: evidenceSeq, severity: "major" } });
const run2d33: LinkStep[] = [
  st(1, "screen"), st(2, "tap"), st(3, "screen"), ev(4, 1), st(5, "tap"), st(6, "screen"), st(7, "tap"), st(8, "screen"), ev(9, 2), st(10, "tap"),
  st(11, "screen"), st(12, "tap"), st(13, "screen"), st(14, "screen"), st(15, "type"), st(16, "screen"), st(17, "tap"), st(18, "screen"), st(19, "screen"), st(20, "type"),
  st(21, "screen"), st(22, "tap"), st(23, "screen"), st(24, "wait"), st(25, "screen"), st(26, "wait"), st(27, "screen"), st(28, "screen"), st(29, "type"), st(30, "wait"),
  st(31, "screen"), st(32, "wait"), st(33, "screen"), st(34, "wait"), st(35, "screen"), st(36, "wait"), st(37, "screen"), st(38, "wait"), st(39, "screen"),
];
const run2d33Evidence = [
  { seq: 1, step_seq: 1 },
  { seq: 2, step_seq: 4 },
];
const f1 = { seq: 1, repro_from_step: 3, repro_to_step: 3, evidence_seqs: [1] };
const f2 = { seq: 2, repro_from_step: 8, repro_to_step: 8, evidence_seqs: [2] };
const actions2d33 = run2d33.filter((s) => s.kind !== "screen").map((s) => s.seq);

describe("findingReproActions (#190)", () => {
  it("reads raw step numbers that would land after the evidence as the action at or before that step", () => {
    expect(findingReproActions(run2d33, actions2d33, run2d33Evidence, f1)).toEqual({ from: 1, to: 1 });
    expect(actionToStepSeq(actions2d33, 1)).toBe(2); // tap Add one
    expect(findingReproActions(run2d33, actions2d33, run2d33Evidence, f2)).toEqual({ from: 4, to: 4 });
    expect(actionToStepSeq(actions2d33, 4)).toBe(7); // tap Send message on the empty form
  });

  it("keeps action numbers that land at or before the evidence", () => {
    const asActions = { seq: 2, repro_from_step: 3, repro_to_step: 4, evidence_seqs: [2] };
    expect(findingReproActions(run2d33, actions2d33, run2d33Evidence, asActions)).toEqual({ from: 3, to: 4 });
  });

  it("keeps the numbers as they are without evidence to compare with", () => {
    expect(findingReproActions(run2d33, actions2d33, [], { ...f2, evidence_seqs: [] })).toEqual({ from: 8, to: 8 });
  });

  it("finds the capture from the evidence row when the run recorded no evidence step", () => {
    const noEvidenceSteps = run2d33.filter((s) => s.kind !== "evidence");
    const actions = noEvidenceSteps.filter((s) => s.kind !== "screen").map((s) => s.seq);
    // Evidence 2 came after 4 actions: the capture is the 5th action's step.
    expect(evidenceStepSeq(noEvidenceSteps, actions, run2d33Evidence, 2)).toBe(actions[4]);
  });
});

describe("deepLinkStepSeq ?finding=N (#190)", () => {
  const context = { findings: [f1, f2], evidence: run2d33Evidence };

  it("opens a finding where the Findings tab maps it, not at its raw number read as an action", () => {
    expect(deepLinkStepSeq(run2d33, { action: 8 }, context)).toBe(15);
    expect(deepLinkStepSeq(run2d33, { action: 8, finding: 2 }, context)).toBe(7);
    expect(deepLinkStepSeq(run2d33, { action: 3, finding: 1 }, context)).toBe(2);
  });

  it("falls back to ?action= when the finding is not in the run", () => {
    expect(deepLinkStepSeq(run2d33, { action: 8, finding: 9 }, context)).toBe(15);
  });

  it("opens a finding with no repro at its evidence step", () => {
    const ctx = { findings: [{ seq: 3, repro_from_step: null, repro_to_step: null, evidence_seqs: [2] }], evidence: run2d33Evidence };
    expect(deepLinkStepSeq(run2d33, { finding: 3 }, ctx)).toBe(9);
  });
});

describe("buildReplayModel pins (#190)", () => {
  it("pins a raw-numbered finding on the frame of its bug, not after it", () => {
    const withFrames = run2d33.map(
      (s) => ({ ...s, args: s.args ?? {}, frame_path: s.kind === "screen" ? `f/${s.seq}.jpg` : null, at_ms: s.seq * 1000, foreground: null }) as unknown as Step,
    );
    const finding = { ...f2, id: "f2", run_id: "r", severity: "major", title: "Empty contact form reports success" } as unknown as Finding;
    const model = buildReplayModel(withFrames, [], [finding]);
    const pin = model.pins.find((p) => p.label.startsWith("F2"));
    // The frame at or before the submit tap (seq 7) is the screen at seq 6, not the one at seq 14.
    expect(model.frames[pin!.frameIndex].seq).toBe(6);
  });
});
