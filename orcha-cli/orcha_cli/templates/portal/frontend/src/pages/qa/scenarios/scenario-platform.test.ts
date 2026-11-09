import { describe, expect, it } from "vitest";
import { platformStatusLabel } from "./platform-status-strip";
import {
  criteriaDontFit,
  displayScenarioName,
  inPlatformFilter,
  latestOutcomesByKind,
  noFitLine,
  noFitWhy,
  pickableScenarios,
  pickedElsewhereNote,
  picksForKind,
  platformFilterCounts,
  platformFitByKind,
  platformFitWarning,
  projectKinds,
  scenarioPlatformStatus,
  scenariosThatRun,
  splitDraftName,
  validatedScenariosForKind,
  type PlatformResultRow,
} from "./scenario-platform";

describe("platform scope: pinned vs shared", () => {
  it("orders the project's platforms web, iOS, Android, each once", () => {
    expect(projectKinds([{ kind: "android" }, { kind: "web" }, { kind: "web" }, { kind: "ios" }])).toEqual([
      "web",
      "ios",
      "android",
    ]);
  });

  it("filters: All shows everything, a platform shows pinned-there and shared", () => {
    expect(inPlatformFilter("ios", null)).toBe(true);
    expect(inPlatformFilter(null, "web")).toBe(true);
    expect(inPlatformFilter("web", "web")).toBe(true);
    expect(inPlatformFilter("ios", "web")).toBe(false);
  });

  it("counts what runs on each platform", () => {
    const rows = [{ target_kind: "web" as const }, { target_kind: "ios" as const }, { target_kind: null }];
    expect(platformFilterCounts(rows, ["web", "ios"])).toEqual({ all: 3, web: 2, ios: 2 });
  });

  it("keeps the newest outcome per scenario and platform", () => {
    const out = latestOutcomesByKind([
      { scenario_id: "s", outcome: "fail", kind: "web", at: "2026-10-01" },
      { scenario_id: "s", outcome: "pass", kind: "web", at: "2026-10-02" },
      { scenario_id: "s", outcome: "fail", kind: "ios", at: "2026-10-03" },
      { scenario_id: "s", outcome: "pass", kind: null, at: "2026-10-04" },
    ]);
    expect(out).toEqual({ s: { web: "pass", ios: "fail" } });
  });

  it("builds a strip cell per platform the scenario applies to", () => {
    const outcomes = { shared: { web: "pass" as const, ios: "fail" as const } };
    const traces = { shared: ["web" as const] };
    expect(scenarioPlatformStatus({ id: "shared", target_kind: null }, ["web", "ios", "android"], outcomes, traces)).toEqual([
      { kind: "web", outcome: "pass", traced: true },
      { kind: "ios", outcome: "fail", traced: false },
      { kind: "android", outcome: null, traced: false },
    ]);
    expect(scenarioPlatformStatus({ id: "shared", target_kind: "ios" }, ["web", "ios"], outcomes, traces)).toEqual([
      { kind: "ios", outcome: "fail", traced: false },
    ]);
  });

  it("drops the platform tag from a pinned scenario's name only", () => {
    expect(displayScenarioName("Navigate the main tabs (iOS)", "ios")).toBe("Navigate the main tabs");
    expect(displayScenarioName("Sign in (web)", null)).toBe("Sign in (web)");
    expect(displayScenarioName("(iOS)", "ios")).toBe("(iOS)");
  });
});

// ILM: 12 iOS + 8 web validated; the schedule dialog said "(20)" for both targets (D63).
const scenarios = [
  { id: "w", status: "validated", target_kind: "web" },
  { id: "i", status: "validated", target_kind: "ios" },
  { id: "a", status: "validated", target_kind: null },
  { id: "d", status: "draft", target_kind: "web" },
];

describe("validatedScenariosForKind (D36, D63)", () => {
  it("counts the chosen platform's validated scenarios and the unpinned ones", () => {
    expect(validatedScenariosForKind(scenarios, "web").map((s) => s.id)).toEqual(["w", "a"]);
    expect(validatedScenariosForKind(scenarios, "ios").map((s) => s.id)).toEqual(["i", "a"]);
    expect(validatedScenariosForKind(scenarios, "android").map((s) => s.id)).toEqual(["a"]);
  });

  it("lists every validated scenario while no target is chosen", () => {
    expect(validatedScenariosForKind(scenarios, null).map((s) => s.id)).toEqual(["w", "i", "a"]);
  });
});

