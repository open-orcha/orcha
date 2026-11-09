/**
 * The onboarding flow as a small state machine: Connect, We found, Map, Coverage, Bring it in,
 * First run. The first two run in the browser (the project does not exist yet); from Map on,
 * the server's snapshot (`OnboardingMap.phase` and `phases`) says how far the person may go,
 * and the person moves on themselves, so a fast backend never yanks the page from under them.
 * Pure: the wizard renders it, the tests drive it.
 */
import { settled, type OnboardingMap } from "./contract";
import { resultWords } from "./first-run-result";

export const FLOW_STEPS = ["connect", "found", "map", "coverage", "bring_in", "first_run"] as const;
export type FlowStep = (typeof FLOW_STEPS)[number];

export const FLOW_LABELS: Record<FlowStep, string> = {
  connect: "Connect",
  found: "We found",
  map: "Map",
  coverage: "Coverage",
  bring_in: "Bring it in",
  first_run: "First run",
};

/** The `data-onboarding-step` hook of each step (stable for the e2e suite). */
export const FLOW_KEYS: Record<FlowStep, string> = {
  connect: "Repository",
  found: "Found",
  map: "Map",
  coverage: "Coverage",
  bring_in: "Bring in",
  first_run: "First run",
};

export const FLOW_COPY: Record<FlowStep, { title: string; lead: string }> = {
  connect: { title: "Connect your app", lead: "Embodent reads the project's repository to find your platforms, your screens and the tests you already have." },
  found: { title: "Here is what we found", lead: "Check it over. Everything is chosen for you; change anything with Edit." },
  map: { title: "Mapping your app", lead: "Embodent follows the code to every screen, then lights up the ones your tests already reach." },
  coverage: { title: "Your coverage", lead: "What your tests reach today, and what nothing checks yet, riskiest first." },
  bring_in: { title: "Bring it in", lead: "Your tests come in as pointers, free: their code stays in your repository." },
  first_run: { title: "Run your first test", lead: "Embodent picked the best one to start with. Watch it run on the device." },
};

export function stepIndex(step: FlowStep): number {
  return FLOW_STEPS.indexOf(step);
}

/** Where the map is within the Map step: the beats of the cinematic. */
export type MapBeat = "waiting" | "code" | "tests" | "live_offer" | "live" | "ready" | "failed";

export function mapBeat(map: OnboardingMap | null): MapBeat {
  if (!map) return "waiting";
  const { code_map, tests, live } = map.phases;
  if (code_map.state === "failed" || tests.state === "failed") return "failed";
  if (code_map.state === "pending" && map.screens.length === 0) return "waiting";
  if (!settled(code_map)) return "code";
  if (!settled(tests)) return "tests";
  if (live.state === "running") return "live";
  if (live.state === "pending") return "live_offer";
  // A failed live pass keeps the code map: the person goes on with what was found.
  return "ready";
}

/** The furthest step the snapshot lets the person reach. */
export function furthestStep(map: OnboardingMap | null): FlowStep {
  if (!map) return "map";
  const beat = mapBeat(map);
  if (beat !== "ready") return "map";
  if (!settled(map.phases.bring_in) && map.phase !== "first_run" && map.phase !== "done") return "bring_in";
  return "first_run";
}

/** Whether Continue on `step` may go on, and why not (shown under the button). */
export function canContinue(step: FlowStep, map: OnboardingMap | null): { ok: boolean; why?: string } {
  if (step === "map") {
    const beat = mapBeat(map);
    if (beat === "ready") return { ok: true };
    if (beat === "failed") return { ok: false, why: "The map did not finish. Try again." };
    if (beat === "live_offer") return { ok: false, why: "Run the live pass, or skip it to go on." };
    if (beat === "live") return { ok: false, why: "The live pass is running. Skip the rest to go on now." };
    return { ok: false, why: "Still mapping." };
  }
  if (step === "coverage") return { ok: true };
  if (step === "bring_in") {
    const bi = map?.phases.bring_in;
    if (bi?.state === "running") return { ok: false, why: "Still drafting for the gaps." };
    return { ok: true };
  }
  return { ok: true };
}

