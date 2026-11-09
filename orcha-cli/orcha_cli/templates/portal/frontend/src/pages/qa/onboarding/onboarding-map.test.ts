import { describe, expect, it } from "vitest";
import { STILL_STEPS, STILL_STEP_MS, activeFlights, advancePlan, animating, deviceAt, emptyPlan, fileGlow, progress, pulse } from "./choreo";
import { MAP_PHASES, duration, mergeAccepted, parseOnboardingMap, usd, type OnboardingMap } from "./contract";
import { bringInCount, coverageCounts, coverageSentence, fallbackFirstTest, joinAnd, matchedTests, smokeSuite, smokeSuiteCount, yourTestsPhrase } from "./coverage";
import { fixture, fixtureAt } from "./fixtures";
import { canContinue, flowReducer, furthestStep, initialFlow, mapBeat, phaseAnnouncement } from "./flow";
import { computeLayout, neighbour, nodeAt, nodeShape, screenAspect, treeRows } from "./layout";
import { coverRect } from "./draw";

const roundTrip = (m: OnboardingMap) => parseOnboardingMap(JSON.parse(JSON.stringify(m)))!;

describe("fixtures", () => {
  it("have the sizes the proof asks for", () => {
    expect(fixture("small").screens).toHaveLength(12);
    expect(fixture("snug").screens).toHaveLength(40);
    expect(fixture("big").screens).toHaveLength(250);
  });

  it("follow the contract exactly: parsing them changes nothing", () => {
    for (const name of ["small", "snug", "big"] as const) {
      const m = fixture(name);
      const parsed = roundTrip(m);
      expect(parsed.screens.map((s) => s.id)).toEqual(m.screens.map((s) => s.id));
      expect(parsed.edges).toHaveLength(m.edges.length);
      expect(parsed.files).toHaveLength(m.files.length);
      expect(parsed.gaps).toEqual(m.gaps);
    }
  });

  it("the Snug-Log-like app has XCUITest and Espresso tests", () => {
    const m = fixture("snug");
    expect(m.found.tests.map((t) => t.framework)).toEqual(["xcuitest", "espresso"]);
    expect(m.screens.some((s) => s.tests.some((t) => t.framework === "espresso"))).toBe(true);
  });

  it("step back through the phases", () => {
    const full = fixture("snug");
    const early = fixtureAt(full, { phase: "code_map", progress: 0.25 });
    expect(early.screens).toHaveLength(10);
    expect(early.screens.every((s) => s.source === "code" && s.tests.length === 0 && !s.thumbnail)).toBe(true);
    expect(early.phases.code_map.state).toBe("running");
    expect(early.phases.tests.state).toBe("pending");
    const live = fixtureAt(full, { phase: "live", progress: 0.5 });
    expect(live.screens.filter((s) => s.source !== "code")).toHaveLength(20);
    const skipped = fixtureAt(full, { phase: "coverage", liveSkipped: true });
    expect(skipped.phases.live.state).toBe("skipped");
    expect(skipped.screens.every((s) => s.source === "code")).toBe(true);
    const brought = fixtureAt(full, { phase: "bring_in" });
    expect(brought.first_test).not.toBeNull();
    expect(brought.screens.some((s) => s.scenarios.some((x) => x.status === "draft"))).toBe(true);
  });
});

