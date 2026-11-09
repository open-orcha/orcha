/** QA pure helpers: tolerant readers, words, grouping, diffs, decisions and authority. */
import { describe, expect, it } from "vitest";
import { qaAuthority, QA_NO_HUMAN_REASON } from "./authority";
import { allowedSites, detectedApp } from "./QaTargets";
import { qaTaskBody } from "./runQa";
import { comingBackFromFirstRun, opensOnOnboarding, setupSteps } from "./onboarding/opens-onboarding";
import { defaultPlatform, missionsOf, normalizeOverview, parsePlatform, screenRoute, splitWebEvents, viewportWord, normalizeScenario, normalizeSessionDetail, normalizeTaskQa, taskQaIsEmpty, walkName, type QaNode } from "./qaApi";
import { blockedKindWord, platformWord, webEventWord, evidenceWord, minutesWord, nodeStateWord, scenarioStatusWord, screenLabel, sessionKindWord } from "./qaWords";
import type { QaFeature } from "./qaApi";
import { blockedLine, firstInState, groupByFeature, sortScreens } from "./QaMap";
import { diffCriteria, evidenceSummary, statusActions } from "./QaScenarios";
import { producedLine, sessionTitle } from "./QaSessions";
import { verdictTally } from "./TaskQaSection";

const node = (over: Partial<QaNode>): QaNode => ({
  id: over.key ?? "n", platform: "ios", kind: "screen", key: "k", label: null, feature_key: null, state: "declared",
  blocked_kind: null, blocked_reason: null, sources: [], frame_id: null, last_seen_at: null, ...over,
});

describe("QA words", () => {
  it("never shows a raw enum", () => {
    expect(nodeStateWord("declared")).toBe("Not reached yet");
    expect(blockedKindWord("needs_sign_in")).toBe("Needs sign-in");
    expect(scenarioStatusWord("validated")).toBe("Approved");
    expect(evidenceWord("code_only")).toBe("Code only");
    expect(sessionKindWord("explore")).toBe("Exploration");
    // an unknown value is humanised, not shown as snake_case
    expect(blockedKindWord("rate_limited")).toBe("Rate limited");
    expect(minutesWord(65)).toBe("1 h 5 min");
    expect(minutesWord(null)).toBe("—");
  });

  it("labels a screen from its key when the map has no label", () => {
    expect(screenLabel({ key: "ProfileSettingsView", label: null })).toBe("Profile Settings");
    expect(screenLabel({ key: "settings/profile", label: "  Profile " })).toBe("Profile");
  });
});

describe("tolerant readers", () => {
  it("reads the overview from any of its shapes", () => {
    const a = normalizeOverview({ platforms: { ios: { screens: { seen: 3, declared: 2, blocked: 1 }, features: 4, scenarios: { draft: 2 }, open_findings: 1 } } });
    expect(a.ios.screens).toEqual({ seen: 3, declared: 2, blocked: 1 });
    expect(a.ios.scenarios.draft).toBe(2);
    expect(a.android.screens.seen).toBe(0);
    const b = normalizeOverview({ platforms: [{ platform: "android", features: [{}, {}], open_findings: 5 }] });
    expect(b.android.features).toBe(2);
    expect(b.android.open_findings).toBe(5);
    // the backend's shape: project-wide feature count, the target and last_session per platform
    const c = normalizeOverview({ features: 7, platforms: { ios: { target: { platform: "ios", app_id: "com.acme" }, screens: { seen: 1 }, last_session: { map: { id: "s" } } } } });
    expect(c.ios.features).toBe(7);
    expect(c.ios.target?.app_id).toBe("com.acme");
    expect(c.ios.last_sessions.map?.id).toBe("s");
  });

  it("reads a flattened session detail (the backend's shape) and a charter either way", () => {
    const d = normalizeSessionDetail({ id: "s1", kind: "explore", platform: "ios", status: "done", walks: [{ id: "w" }], findings: [], steps_count: 9, drafts: [], verdicts: [] });
    expect(d.session.id).toBe("s1");
    expect(d.walks).toHaveLength(1);
    expect(d.steps_count).toBe(9);
    expect(missionsOf({ missions: [{ id: "m1", title: "Sign in", status: "covered" }] })[0].status).toBe("covered");
    expect(missionsOf([{ title: "Checkout" }])[0]).toMatchObject({ id: "1", status: "active" });
    expect(missionsOf(null)).toEqual([]);
    expect(missionsOf("not a charter")).toEqual([]);
  });

  it("fills a scenario's lists so views never crash on nulls", () => {
    const s = normalizeScenario({ id: "x", name: "N", criteria: null, evidence: null, suggestions: null });
    expect(s.criteria).toEqual([]);
    expect(s.evidence).toEqual([]);
    expect(s.suggestions).toEqual([]);
    expect(s.walk).toBeNull();
  });

  it("knows when a task has no QA data", () => {
    expect(taskQaIsEmpty(normalizeTaskQa({}))).toBe(true);
    expect(taskQaIsEmpty(normalizeTaskQa({ findings: [{ id: "f" }] }))).toBe(false);
    expect(taskQaIsEmpty(null)).toBe(true);
  });

  it("names a walk from its joined flow, else the flow queue", () => {
    expect(walkName({ flow: { id: "f", key: "k", name: "Sign in" } } as never)).toBe("Sign in");
    expect(walkName({ flow_id: "f2" } as never, [{ id: "f2", name: "Checkout" } as never])).toBe("Checkout");
    expect(walkName({ flow_id: "nope" } as never, [])).toBeNull();
  });
});

