/**
 * The run theater's pure model (#188 "a run theater, not a verdict card"): which tab opens, the
 * running run's phases, how the timeline groups its steps, and the logs' live tail. No React
 * here, so every rule is unit tested (`theater-model.test.ts`).
 */
import { actionRangeToStepSeqRange } from "../replay/model";
import { isRunTab, type RunTab } from "../replay/run-tabs";
import type { CharterItem } from "../../sessions/explorations";
import type { Json, Step } from "../types";

/** A phase event: a session has none stored, so the steps tell the story. */
export interface PrepEvent {
  phase: string;
  status: string;
  message: string;
}

// Tabs -----------------------------------------------------------------------------------------

export type TheaterVariant = "pane" | "page";

/**
 * The tab a theater opens on. A `?tab=` that names a tab wins; a `?step=N` deep link opens Steps
 * (the replay at that step, #187); otherwise the pane opens on Overview (a selected run reads as
 * its verdict and cause first) and the page on the run's own default (Scenarios for a scenario
 * run, Steps for an exploration), as it always has.
 */
export function initialTheaterTab({
  variant,
  tabParam,
  stepParam,
  defaultTab,
  live = false,
}: {
  variant: TheaterVariant;
  tabParam?: string | null;
  stepParam?: number | null;
  defaultTab: RunTab;
  /** A run still running opens on Steps, page or pane: the actions as they happen. */
  live?: boolean;
}): RunTab {
  if (isRunTab(tabParam)) return tabParam;
  if (stepParam != null || live) return "steps";
  return variant === "pane" ? "overview" : defaultTab;
}

/**
 * The tab to show for a requested one, given which tabs exist. A tab that is gone (Map without
 * frames, Video without a recording, Scenarios on an exploration) falls back to Overview rather
 * than leaving the bar with nothing selected.
 */
export function resolveTab(requested: RunTab, available: readonly RunTab[]): RunTab {
  if (available.includes(requested)) return requested;
  return available.includes("overview") ? "overview" : (available[0] ?? requested);
}

// Running phases -------------------------------------------------------------------------------

export const MACRO_PHASES = ["claimed", "prepare", "testing", "judging", "syncing"] as const;
export type MacroPhase = (typeof MACRO_PHASES)[number];

export const MACRO_PHASE_LABEL: Record<MacroPhase, string> = {
  claimed: "Claimed",
  prepare: "Prepare",
  testing: "Testing",
  judging: "Judging",
  syncing: "Syncing",
};

export type MacroStatus = "pending" | "running" | "done" | "failed";

export interface MacroPhaseRow {
  key: MacroPhase;
  label: string;
  status: MacroStatus;
  /** The latest message the worker wrote in this phase. */
  message: string | null;
}

/** Which of the five phases a worker timeline event belongs to (`prep_events.py` keys). The
 * worker's single `finishing` phase covers judging, the report, the sync and teardown: its
 * message says which. */
export function macroPhaseOf(event: Pick<PrepEvent, "phase" | "message">): MacroPhase {
  switch (event.phase) {
    case "claimed":
    case "waiting_device":
      return "claimed";
    case "device":
    case "environment":
    case "build":
    case "install":
    case "launch":
    case "agent":
      return "prepare";
    case "steps":
      return "testing";
    case "finishing":
      return /sync|teardown|complete/i.test(event.message) ? "syncing" : "judging";
    default:
      return "prepare";
  }
}

/**
 * The running run's phase timeline: claimed → prepare → testing → judging → syncing. A phase is
 * done once a later one began, running while it is the latest, failed when its last event
 * failed. Without a worker timeline (an older worker, a run with no request) the steps tell
 * the story: claimed and prepared once a step exists, testing while live.
 */
export function macroPhases(
  events: readonly PrepEvent[],
  { live, hasSteps, finished }: { live: boolean; hasSteps: boolean; finished: boolean },
): MacroPhaseRow[] {
  const latest = new Map<MacroPhase, PrepEvent>();
  let reached = -1;
  for (const e of events) {
    const m = macroPhaseOf(e);
    latest.set(m, e);
    reached = Math.max(reached, MACRO_PHASES.indexOf(m));
  }
  if (reached === -1 && hasSteps) reached = MACRO_PHASES.indexOf("testing");
  if (reached === -1 && live) reached = 0;
  return MACRO_PHASES.map((key, i) => {
    const e = latest.get(key) ?? null;
    let status: MacroStatus;
    if (e?.status === "failed") status = "failed";
    else if (finished) status = i <= reached || key === "syncing" ? "done" : "pending";
    else if (i < reached) status = "done";
    else if (i === reached) status = live ? "running" : "done";
    else status = "pending";
    return { key, label: MACRO_PHASE_LABEL[key], status, message: e?.message ?? null };
  });
}

