import { describe, expect, it } from "vitest";
import {
  calmLine,
  draftingJobName,
  draftingStage,
  explorationPhase,
  explorationWorkStatus,
  fmtClock,
  fmtCost,
  fmtTook,
  newestFile,
  phaseStates,
  phasesFor,
  readCounts,
  requestWorkStatus,
  shortPath,
  statusLabel,
} from "./words";

describe("the words every job shares", () => {

  it("names a drafting job by the button that started it", () => {
    expect(draftingJobName("map:gaps")).toBe("Draft the gaps");
    expect(draftingJobName("feature:onboarding", "Onboarding")).toBe("Draft scenarios for Onboarding");
    expect(draftingJobName("feature:onboarding")).toBe("Draft scenarios for this feature");
    expect(draftingJobName("map:screen:/listings/*", "Listings")).toBe("Draft scenarios for Listings");
    expect(draftingJobName("failures")).toBe("Draft failure scenarios");
    expect(draftingJobName(null)).toBe("Draft scenarios");
  });


  it("gives each job only its own phases, in one order", () => {
    expect(phasesFor("exploration")).toEqual(["read", "explore", "review"]);
    expect(phasesFor("drafting")).toEqual(["read", "draft", "review", "run"]);
    expect(phasesFor("drafting-exploration")).toEqual(["read", "explore", "draft", "review", "run"]);
  });

  it("marks the phases before the current one done and the rest to do", () => {
    const s = phaseStates(phasesFor("drafting"), "draft").map((p) => p.state);
    expect(s).toEqual(["done", "active", "todo", "todo"]);
    expect(phaseStates(phasesFor("drafting"), null).every((p) => p.state === "todo")).toBe(true);
    expect(phaseStates(phasesFor("exploration"), "finished").every((p) => p.state === "done")).toBe(true);
  });

  it("maps an exploration's status onto the bar: checking is still exploring", () => {
    expect(explorationPhase("queued")).toBeNull();
    expect(explorationPhase("studying")).toBe("read");
    expect(explorationPhase("checking")).toBe("explore");
    expect(explorationPhase("done")).toBe("review");
    expect(explorationWorkStatus("cancelled")).toBe("stopped");
    expect(requestWorkStatus("completed")).toBe("done");
    expect(statusLabel("queued")).toBe("Waiting for an agent");
    expect(statusLabel("queued", null, "Waiting for a device")).toBe("Waiting for a device");
    expect(statusLabel("running", "Exploring", "Waiting for a device")).toBe("Exploring");
    expect(statusLabel("running", "Drafting")).toBe("Drafting");
  });
});

describe("drafting's live words: the bugs in the owner's screenshots", () => {
  it("shows both reading counters, so the header never says 40 files while the log says more", () => {
    expect(readCounts({ reads: 84, searches: 66 })).toBe("84 files read · 66 searches");
    expect(readCounts({ reads: 1, searches: 0 })).toBe("1 file read");
    expect(readCounts({ reads: 0, searches: 2 })).toBe("2 searches");
    expect(readCounts(null)).toBeNull();
  });

  it("never goes back to reading once a draft landed (a search between drafts is still drafting)", () => {
    expect(draftingStage({ status: "running", drafted: 0 })).toBe("reading");
    expect(draftingStage({ status: "running", drafted: 7 })).toBe("drafting");
    expect(draftingStage({ status: "queued", drafted: 0 })).toBe("queued");
    expect(draftingStage({ status: "completed", drafted: 16 })).toBe("done");
    expect(draftingStage({ status: "cancelled", drafted: 3 })).toBe("stopped");
  });

  it("says what is normal while nothing is drafted yet", () => {
    expect(calmLine({ stage: "reading", reads: 84, drafted: 0 })).toBe("Reading 84 files: the first drafts usually land within a few minutes.");
    expect(calmLine({ stage: "reading", reads: 0, drafted: 0, sources: "exploration" })).toMatch(/^Reading the explorations: /);
    expect(calmLine({ stage: "drafting", reads: 84, drafted: 7 })).toMatch(/^7 drafted so far/);
    expect(calmLine({ stage: "done", reads: 84, drafted: 7 })).toBeNull();
  });

  it("finds the newest file Embodent opened", () => {
    expect(newestFile({ read_files: ["a/b.ts", "c/d.swift"] })).toBe("c/d.swift");
    expect(newestFile({ read_files: [], note: "Reading src/app.tsx" })).toBe("src/app.tsx");
    expect(newestFile({ note: "Reading the project's scenarios" })).toBeNull();
    expect(shortPath("snuglog-ios/SnugLog/Views/Today/QuickNotesSheet.swift")).toEqual({ name: "QuickNotesSheet.swift", dir: "snuglog-ios/SnugLog/Views/Today" });
  });
});

describe("time and money", () => {
  it("formats clocks, durations and costs", () => {
    expect(fmtClock(266)).toBe("4:26");
    expect(fmtClock(3725)).toBe("1:02:05");
    expect(fmtTook(524)).toBe("8m 44s");
    expect(fmtTook(42)).toBe("42s");
    expect(fmtTook(3720)).toBe("1h 02m");
    expect(fmtCost(2.4812)).toBe("$2.48");
    expect(fmtCost(0.004)).toBe("<$0.01");
    expect(fmtCost(null)).toBeNull();
  });
});
