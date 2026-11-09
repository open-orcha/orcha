import type { RunDevice } from "./types";
import { apiPriceLabel, notChargedTitle, subscriptionPhrase } from "./ui";

/**
 * "Let us map your app": the snapshot `GET /api/projects/[id]/onboarding/map` returns, as the
 * shared contract describes it (core and UI agents, 2026-10-26, with its `first_test` change).
 * `parseOnboardingMap` reads an unknown JSON body defensively: a field of the wrong type falls
 * back to its empty value instead of throwing, so a backend a version ahead or behind never
 * blanks the onboarding.
 */

export const MAP_PHASES = ["found", "code_map", "tests", "live", "coverage", "bring_in", "first_run", "done"] as const;
export type MapPhase = (typeof MAP_PHASES)[number];

export const PHASE_STATES = ["pending", "running", "done", "skipped", "failed"] as const;
export type PhaseState = (typeof PHASE_STATES)[number];

export interface PhaseInfo {
  state: PhaseState;
  started_at?: string;
  ended_at?: string;
  note?: string;
  cost_usd?: number;
  estimate_usd?: number;
  /** What it counted: a bring-in's `imported`. */
  counts?: Record<string, number>;
  /** Why it cannot go on, and the open request that says so (live, bring in, first run). */
  blocked_reason?: string;
  request_id?: string;
  /** The phase's task: a stuck one is given to the agent a person adds or picks. */
  task_id?: string;
}

/** The build the live pass opens: Embodent does not compile it. */
export interface LiveBuildInfo {
  source: "installed" | "url";
  platform: string;
  app_id: string;
  device?: string;
  version?: string;
  build?: string;
  installed_at?: string;
}

export const FRAMEWORKS = ["xcuitest", "espresso", "maestro", "detox", "playwright", "cypress", "gherkin"] as const;
export type Framework = (typeof FRAMEWORKS)[number];

export type PlatformKind = "ios" | "android" | "web";

export interface FoundSheet {
  repo: { path?: string; url?: string; name: string };
  platforms: { kind: PlatformKind; app_id?: string; stack?: string; path?: string; candidates?: string[] }[];
  environments: { name: string; base_url?: string }[];
  tests: { framework: Framework; count: number; path: string }[];
  ci?: { provider: string; path: string }[];
  defaults: { device?: string; test_data?: string };
  /** The sign-in the code shows. */
  auth?: { summary: string; methods: string[]; sure: boolean };
  /** The sandboxed services the repository shows, per platform. */
  sandboxes?: Partial<Record<PlatformKind, Record<string, SandboxFound>>>;
  /** Phones whose newest run never read the app's screen, each with why: the live pass maps on
   * a platform it can read unless the person picks this one. */
  unreadable?: Partial<Record<PlatformKind, string>>;
  /** The platform the live pass maps on when it is not the first one listed, and why. */
  live_platform?: { kind: PlatformKind; why: string };
  /** The backend each platform's app talks to, per build, read from the repository (#453). */
  backends?: FoundBackend[];
  /** Platforms whose backend cannot be told from the repository, each with why. */
  backend_unknown?: Partial<Record<PlatformKind, string>>;
}

/** A sandboxed service: `ready` true, or null when a person has to say. */
export interface SandboxFound {
  ready: boolean | null;
  evidence: string;
}

/** Which builds talk to a backend: a build from this checkout (Embodent's "Build from the
 * repository", a dev server), a release build (an APK or IPA someone adds), or every build. */
export type BackendBuild = "checkout" | "release" | "any";

export interface FoundBackend {
  platforms: PlatformKind[];
  /** "Supabase", "Firebase", "API", ... */
  service: string;
  /** `scheme://host[:port][/path]`: never a user, password or query. */
  url: string;
  /** The file it was read from, relative to the repository. */
  source: string;
  /** The variable or constant that holds it. */
  variable: string;
  build: BackendBuild;
  /** A hosted URL with no staging, dev, test or preview marker: runs there are read-only. */
  production: boolean;
}

export type Coverage = "your_tests" | "qa" | "both" | "none";