/** "4:12 of 10 min", "4:12": elapsed against the budget, when the run has one. */
export function elapsedAgainstBudget(elapsedMs: number | null, budgetMinutes: number | null): string | null {
  if (elapsedMs == null) return null;
  const s = Math.max(0, Math.floor(elapsedMs / 1000));
  const clock = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return budgetMinutes ? `${clock} of ${budgetMinutes} min` : clock;
}

/** Share of the budget used, 0..1, or null without a budget. */
export function budgetShare(elapsedMs: number | null, budgetMinutes: number | null): number | null {
  if (elapsedMs == null || !budgetMinutes) return null;
  return Math.min(1, Math.max(0, elapsedMs / (budgetMinutes * 60_000)));
}

// Timeline grouping ----------------------------------------------------------------------------

export interface TimelineScenario {
  scenario_id: string;
  name: string;
  outcome: string | null;
  /** `scenario_results.criteria`: `[{text, outcome, from_step, to_step}]` in action numbers. */
  criteria: Json;
}

export interface TimelineGroup {
  key: string;
  /** The scenario or mission this run of steps belongs to; null for steps outside every one. */
  title: string;
  /** The criterion inside the scenario, when the steps fall in one's window. */
  subtitle: string | null;
  outcome: string | null;
  /** True for the first group of its scenario/mission: the one that draws its heading. */
  leads: boolean;
  steps: Step[];
}

interface Window {
  scenarioKey: string;
  title: string;
  subtitle: string | null;
  outcome: string | null;
  lo: number;
  hi: number;
}

function criterionWindows(scenarios: readonly TimelineScenario[], actionSeqs: readonly number[]): Window[] {
  const out: Window[] = [];
  for (const sc of scenarios) {
    const items = Array.isArray(sc.criteria) ? sc.criteria : [];
    items.forEach((raw, i) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
      const c = raw as Record<string, Json | undefined>;
      const from = typeof c.from_step === "number" ? c.from_step : null;
      const to = typeof c.to_step === "number" ? c.to_step : null;
      const range = actionRangeToStepSeqRange(actionSeqs, from, to);
      if (!range) return;
      out.push({
        scenarioKey: `scenario:${sc.scenario_id}`,
        title: sc.name,
        subtitle: typeof c.text === "string" ? c.text : `Criterion ${i + 1}`,
        outcome: typeof c.outcome === "string" ? c.outcome : sc.outcome,
        lo: range[0],
        hi: range[1],
      });
    });
  }
  return out;
}

/** Consecutive steps with the same key become one group; a group leads when its scenario
 * differs from the previous group's. */
function segment(steps: readonly Step[], keyOf: (s: Step) => Omit<TimelineGroup, "steps" | "leads" | "key"> & { scenarioKey: string; groupKey: string }): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  let prevScenario: string | null = null;
  let prevGroup: string | null = null;
  for (const s of steps) {
    const k = keyOf(s);
    if (k.groupKey !== prevGroup) {
      groups.push({
        key: `${k.groupKey}@${s.seq}`,
        title: k.title,
        subtitle: k.subtitle,
        outcome: k.outcome,
        leads: k.scenarioKey !== prevScenario,
        steps: [s],
      });
      prevScenario = k.scenarioKey;
      prevGroup = k.groupKey;
    } else {
      groups[groups.length - 1].steps.push(s);
    }
  }
  return groups;
}

/**
 * The timeline's groups: a scenario run's steps under the scenario and criterion whose window
 * (`from_step..to_step`, action numbers) they fall in; an exploration's under the charter mission
 * it was on (a mission starts at its `step_seq` and lasts until the next one starts). Null when
 * there is nothing to group by (no criterion windows, no missions with a step): the timeline is
 * then the plain list.
 */