export interface FlowState {
  step: FlowStep;
  /** The furthest step visited: the rail lets the person jump back to any of them. */
  reached: FlowStep;
  /** Said politely when the step changes (the phase lines are said by `phaseAnnouncement`). */
  announcement: string;
}

export type FlowEvent =
  | { type: "next" }
  | { type: "back" }
  /** The rail: back to a step already reached. */
  | { type: "go"; step: FlowStep }
  /** Ahead past steps there is nothing to do on (Run your first test, the classic drafting's Skip). */
  | { type: "jump"; step: FlowStep }
  /** Start over: back to Connect with nothing reached (a new project's draft was dropped). */
  | { type: "reset" };

export function initialFlow(step: FlowStep = "connect"): FlowState {
  return { step, reached: step, announcement: "" };
}

const later = (a: FlowStep, b: FlowStep): FlowStep => (stepIndex(a) >= stepIndex(b) ? a : b);
const said = (step: FlowStep) => `${FLOW_LABELS[step]}. Step ${stepIndex(step) + 1} of ${FLOW_STEPS.length}.`;

export function flowReducer(state: FlowState, event: FlowEvent): FlowState {
  switch (event.type) {
    case "next": {
      const step = FLOW_STEPS[Math.min(stepIndex(state.step) + 1, FLOW_STEPS.length - 1)];
      return { step, reached: later(state.reached, step), announcement: said(step) };
    }
    case "back": {
      // Once the project exists, Connect and We found are behind it: Back stops at Map.
      const floor = stepIndex(state.reached) >= stepIndex("map") ? stepIndex("map") : 0;
      const step = FLOW_STEPS[Math.max(stepIndex(state.step) - 1, floor)];
      return { ...state, step, announcement: said(step) };
    }
    case "go": {
      // Back to any step reached; forward only by finishing the one before.
      if (stepIndex(event.step) > stepIndex(state.reached)) return state;
      if (stepIndex(state.reached) >= stepIndex("map") && stepIndex(event.step) < stepIndex("map")) return state;
      return { ...state, step: event.step, announcement: said(event.step) };
    }
    case "jump":
      return { step: event.step, reached: later(state.reached, event.step), announcement: said(event.step) };
    case "reset":
      return { ...initialFlow("connect"), announcement: said("connect") };
  }
}

/** What the live region says for a snapshot: one line per beat, never per screen. */
export function phaseAnnouncement(map: OnboardingMap): { key: string; text: string } {
  const beat = mapBeat(map);
  const n = map.screens.length;
  if (map.phase === "first_run" || map.phase === "done") {
    const run = map.screens.find((s) => s.first_run)?.first_run;
    if (run && (run.verdict === "pass" || run.verdict === "fail" || run.verdict === "error")) {
      // What really happened (#486): never "the finding is on the screen" when there is none.
      const words = resultWords(run, null);
      return { key: run.verdict === "pass" ? "fr-pass" : `fr-${words.outcome}`, text: words.said };
    }
    if (run) return { key: "fr-run", text: "Your first test is running." };
    return { key: "fr-ready", text: "Ready to run your first test." };
  }
  if (map.phase === "bring_in" && map.phases.bring_in.state !== "pending") {
    return settled(map.phases.bring_in) ? { key: "bi-done", text: "Your tests are in, and the drafts are on their screens." } : { key: "bi-run", text: "Drafting for the gaps." };
  }
  switch (beat) {
    case "waiting":
      return { key: "wait", text: "Starting the map." };
    case "code":
      return { key: "code", text: "Reading the code for screens." };
    case "tests":
      return { key: "tests", text: `Found ${n} screens. Matching your existing tests to them.` };
    case "live_offer":
      return { key: "offer", text: "The code map is done. The live pass waits for you: run it or skip it." };
    case "live":
      return { key: "live", text: "Live pass started. Screens turn solid as the device reaches them." };
    case "failed":
      return { key: "failed", text: "The map did not finish." };
    case "ready":
      return { key: "ready", text: `Map ready: ${n} screens, ${map.summary.covered_by_tests} covered by your tests.` };
  }
}