export interface ScreenTest {
  framework: string;
  name: string;
  path: string;
  line?: number;
  /** Why this test covers this screen. */
  evidence: string;
}

export type FirstRunVerdict = "pass" | "fail" | "error" | "running" | "queued";

/** What happened to an ended first run (#486): it passed, the test found something, the run
 * could not check the test as written, the starting state Embodent made first did not get there,
 * or the run itself broke. */
export const FIRST_RUN_OUTCOMES = ["passed", "failed", "unchecked", "setup_failed", "error"] as const;
export type FirstRunOutcome = (typeof FIRST_RUN_OUTCOMES)[number];

/** The starting state's setup run that failed before the test. */
export interface FirstRunSetup {
  request_id: string;
  run_id: string;
  finding?: string;
  /** Why the setup's failure was not the app's (a finding that does not hold, #486): the next run makes it again. */
  not_app?: string;
  reason?: string;
  screen_id?: string;
  screen?: string;
}

export interface ScreenFirstRun {
  scenario_id: string;
  run_id: string;
  verdict: FirstRunVerdict;
  duration_s?: number;
  finding?: string;
  /** Absent while it runs, and on a run that ended before #486. */
  outcome?: FirstRunOutcome;
  /** Why the test could not be checked, or the run's error. */
  reason?: string;
  /** The screen the failure was on (never the picked test's riskiest screen). */
  screen_id?: string;
  screen?: string;
  setup?: FirstRunSetup;
}

export interface MapScreen {
  id: string;
  name: string;
  route?: string;
  platform?: string;
  /** Dashed while code-only, solid once seen live. */
  source: "code" | "live" | "both";
  /** A live screenshot URL, once seen. */
  thumbnail?: string;
  files: string[];
  endpoints: string[];
  coverage: Coverage;
  tests: ScreenTest[];
  /** `origin` (when the backend says): what made it, an imported test, a draft for a gap or a
   * run's trace. Imported tests come in as drafts too, so `status` alone cannot tell. */
  scenarios: { id: string; name: string; status: string; origin?: "imported" | "drafted" | "traced"; unfit?: string }[];
  risk: { score: number; reasons: string[] };
  first_run?: ScreenFirstRun;
}

export type EdgeKind = "nav" | "calls" | "reads" | "writes";

export interface FirstTest {
  scenario_id: string;
  name: string;
  screen_id?: string;
  platform?: string;
  estimate_seconds: number;
  estimate_usd: number;
  why: string;
}

export interface OnboardingMap {
  project_id: string;
  phase: MapPhase;
  phases: Record<MapPhase, PhaseInfo>;
  found: FoundSheet;
  files: { path: string; screen_ids: string[] }[];
  screens: MapScreen[];
  edges: { from: string; to: string; kind: EdgeKind }[];
  gaps: { screen_id: string; flow?: string; risk: number; reason: string }[];
  summary: { screens: number; covered_by_tests: number; covered_by_qa: number; uncovered: number; untested_critical: string[] };
  bring_in: { migrate: { framework: string; count: number }[]; draft: { gap_screen_ids: string[]; estimate_usd: number } };
  first_test: FirstTest | null;
  /** The smoke suite (imported plus drafted): `projected` before Bring it in. Null from a
   * backend that predates it (the UI then estimates from the first test). */
  smoke: SmokeSuite | null;
  /** The live pass's crawl, so the map can show it on its device: null until one is queued. */
  live_run: LiveRun | null;
  live_build?: LiveBuildInfo | null;
  /** The subscription each lane runs on ("Claude Code"), null where it bills per token: the live
   * pass, the first test and the smoke suite run on `run`, drafting on `draft`. */
  billing: Billing;
  /** Why this portal cannot read the project folder (a container portal): the Apps form stays. */
  unavailable?: string | null;
  /** The picks saved on the row. */
  options?: { agent_id?: string | null };
  /** The run's error, when the row has one. */
  error?: string | null;
}

export interface Billing {
  run: string | null;
  draft: string | null;
}