describe("parseOnboardingMap", () => {
  it("refuses what is not a map", () => {
    expect(parseOnboardingMap(null)).toBeNull();
    expect(parseOnboardingMap({ error: "nope" })).toBeNull();
    expect(parseOnboardingMap([])).toBeNull();
  });

  it("fills every phase and empty lists for a bare snapshot", () => {
    const m = parseOnboardingMap({ project_id: "p1" })!;
    expect(Object.keys(m.phases)).toEqual([...MAP_PHASES]);
    expect(m.phases.code_map.state).toBe("pending");
    expect(m.phase).toBe("found");
    expect(m.screens).toEqual([]);
    expect(m.first_test).toBeNull();
    expect(m.found.repo.name).toBe("");
  });

  it("drops what it cannot draw and falls back on bad values", () => {
    const m = parseOnboardingMap({
      project_id: "p1",
      phase: "teleport",
      phases: { code_map: { state: "exploded", cost_usd: "free" }, live: { state: "running", estimate_usd: 0.4 } },
      screens: [
        { id: "a", name: "Basket", source: "both", coverage: "your_tests", files: ["a.swift", 3], endpoints: [], tests: [{ framework: "xcuitest", name: "t", path: "x", evidence: "e" }], scenarios: [], risk: { score: 0.4, reasons: [] } },
        { id: "b", name: "Payment", source: "weird", coverage: "nope" },
        { name: "no id" },
      ],
      edges: [
        { from: "a", to: "b", kind: "nav" },
        { from: "a", to: "ghost", kind: "nav" },
        { from: "a", to: "a", kind: "nav" },
      ],
      gaps: [
        { screen_id: "b", risk: 0.2, reason: "low" },
        { screen_id: "a", risk: 0.9, reason: "high" },
        { screen_id: "ghost", risk: 1, reason: "gone" },
      ],
      found: { platforms: [{ kind: "ios" }, { kind: "desktop" }], tests: [{ framework: "xcuitest", count: 3.6, path: "UITests" }, { framework: "selenium", count: 2 }] },
      first_test: { scenario_id: "s1", name: "Pay", estimate_seconds: 40, estimate_usd: 0.05, why: "short" },
    })!;
    expect(m.phase).toBe("found");
    expect(m.phases.code_map).toEqual({ state: "pending" });
    expect(m.phases.live).toEqual({ state: "running", estimate_usd: 0.4 });
    expect(m.screens.map((s) => s.id)).toEqual(["a", "b"]);
    expect(m.screens[0].files).toEqual(["a.swift"]);
    expect(m.screens[1]).toMatchObject({ source: "code", coverage: "none", files: [], tests: [] });
    expect(m.edges).toEqual([{ from: "a", to: "b", kind: "nav" }]);
    expect(m.gaps.map((g) => g.screen_id)).toEqual(["a", "b"]);
    expect(m.found.platforms.map((p) => p.kind)).toEqual(["ios"]);
    expect(m.found.tests).toEqual([{ framework: "xcuitest", count: 4, path: "UITests" }]);
    expect(m.first_test?.scenario_id).toBe("s1");
  });

  it("reads the first run's result on a screen", () => {
    const m = parseOnboardingMap({
      project_id: "p",
      screens: [
        { id: "a", name: "A", first_run: { scenario_id: "s", run_id: "r1", verdict: "pass", duration_s: 42 } },
        { id: "b", name: "B", first_run: { scenario_id: "s2", run_id: "", verdict: "queued" } },
        { id: "c", name: "C", first_run: { run_id: "r3" } },
      ],
      smoke: { count: 13, estimate_usd: 0.78, estimate_seconds: 520, projected: false },
    })!;
    expect(m.screens[0].first_run).toEqual({ scenario_id: "s", run_id: "r1", verdict: "pass", duration_s: 42, finding: undefined });
    // Queued with no run yet: kept, with an empty run id (the device view waits for it).
    expect(m.screens[1].first_run).toMatchObject({ verdict: "queued", run_id: "" });
    expect(m.screens[2].first_run).toBeUndefined();
    expect(m.smoke).toEqual({ count: 13, estimate_usd: 0.78, estimate_seconds: 520, projected: false });
    expect(parseOnboardingMap({ project_id: "p" })!.smoke).toBeNull();
  });

  it("folds a 202 answer's phases into the map on screen, keeping its screens", () => {
    const shown = fixtureAt(fixture("small"), { phase: "tests" });
    const merged = mergeAccepted(shown, { project_id: shown.project_id, phase: "live", phases: { live: { state: "running", estimate_usd: 0.13 } } })!;
    expect(merged.screens).toHaveLength(12);
    expect(merged.phase).toBe("live");
    expect(merged.phases.live.state).toBe("running");
    expect(merged.phases.code_map.state).toBe("done");
    expect(mergeAccepted(shown, { error: "nope" })).toBe(shown);
    expect(mergeAccepted(null, { project_id: "p", phase: "code_map", phases: {} })?.screens).toEqual([]);
    const full = fixture("small");
    expect(mergeAccepted(shown, full)?.screens).toHaveLength(12);
  });

  it("formats money and time plainly", () => {
    expect(usd(undefined)).toBe("estimate pending");
    expect(usd(0)).toBe("free");
    expect(usd(0.004)).toBe("under $0.01");
    expect(usd(0.84)).toBe("$0.84");
    expect(duration(42)).toBe("42 s");
    expect(duration(360)).toBe("6 min");
  });
});

