import { describe, expect, it } from "vitest";
import type { CharterItem, Exploration, ExplorationResult, ResultFinding } from "../explorations";
import type { Finding } from "../explorations";
import {
  charterOthers,
  charterPhrase,
  charterProgress,
  defaultLens,
  exampleFeatureOf,
  findingsByLens,
  lensForFingerprint,
  journeyPaths,
  liveReducer,
  phaseClock,
  phaseStates,
  pickedLenses,
  railFindings,
  readLine,
  scoreNote,
  selectFace,
  splitCount,
  studyFeatures,
  type LiveState,
} from "./model";

function exploration(over: Partial<Exploration> = {}): Exploration {
  return {
    id: "e1",
    project_id: "p1",
    series_id: "e1",
    name: "Deep dive · Expenses · Oct 16",
    name_is_custom: false,
    description: null,
    recipe: "explore",
    minutes: 8,
    lenses: ["works"],
    goal: null,
    targets: [],
    context: null,
    target_id: null,
    environment_id: null,
    platform: "web",
    status: "queued",
    request_id: null,
    run_id: null,
    report_id: null,
    briefing: null,
    charter: [],
    result: null,
    error: null,
    started_at: null,
    study_done_at: null,
    finished_at: null,
    archived_at: null,
    created_at: "2026-10-16T10:00:00.000Z",
    updated_at: "2026-10-16T10:00:00.000Z",
    ...over,
  };
}

function mission(id: string, status: CharterItem["status"], over: Partial<CharterItem> = {}): CharterItem {
  return { id, title: `Mission ${id}`, why: "because", lens: "works", status, ...over };
}

function rf(over: Partial<ResultFinding>): ResultFinding {
  return { fingerprint: Math.random().toString(16).slice(2, 14), lens: "works", severity: "minor", title: "A finding", source: "agent", ...over };
}

function result(findings: ResultFinding[], over: Partial<ExplorationResult> = {}): ExplorationResult {
  return {
    verdict: "2 bugs",
    score: 72,
    lenses: [],
    charter: { total: 0, covered: 0, partial: 0, blocked: 0, bug: 0 },
    findings,
    screens: 5,
    steps: 40,
    duration_s: 600,
    study_s: 90,
    next: [],
    ...over,
  };
}

function finding(id: string, seq: number): Finding {
  return { id, run_id: "s1", seq, severity: "major", title: `F${seq}`, note: null, expected: null, actual: null, repro_from_step: null, repro_to_step: null, fix_prompt: null, qa: {} as Finding["qa"] };
}

describe("selectFace", () => {
  it("shows the report once a session is done", () => {
    expect(selectFace({ status: "done" })).toBe("report");
  });

  it("gives mission control a face per running phase", () => {
    expect(selectFace(exploration({ status: "queued" }))).toBe("queued");
    expect(selectFace(exploration({ status: "studying" }))).toBe("study");
    expect(selectFace(exploration({ status: "exploring" }))).toBe("explore");
    expect(selectFace(exploration({ status: "checking" }))).toBe("check");
  });


  it("gives failed and cancelled rows the ended state", () => {
    expect(selectFace(exploration({ status: "failed", error: "boom" }))).toBe("ended");
    expect(selectFace(exploration({ status: "cancelled" }))).toBe("ended");
  });
});

describe("scoreNote", () => {
  const lens = (l: "works" | "usable", score: number, grade: "good" | "fair" | "unknown" = "good") => ({ lens: l, score, grade, findings: 0 });
  const charter = (blocked: number) => ({ total: 3, covered: 0, partial: 2, blocked, bug: 0 });

  it("says why the ring is lower than the lens beside it (Slate 200b36b0: 80 next to Works right 90)", () => {
    expect(scoreNote({ score: 80, lenses: [lens("works", 90)], charter: charter(1) })).toBe("Overall 80: Works right's 90, less 10 for 1 blocked mission.");
    expect(scoreNote({ score: 62, lenses: [lens("works", 90), lens("usable", 74, "fair"), lens("usable", 0, "unknown")], charter: charter(2) })).toBe(
      "Overall 62: the lenses' average of 82, less 20 for 2 blocked missions.",
    );
  });

  it("says nothing when the ring is the lenses' own score", () => {
    expect(scoreNote({ score: 90, lenses: [lens("works", 90)], charter: charter(0) })).toBeNull();
    expect(scoreNote({ score: 0, lenses: [lens("works", 0, "unknown")], charter: charter(1) })).toBeNull();
  });
});