/** How deep a live pass maps: `overview` is the default high-level map (the entry screen and
 * each main area once); `deeper` (Map deeper, Continue mapping) goes to the riskiest gaps first,
 * then every screen not seen yet. */
export const LIVE_DEPTHS = ["overview", "deeper"] as const;
export type LiveDepth = (typeof LIVE_DEPTHS)[number];

export interface LiveRun {
  request_id: string;
  /** The request's status: queued, running, completed, failed or cancelled. */
  status: string;
  /** Absent until a device picks the request up. */
  run_id?: string;
  exploration_id?: string;
  depth: LiveDepth;
  /** Screens this pass aims at (the overview: the entry screen and the main areas). */
  targets: number;
  /** Of those, how many are seen live now. */
  reached: number;
  /** The platform the pass runs on (its device is that platform's). */
  platform?: PlatformKind;
  /** What the pass is doing before its first step (from the worker's preparation timeline):
   * `building` while the app compiles, absent once the pass has ended. */
  stage?: LiveStage;
  /** That step's own words ("Compiling the Expo app (installing dependencies, then building)"). */
  stage_note?: string;
}

export const LIVE_STAGES = ["queued", "starting", "waiting_device", "device", "preparing", "building", "installing", "launching", "mapping", "finishing"] as const;
export type LiveStage = (typeof LIVE_STAGES)[number];

export interface SmokeSuite {
  count: number;
  estimate_usd: number;
  estimate_seconds: number;
  projected: boolean;
}

/** The actions `POST C/onboarding` takes. */
export type MapAction = "start" | "confirm" | "skip_live" | "run_live" | "bring_in" | "first_run" | "skip" | "restart";

/** `run_live`'s options: Retry keeps the pass's depth, Map deeper asks for `deeper`. */
export interface RunLiveOptions {
  depth?: LiveDepth;
  /** Run this pass on another platform ("Map on Android"); the person's pick wins from then on. */
  platform?: PlatformKind;
  device?: RunDevice;
}

/** `bring_in`'s options (the contract's "how the route behaves" change). */
export interface BringInOptions {
  /** Bring the existing tests in as pointers. */
  migrate?: boolean;
  /** Draft scenarios for the gaps (paid: the estimate was shown first). */
  draft?: boolean;
  /** The per-framework and per-area choice: left out, all N come in. */
  frameworks?: string[];
  areas?: string[];
  /** Defaults to `bring_in.draft.gap_screen_ids`. */
  gap_screen_ids?: string[];
}

export interface StartOptions {
  /** `"ask"`: map the code and tests, then offer the live pass with its cost and wait for Run
   * (onboarding); `true`: run it when its turn comes; `false`: skip it. */
  live?: boolean | "ask";
  /** Only when the person picked it: left out, Embodent maps on the first platform it can read. */
  platform?: PlatformKind;
  /** The device object New Run sends. */
  device?: RunDevice;
  /** The device picked for each platform, so a pass on another platform takes its own. */
  devices?: Partial<Record<PlatformKind, RunDevice>>;
}

export interface FirstRunOptions {
  scenario_id?: string;
  suite?: "smoke";
  /** The device object New Run sends. */
  device?: RunDevice;
  platform?: PlatformKind;
}

// ---------- parsing ----------

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const optStr = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const optNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === "string");
function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function parsePhase(v: unknown): PhaseInfo {
  const o = isObj(v) ? v : {};
  // Orcha's row says `status`; the snapshot's word is `state`.
  const info: PhaseInfo = { state: oneOf(o.state ?? o.status, PHASE_STATES, "pending") };
  const started = optStr(o.started_at);
  const ended = optStr(o.ended_at);
  const note = optStr(o.note);
  const cost = optNum(o.cost_usd);
  const estimate = optNum(o.estimate_usd);
  if (started) info.started_at = started;
  if (ended) info.ended_at = ended;
  if (note) info.note = note;
  if (cost !== undefined) info.cost_usd = cost;
  if (estimate !== undefined) info.estimate_usd = estimate;
  const blocked = optStr(o.blocked_reason);
  const request = optStr(o.request_id);
  if (blocked) info.blocked_reason = blocked;
  if (request) info.request_id = request;
  const task = optStr(o.task_id);
  if (task) info.task_id = task;
  if (isObj(o.counts)) {
    const counts = Object.entries(o.counts).filter((e): e is [string, number] => typeof e[1] === "number");
    if (counts.length) info.counts = Object.fromEntries(counts);
  }
  return info;
}