describe("picksForKind", () => {
  it("drops picks pinned to another platform when the target changes", () => {
    expect(picksForKind(["w", "i", "a"], scenarios, "web")).toEqual(["w", "a"]);
    expect(picksForKind(["w", "i"], scenarios, "ios")).toEqual(["i"]);
  });

  it("keeps the picks while the scenarios have not loaded", () => {
    expect(picksForKind(["w", "i"], [], "web")).toEqual(["w", "i"]);
  });
});

describe("scenariosThatRun (the New Run summary)", () => {
  const rows = [
    { id: "w", status: "validated", target_kind: "web" },
    { id: "d", status: "draft", target_kind: null },
    { id: "i", status: "draft", target_kind: "ios" },
    { id: "a", status: "validated", target_kind: null },
  ];
  it("counts a picked draft, as the worker runs it", () => {
    expect(scenariosThatRun(rows, "web", ["d"]).map((s) => s.id)).toEqual(["d"]);
  });
  it("leaves out picks pinned to another platform", () => {
    expect(scenariosThatRun(rows, "web", ["d", "i", "w"]).map((s) => s.id)).toEqual(["w", "d"]);
  });
  it("without a pick runs every validated scenario for the platform", () => {
    expect(scenariosThatRun(rows, "web", null).map((s) => s.id)).toEqual(["w", "a"]);
  });
});

describe("pickableScenarios (D92)", () => {
  const all = [
    { id: "w", target_kind: "web" },
    { id: "i", target_kind: "ios" },
    { id: "d", target_kind: "android", status: "draft" },
    { id: "any", target_kind: null },
  ];

  it("offers an Android run only Android and unpinned scenarios, drafts included", () => {
    expect(pickableScenarios(all, "android").map((s) => s.id)).toEqual(["d", "any"]);
  });

  it("never hides what is already picked, and lists everything without a platform", () => {
    expect(pickableScenarios(all, "android", ["i"]).map((s) => s.id)).toEqual(["i", "d", "any"]);
    expect(pickableScenarios(all, null)).toHaveLength(4);
  });
});

describe("pickedElsewhereNote (polish-8)", () => {
  // Snugly's three onboarding scenarios, all pinned to iOS, opened with New Run on Android.
  const rows = [
    { id: "e1667371", target_kind: "ios" },
    { id: "0fb0102e", target_kind: "ios" },
    { id: "38a2915c", target_kind: "ios" },
    { id: "shared", target_kind: null },
    { id: "web-only", target_kind: "web" },
  ];
  it("says plainly which picks do not run here", () => {
    expect(pickedElsewhereNote(rows, "android", ["e1667371", "0fb0102e", "38a2915c"])).toBe("The 3 picked scenarios are iOS only: none runs on Android.");
    expect(pickedElsewhereNote(rows, "android", ["e1667371"])).toBe("The picked scenario is iOS only: it does not run on Android.");
    expect(pickedElsewhereNote(rows, "android", ["e1667371", "shared"])).toBe("1 picked scenario is iOS only and is left out on Android.");
    expect(pickedElsewhereNote(rows, "android", ["e1667371", "web-only"])).toBe("The 2 picked scenarios are for iOS or Web only: none runs on Android.");
  });
  it("says nothing when every pick runs here, or before anything is known", () => {
    expect(pickedElsewhereNote(rows, "ios", ["e1667371", "0fb0102e", "38a2915c", "shared"])).toBeNull();
    expect(pickedElsewhereNote(rows, "android", null)).toBeNull();
    expect(pickedElsewhereNote([], "android", ["e1667371"])).toBeNull();
  });
});

