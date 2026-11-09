/**
 * QA tab: three tabs, Exploration (the home, a session's charter, walks and findings → File as task),
 * Scenarios (by status; approve / pause-with-reason; suggestions) and Runs, old links, the app
 * settings, and the human-only gate.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ToastProvider } from "../../components/ui";
import { SnapshotProvider } from "../../state/SnapshotProvider";
import { installFlowEnv } from "./map/kit/testEnv";
import { QaPage } from "./QaPage";

interface Call { url: string; method: string; body: any }
let calls: Call[] = [];
let setup = { tools_on: true, can_enable: true, ai_agents: 1 };

const HUMAN = { id: "h1", alias: "kedar", kind: "human", role: "Founder", status: "idle" };
const FORGE = { id: "a1", alias: "forge", kind: "ai", role: "QA", status: "idle" };

function snap(withHuman: boolean) {
  return {
    container: { id: "c1", name: "Acme", status: "active", autonomy_level: "plan" },
    agents: withHuman ? [HUMAN, FORGE] : [FORGE],
    tasks: [{ id: "t1", title: "Explore sign-up", status: "in_progress" }],
    requests: [],
  };
}

const OVERVIEW = {
  platforms: {
    ios: { screens: { seen: 5, declared: 3, blocked: 1 }, features: 2, scenarios: { draft: 2, validated: 4, paused: 0, retired: 1 }, open_findings: 3,
      last_sessions: { explore: { id: "s1", kind: "explore", platform: "ios", status: "done", started_at: "2026-11-04T10:00:00Z", ended_at: "2026-11-04T10:20:00Z" } } },
    android: { screens: { seen: 0, declared: 0, blocked: 0 }, features: 0, scenarios: {}, open_findings: 0, last_sessions: {} },
    web: { target: { platform: "web", app_id: "https://staging.acme.com", app_name: "Acme web", device_name: "mobile" }, features: 1, screens: { seen: 2, declared: 1, blocked: 0 }, scenarios: { draft: 1 }, open_findings: 1, last_session: {} },
  },
};

const TARGETS = { targets: [{ platform: "ios", app_id: "com.acme.app", app_name: "Acme", build_path: null, device_name: "iPhone 17 Pro", notes: "Use the qa@acme test account", updated_at: "2026-11-01T00:00:00Z", updated_by_agent_id: "h1" }] };

const MAP = {
  platform: "ios",
  features: [{ id: "f1", key: "auth", name: "Sign in", summary: "Email and Apple sign-in", entry: "LoginView", paths: [], source: "code", last_explored_at: null }],
  nodes: [
    { id: "n1", platform: "ios", kind: "screen", key: "LoginView", label: "Sign in", feature_key: "auth", state: "seen", blocked_kind: null, blocked_reason: null, sources: ["code", "live"], frame_id: "fr1", last_seen_at: "2026-11-04T10:05:00Z" },
    { id: "n2", platform: "ios", kind: "screen", key: "ProfileView", label: "Profile", feature_key: "auth", state: "blocked", blocked_kind: "needs_sign_in", blocked_reason: "the test account is locked", sources: ["code"], frame_id: null, last_seen_at: null },
    { id: "n3", platform: "ios", kind: "screen", key: "SettingsView", label: null, feature_key: null, state: "declared", blocked_kind: null, blocked_reason: null, sources: ["code"], frame_id: null, last_seen_at: null },
  ],
  edges: [{ id: "e1", platform: "ios", kind: "navigates", from_node_id: "n1", to_node_id: "n2", label: "tap Profile", count: 3, sources: ["live"] }],
  last_build: { id: "b1", platform: "ios", source: "code", status: "done", error: null, started_at: "2026-11-04T09:00:00Z", ended_at: "2026-11-04T09:01:00Z" },
};

const SCENARIOS = {
  scenarios: [
    { id: "sc1", platform: "ios", name: "Sign in with email", category: "Auth", persona: "New user", description: "A new user signs in.", criteria: ["The sign-in screen shows", "Home shows the user's name"], tags: [], source: "walk", status: "draft", status_reason: null, walk_id: "w1", session_id: "s1", task_id: "t1", created_at: null, updated_at: null },
    { id: "sc2", platform: "ios", name: "Edit profile", category: "Profile", persona: null, description: null, criteria: ["Profile opens", "Name saves"], tags: [], source: "generated", status: "validated", status_reason: null, walk_id: null, session_id: null, task_id: null, created_at: null, updated_at: null },
    { id: "sc3", platform: "ios", name: "Old onboarding", category: null, persona: null, description: null, criteria: ["x"], tags: [], source: "authored", status: "retired", status_reason: "Removed", walk_id: null, session_id: null, task_id: null, created_at: null, updated_at: null },
  ],
};

const SC1_DETAIL = {
  ...SCENARIOS.scenarios[0],
  evidence: [
    { id: "ev1", scenario_id: "sc1", criterion_index: 0, status: "verified", frame_id: "fr1", code_ref: null, note: null },
    { id: "ev2", scenario_id: "sc1", criterion_index: 1, status: "code_only", frame_id: null, code_ref: "HomeView.swift:42", note: null },
  ],
  walk: { id: "w1", session_id: "s1", flow_id: "fl1", flow: { id: "fl1", key: "sign-in", name: "Sign in with email" }, status: "passed", blocked_kind: null, reason: null,
    steps: [{ index: 0, text: "Open the app", reached: true, frame_id: "fr2" }, { index: 1, text: "Tap Sign in", reached: true, frame_id: "fr3" }], scenario_id: "sc1", started_at: null, ended_at: null },
  frames: [], suggestions: [], verdicts: [],
};

const SC2_DETAIL = {
  ...SCENARIOS.scenarios[1],
  evidence: [], walk: null, frames: [], verdicts: [{ id: "v1", session_id: "s9", scenario_id: "sc2", criterion_index: 0, verdict: "fail", note: "Profile didn't open", frame_ids: [], created_at: "2026-11-04T00:00:00Z" }],
  suggestions: [{ id: "g1", scenario_id: "sc2", proposed: { criteria: ["Profile opens", "Name and photo save"] }, reason: "The photo picker is part of the flow now.", status: "proposal", agent_id: "a1", created_at: "2026-11-04T00:00:00Z" }],
};

const SESSIONS = {
  sessions: [
    { id: "s1", kind: "explore", platform: "ios", task_id: "t1", agent_id: "a1", device_name: "iPhone 17 Pro", app_id: "com.acme.app", status: "done", budget_minutes: 20, goal: "Explore sign-up", report_md: null, started_at: "2026-11-04T10:00:00Z", ended_at: "2026-11-04T10:18:00Z", last_seen_at: null },
    { id: "s2", kind: "map", platform: "ios", task_id: null, agent_id: "a1", device_name: null, app_id: null, status: "running", budget_minutes: 20, goal: null, report_md: null, started_at: "2026-11-04T11:00:00Z", ended_at: null, last_seen_at: null },
    { id: "s3", kind: "map", platform: "android", task_id: null, agent_id: "a1", device_name: null, app_id: null, status: "done", budget_minutes: 20, goal: null, report_md: null, started_at: "2026-11-03T11:00:00Z", ended_at: null, last_seen_at: null },
  ],
};

const S1_DETAIL = {
  ...SESSIONS.sessions[0],
  briefing: { app_summary: "A notes app with sign-in", risks: ["Password reset", "Apple sign-in"], nested: { deep: { x: 1 } } },
  charter: { missions: [
    { id: "m1", title: "Sign up with email", why: "The main entry", status: "covered" },
    { id: "m2", title: "Reset a password", why: "Often broken", status: "bug", note: "The reset link never arrives", finding_ids: ["fd1"] },
  ] },
  walks: [{ id: "w9", session_id: "s1", flow_id: "fl2", status: "failed", blocked_kind: null, reason: null,
    steps: [{ index: 0, text: "Open reset", reached: true, frame_id: "fr4" }, { index: 1, text: "Get the email", reached: false, frame_id: "fr5" }], scenario_id: null, started_at: null, ended_at: null }],
  findings: [{ id: "fd1", session_id: "s1", task_id: "t1", severity: "major", title: "Reset email never arrives", detail: null, expected: "An email within a minute", actual: "Nothing after 5 minutes", frame_ids: ["fr5"], screen_key: "ResetView", status: "open", filed_task_id: null, created_at: "2026-11-04T10:10:00Z" }],
  steps_count: 42, drafts: [{ id: "sc1", name: "Sign in with email", status: "draft" }], verdicts: [],
};

const WEB_MAP = {
  platform: "web",
  features: [{ id: "f2", key: "shop", name: "Shop", summary: null, entry: null, paths: [], source: "code", last_explored_at: null }],
  nodes: [
    { id: "w1", platform: "web", kind: "screen", key: "/shop/cart", label: "Cart", feature_key: "shop", state: "seen", blocked_kind: null, blocked_reason: null, sources: ["code", "live"], frame_id: "wf1", last_seen_at: null, detail: {} },
    { id: "w2", platform: "web", kind: "screen", key: "/shop", label: "Shop", feature_key: "shop", state: "declared", blocked_kind: null, blocked_reason: null, sources: ["code"], frame_id: null, last_seen_at: null, detail: {} },
  ],
  edges: [], last_build: null,
};

const WEB_SESSION = {
  id: "s7", kind: "explore", platform: "web", task_id: null, agent_id: "a1", agent_alias: "forge", device_name: "desktop", app_id: "https://staging.acme.com", status: "done",
  budget_minutes: 20, goal: "Explore checkout", report_md: null, started_at: "2026-11-05T10:00:00Z", ended_at: "2026-11-05T10:10:00Z", last_seen_at: null,
  briefing: null, charter: null, walks: [], drafts: [], verdicts: [], steps_count: 3,
  findings: [{ id: "fd7", session_id: "s7", task_id: null, severity: "blocker", title: "Checkout fails", screen_key: "/shop/cart", status: "open", filed_task_id: null, frame_ids: ["wf1"], created_at: "2026-11-05T10:05:00Z",
    expected: "The order is placed", actual: "A blank page", detail: "Pressing Pay shows nothing.\nevents since last screen (2):\npageerror: Cannot read properties of null\nresponse 502: POST /api/orders" }],
};

const FLOWS = { flows: [{ id: "fl2", platform: "ios", key: "reset", name: "Reset a password", persona: null, criticality: "high", status: "failed" }] };

function jsonRes(data: unknown, status = 200) {
  return { ok: status < 300, status, json: async () => data } as Response;
}

function stubFetch(opts: { withHuman?: boolean; fresh?: boolean; detected?: boolean } = {}) {
  calls = [];
  global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const method = (init?.method || "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const path = url.split("?")[0];
    if (url === "/api/containers") return jsonRes([{ id: "c1", status: "active" }]);
    if (path === "/api/containers/c1/qa/overview") return jsonRes(opts.fresh ? { features: 0, platforms: {} } : OVERVIEW);
    if (path === "/api/containers/c1/qa/setup") return jsonRes(setup);
    if (path === "/api/containers/c1/qa/targets") return jsonRes(opts.fresh ? { targets: [] } : TARGETS);
    if (path === "/api/containers/c1/tasks" && method === "POST") return jsonRes({ task_id: "t9" }, 201);
    if (path === "/api/containers/c1/qa/onboarding" && method === "POST") return jsonRes({ project_id: "c1", phase: "found", state: "running", phases: {} }, 202);
    if (path === "/api/containers/c1/qa/onboarding") return jsonRes({ project_id: "c1", phase: "found", state: "idle", phases: {}, found: opts.detected ? { repo: { name: "acme" }, platforms: [{ kind: "android", app_id: "com.acme.droid", stack: "Kotlin" }], environments: [], tests: [], defaults: {} } : {}, screens: [] });
    if (path.startsWith("/api/containers/c1/qa/targets/") && method === "PUT") return jsonRes({ platform: "android", ...body });
    if (path === "/api/containers/c1/qa/map") return jsonRes(url.includes("platform=android") ? { features: [], nodes: [], edges: [], last_build: null } : url.includes("platform=web") ? WEB_MAP : MAP);
    if (path === "/api/containers/c1/qa/sessions" && url.includes("platform=web")) return jsonRes({ sessions: [WEB_SESSION] });
    if (path === "/api/qa/sessions/s7") return jsonRes(WEB_SESSION);
    if (path === "/api/containers/c1/qa/scenarios") return jsonRes(SCENARIOS);
    if (path === "/api/containers/c1/qa/scenarios/status") return jsonRes({ scenarios: [] });
    if (path === "/api/containers/c1/qa/suggestions") return jsonRes({ suggestions: [SC2_DETAIL.suggestions[0]] });
    if (path === "/api/containers/c1/qa/sessions") return jsonRes(SESSIONS);
    if (path === "/api/containers/c1/qa/flows") return jsonRes(FLOWS);
    if (path === "/api/qa/scenarios/sc1") return jsonRes(SC1_DETAIL);
    if (path === "/api/qa/scenarios/sc2") return jsonRes(SC2_DETAIL);
    if (path === "/api/qa/suggestions/g1") return jsonRes({ suggestion: {}, scenario: SC2_DETAIL });
    if (path === "/api/qa/sessions/s1") return jsonRes(S1_DETAIL);
    if (path === "/api/qa/findings/fd1" && method === "PATCH") return jsonRes({ ...S1_DETAIL.findings[0], status: "filed", filed_task_id: "t2" });
    if (url.startsWith("/api/containers/c1")) return jsonRes(snap(opts.withHuman ?? true));
    return jsonRes({});
  }) as unknown as typeof fetch;
}

function mount(path = "/qa") {
  return render(
    <ToastProvider>
      <SnapshotProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/qa" element={<QaPage />} />
            <Route path="*" element={<div>elsewhere</div>} />
          </Routes>
        </MemoryRouter>
      </SnapshotProvider>
    </ToastProvider>,
  );
}

const writes = () => calls.filter((c) => c.method !== "GET");

beforeEach(() => { setup = { tools_on: true, can_enable: true, ai_agents: 1 }; stubFetch(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Quality tab", () => {
  it("three tabs: Exploration opens first, and says what waits for a person", async () => {
    mount();
    expect(await screen.findByRole("heading", { name: "Explorations" })).toBeInTheDocument();
    // one row of real tabs, in plain words (no native select)
    const views = screen.getByRole("tablist", { name: "Quality views" });
    expect(within(views).getAllByRole("tab").map((r) => r.querySelector(".v2-tab-label")!.textContent)).toEqual(["Exploration", "Scenarios", "Runs"]);
    expect(within(views).getAllByRole("tab").every((r) => r.querySelector("svg"))).toBe(true);
    expect(document.querySelector("select")).toBeNull();
    // what waits for a person, said in words to a screen reader, and both levels drive one panel
    const scenarios = await within(views).findByRole("tab", { name: /Scenarios.*3 drafts to review/ });
    expect(scenarios).toHaveAttribute("title", "3 drafts to review: 2 on iOS, 1 on Web");
    expect(scenarios).toHaveAttribute("aria-controls", "qa-panel");
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "qa-view-tab-exploration");
    expect(document.querySelector("[data-qa-subnav]")).toBeNull();
  });

  it("old links land on one of the three tabs, keeping the platform", async () => {
    const tabOf = () => within(screen.getByRole("tablist", { name: "Quality views" })).getByRole("tab", { selected: true });
    for (const path of ["/qa?view=overview", "/qa?view=map", "/qa?view=map&sub=atlas&platform=ios", "/qa?view=map&sub=slowest&screen=n2"]) {
      mount(path);
      expect(await screen.findByRole("heading", { name: "Explorations" })).toBeInTheDocument();
      expect(tabOf()).toHaveAttribute("id", "qa-view-tab-exploration");
      cleanup();
    }
    mount("/qa?view=triage&finding=fd1");
    expect(await screen.findByRole("list", { name: "Explorations" })).toBeInTheDocument();
    expect(tabOf()).toHaveAttribute("id", "qa-view-tab-sessions");
    cleanup();
    installFlowEnv();
    for (const path of ["/qa?view=scenarios&sub=health", "/qa?view=scenarios&sub=coverage"]) {
      mount(path);
      await waitFor(() => expect(document.querySelector("[data-scenarios-view]")).not.toBeNull());
      expect(tabOf()).toHaveAttribute("id", "qa-view-tab-scenarios");
      expect(document.querySelector("[data-qa-subnav]")).toBeNull();
      cleanup();
    }
  });

  it("the Runs tab lists every run, with no Exploration home above it", async () => {
    mount("/qa?view=sessions");
    const list = await screen.findByRole("list", { name: "Explorations" });
    expect(list.querySelectorAll("[data-exploration-name]")).toHaveLength(2);
    expect(screen.queryByRole("heading", { name: "Explorations" })).toBeNull();
    expect(document.querySelector("[data-runs-home]")).not.toBeNull();
  });

  it("the app and Quality settings open from the tab row", async () => {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "App and Quality settings" }));
    const dlg = await screen.findByRole("dialog", { name: "App and Quality settings" });
    expect(await within(dlg).findByRole("region", { name: "iOS app" })).toBeInTheDocument();
  });

  it("second level: one control under Runs, moved by the arrow keys, there while a view loads", async () => {
    installFlowEnv();
    mount("/qa?view=sessions");
    const runs = screen.getByRole("tablist", { name: "Run views" });
    expect(within(runs).getAllByRole("tab").map((r) => r.textContent)).toEqual(["All runs", "Requests"]);
    within(runs).getByRole("tab", { name: "All runs" }).focus();
    fireEvent.keyDown(runs, { key: "ArrowRight" });
    await waitFor(() => expect(within(screen.getByRole("tablist", { name: "Run views" })).getByRole("tab", { name: "Requests" })).toHaveAttribute("aria-selected", "true"));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Requests" })));
    expect(within(screen.getByRole("tablist", { name: "Quality views" })).getByRole("tab", { name: /^Runs/ })).toHaveAttribute("aria-selected", "true");
    // a view's filter sits beside the tabs, and is not one of them
    const pills = await screen.findByRole("radiogroup", { name: "Show requests" });
    expect(pills.closest("[data-qa-subnav]")).not.toBeNull();
    fireEvent.click(within(screen.getByRole("tablist", { name: "Quality views" })).getByRole("tab", { name: /^Scenarios/ }));
    await waitFor(() => expect(screen.queryByRole("tablist", { name: "Run views" })).toBeNull());
    expect(document.querySelector("[data-qa-subnav]")).toBeNull();
  });

  it("scenarios: the list by category (retired hidden), criteria evidence + walk filmstrip, Validate", async () => {
    mount("/qa?view=scenarios&sub=list");
    const rows = await screen.findByRole("listbox", { name: "Scenarios" });
    expect(within(rows).getByRole("group", { name: "Auth" })).toBeInTheDocument();
    expect(within(rows).getByRole("group", { name: "Profile" })).toBeInTheDocument();
    expect(screen.queryByText("Old onboarding")).toBeNull();
    expect(screen.getByText(/1 suggested change to validated scenarios is waiting/)).toBeInTheDocument();

    fireEvent.click(within(rows).getByText("Sign in with email"));
    const panel = await screen.findByRole("complementary", { name: "Scenario" });
    await within(panel).findByText("1 of 2 verified on screen");
    expect(within(panel).getByText("verified on screen")).toBeInTheDocument();
    expect(within(panel).getByText("HomeView.swift:42")).toBeInTheDocument();
    const strip = within(panel).getByRole("list", { name: "Walk screenshots" });
    expect(within(strip).getAllByRole("img").map((i) => i.getAttribute("src"))).toEqual(["/api/qa/frames/fr2", "/api/qa/frames/fr3"]);
    expect(within(panel).getByText("2 of 2 steps reached")).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("button", { name: "Validate" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ url: "/api/containers/c1/qa/scenarios/status", method: "POST", body: { ids: ["sc1"], status: "validated", actor_agent_id: "h1" } });
  });

  it("scenarios: the map draws a card per scenario; a person edits and saves only what changed", async () => {
    globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
    globalThis.DOMMatrixReadOnly ??= class { m22 = 1; } as unknown as typeof DOMMatrixReadOnly;
    mount("/qa?view=scenarios&scenario=sc1");
    const panel = await screen.findByRole("complementary", { name: "Scenario" });
    await waitFor(() => expect(document.querySelector('[data-scenario-node][data-scenario-id="sc2"]')).toBeTruthy());
    expect(document.querySelector('[data-scenario-id="sc3"]')).toBeNull();

    fireEvent.change(within(panel).getByRole("textbox", { name: "Name" }), { target: { value: "Sign in with a code" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ url: "/api/qa/scenarios/sc1", method: "PATCH" });
    expect(writes()[0].body).toEqual({ name: "Sign in with a code", actor_agent_id: "h1" });
  });

  it("scenarios: pausing needs a reason; the last check per criterion shows; a suggestion is accepted", async () => {
    mount("/qa?view=scenarios&sub=list&scenario=sc2");
    const panel = await screen.findByRole("complementary", { name: "Scenario" });
    await within(panel).findByText(/Last check: Fail/);
    const sugg = within(panel).getByRole("region", { name: "Suggested change" });
    expect(within(sugg).getByText("New")).toBeInTheDocument();
    expect(within(sugg).getByText("Name and photo save")).toBeInTheDocument();
    expect(within(sugg).getByText("Removed")).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole("combobox", { name: "Status" }));
    fireEvent.click(await screen.findByRole("option", { name: /Paused/ }));
    const form = await within(panel).findByRole("form", { name: "Paused: details" });
    fireEvent.click(within(form).getByRole("button", { name: "Pause" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("Say why, so whoever sees it skipped knows.");
    expect(writes()).toHaveLength(0);
    fireEvent.change(within(form).getByRole("textbox", { name: "Reason" }), { target: { value: "Known bug in the photo picker" } });
    fireEvent.click(within(form).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0].body).toMatchObject({ ids: ["sc2"], status: "paused", reason: "Known bug in the photo picker", actor_agent_id: "h1" });

    fireEvent.click(within(sugg).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(writes()).toHaveLength(2));
    expect(writes()[1]).toMatchObject({ url: "/api/qa/suggestions/g1", body: { decision: "accept", actor_agent_id: "h1" } });
  });

  it("exploration: the home per platform; a session opens in full with its report, walks and findings → File as task", async () => {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
    mount();
    const list = await screen.findByRole("list", { name: "Explorations" });
    // android's session is not on the iOS list; newest first
    expect([...list.querySelectorAll("[data-exploration-name]")].map((a) => a.textContent)).toEqual([expect.stringMatching(/^Map the app · /), expect.stringMatching(/^Exploration · /)]);
    expect(screen.getByRole("heading", { name: "Explorations" })).toBeInTheDocument();
    fireEvent.click(within(list).getByText(/^Exploration · /));
    const page = await waitFor(() => { const el = document.querySelector<HTMLElement>("[data-exploration-detail]"); expect(el).not.toBeNull(); return el!; });
    await within(page).findByText("1 bug, 1 serious · 1 of 1 flow walked: 1 failed · 1 of 2 missions covered, 1 found a bug");
    expect(page.querySelector("[data-detail-goal]")).toHaveTextContent("Asked: Explore sign-up");
    // the briefing: readable fields only, nested objects are never dumped as JSON
    expect(within(page).getByText("A notes app with sign-in")).toBeInTheDocument();
    expect(within(page).getByText("Apple sign-in")).toBeInTheDocument();
    expect(page.textContent).not.toMatch(/[{}]/);
    const charter = page.querySelector<HTMLElement>("[data-report-section='charter']")!;
    expect(within(charter).getByText("Reset a password")).toBeInTheDocument();
    expect(within(charter).getByText("The reset link never arrives")).toBeInTheDocument();
    expect(within(charter).getAllByText(/Bug found/).length).toBeGreaterThan(0);
    // the walk's name comes from the flow queue
    const walk = await waitFor(() => { const el = page.querySelector<HTMLElement>("[data-walk-outcome='failed']"); expect(el?.textContent).toMatch(/Reset a password/); return el!; });
    expect(walk.textContent).toMatch(/Failed at step 2 of 2: Get the email/);
    const finding = page.querySelector<HTMLElement>("[data-report-finding='fd1']")!;
    expect(within(finding).getByText("Reset email never arrives")).toBeInTheDocument();
    expect(within(finding).getByText("Major", { exact: false })).toBeInTheDocument();
    expect(within(finding).getByText("Nothing after 5 minutes")).toBeInTheDocument();

    fireEvent.click(within(finding).getByRole("button", { name: "File as task" }));
    const dlg = await screen.findByRole("dialog", { name: "File as task" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Create task" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ url: "/api/qa/findings/fd1", method: "PATCH", body: { action: "file", title: "Reset email never arrives", assignee_agent_id: null, actor_agent_id: "h1" } });
  });

  it("apps: an old Apps link opens the settings; edit and save a platform's app", async () => {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
    mount("/qa?view=targets");
    const android = await screen.findByRole("region", { name: "Android app" });
    fireEvent.click(within(android).getByRole("button", { name: "Edit" }));
    fireEvent.click(within(android).getByRole("button", { name: "Save" }));
    expect(await within(android).findByRole("alert")).toHaveTextContent(/Add the package/);
    fireEvent.change(within(android).getByPlaceholderText("com.example.app"), { target: { value: "com.acme.android" } });
    fireEvent.click(within(android).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ url: "/api/containers/c1/qa/targets/android", method: "PUT", body: { app_id: "com.acme.android", app_name: null, actor_agent_id: "h1" } });
    const ios = screen.getByRole("region", { name: "iOS app" });
    expect(within(ios).getByText("Use the qa@acme test account")).toBeInTheDocument();
  });

  it("web: page events on findings, the start URL app", async () => {
    mount("/qa?view=sessions&platform=web&session=s7");
    const sess = await waitFor(() => { const el = document.querySelector<HTMLElement>("[data-exploration-detail]"); expect(el).not.toBeNull(); return el!; });
    await within(sess).findByText("Desktop (1280×800)");
    const events = within(sess).getByRole("list", { name: "Page events" });
    expect(within(events).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["Page errorCannot read properties of null", "Server error (502)POST /api/orders"]);
    expect(sess.textContent).not.toMatch(/events since last screen/);
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
    fireEvent.click(within(sess).getByRole("button", { name: "Checkout fails" }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText("Pressing Pay shows nothing.")).toBeInTheDocument();
    cleanup();

    mount("/qa?view=targets");
    const web = await screen.findByRole("region", { name: "Web app" });
    fireEvent.click(within(web).getByRole("button", { name: "Edit" }));
    expect(within(web).getByText("Sign-in notes and allowed sites")).toBeInTheDocument();
    expect(within(web).queryByText("Build to install")).toBeNull();
    fireEvent.change(within(web).getByPlaceholderText("https://staging.example.com"), { target: { value: "staging.acme.com" } });
    fireEvent.click(within(web).getByRole("button", { name: "Save" }));
    expect(await within(web).findByRole("alert")).toHaveTextContent(/http/);
    fireEvent.change(within(web).getByPlaceholderText("https://staging.example.com"), { target: { value: "https://staging.acme.com" } });
    fireEvent.click(within(within(web).getByRole("radiogroup", { name: "Browser viewport" })).getByRole("radio", { name: /Mobile/ }));
    fireEvent.click(within(web).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]).toMatchObject({ url: "/api/containers/c1/qa/targets/web", method: "PUT", body: { app_id: "https://staging.acme.com", device_name: "mobile", build_path: null } });
  });

  it("a project with no QA set up opens on the onboarding; one that is set up opens on Exploration", async () => {
    mount();
    await screen.findByRole("heading", { name: "Explorations" });
    expect(document.querySelector("[data-onboarding]")).toBeNull();
    cleanup();

    stubFetch({ fresh: true });
    mount();
    await screen.findByRole("navigation", { name: "Onboarding steps" });
    expect(screen.queryByRole("heading", { name: "Explorations" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Connect your app" })).toBeInTheDocument();
    await waitFor(() => expect(writes().some((c) => c.url === "/api/containers/c1/qa/onboarding" && c.body.action === "start")).toBe(true));
  });

  it("apps: shows what the scan detected, the form behind Edit, and Run onboarding again", async () => {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
    stubFetch({ detected: true });
    mount("/qa?view=targets");
    const android = await screen.findByRole("region", { name: "Android app" });
    const found = await within(android).findByText("com.acme.droid");
    expect(found).toBeInTheDocument();
    expect(within(android).queryByRole("textbox")).toBeNull();
    fireEvent.click(within(android).getByRole("button", { name: "Use this app" }));
    await waitFor(() => expect(writes()[0]).toMatchObject({ url: "/api/containers/c1/qa/targets/android", method: "PUT", body: { app_id: "com.acme.droid", actor_agent_id: "h1" } }));
    fireEvent.click(screen.getByRole("button", { name: "Run onboarding again" }));
    await waitFor(() => expect(writes().some((c) => c.body.action === "restart")).toBe(true));
    await screen.findByRole("navigation", { name: "Onboarding steps" });
  });

  it("Run check: a page, not a dialog: pick what to run, then Start, and land on the live run", async () => {
    mount("/qa?view=sessions");
    await screen.findByRole("list", { name: "Explorations" });
    fireEvent.click(screen.getByRole("button", { name: "Run check" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /^Explore/ }));
    const start = await screen.findByRole("button", { name: "Start" });
    // one platform set: plain text, no one-item picker; the QA agent is already chosen
    await waitFor(() => expect(document.querySelector("[data-run-platform]")?.textContent).toBe("iOS"));
    expect(screen.queryByRole("radiogroup", { name: "Platform" })).toBeNull();
    expect(document.querySelector("[data-run-agent]")?.textContent).toBe("forge");
    // what Start will run is shown before it runs
    expect(document.querySelector("[data-run-preview]")?.textContent).toContain("Explore the iOS app");
    fireEvent.click(screen.getByRole("tab", { name: /Options/ }));
    fireEvent.change(screen.getByLabelText("Minutes"), { target: { value: "3" } });
    expect(screen.getByRole("alert")).toHaveTextContent("between 5 and 240 minutes");
    expect(start).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Minutes"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("Focus"), { target: { value: "password reset" } });
    fireEvent.click(start);
    await waitFor(() => expect(writes().length).toBeGreaterThan(0));
    expect(writes()[0]).toMatchObject({
      url: "/api/containers/c1/tasks", method: "POST",
      body: {
        title: "Explore the iOS app: password reset",
        description: expect.stringMatching(/^Run \/orcha-qa-explore for this task on ios --minutes 30 --focus "password reset"/),
        definition_of_done: "The app is explored; findings, walked flows and draft scenarios are in Quality for review.",
        created_by_agent_id: "h1",
        assignee_alias: "forge",
      },
    });
  });

  it("Run check: no agent is one clear state, never a form with a disabled button", async () => {
    setup = { tools_on: true, can_enable: true, ai_agents: 0 };
    mount("/qa?view=run&kind=explore");
    expect(await screen.findByRole("heading", { name: "This project has no agent to run checks" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add a QA agent" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
  });

  it("without an acting human the human-only decisions are disabled with the reason", async () => {
    stubFetch({ withHuman: false });
    mount("/qa?view=scenarios&sub=list&scenario=sc1");
    const panel = await screen.findByRole("complementary", { name: "Scenario" });
    await within(panel).findByText("1 of 2 verified on screen");
    expect(within(panel).getByRole("button", { name: "Validate" })).toBeDisabled();
    expect(within(panel).getByRole("combobox", { name: "Status" })).toBeDisabled();
    expect(within(panel).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(within(panel).getByRole("textbox", { name: "Name" })).toBeDisabled();
    expect(within(panel).getByText(/acting human/i)).toBeInTheDocument();
    // starting QA work is human-only too
    expect(screen.getByRole("button", { name: "Run check" })).toBeDisabled();
    expect(writes()).toHaveLength(0);
  });
});