describe("phaseStates and phaseClock", () => {
  it("marks earlier phases done and the current one active", () => {
    expect(phaseStates("exploring").map((p) => p.state)).toEqual(["done", "active", "todo", "todo"]);
    expect(phaseStates("queued").map((p) => p.state)).toEqual(["todo", "todo", "todo", "todo"]);
    expect(phaseStates("studying").map((p) => p.state)).toEqual(["active", "todo", "todo", "todo"]);
    expect(phaseStates("done").map((p) => p.state)).toEqual(["done", "done", "done", "done"]);
  });



  it("knows nothing before the row has a start time", () => {
    expect(phaseClock(exploration({ status: "studying" }), Date.now()).elapsedS).toBeNull();
  });
});

describe("charterProgress", () => {
  const items = [mission("m1", "covered"), mission("m2", "bug"), mission("m3", "planned"), mission("m4", "planned")];

  it("counts settled missions and picks the first planned one as active while exploring", () => {
    const p = charterProgress(items);
    expect(p.total).toBe(4);
    expect(p.settled).toBe(2);
    expect(p.fraction).toBe(0.5);
    expect(p.counts.bug).toBe(1);
    expect(p.activeId).toBe("m3");
  });

  it("says the missions as the summary does, never \"2 of 2 done\" (Slate b8ce528b)", () => {
    const slate = charterProgress([mission("m1", "partial"), mission("m2", "blocked")], false);
    expect(charterPhrase(slate)).toBe("1 of 2 missions partly covered, 1 blocked");
    expect(charterOthers(slate)).toBe("1 partly covered, 1 blocked");
    expect(charterPhrase(charterProgress(items))).toBe("1 of 4 missions covered, 1 found a bug");
    expect(charterPhrase(charterProgress([mission("m1", "planned"), mission("m2", "active")]))).toBe("0 of 2 missions covered");
    expect(charterOthers(charterProgress([mission("m1", "covered")]))).toBe("");
  });

  it("prefers the mission the explorer marked active", () => {
    expect(charterProgress([...items.slice(0, 3), mission("m4", "active")]).activeId).toBe("m4");
  });

  it("has no active mission once exploring is over, and copes with no charter", () => {
    expect(charterProgress(items, false).activeId).toBeNull();
    expect(charterProgress([])).toMatchObject({ total: 0, settled: 0, fraction: 0, activeId: null });
  });

});

describe("journeyPaths", () => {
  const journeys = [
    { id: "j1", name: "Owner adds a truck", persona: "Owner", steps: ["Open fleet", "Add truck", "Log expense", "See review"] },
    { id: "j2", name: "Driver logs fuel", steps: ["Open app", "Log fuel"] },
    { id: "j3", name: "Accountant exports", steps: ["Open reports", "Export"] },
  ];

  it("draws passed steps up to where it broke, the broken step failed, the rest not reached", () => {
    const [j1] = journeyPaths(journeys, [{ id: "j1", name: "Owner adds a truck", outcome: "failed", broke_at: "log expense" }]);
    expect(j1.steps.map((s) => s.state)).toEqual(["passed", "passed", "failed", "not_reached"]);
    expect(j1.brokeIndex).toBe(2);
    expect(j1.brokeNote).toBeNull();
    expect(j1.persona).toBe("Owner");
  });

  it("passes every step of a passed journey and leaves unrun journeys to do", () => {
    const paths = journeyPaths(journeys, [{ id: "j2", name: "Driver logs fuel", outcome: "passed" }]);
    expect(paths[1].steps.every((s) => s.state === "passed")).toBe(true);
    expect(paths[2].outcome).toBe("not_run");
    expect(paths[2].steps.every((s) => s.state === "todo")).toBe(true);
  });

  it("keeps a broke_at that names no step as a note, breaking at the last step", () => {
    const [, j2] = journeyPaths(journeys, [{ id: "j2", name: "Driver logs fuel", outcome: "blocked", broke_at: "the login wall" }]);
    expect(j2.steps.map((s) => s.state)).toEqual(["passed", "blocked"]);
    expect(j2.brokeNote).toBe("the login wall");
  });

  it("draws a result journey the briefing never named as one step", () => {
    const paths = journeyPaths([], [{ id: "x", name: "Guest checkout", outcome: "failed" }]);
    expect(paths).toHaveLength(1);
    expect(paths[0].steps).toEqual([{ label: "Guest checkout", state: "failed" }]);
  });
});