describe("map", () => {
  it("orders screens seen → not reached → blocked, then by name", () => {
    const out = sortScreens([node({ key: "b", state: "blocked" }), node({ key: "z", state: "seen" }), node({ key: "a", state: "seen" }), node({ key: "m", state: "declared" })]);
    expect(out.map((n) => n.key)).toEqual(["a", "z", "m", "b"]);
  });

  it("groups screens under their feature and puts the rest under Other screens", () => {
    const groups = groupByFeature(
      [{ id: "f1", key: "auth", name: "Sign in" } as never],
      [node({ key: "login", feature_key: "auth" }), node({ key: "orphan", feature_key: "gone" }), node({ key: "home" })],
    );
    expect(groups.map((g) => g.feature?.name ?? "Other")).toEqual(["Sign in", "Other"]);
    expect(groups[1].screens.map((n) => n.key)).toEqual(["home", "orphan"]);
  });

  it("writes the blocked reason without repeating the kind", () => {
    expect(blockedLine({ blocked_kind: "needs_sign_in", blocked_reason: "the profile tab asks for an account" })).toBe("Needs sign-in: the profile tab asks for an account");
    expect(blockedLine({ blocked_kind: "needs_sign_in", blocked_reason: "Needs sign-in to open" })).toBe("Needs sign-in to open");
    expect(blockedLine({ blocked_kind: "paywall", blocked_reason: null })).toBe("Behind a paywall");
  });
});

describe("scenarios", () => {
  it("offers the right decisions per status; pause and retire need a reason", () => {
    expect(statusActions("draft").map((a) => a.label)).toEqual(["Validate", "Retire"]);
    expect(statusActions("validated").map((a) => [a.label, a.reason])).toEqual([["Pause", true], ["Retire", true]]);
    expect(statusActions("paused")[0]).toMatchObject({ label: "Resume", to: "validated", reason: false });
    expect(statusActions("retired")).toEqual([expect.objectContaining({ label: "Restore as draft", to: "draft" })]);
  });

  it("diffs proposed criteria: new ones tagged, removed ones listed after", () => {
    expect(diffCriteria(["A", "B", "C"], ["A", "C", "D"])).toEqual([
      { text: "A", mark: "kept" }, { text: "C", mark: "kept" }, { text: "D", mark: "new" }, { text: "B", mark: "removed" },
    ]);
  });

  it("summarises evidence like the drafting board", () => {
    const ev = (i: number, status: string) => ({ id: `${i}${status}`, criterion_index: i, status, frame_id: null, code_ref: null, note: null }) as never;
    expect(evidenceSummary(["a", "b", "c"], [ev(0, "verified"), ev(1, "unconfirmed")])).toBe("1 of 3 verified on screen");
    expect(evidenceSummary(["a"], [ev(0, "code_only")])).toBe("code only");
    expect(evidenceSummary(["a"], [])).toBeNull();
  });
});