describe("the flow", () => {
  it("walks forward, and Back stops at Map once the project exists", () => {
    let s = initialFlow();
    s = flowReducer(s, { type: "next" });
    expect(s.step).toBe("found");
    expect(s.announcement).toBe("We found. Step 2 of 6.");
    s = flowReducer(s, { type: "back" });
    expect(s.step).toBe("connect");
    s = flowReducer(flowReducer(s, { type: "next" }), { type: "next" });
    expect(s.step).toBe("map");
    s = flowReducer(s, { type: "back" });
    expect(s.step).toBe("map");
  });

  it("the rail goes back to steps reached, never ahead or before Map", () => {
    let s = initialFlow("map");
    s = flowReducer(flowReducer(s, { type: "next" }), { type: "next" });
    expect(s.step).toBe("bring_in");
    expect(flowReducer(s, { type: "go", step: "map" }).step).toBe("map");
    expect(flowReducer(s, { type: "go", step: "first_run" }).step).toBe("bring_in");
    expect(flowReducer(s, { type: "go", step: "found" }).step).toBe("bring_in");
    const back = flowReducer(s, { type: "go", step: "coverage" });
    expect(back.reached).toBe("bring_in");
  });

  it("starts over from Connect with nothing reached (#454)", () => {
    let st = flowReducer(initialFlow("found"), { type: "next" });
    st = flowReducer(st, { type: "reset" });
    expect(st).toMatchObject({ step: "connect", reached: "connect" });
  });

  it("asks for a click on the offered live pass, and says so (#454)", () => {
    const full = fixture("small");
    const offered = fixtureAt(full, { phase: "tests" });
    offered.phases.live = { state: "pending" };
    expect(mapBeat(offered)).toBe("live_offer");
    expect(canContinue("map", offered)).toEqual({ ok: false, why: "Run the live pass, or skip it to go on." });
    expect(phaseAnnouncement(offered).text).toBe("The code map is done. The live pass waits for you: run it or skip it.");
  });

  it("jumps ahead to the first run", () => {
    const s = flowReducer(initialFlow("map"), { type: "jump", step: "first_run" });
    expect(s).toMatchObject({ step: "first_run", reached: "first_run" });
  });

  it("knows the Map step's beat from the phases", () => {
    const full = fixture("small");
    expect(mapBeat(null)).toBe("waiting");
    expect(mapBeat(fixtureAt(full, { phase: "found" }))).toBe("waiting");
    expect(mapBeat(fixtureAt(full, { phase: "code_map", progress: 0.5 }))).toBe("code");
    expect(mapBeat(fixtureAt(full, { phase: "tests", progress: 0.5 }))).toBe("tests");
    const offer = fixtureAt(full, { phase: "tests" });
    expect(mapBeat(offer)).toBe("live_offer");
    expect(mapBeat(fixtureAt(full, { phase: "live", progress: 0.3 }))).toBe("live");
    expect(mapBeat(fixtureAt(full, { phase: "coverage" }))).toBe("ready");
    expect(mapBeat(fixtureAt(full, { phase: "coverage", liveSkipped: true }))).toBe("ready");
    const failed = fixtureAt(full, { phase: "code_map", progress: 0.5 });
    failed.phases.code_map.state = "failed";
    expect(mapBeat(failed)).toBe("failed");
  });

  it("gates Continue on Map until the map is ready, and says why", () => {
    const full = fixture("small");
    expect(canContinue("map", fixtureAt(full, { phase: "code_map", progress: 0.5 }))).toEqual({ ok: false, why: "Still mapping." });
    expect(canContinue("map", fixtureAt(full, { phase: "live", progress: 0.5 })).ok).toBe(false);
    expect(canContinue("map", fixtureAt(full, { phase: "coverage" })).ok).toBe(true);
    expect(canContinue("bring_in", fixtureAt(full, { phase: "bring_in", progress: 0.5 })).ok).toBe(false);
    expect(furthestStep(fixtureAt(full, { phase: "coverage" }))).toBe("bring_in");
    expect(furthestStep(fixtureAt(full, { phase: "first_run" }))).toBe("first_run");
  });

  it("announces each beat once, in words", () => {
    const full = fixture("snug");
    expect(phaseAnnouncement(fixtureAt(full, { phase: "tests", progress: 0.5 })).text).toBe("Found 40 screens. Matching your existing tests to them.");
    const a = phaseAnnouncement(fixtureAt(full, { phase: "code_map", progress: 0.3 }));
    const b = phaseAnnouncement(fixtureAt(full, { phase: "code_map", progress: 0.6 }));
    expect(a.key).toBe(b.key);
    expect(phaseAnnouncement(fixtureAt(full, { phase: "first_run", firstRun: "pass" })).text).toBe("Your first test passed in 42 seconds.");
    // Bring it in waits for the person: the map is still the news.
    const waiting = fixtureAt(full, { phase: "coverage" });
    waiting.phase = "bring_in";
    expect(phaseAnnouncement(waiting).key).toBe("ready");
  });
});