describe("checks that do not fit a platform", () => {
  const NOTE = `criteria don't fit: Android guest home has no "For Sale"/"For Rent"/"Search" labels by design.`;
  const row = (kind: "ios" | "android" | "web", outcome: PlatformResultRow["outcome"], at: string, reason: string | null = null): PlatformResultRow => ({
    scenario_id: "s",
    kind,
    outcome,
    at,
    reason,
  });
  const shared = { id: "s", status: "validated", target_kind: null };
  const warn = (rows: PlatformResultRow[], kinds: ("ios" | "android" | "web")[] = ["ios", "android"], flags: Parameters<typeof platformFitWarning>[3] = []) =>
    platformFitWarning(shared, kinds, platformFitByKind(rows), flags);

  it("reads only the agent's own note on an inconclusive result", () => {
    expect(criteriaDontFit("inconclusive", NOTE)).toBe(true);
    expect(criteriaDontFit("inconclusive", "Criteria don't fit this build")).toBe(true);
    expect(criteriaDontFit("inconclusive", "criteria don’t fit what the app shows")).toBe(true);
    expect(criteriaDontFit("inconclusive", "criteria do not fit")).toBe(true);
    // A verdict stays a verdict, whatever its reason says.
    expect(criteriaDontFit("fail", NOTE)).toBe(false);
    // Device trouble, another cause named first, one examples row's data.
    expect(criteriaDontFit("inconclusive", "hard blocker: the accessibility tree was empty")).toBe(false);
    expect(criteriaDontFit("inconclusive", "sign-in failed: no credentials, and criteria don't fit")).toBe(false);
    expect(criteriaDontFit("inconclusive", "criteria don't fit: this example row uses an empty baby name")).toBe(false);
    expect(criteriaDontFit("inconclusive", null)).toBe(false);
  });

  it("says the note without repeating its prefix", () => {
    expect(noFitWhy(NOTE)).toBe(`Android guest home has no "For Sale"/"For Rent"/"Search" labels by design.`);
    expect(noFitWhy("criteria don't fit what the Android app does")).toBe("Criteria don't fit what the Android app does");
    expect(noFitLine("android")).toBe("These checks don't fit Android, so Android can't judge them. No verdict, not a failure.");
  });

  // Guest browse properties (Nyumbani), its stored results: Android says the checks do not fit,
  // around device trouble; iOS judged them, and failed. The fails are not touched.
  const GUEST = [
    row("android", "inconclusive", "2026-11-05T09:41", NOTE),
    row("ios", "blocked", "2026-11-05T07:44", "Could not get past onboarding on the iPad"),
    row("android", "blocked", "2026-11-04T07:10", "needs setup: the app's data could not be reset"),
    row("android", "inconclusive", "2026-11-03T21:05", "criteria don't fit what the Android app does (iOS-style labels)"),
    row("ios", "fail", "2026-11-03T21:04", `criteria don't fit: the app has no standalone "Nyumbani" label`),
    row("android", "inconclusive", "2026-11-03T07:03", "hard blocker: the accessibility tree was empty"),
    row("ios", "pass", "2026-11-01T07:23", "Both criteria passed during replay"),
  ];

  it("warns on Guest browse properties, without claiming the labels are iOS's", () => {
    expect(warn(GUEST)).toEqual({
      misfit: ["android"],
      limitTo: "ios",
      text: "These checks don't fit Android, so Android can't judge them.",
      detail: `Last Android run: Android guest home has no "For Sale"/"For Rent"/"Search" labels by design.`,
    });
  });

  it("names the labels' platform when that platform passes, the example the owner gave", () => {
    const w = warn([row("android", "inconclusive", "2026-11-05", NOTE), row("ios", "pass", "2026-11-04")]);
    expect(w?.text).toBe("These checks use iOS labels, so Android can't judge them.");
    expect(w?.limitTo).toBe("ios");
  });

  it("device trouble after the note neither raises nor clears it", () => {
    expect(warn([row("android", "inconclusive", "2026-11-06", "hard blocker: empty tree"), ...GUEST])?.misfit).toEqual(["android"]);
    expect(warn([row("android", "inconclusive", "2026-11-06", "hard blocker: empty tree"), row("ios", "pass", "2026-11-05")])).toBeNull();
  });

  it("goes quiet once the platform judged them", () => {
    expect(warn([row("android", "pass", "2026-11-06"), ...GUEST])).toBeNull();
    expect(warn([row("android", "fail", "2026-11-06"), ...GUEST])).toBeNull();
    // An older note under a newer verdict says nothing.
    expect(warn([row("android", "inconclusive", "2026-11-01", NOTE), row("android", "pass", "2026-11-02"), row("ios", "pass", "2026-11-02")])).toBeNull();
  });

  it("stays quiet when no platform judged them: then it may be the wording, not the platform", () => {
    expect(warn([row("android", "inconclusive", "2026-11-05", NOTE)])).toBeNull();
    expect(warn([row("android", "inconclusive", "2026-11-05", NOTE), row("ios", "inconclusive", "2026-11-05", NOTE)])).toBeNull();
    expect(warn([row("android", "inconclusive", "2026-11-05", NOTE), row("ios", "blocked", "2026-11-05", "sign-in wall")])).toBeNull();
  });

  it("never warns on a pinned, retired or single-platform scenario", () => {
    const fit = platformFitByKind(GUEST);
    expect(platformFitWarning({ ...shared, target_kind: "android" }, ["ios", "android"], fit, [])).toBeNull();
    expect(platformFitWarning({ ...shared, status: "retired" }, ["ios", "android"], fit, [])).toBeNull();
    expect(platformFitWarning(shared, ["android"], fit, [])).toBeNull();
  });

  it("offers Limit only when one platform is left", () => {
    const w = warn([row("android", "inconclusive", "2026-11-05", NOTE), row("ios", "pass", "2026-11-04"), row("web", "pass", "2026-11-04")], ["web", "ios", "android"]);
    expect(w?.limitTo).toBeNull();
    expect(w?.text).toBe("These checks use Web and iOS labels, so Android can't judge them.");
  });

  const WORDING = { kind: "platform_wording", detail: { only_on: { ios: ["New Memory", "Smart Trends", "Timeline", "Week"] }, suggested_kind: "ios" } };

  it("warns from stored labels before any run on the other platform, and says may", () => {
    expect(warn([], ["ios", "android"], [WORDING])).toEqual({
      misfit: ["android"],
      limitTo: "ios",
      text: "These checks use iOS labels, so Android may not be able to judge them.",
      detail: `Seen only on iOS: "New Memory", "Smart Trends", "Timeline".`,
    });
    // Labels on both sides have no one platform to limit it to: the health badge says that one.
    expect(warn([], ["ios", "android"], [{ kind: "platform_wording", detail: { only_on: { ios: ["A"], android: ["B"] } } }])).toBeNull();
  });

  it("lets a pass on the other platform overrule stored labels", () => {
    expect(warn([row("android", "pass", "2026-11-05")], ["ios", "android"], [WORDING])).toBeNull();
  });

  it("a person's Keep on all platforms silences both kinds of evidence", () => {
    const kept = { ...WORDING, dismissed_at: "2026-11-05" };
    expect(warn(GUEST, ["ios", "android"], [kept])).toBeNull();
    expect(warn([], ["ios", "android"], [kept])).toBeNull();
  });

  it("the status strip says it on that platform, and only for a result that could not be judged", () => {
    const fit = platformFitByKind(GUEST);
    const cells = scenarioPlatformStatus({ id: "s" }, ["ios", "android"], latestOutcomesByKind(GUEST), {}, fit);
    expect(cells.map((c) => platformStatusLabel(c))).toEqual(["iOS: blocked", "Android: criteria don't fit"]);
    // The stored fail on iOS keeps reading as what it is.
    expect(cells[0].noFit).toBeUndefined();
    const failing = scenarioPlatformStatus({ id: "s" }, ["ios"], latestOutcomesByKind([row("ios", "fail", "2026-11-06")]), {}, fit);
    expect(platformStatusLabel(failing[0])).toBe("iOS: failed");
  });

  it("names one draft per platform, without doubling a platform already in the name", () => {
    expect(splitDraftName("Guest browse properties", "android")).toBe("Guest browse properties (Android)");
    expect(splitDraftName("Sign in (iOS)", "ios")).toBe("Sign in (iOS)");
    expect(splitDraftName("Sign in (iOS)", "android")).toBe("Sign in (Android)");
  });
});