describe("sessions + task QA", () => {
  it("titles a session by its goal, else kind and platform", () => {
    expect(sessionTitle({ goal: "  Check sign-up ", kind: "explore", platform: "ios" })).toBe("Check sign-up");
    expect(sessionTitle({ goal: null, kind: "map", platform: "android" })).toBe("Mapping on Android");
  });

  it("says what a session produced", () => {
    const d = normalizeSessionDetail({ id: "s", walks: [{ status: "passed" }, { status: "failed" }, { status: "passed" }], findings: [{ status: "open" }, { status: "dismissed" }], drafts: [{ id: "x" }] });
    expect(producedLine(d)).toBe("1 finding · 3 flows walked: 2 passed, 1 failed · 1 draft scenario");
  });

  it("tallies verdicts per scenario", () => {
    const v = (sid: string, verdict: string, name?: string) => ({ id: Math.random().toString(), session_id: "s", scenario_id: sid, scenario_name: name, criterion_index: 0, verdict, note: null, frame_ids: [], created_at: "" }) as never;
    expect(verdictTally([v("a", "pass", "Login"), v("a", "pass"), v("a", "fail"), v("b", "blocked")])).toEqual([
      { scenario_id: "a", name: "Login", tally: "2 pass · 1 fail", failed: true },
      { scenario_id: "b", name: "Scenario", tally: "1 blocked", failed: false },
    ]);
  });
});

describe("authority (human-only QA decisions)", () => {
  const human = { id: "h1", alias: "kedar", kind: "human" } as never;
  it("lets the acting human decide", () => {
    expect(qaAuthority({ human, readOnly: false, pending: false, reason: null })).toMatchObject({ can: true });
  });
  it("refuses viewers, agents, nobody and an unresolved identity — with the reason", () => {
    expect(qaAuthority({ human: null, readOnly: true, pending: false, reason: "Your role is viewer (read-only)" })).toEqual({ can: false, human: null, reason: "Your role is viewer (read-only)" });
    expect(qaAuthority({ human: { id: "a", alias: "forge", kind: "ai" } as never, readOnly: false, pending: false, reason: null }).reason).toBe(QA_NO_HUMAN_REASON);
    expect(qaAuthority({ human: null, readOnly: false, pending: false, reason: null }).can).toBe(false);
    expect(qaAuthority({ human: null, readOnly: false, pending: true, reason: null }).reason).toMatch(/Checking/);
  });
});

describe("web", () => {
  it("is a third platform", () => {
    expect(parsePlatform("web")).toBe("web");
    expect(parsePlatform("nope")).toBe("ios");
    expect(platformWord("web")).toBe("Web");
    expect(normalizeOverview({ platforms: { web: { screens: { seen: 2 } } } }).web.screens.seen).toBe(2);
  });

  it("names viewports and labels routes", () => {
    expect(viewportWord("mobile")).toBe("Mobile (390×844)");
    expect(viewportWord(null)).toBe("Desktop (1280×800)");
    expect(screenLabel({ key: "/", label: null })).toBe("Home");
    expect(screenLabel({ key: "/settings/billing-plans", label: null })).toBe("Billing plans");
    expect(screenLabel({ key: "/orders/:id", label: null })).toBe("Orders");
  });

  it("reads a screen's route from its key (web) or any source's detail", () => {
    expect(screenRoute(node({ platform: "web", key: "/checkout" }))).toBe("/checkout");
    expect(screenRoute(node({ platform: "web", key: "checkout", detail: { code: { route: "/cart/checkout" } } }))).toBe("/cart/checkout");
    expect(screenRoute(node({ platform: "web", key: "cart", detail: { live: { routes: ["/cart"] } } }))).toBe("/cart");
    expect(screenRoute(node({ platform: "ios", key: "CartView" }))).toBeNull();
  });

  it("groups web screens by feature, then route", () => {
    const g = groupByFeature([{ id: "f", key: "shop", name: "Shop" } as never], [
      node({ platform: "web", key: "/shop/cart", feature_key: "shop", state: "seen" }),
      node({ platform: "web", key: "/shop", feature_key: "shop", state: "blocked" }),
      node({ platform: "web", key: "/shop/a", feature_key: "shop", state: "declared" }),
    ], true);
    expect(g[0].screens.map((n) => n.key)).toEqual(["/shop", "/shop/a", "/shop/cart"]);
  });

  it("splits page events out of a finding's detail into plain words", () => {
    const { text, events } = splitWebEvents(
      "The cart total never updates.\nevents since last screen (3):\nconsole.error: TypeError: x is undefined (app.js:12)\nrequestfailed: GET /api/cart net::ERR_FAILED\nresponse 500: POST /api/checkout",
    );
    expect(text).toBe("The cart total never updates.");
    expect(events.map(webEventWord)).toEqual(["Console error", "Request failed", "Server error (500)"]);
    expect(events[2].text).toBe("POST /api/checkout");
    expect(splitWebEvents(null, [{ kind: "pageerror", text: "boom" }, "response 404: GET /missing"]).events.map(webEventWord)).toEqual(["Page error", "Page not found (404)"]);
    // a non-text detail (an older portal sent {}) never crashes the session view
    expect(splitWebEvents({} as unknown as string)).toEqual({ text: "", events: [] });
  });

  it("reads allowed sites from a web target's notes", () => {
    expect(allowedSites("Use qa@acme.\nAllowed: https://auth.acme.com, https://pay.acme.com")).toEqual({ sites: ["https://auth.acme.com", "https://pay.acme.com"], rest: "Use qa@acme." });
  });
});