describe("coverage counts", () => {
  it("say it the owner's way", () => {
    const m = fixtureAt(fixture("snug"), { phase: "coverage" });
    const parts = coverageSentence(m);
    const c = coverageCounts(m.screens);
    expect(parts[0]).toBe("40 screens");
    expect(parts[1]).toBe(`${c.yours} covered by your XCUITest and Espresso tests`);
    expect(parts[2]).toBe(`${c.none} not covered`);
    expect(parts[3]).toBe("sign in untested");
    expect(c.yours + c.qa + c.both + c.none).toBe(40);
  });

  it("names one framework in its own plural", () => {
    expect(yourTestsPhrase(["xcuitest"])).toBe("your XCUITests");
    expect(yourTestsPhrase(["maestro"])).toBe("your Maestro flows");
    expect(yourTestsPhrase(["xcuitest", "espresso", "detox"])).toBe("your tests");
    expect(joinAnd(["checkout", "sign-in"])).toBe("checkout and sign-in");
    expect(joinAnd(["a", "b", "c"])).toBe("a, b and c");
  });

  it("counts Embodent once drafts land, and both on a screen with each", () => {
    const m = fixtureAt(fixture("small"), { phase: "bring_in" });
    const c = coverageCounts(m.screens);
    expect(c.qa + c.both).toBeGreaterThan(0);
    expect(coverageSentence(m).some((p) => p.endsWith("covered by Embodent"))).toBe(true);
  });

  it("says every screen is covered when none is left", () => {
    const m = fixture("small");
    for (const s of m.screens) s.coverage = "your_tests";
    m.summary.untested_critical = [];
    expect(coverageSentence(m).at(-1)).toBe("every screen covered");
  });

  it("takes the smoke suite's figures from the server, projected before Bring it in", () => {
    const before = fixtureAt(fixture("snug"), { phase: "coverage" });
    expect(before.smoke?.projected).toBe(true);
    expect(smokeSuite(before)).toBe(before.smoke);
    const after = fixtureAt(fixture("snug"), { phase: "bring_in" });
    expect(after.smoke?.projected).toBe(false);
    after.smoke = null;
    expect(smokeSuite(after).count).toBe(smokeSuiteCount(after.screens));
  });

  it("brings in every test unless narrowed, and counts the smoke suite", () => {
    const m = fixtureAt(fixture("snug"), { phase: "bring_in" });
    expect(bringInCount(m, null)).toBe(29);
    expect(bringInCount(m, new Set(["espresso"]))).toBe(11);
    expect(matchedTests(m.screens)).toBeGreaterThan(0);
    expect(smokeSuiteCount(m.screens)).toBeGreaterThan(0);
  });

  it("falls back to the riskiest imported test, then a drafted gap", () => {
    const m = fixtureAt(fixture("small"), { phase: "bring_in" });
    const server = m.first_test;
    expect(fallbackFirstTest(m)).toBe(server);
    m.first_test = null;
    expect(fallbackFirstTest(m)?.scenario_id.startsWith("imp-")).toBe(true);
    for (const s of m.screens) s.scenarios = s.scenarios.filter((x) => x.status === "draft");
    expect(fallbackFirstTest(m)?.scenario_id.startsWith("drf-")).toBe(true);
    for (const s of m.screens) s.scenarios = [];
    expect(fallbackFirstTest(m)).toBeNull();
  });
});