export function groupTimeline({
  steps,
  actionSeqs,
  scenarios = [],
  charter = [],
}: {
  steps: readonly Step[];
  actionSeqs: readonly number[];
  scenarios?: readonly TimelineScenario[];
  charter?: readonly CharterItem[];
}): TimelineGroup[] | null {
  const ordered = [...steps].sort((a, b) => a.seq - b.seq);
  if (ordered.length === 0) return null;

  const windows = criterionWindows(scenarios, actionSeqs);
  if (windows.length > 0) {
    // A lone scenario still groups by criterion; its name heads the first group.
    // The screen right after a criterion's last action shows that action's result: it stays in
    // the criterion's group rather than opening an "Other steps" group of one.
    let prev: Window | null = null;
    return segment(ordered, (s) => {
      const w = windows.find((x) => s.seq >= x.lo && s.seq <= x.hi) ?? (s.kind === "screen" ? prev : null);
      prev = w ?? null;
      if (w) return { scenarioKey: w.scenarioKey, groupKey: `${w.scenarioKey}:${w.subtitle}`, title: w.title, subtitle: w.subtitle, outcome: w.outcome };
      const before = s.seq < Math.min(...windows.map((x) => x.lo));
      const title = before ? "Getting ready" : "Other steps";
      return { scenarioKey: title, groupKey: title, title, subtitle: null, outcome: null };
    });
  }

  const missions = charter
    .filter((m): m is CharterItem & { step_seq: number } => typeof m.step_seq === "number")
    .sort((a, b) => a.step_seq - b.step_seq);
  if (missions.length > 0) {
    return segment(ordered, (s) => {
      let mission: (typeof missions)[number] | null = null;
      for (const m of missions) if (m.step_seq <= s.seq) mission = m;
      if (!mission) return { scenarioKey: "study", groupKey: "study", title: "Getting ready", subtitle: null, outcome: null };
      const key = `mission:${mission.id}`;
      return { scenarioKey: key, groupKey: key, title: mission.title, subtitle: null, outcome: mission.status };
    });
  }
  return null;
}

// Live tail ------------------------------------------------------------------------------------

/**
 * The logs' live tail: while following, new lines scroll into view; scrolling up pauses it, and
 * what arrived since counts up until the reader scrolls back down or presses "Jump to latest".
 * Kept as "how many lines were there when the reader paused", so the count is derived from the
 * list itself and never has to be pushed into state as lines land.
 */
export interface TailState {
  following: boolean;
  /** How many lines the list had when the reader paused (or last caught up). */
  seenCount: number;
}

export function tailStart(count = 0): TailState {
  return { following: true, seenCount: count };
}

/** The reader scrolled: at the bottom follows again, anywhere else pauses. */
export function tailOnScroll(state: TailState, atBottom: boolean, count: number): TailState {
  if (atBottom) return state.following ? state : { following: true, seenCount: count };
  return state.following ? { following: false, seenCount: count } : state;
}

/** Lines that arrived while paused (0 while following). */
export function tailUnseen(state: TailState, count: number): number {
  return state.following ? 0 : Math.max(0, count - state.seenCount);
}

/** "Jump to latest". */
export function tailJump(count: number): TailState {
  return { following: true, seenCount: count };
}

/** One line of the running band's log tail. */
export interface TailLine {
  key: string;
  label: string;
  text: string;
  level?: string;
}

/**
 * The running band's last few log lines: the app's own (console, network, device, crash) when it
 * logged any, else the run's log (the agent's steps, the worker's lines) that the Log panel shows,
 * so a crawl on an app that logs nothing never reads "No log lines yet" beside 120 lines.
 */
export function logTail(
  appLogs: readonly { seq: number; source: string; text: string; level?: string | null }[],
  runLog: readonly { ts: string; src: string; text: string }[],
  n = 3,
): TailLine[] {
  if (appLogs.length) {
    return [...appLogs]
      .sort((a, b) => a.seq - b.seq)
      .slice(-n)
      .map((l) => ({ key: `app-${l.seq}`, label: l.source, text: l.text, level: l.level ?? undefined }));
  }
  const start = Math.max(0, runLog.length - n);
  return runLog.slice(start).map((l, i) => ({ key: `run-${start + i}-${l.ts}`, label: l.src, text: l.text }));
}