describe("map features per platform", () => {
  it("counts only the features with a screen on this platform (all while it has none)", async () => {
    const { featuresHere } = await import("./QaMap");
    const f = (key: string) => ({ id: key, key, name: key, summary: null, entry: null, paths: [], source: "code", last_explored_at: null });
    const scr = (feature_key: string | null) => ({ id: "n" + feature_key, kind: "screen", key: "/" + feature_key, feature_key } as never);
    expect(featuresHere({ features: [f("orders"), f("account")], nodes: [scr("orders")] } as never)).toBe(1);
    expect(featuresHere({ features: [f("orders"), f("account")], nodes: [] } as never)).toBe(2);
  });
});

describe("Run check task body", () => {
  it("explore: the skill instruction with platform, minutes and focus; the human creates it for the agent", () => {
    expect(qaTaskBody({ kind: "explore", platform: "ios", minutes: 20, focus: 'sign-up and "reset"', agentAlias: "forge", humanId: "h1" })).toEqual({
      title: 'Explore the iOS app: sign-up and "reset"',
      description: "Run /orcha-qa-explore for this task on ios --minutes 20 --focus \"sign-up and 'reset'\"\n\nResults land in the project's Quality tab; a person reviews them there.",
      definition_of_done: "The app is explored; findings, walked flows and draft scenarios are in Quality for review.",
      created_by_agent_id: "h1",
      assignee_alias: "forge",
    });
  });

  it("map uses --feature; draft has no time budget; check puts the focus in words", () => {
    const map = qaTaskBody({ kind: "map", platform: "web", minutes: 30, focus: "Checkout", agentAlias: "forge", humanId: "h1" });
    expect(map.title).toBe("Map the web app: Checkout");
    expect(map.description.split("\n")[0]).toBe('Run /orcha-qa-map for this task on web --minutes 30 --feature "Checkout"');
    const draft = qaTaskBody({ kind: "draft", platform: "android", minutes: 30, focus: "", agentAlias: "forge", humanId: "h1" });
    expect(draft.title).toBe("Draft QA scenarios for the Android app");
    expect(draft.description.split("\n")[0]).toBe("Run /orcha-qa-draft for this task on android");
    const picked = qaTaskBody({ kind: "check", platform: "ios", minutes: null, focus: "", agentAlias: "forge", humanId: "h1", scenarioIds: ["s1", "s2"] });
    expect(picked.description).toContain("--scenario s1 --scenario s2");
    expect(qaTaskBody({ kind: "draft", platform: "ios", minutes: null, focus: "", agentAlias: "forge", humanId: "h1", scenarioIds: ["s1"] }).description).not.toContain("--scenario");
    const check = qaTaskBody({ kind: "check", platform: "ios", minutes: null, focus: "payments", agentAlias: "forge", humanId: "h1" });
    expect(check.description).toMatch(/^Run \/orcha-qa-check for this task on ios\n\nFocus on: payments\n/);
    expect(check.definition_of_done).toMatch(/verdict per criterion/);
    // a missing budget falls back to 20 minutes
    expect(qaTaskBody({ kind: "explore", platform: "ios", minutes: null, agentAlias: null, humanId: null }).description).toMatch(/--minutes 20$/m);
  });
});

describe("what a project has set up", () => {
  const empty = () => normalizeOverview({});
  it("nothing done on a fresh project", () => {
    expect(setupSteps(empty(), [])).toEqual({ app: false, tools: false, mapped: false });
  });
  it("app set → step 1; any session → step 2; a map session or mapped screens → step 3", () => {
    const o = empty();
    expect(setupSteps(o, [{ platform: "web", app_id: "https://a.com" } as never]).app).toBe(true);
    o.ios.last_sessions = { explore: { id: "s" } as never };
    expect(setupSteps(o, [])).toEqual({ app: false, tools: true, mapped: false });
    o.android.screens.declared = 4;
    expect(setupSteps(o, []).mapped).toBe(true);
    const p = empty();
    p.web.last_sessions = { map: { id: "m" } as never };
    p.web.target = { platform: "web", app_id: "https://a.com" } as never;
    expect(setupSteps(p, [])).toEqual({ app: true, tools: true, mapped: true });
  });
});