describe("the cinematic's plan", () => {
  const m = fixtureAt(fixture("snug"), { phase: "coverage" });

  it("plays the beats in order: code, then tests, then live", () => {
    const p = advancePlan(emptyPlan(false), m, 0);
    const lastNode = Math.max(...p.nodeIn.values());
    const firstTest = Math.min(...p.testIn.values());
    const lastTest = Math.max(...p.testIn.values());
    const firstLive = Math.min(...p.liveIn.values());
    expect(firstTest).toBeGreaterThan(Math.min(...p.nodeIn.values()));
    expect(firstTest).toBeGreaterThanOrEqual(p.codeEnd - 1000);
    expect(firstLive).toBeGreaterThanOrEqual(lastTest);
    expect(p.flights.length).toBeGreaterThan(0);
    expect(lastNode).toBeLessThan(6000);
    expect(p.end).toBeGreaterThan(firstLive);
  });

  it("adds only what is new, never replaying what was shown", () => {
    const early = fixtureAt(fixture("snug"), { phase: "code_map", progress: 0.5 });
    const p1 = advancePlan(emptyPlan(false), early, 0);
    const p2 = advancePlan(p1, m, 10_000);
    for (const [id, t] of p1.nodeIn) expect(p2.nodeIn.get(id)).toBe(t);
    const fresh = [...p2.nodeIn.entries()].filter(([id]) => !p1.nodeIn.has(id));
    expect(fresh.length).toBe(20);
    expect(fresh.every(([, t]) => t >= 10_000)).toBe(true);
  });

  it("shows a remount settled (instant)", () => {
    const p = advancePlan(emptyPlan(false), m, 50_000, true);
    expect(animating(p, 50_000)).toBe(false);
    expect([...p.nodeIn.values()].every((t) => t < 50_000)).toBe(true);
  });

  it("reduced motion: still steps, no flights, no glow, only 0 or 1", () => {
    const p = advancePlan(emptyPlan(true), m, 0);
    expect(p.flights).toEqual([]);
    expect(activeFlights(p, 500)).toEqual([]);
    const times = new Set(p.nodeIn.values());
    expect(times.size).toBeLessThanOrEqual(STILL_STEPS);
    for (const t of [0, 100, 350, 700, 1500, 4000]) {
      for (const id of p.nodeIn.keys()) {
        const v = progress(p, p.nodeIn.get(id), t, 400);
        expect(v === 0 || v === 1).toBe(true);
        expect(pulse(p, p.testIn.get(id), t)).toBe(0);
      }
    }
    expect(deviceAt(p, 2000)).toBeNull();
    const lastCode = Math.max(...p.nodeIn.values());
    expect(lastCode).toBeLessThanOrEqual((STILL_STEPS - 1) * STILL_STEP_MS);
    // Progressive: something is shown at the first step, everything by the last.
    expect([...p.nodeIn.values()].filter((t) => t <= 0).length).toBeGreaterThan(0);
    expect(fileGlow(p, m.files[0].path, 10_000)).toBe(0.4);
  });

  it("lands a first-run verdict on its screen", () => {
    const run = fixtureAt(fixture("small"), { phase: "first_run", firstRun: "running" });
    const p1 = advancePlan(emptyPlan(false), run, 0, true);
    expect(p1.resultIn.size).toBe(0);
    const done = fixtureAt(fixture("small"), { phase: "first_run", firstRun: "pass" });
    const p2 = advancePlan(p1, done, 1000);
    expect(p2.resultIn.size).toBe(1);
    expect(progress(p2, [...p2.resultIn.values()][0], 1600, 500)).toBe(1);
  });
});