function parseFound(v: unknown): FoundSheet {
  const o = isObj(v) ? v : {};
  const repo = isObj(o.repo) ? o.repo : {};
  const defaults = isObj(o.defaults) ? o.defaults : {};
  const found: FoundSheet = {
    repo: { name: str(repo.name), path: optStr(repo.path), url: optStr(repo.url) },
    platforms: arr(o.platforms)
      .filter(isObj)
      .filter((p) => p.kind === "ios" || p.kind === "android" || p.kind === "web")
      .map((p) => ({ kind: p.kind as PlatformKind, app_id: optStr(p.app_id), stack: optStr(p.stack), path: optStr(p.path), ...(Array.isArray(p.candidates) ? { candidates: strs(p.candidates) } : {}) })),
    environments: arr(o.environments)
      .filter(isObj)
      .map((e) => ({ name: str(e.name, "local"), base_url: optStr(e.base_url) })),
    tests: arr(o.tests)
      .filter(isObj)
      .filter((t) => (FRAMEWORKS as readonly unknown[]).includes(t.framework))
      .map((t) => ({ framework: t.framework as Framework, count: Math.max(0, Math.round(num(t.count))), path: str(t.path) })),
    defaults: { device: optStr(defaults.device), test_data: optStr(defaults.test_data) },
  };
  if (Array.isArray(o.ci)) found.ci = o.ci.filter(isObj).map((c) => ({ provider: str(c.provider), path: str(c.path) }));
  if (isObj(o.unreadable)) {
    const blocked: Partial<Record<PlatformKind, string>> = {};
    for (const k of ["ios", "android"] as const) if (typeof o.unreadable[k] === "string") blocked[k] = o.unreadable[k] as string;
    if (Object.keys(blocked).length) found.unreadable = blocked;
  }
  if (isObj(o.auth) && typeof o.auth.summary === "string") {
    found.auth = { summary: o.auth.summary, methods: strs(o.auth.methods), sure: o.auth.sure === true };
  }
  if (isObj(o.sandboxes)) {
    const sandboxes: FoundSheet["sandboxes"] = {};
    for (const kind of ["ios", "android", "web"] as const) {
      const boxes = o.sandboxes[kind];
      if (!isObj(boxes)) continue;
      sandboxes[kind] = Object.fromEntries(
        Object.entries(boxes).flatMap(([key, box]) => (isObj(box) ? [[key, { ready: box.ready === true ? true : null, evidence: str(box.evidence) }]] : [])),
      );
    }
    found.sandboxes = sandboxes;
  }
  if (isObj(o.live_platform) && (o.live_platform.kind === "ios" || o.live_platform.kind === "android" || o.live_platform.kind === "web")) {
    found.live_platform = { kind: o.live_platform.kind, why: str(o.live_platform.why) };
  }
  const backends = parseBackends(o.backends);
  if (backends.length) found.backends = backends;
  if (isObj(o.backend_unknown)) {
    const unknown: Partial<Record<PlatformKind, string>> = {};
    for (const k of ["ios", "android", "web"] as const) if (typeof o.backend_unknown[k] === "string") unknown[k] = o.backend_unknown[k] as string;
    if (Object.keys(unknown).length) found.backend_unknown = unknown;
  }
  return found;
}

const isPlatform = (k: unknown): k is PlatformKind => k === "ios" || k === "android" || k === "web";