describe("where the tab opens", () => {
  const none = { app: false, tools: false, mapped: false };
  it("a project with no QA set up opens on the onboarding, until it is done or skipped", () => {
    expect(opensOnOnboarding(none, null)).toBe(true);
    expect(opensOnOnboarding(none, { phase: "found", state: "idle" })).toBe(true);
    expect(opensOnOnboarding({ ...none, app: true }, { phase: "live", state: "waiting" })).toBe(true);
    expect(opensOnOnboarding(none, { phase: "done", state: "done" })).toBe(false);
    expect(comingBackFromFirstRun("?cid=c&step=first_run&after=first_run")).toBe(true);
    expect(comingBackFromFirstRun("?cid=c&step=first_run")).toBe(false);
    expect(opensOnOnboarding({ app: true, tools: true, mapped: true }, { phase: "found" })).toBe(false);
    // the flow's own session and screens must not close it while the person watches the live pass
    const live = { phase: "live", state: "running", phases: { code_map: { state: "done" } } };
    expect(opensOnOnboarding({ app: true, tools: true, mapped: true }, live)).toBe(true);
    expect(opensOnOnboarding({ app: true, tools: true, mapped: true }, { phase: "done", state: "done", phases: { code_map: { state: "done" } } })).toBe(false);
    expect(opensOnOnboarding({ app: true, tools: true, mapped: true }, { phase: "code_map", state: "waiting", phases: { code_map: { state: "pending" } } })).toBe(false);
  });
  it("reads a detected app off the scan: the id, or the web app's URL", () => {
    const found = { platforms: [{ kind: "ios", app_id: "com.a", stack: "Native iOS", path: "ios" }, { kind: "web" }], environments: [{ name: "Local", base_url: "http://localhost:3000" }] } as never;
    expect(detectedApp(found, "ios")).toEqual({ id: "com.a", stack: "Native iOS", path: "ios" });
    expect(detectedApp(found, "web")).toEqual({ id: "http://localhost:3000", stack: null, path: null });
    expect(detectedApp(found, "android")).toBeNull();
    expect(detectedApp(null, "ios")).toBeNull();
  });
});

describe("the Overview's counts open the map on a screen", () => {
  const node = (id: string, state: string, feature: string | null = null, label = id) =>
    ({ id, kind: "screen", key: id, label, state, feature_key: feature }) as unknown as QaNode;
  const map = { features: [{ key: "a", name: "A" }, { key: "b", name: "B" }] as unknown as QaFeature[], nodes: [node("x", "seen", "b"), node("y", "declared", "b"), node("z", "declared", "a"), node("w", "blocked")] };

  it("takes the first in that state, in the map's feature order", () => {
    expect(firstInState(map, "declared")?.id).toBe("z");
    expect(firstInState(map, "seen")?.id).toBe("x");
    expect(firstInState(map, "blocked")?.id).toBe("w");
  });

  it("finds nothing for a state with no screen", () => {
    expect(firstInState({ ...map, nodes: [] }, "seen")).toBeNull();
  });
});

describe("a pass of the map skill", () => {
  it("says which pass and which device", () => {
    const body = qaTaskBody({ kind: "map", platform: "android", minutes: 10, pass: "deeper", device: "Pixel 9a", passTitle: "Fill in Android: 3 screens not seen", agentAlias: "forge", humanId: "h1" });
    expect(body.title).toBe("Fill in Android: 3 screens not seen");
    expect(body.description.split("\n")[0]).toBe('Run /orcha-qa-map for this task on android --minutes 10 --pass deeper --device "Pixel 9a"');
  });
});

describe("the platform a page opens on", () => {
  it("is the one with an app: a web-only project never opens on an empty iOS map", () => {
    expect(defaultPlatform([{ platform: "ios", app_id: null }, { platform: "web", app_id: "http://a.test" }])).toBe("web");
    expect(defaultPlatform([{ platform: "ios", app_id: "com.a" }, { platform: "web", app_id: "http://a.test" }])).toBe("ios");
    expect(defaultPlatform([])).toBe("ios");
    expect(defaultPlatform(null)).toBe("ios");
  });
});