describe("the layout", () => {
  it("places every screen without overlaps, inside the graph", () => {
    for (const name of ["small", "snug", "big"] as const) {
      const m = fixture(name);
      const L = computeLayout(m, 1200, 640);
      expect(L.nodes.size).toBe(m.screens.length);
      const boxes = [...L.nodes.values()];
      for (const b of boxes) {
        expect(b.x).toBeGreaterThanOrEqual(L.graph.x - 0.5);
        expect(b.x + b.w).toBeLessThanOrEqual(L.graph.x + L.graph.w + 0.5);
        expect(b.y).toBeGreaterThanOrEqual(L.graph.y - 0.5);
      }
      for (let i = 0; i < boxes.length; i++)
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i];
          const b = boxes[j];
          const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          expect(overlap).toBe(false);
        }
    }
  });

  it("reads 12 screens as cards and 250 as chips", () => {
    expect(computeLayout(fixture("small"), 1200, 460).lod).toBe("card");
    expect(computeLayout(fixture("big"), 1200, 660).lod).not.toBe("card");
  });

  it("folds the tree to folders when the files do not fit", () => {
    const paths = Array.from({ length: 60 }, (_, i) => `app/src/area${i % 6}/File${i}.tsx`);
    const open = treeRows(paths.slice(0, 8), 40);
    expect(open.rows.some((r) => r.kind === "file")).toBe(true);
    const folded = treeRows(paths, 5);
    expect(folded.rows).toHaveLength(5);
    expect(folded.rows.at(-1)?.kind).toBe("more");
    for (const p of paths) expect(folded.rowOf.has(p)).toBe(true);
  });

  it("drops the tree and the endpoints at phone width", () => {
    const L = computeLayout(fixture("small"), 360, 420);
    expect(L.tree).toBeNull();
    expect(L.rail).toBeNull();
  });

  it("finds the screen under the pointer and moves with the arrows", () => {
    const L = computeLayout(fixture("small"), 1200, 460);
    const first = L.nodes.get(L.order[0])!;
    expect(nodeAt(L, first.x + 2, first.y + 2)).toBe(first.id);
    expect(nodeAt(L, 1, 1)).toBeNull();
    expect(neighbour(L, null, "right")).toBe(L.order[0]);
    const right = neighbour(L, first.id, "right")!;
    expect(L.nodes.get(right)!.x).toBeGreaterThan(first.x);
    expect(neighbour(L, first.id, "end")).toBe(L.order.at(-1));
  });
});

describe("screen card shape and screenshot crop", () => {
  it("shapes a phone app's cards tall and a web app's wide, at about the same area", () => {
    const phone = nodeShape(screenAspect({ screens: [{ platform: "ios" }, { platform: "ios" }, { platform: "web" }] as never, found: undefined }));
    const web = nodeShape(screenAspect({ screens: [{ platform: "web" }] as never, found: undefined }));
    expect(phone.nodeH).toBeGreaterThan(phone.nodeW);
    expect(web.nodeW).toBeGreaterThan(web.nodeH);
    expect(Math.abs(phone.nodeW * phone.nodeH - web.nodeW * web.nodeH)).toBeLessThan(0.1 * phone.nodeW * phone.nodeH);
    expect(phone.cellW).toBe(phone.nodeW + 20);
  });

  it("falls back to the found platform when no screen names one", () => {
    const shape = screenAspect({ screens: [] as never, found: { platforms: [{ kind: "web" }] } as never });
    expect(nodeShape(shape).nodeW).toBeGreaterThan(nodeShape(shape).nodeH);
  });

  it("crops a screenshot to fill the card without stretching: centred across, kept from the top", () => {
    // A phone screenshot into a wider card: the full width, cut at the bottom.
    expect(coverRect(400, 800, 100, 100)).toEqual({ sx: 0, sy: 0, sw: 400, sh: 400 });
    // A wide screenshot into a tall card: the full height, centred across.
    expect(coverRect(1200, 600, 50, 100)).toEqual({ sx: 450, sy: 0, sw: 300, sh: 600 });
    // The same aspect: the whole image.
    expect(coverRect(402, 874, 201, 437)).toEqual({ sx: 0, sy: 0, sw: 402, sh: 874 });
  });
});

describe("what the coverage step names", () => {
  it("says a gap's platform only when the map has more than one", async () => {
    const { gapPlatform } = await import("./coverage");
    expect(gapPlatform("screen:ios:paywall", ["screen:ios:paywall", "screen:ios:home"])).toBeNull();
    expect(gapPlatform("screen:android:/paywall", ["screen:ios:paywall", "screen:android:/paywall"])).toBe("android");
  });
});