describe("findingsByLens", () => {
  const findings = [
    rf({ lens: "works", severity: "minor", title: "Total off by one", step_seq: 9 }),
    rf({ lens: "works", severity: "blocker", title: "Save crashes", step_seq: 20 }),
    rf({ lens: "accessible", source: "measured", severity: "major", title: "Low contrast ×4", screen: "Home", fingerprint: "a|home|x|low_contrast" }),
    rf({ lens: "accessible", source: "measured", severity: "minor", title: "Low contrast ×2", screen: "Settings", fingerprint: "a|set|y|low_contrast" }),
    rf({ lens: "accessible", source: "measured", severity: "minor", title: "Tap target too small (3)", screen: "Home", fingerprint: "a|home|z|tap_target_too_small" }),
    rf({ lens: "accessible", source: "agent", severity: "major", title: "Focus lost after dialog" }),
    rf({ lens: "visual", source: "measured", severity: "minor", title: "Clipped text", screen: "Home" }),
  ];

  it("shows only the picked lenses, agent findings first and most severe first", () => {
    const groups = findingsByLens(result(findings), ["works", "accessible"]);
    expect(groups.map((g) => g.lens)).toEqual(["works", "accessible"]);
    expect(groups[0].agent.map((f) => f.title)).toEqual(["Save crashes", "Total off by one"]);
    expect(groups[0].measured).toEqual([]);
    expect(groups[1].agent.map((f) => f.title)).toEqual(["Focus lost after dialog"]);
    // The visual measured check is stored but never shown when Looks right was not picked.
    expect(groups.flatMap((g) => g.measured.map((m) => m.label))).not.toContain("Clipped text");
  });

  it("finds the lens tab a Compare link (#finding-<fingerprint>) points at", () => {
    const groups = findingsByLens(result(findings), ["works", "accessible"]);
    expect(lensForFingerprint(groups, "a|set|y|low_contrast")).toBe("accessible");
    expect(lensForFingerprint(groups, groups[0].agent[0].fingerprint)).toBe("works");
    expect(lensForFingerprint(groups, "nope")).toBeNull();
  });

  it("collapses measured checks into one row per check, listing the screens", () => {
    const [, accessible] = findingsByLens(result(findings), ["works", "accessible"]);
    expect(accessible.measured.map((m) => [m.label, m.count, m.screens.length, m.severity])).toEqual([
      ["Low contrast", 6, 2, "major"],
      ["Tap target too small", 3, 1, "minor"],
    ]);
    expect(accessible.measured[0].screens.map((s) => [s.screen, s.count])).toEqual([
      ["Home", 4],
      ["Settings", 2],
    ]);
    expect(accessible.total).toBe(3);
  });

  it("reads counts out of titles in the shapes the backend writes", () => {
    expect(splitCount("Low contrast ×4")).toEqual({ label: "Low contrast", count: 4 });
    expect(splitCount("Empty label (12)")).toEqual({ label: "Empty label", count: 12 });
    expect(splitCount("3 clipped text")).toEqual({ label: "Clipped text", count: 3 });
    expect(splitCount("Off screen")).toEqual({ label: "Off screen", count: 1 });
  });

  it("opens the lens with an agent finding first and keeps picked lenses in canonical order", () => {
    const groups = findingsByLens(result(findings.slice(2, 5)), ["works", "accessible"]);
    expect(defaultLens(groups)).toBe("accessible");
    expect(pickedLenses(["visual", "works"], null)).toEqual(["works", "visual"]);
    expect(pickedLenses([], null)).toEqual(["works"]);
  });
});