function parseBackends(v: unknown): FoundBackend[] {
  return arr(v)
    .filter(isObj)
    .map((b) => ({
      platforms: arr(b.platforms).filter(isPlatform),
      service: str(b.service, "API") || "API",
      url: str(b.url),
      source: str(b.source),
      variable: str(b.variable),
      build: oneOf(b.build, ["checkout", "release", "any"] as const, "any"),
      production: b.production === true,
    }))
    .filter((b) => b.platforms.length > 0 && /^https?:\/\//.test(b.url));
}

function parseScreen(v: Json): MapScreen | null {
  const id = str(v.id);
  if (!id) return null;
  const risk = isObj(v.risk) ? v.risk : {};
  const screen: MapScreen = {
    id,
    name: str(v.name, id),
    route: optStr(v.route),
    platform: optStr(v.platform),
    source: oneOf(v.source, ["code", "live", "both"] as const, "code"),
    thumbnail: optStr(v.thumbnail),
    files: strs(v.files),
    endpoints: strs(v.endpoints),
    coverage: oneOf(v.coverage, ["your_tests", "qa", "both", "none"] as const, "none"),
    tests: arr(v.tests)
      .filter(isObj)
      .map((t) => ({ framework: str(t.framework), name: str(t.name), path: str(t.path), line: optNum(t.line), evidence: str(t.evidence) })),
    scenarios: arr(v.scenarios)
      .filter(isObj)
      .map((s) => ({
        id: str(s.id),
        name: str(s.name),
        status: str(s.status, "draft"),
        ...(s.origin === "imported" || s.origin === "drafted" || s.origin === "traced" ? { origin: s.origin as "imported" | "drafted" | "traced" } : {}),
        // Why it would not run well first (#486): "it needs the launch argument -denly-uitest-reset".
        ...(optStr(s.unfit) ? { unfit: optStr(s.unfit) } : {}),
      }))
      .filter((s) => s.id),
    risk: { score: num(risk.score), reasons: strs(risk.reasons) },
  };
  // Queued with an empty `run_id` until the run exists, then `running` with it.
  if (isObj(v.first_run) && typeof v.first_run.verdict === "string") {
    const fr = v.first_run;
    screen.first_run = {
      scenario_id: str(fr.scenario_id),
      run_id: str(fr.run_id),
      verdict: oneOf(fr.verdict, ["pass", "fail", "error", "running", "queued"] as const, "queued"),
      duration_s: optNum(fr.duration_s),
      finding: optStr(fr.finding),
      outcome: (FIRST_RUN_OUTCOMES as readonly unknown[]).includes(fr.outcome) ? (fr.outcome as FirstRunOutcome) : undefined,
      reason: optStr(fr.reason),
      screen_id: optStr(fr.screen_id),
      screen: optStr(fr.screen),
      setup: parseSetup(fr.setup),
    };
  }
  return screen;
}

function parseSetup(v: unknown): FirstRunSetup | undefined {
  if (!isObj(v)) return undefined;
  return {
    request_id: str(v.request_id),
    run_id: str(v.run_id),
    finding: optStr(v.finding),
    not_app: optStr(v.not_app),
    reason: optStr(v.reason),
    screen_id: optStr(v.screen_id),
    screen: optStr(v.screen),
  };
}

function parseFirstTest(v: unknown): FirstTest | null {
  if (!isObj(v) || !str(v.scenario_id)) return null;
  return {
    scenario_id: str(v.scenario_id),
    name: str(v.name, "First test"),
    screen_id: optStr(v.screen_id),
    platform: optStr(v.platform),
    estimate_seconds: Math.max(0, num(v.estimate_seconds)),
    estimate_usd: Math.max(0, num(v.estimate_usd)),
    why: str(v.why),
  };
}

function parseLiveBuild(v: unknown): LiveBuildInfo | null {
  if (!isObj(v) || (v.source !== "installed" && v.source !== "url")) return null;
  const out: LiveBuildInfo = { source: v.source, platform: str(v.platform), app_id: str(v.app_id) };
  for (const k of ["device", "version", "build", "installed_at"] as const) {
    const text = optStr(v[k]);
    if (text) out[k] = text;
  }
  return out;
}

function parseLiveRun(v: unknown): LiveRun | null {
  if (!isObj(v)) return null;
  const request_id = str(v.request_id);
  if (!request_id) return null;
  const run: LiveRun = {
    request_id,
    status: str(v.status, "queued") || "queued",
    depth: oneOf(v.depth, LIVE_DEPTHS, "overview"),
    targets: Math.max(0, Math.round(num(v.targets))),
    reached: Math.max(0, Math.round(num(v.reached))),
  };
  const runId = optStr(v.run_id);
  const exploration = optStr(v.exploration_id);
  if (runId) run.run_id = runId;
  if (exploration) run.exploration_id = exploration;
  if (v.platform === "ios" || v.platform === "android" || v.platform === "web") run.platform = v.platform;
  if ((LIVE_STAGES as readonly unknown[]).includes(v.stage)) run.stage = v.stage as LiveStage;
  const stageNote = optStr(v.stage_note);
  if (stageNote) run.stage_note = stageNote;
  return run;
}

/**
 * What a `POST` answered (202 `{ project_id, phase, phases }`) folded into the snapshot on
 * screen: the phases move at once, the rest waits for the next read. A full snapshot replaces.
 */
export function mergeAccepted(current: OnboardingMap | null, body: unknown): OnboardingMap | null {
  if (!isObj(body) || typeof body.project_id !== "string") return current;
  if (Array.isArray(body.screens) || !current) return parseOnboardingMap(body) ?? current;
  const partial = parseOnboardingMap({ project_id: body.project_id, phase: body.phase, phases: body.phases });
  if (!partial) return current;
  const phases = isObj(body.phases) ? Object.fromEntries(MAP_PHASES.map((p) => [p, isObj(body.phases) && p in body.phases ? partial.phases[p] : current.phases[p]])) : current.phases;
  return { ...current, phase: typeof body.phase === "string" ? partial.phase : current.phase, phases: phases as OnboardingMap["phases"] };
}

/** The snapshot from an unknown JSON body, or null when it is not an onboarding map at all. */
export function parseOnboardingMap(body: unknown): OnboardingMap | null {
  if (!isObj(body) || typeof body.project_id !== "string") return null;
  const rawPhases = isObj(body.phases) ? body.phases : {};
  const phases = Object.fromEntries(MAP_PHASES.map((p) => [p, parsePhase(rawPhases[p])])) as Record<MapPhase, PhaseInfo>;
  const screens = arr(body.screens)
    .filter(isObj)
    .map(parseScreen)
    .filter((s): s is MapScreen => s !== null);
  const ids = new Set(screens.map((s) => s.id));
  const summary = isObj(body.summary) ? body.summary : {};
  const bringIn = isObj(body.bring_in) ? body.bring_in : {};
  const draft = isObj(bringIn.draft) ? bringIn.draft : {};
  return {
    project_id: body.project_id,
    phase: oneOf(body.phase, MAP_PHASES, "found"),
    phases,
    found: parseFound(body.found),
    files: arr(body.files)
      .filter(isObj)
      .map((f) => ({ path: str(f.path), screen_ids: strs(f.screen_ids).filter((id) => ids.has(id)) }))
      .filter((f) => f.path),
    screens,
    // An edge to a screen the snapshot does not hold (yet) is dropped, never drawn to nowhere.
    edges: arr(body.edges)
      .filter(isObj)
      .map((e) => ({ from: str(e.from), to: str(e.to), kind: oneOf(e.kind, ["nav", "calls", "reads", "writes"] as const, "nav") }))
      .filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to),
    gaps: arr(body.gaps)
      .filter(isObj)
      // The server scores 0 to 100; the map works in 0 to 1.
      .map((g) => ({ screen_id: str(g.screen_id), flow: optStr(g.flow), risk: num(g.risk) > 1 ? num(g.risk) / 100 : num(g.risk), reason: str(g.reason) }))
      .filter((g) => ids.has(g.screen_id))
      .sort((a, b) => b.risk - a.risk),
    summary: {
      screens: num(summary.screens, screens.length),
      covered_by_tests: num(summary.covered_by_tests),
      covered_by_qa: num(summary.covered_by_qa),
      uncovered: num(summary.uncovered),
      untested_critical: strs(summary.untested_critical),
    },
    bring_in: {
      migrate: arr(bringIn.migrate)
        .filter(isObj)
        .map((m) => ({ framework: str(m.framework), count: Math.max(0, Math.round(num(m.count))) }))
        .filter((m) => m.framework && m.count > 0),
      draft: { gap_screen_ids: strs(draft.gap_screen_ids).filter((id) => ids.has(id)), estimate_usd: Math.max(0, num(draft.estimate_usd)) },
    },
    first_test: parseFirstTest(body.first_test),
    smoke: isObj(body.smoke)
      ? {
          count: Math.max(0, Math.round(num(body.smoke.count))),
          estimate_usd: Math.max(0, num(body.smoke.estimate_usd)),
          estimate_seconds: Math.max(0, num(body.smoke.estimate_seconds)),
          projected: body.smoke.projected === true,
        }
      : null,
    live_run: parseLiveRun(body.live_run),
    live_build: parseLiveBuild(body.live_build),
    billing: { run: optStr(isObj(body.billing) ? body.billing.run : undefined) ?? null, draft: optStr(isObj(body.billing) ? body.billing.draft : undefined) ?? null },
    unavailable: optStr(body.unavailable) ?? null,
    options: isObj(body.options) && optStr(body.options.agent_id) ? { agent_id: optStr(body.options.agent_id) } : {},
    error: optStr(body.error) ?? null,
  };
}

