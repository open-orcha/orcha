import { describe, expect, it } from "vitest";
import {
  draftingPhase,
  draftingStep,
  isOpenPhase,
  progressLine,
  requestSources,
} from "./drafting-route";

const REQ = "92b93984-9fec-4428-b631-934a528737f0";

describe("drafting state", () => {
  it("derives the phase from the request", () => {
    expect(draftingPhase(null, null)).toBe("idle");
    expect(draftingPhase(REQ, null)).toBe("starting");
    expect(draftingPhase(REQ, "running")).toBe("running");
    expect(draftingPhase(REQ, "weird")).toBe("starting");
    expect(["starting", "queued", "running"].every((p) => isOpenPhase(p as never))).toBe(true);
    expect(["idle", "completed", "failed", "cancelled"].some((p) => isOpenPhase(p as never))).toBe(false);
  });

  it("keeps the progress lines the e2e suite asserts", () => {
    const base = { sources: "both" as const, draftCount: 2, drafted: 3, error: null };
    expect(progressLine({ ...base, phase: "queued" })).toBe("Waiting for an agent…");
    expect(progressLine({ ...base, phase: "running" })).toBe("Drafting from the repo and explorations… 2 drafted");
    expect(progressLine({ ...base, phase: "running", sources: "code" })).toBe("Drafting from the repo… 2 drafted");
    expect(progressLine({ ...base, phase: "running", sources: "code", draftCount: 0 })).toBe("Reading the repo… 0 drafted");
    expect(progressLine({ ...base, phase: "completed" })).toBe("Done. 3 drafted");
    expect(progressLine({ ...base, phase: "failed", error: "boom" })).toBe("Drafting failed: boom");
    expect(progressLine({ ...base, phase: "failed" })).toBe("Drafting failed: unknown error");
    expect(progressLine({ ...base, phase: "cancelled" })).toBe("Stopped. Drafts written before the stop stay for review");
    expect(progressLine({ ...base, phase: "starting" })).toBe("Starting…");
    expect(progressLine({ ...base, phase: "running", stopping: true })).toBe("Stopping…");
    expect(progressLine({ ...base, phase: "completed", stopping: true })).toBe("Done. 3 drafted");
  });

  it("walks the stage rail from data", () => {
    expect(draftingStep({ phase: "idle", draftCount: 0, accepted: 0 })).toBe(0);
    expect(draftingStep({ phase: "running", draftCount: 0, accepted: 0 })).toBe(0);
    expect(draftingStep({ phase: "running", draftCount: 2, accepted: 1 })).toBe(1);
    expect(draftingStep({ phase: "completed", draftCount: 3, accepted: 1 })).toBe(2);
    expect(draftingStep({ phase: "completed", draftCount: 3, accepted: 3 })).toBe(3);
    expect(draftingStep({ phase: "completed", draftCount: 0, accepted: 0 })).toBe(2);
    expect(draftingStep({ phase: "failed", draftCount: 0, accepted: 0 })).toBe(0);
    expect(draftingStep({ phase: "cancelled", draftCount: 2, accepted: 0 })).toBe(2);
  });

  it("reads a reopened request's sources, older requests read code", () => {
    expect(requestSources("both", "/repo")).toBe("both");
    expect(requestSources(null, "/repo")).toBe("code");
    expect(requestSources(undefined, null)).toBe("exploration");
  });
});