describe("liveReducer", () => {
  const base: LiveState = { exploration: exploration({ status: "studying" }), findings: [], frames: [], screens: [], steps: 0, withheld: false };

  it("takes a newer row and ignores an older one delivered late", () => {
    const newer = exploration({ status: "exploring", updated_at: "2026-10-16T10:05:00.000Z" });
    const s1 = liveReducer(base, { type: "exploration", row: newer });
    expect(s1.exploration.status).toBe("exploring");
    const older = exploration({ status: "studying", updated_at: "2026-10-16T10:01:00.000Z" });
    expect(liveReducer(s1, { type: "exploration", row: older }).exploration.status).toBe("exploring");
    expect(liveReducer(s1, { type: "exploration", row: exploration({ id: "other" }) })).toBe(s1);
  });

  it("dedupes findings by id and keeps them in step order; the rail shows newest first", () => {
    const s = liveReducer(base, { type: "findings", rows: [finding("b", 2), finding("a", 1)] });
    const s2 = liveReducer(s, { type: "finding", row: { ...finding("b", 2), title: "renamed" } });
    expect(s2.findings.map((f) => f.id)).toEqual(["a", "b"]);
    expect(s2.findings[1].title).toBe("renamed");
    expect(railFindings(s2.findings).map((f) => f.id)).toEqual(["b", "a"]);
  });

  it("adds frames once, counts steps and follows the newest step's withheld flag", () => {
    let s = liveReducer(base, { type: "step", seq: 1, frame_path: "r/1.png", withheld: false });
    s = liveReducer(s, { type: "step", seq: 3, frame_path: "r/3.png", withheld: true });
    s = liveReducer(s, { type: "step", seq: 1, frame_path: "r/1.png", withheld: false });
    expect(s.frames.map((f) => f.seq)).toEqual([1, 3]);
    expect(s.steps).toBe(3);
    expect(s.withheld).toBe(true);
    s = liveReducer(s, { type: "step", seq: 4, frame_path: null, withheld: false });
    expect(s.withheld).toBe(false);
  });
});

describe("study and follow-up helpers", () => {
  it("lists the features the study names, targets first, without repeats", () => {
    const e = exploration({
      targets: ["expenses"],
      charter: [mission("m1", "planned", { feature: "trucks" }), mission("m2", "planned", { feature: "expenses" })],
      briefing: {
        app_summary: "",
        personas: [],
        journeys: [{ id: "j", name: "J", steps: [], features: ["review", "trucks"] }],
        risks: [],
        sources_read: { files: 1, tests: 0, scenarios: 0, docs: 0, context: false },
      },
    });
    expect(studyFeatures(e)).toEqual(["expenses", "trucks", "review"]);
  });

});

describe("readLine and the walk scene's feature", () => {
  const study = {
    version: 1,
    repo: true,
    bytes: 24476,
    sources: [
      { kind: "code" as const, count: 487, items: [] },
      { kind: "tests" as const, count: 467, items: [] },
      { kind: "features" as const, count: 37, items: [{ name: "Add entry" }, { name: "Add entry / manual log", key: "entry-manual-log", target: true }] },
    ],
  };
  const none = { files: 0, tests: 0, scenarios: 0, docs: 0, context: false };

  it("says what the explorer worked from, never a row of zeros", () => {
    // Snugly's study handed the explorer a 24 KB digest; it opened nothing itself.
    expect(readLine(study, none, false)).toBe("Worked from Embodent's study: a 24 KB digest of 487 code files and 467 tests.");
    expect(readLine(study, { ...none, files: 3, docs: 1 }, false)).toBe(
      "Worked from Embodent's study: a 24 KB digest of 487 code files and 467 tests. It opened 3 code files and 1 doc itself.",
    );
    expect(readLine(study, { ...none, context: true }, true)).toBe(
      "Worked from Embodent's study: a 24 KB digest of 487 code files and 467 tests, and the context you attached.",
    );
    // Before the study: what it opened, and nothing when that is nothing.
    expect(readLine(null, { ...none, files: 1 }, false)).toBe("Read 1 code file.");
    expect(readLine(null, none, false)).toBeNull();
    expect(readLine({ ...study, bytes: 300, sources: [{ kind: "code", count: 2, items: [] }] }, none, false)).toBe(
      "Worked from Embodent's study: a digest of 2 code files.",
    );
  });

  it("picks a feature of the project's own for the walk scene's example, a target first", () => {
    expect(exampleFeatureOf({ study, targets: [] })).toBe("Add entry / manual log");
    expect(exampleFeatureOf({ study: null, targets: ["notebooks"] })).toBe("Notebooks");
    expect(exampleFeatureOf({ study: { ...study, sources: [{ kind: "features", count: 1, items: [{ name: "Library" }] }] }, targets: [] })).toBe("Library");
    expect(exampleFeatureOf({ study: null, targets: [] })).toBeNull();
  });
});