/** A phase that is finished either way: the flow can move past it. */
export function settled(info: PhaseInfo | undefined): boolean {
  return info?.state === "done" || info?.state === "skipped";
}

/** The framework's display name ("XCUITest"). */
export const FRAMEWORK_NAMES: Record<string, string> = {
  xcuitest: "XCUITest",
  espresso: "Espresso",
  maestro: "Maestro",
  detox: "Detox",
  playwright: "Playwright",
  cypress: "Cypress",
  gherkin: "Gherkin",
};

export function frameworkName(fw: string): string {
  return FRAMEWORK_NAMES[fw] ?? fw;
}

/**
 * What a step costs, in words: on a subscription its figure is a list-price equivalent, never a
 * charge, so "≈$0.42 at API prices" ("not charged" before there is one), else "about $0.42".
 */
export function costWords(billing: Billing | undefined, lane: keyof Billing, v: number | undefined): string {
  if (billing?.[lane]) return v !== undefined ? apiPriceLabel(v) : "not charged";
  return `about ${usd(v)}`;
}

/** The same without "about", after a duration ("about 3 min · $0.42" or "· ≈$0.42 at API prices"). */
export function priceWords(billing: Billing | undefined, lane: keyof Billing, v: number | undefined): string {
  if (billing?.[lane]) return v !== undefined ? apiPriceLabel(v) : "not charged";
  return usd(v);
}

/** The tooltip for a figure on a subscription lane ("Not charged: ..."), else undefined. */
export function costTitle(billing: Billing | undefined, lane: keyof Billing, v: number | undefined): string | undefined {
  const sub = billing?.[lane];
  return sub ? notChargedTitle(sub, v ?? null) : undefined;
}

/** "On your Claude Code subscription, not charged" for a lane on one ("…: ≈$0.61 at API prices,
 * not charged" with a figure), else null. */
export function subscriptionWords(billing: Billing | undefined, lane: keyof Billing, v?: number): string | null {
  const sub = billing?.[lane];
  if (!sub) return null;
  const on = `On ${subscriptionPhrase(sub)}`;
  return v !== undefined && v > 0 ? `${on}: ${apiPriceLabel(v)}, not charged` : `${on}, not charged`;
}

/** "$0.42", "under $0.01", or "free". */
export function usd(v: number | undefined): string {
  if (v === undefined) return "estimate pending";
  if (v <= 0) return "free";
  if (v < 0.01) return "under $0.01";
  return `$${v < 10 ? v.toFixed(2) : v.toFixed(0)}`;
}

/** "42 s", "3 min", "1 h 5 min". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
