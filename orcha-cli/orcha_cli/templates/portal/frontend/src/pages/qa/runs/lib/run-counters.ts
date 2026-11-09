/**
 * One source for a run's live counters (#170): actions, screens, elapsed time and scenario
 * progress. Every surface that shows them (the queue card, the run header, the Exploration and
 * first-run guides, the drafting views) reads them from here, so the same run never says
 * "Steps 0" on one card and "Actions 15" on another at the same moment.
 *
 * The rules match what the worker stores when the run ends: `runs.step_count` counts every
 * step except `screen` , and a screen is a distinct map screen, else a distinct screen hash.
 */

export interface CounterStep {
  seq: number;
  kind: string;
  screen_hash?: string | null;
  /** The map's name for the screen: what "screens reached" counts, so the numbers agree. */
  screen_key?: string | null;
  frame_path?: string | null;
  /** Milliseconds from the run's start (`runs.started_at`) to the step. */
  at_ms?: number | null;
}

export interface RunCounters {
  /** Actions taken so far: every step but a screen read (`runs.step_count`). */
  actions: number;
  /** Distinct screens seen so far (by screen hash; a screen read without one counts once). */
  screens: number;
  /** The newest stored frame, for a live thumbnail. */
  latestFrame: string | null;
  /** `at_ms` of the run's first step: the run clock starts there (`runClockStart`, #200). */
  firstAtMs?: number | null;
}

/** The counters for a run's steps so far. `storedActions` (`runs.step_count`) wins once the
 * run has written it, so a finished run reads the same before and after its steps load. */
export function runCounters(steps: readonly CounterStep[], storedActions?: number | null): RunCounters {
  const hashes = new Set<string>();
  let unhashed = 0;
  let actions = 0;
  let latest: CounterStep | null = null;
  let first: CounterStep | null = null;
  for (const s of steps) {
    if (!first || s.seq < first.seq) first = s;
    if (s.kind === "screen") {
      const screen = s.screen_key || s.screen_hash;
      if (screen) hashes.add(screen);
      else unhashed += 1;
      if (s.frame_path && (!latest || s.seq > latest.seq)) latest = s;
    } else if (s.kind !== "note") {
      actions += 1;
    }
  }
  return {
    actions: Math.max(storedActions ?? 0, actions),
    screens: hashes.size + (hashes.size === 0 ? unhashed : 0),
    latestFrame: latest?.frame_path ?? null,
    firstAtMs: first?.at_ms ?? null,
  };
}

export interface StepBreakdown {
  /** Every step the Steps tab lists. */
  steps: number;
  /** Steps that did something (a tap, a swipe, typing): `runs.step_count`, the header's "actions". */
  actions: number;
  /** Screen reads: the agent looking at the screen. Each one with a frame is a step of the replay. */
  looks: number;
}

/** What a run's steps are made of, so "356 steps", "177 actions" and the replay's "1 / 179"
 * read as parts of one whole rather than three numbers that disagree. */
export function stepBreakdown(steps: readonly Pick<CounterStep, "kind">[]): StepBreakdown {
  const looks = steps.filter((s) => s.kind === "screen").length;
  // A note records what the agent concluded; it did nothing to the app.
  const notes = steps.filter((s) => s.kind === "note").length;
  return { steps: steps.length, actions: steps.length - looks - notes, looks };
}

/** `356 steps: 177 actions, 179 screen reads`, the parts left out when there is only one kind. */
export function stepBreakdownLine(b: StepBreakdown): string {
  const total = `${b.steps} ${b.steps === 1 ? "step" : "steps"}`;
  if (b.actions === 0 || b.looks === 0) return total;
  return `${total}: ${b.actions} ${b.actions === 1 ? "action" : "actions"}, ${b.looks} screen ${b.looks === 1 ? "read" : "reads"}`;
}

/**
 * When a run's clock starts (#200): the session's first step (`runs.started_at` plus that step's
 * `at_ms`), so the device session coming up (73 s on an iPad once) is not run time. Null while the
 * run has no step yet: nothing to time but the preparation stage.
 */
export function runClockStart(startedAt: string | null | undefined, firstStepAtMs: number | null | undefined): string | null {
  if (!startedAt || firstStepAtMs == null || !Number.isFinite(firstStepAtMs)) return null;
  const t = Date.parse(startedAt);
  if (!Number.isFinite(t)) return null;
  return new Date(t + Math.max(0, firstStepAtMs)).toISOString();
}

/** Milliseconds since `startedAt` at `now`; null when it has not started. Never negative. */
export function elapsedSince(startedAt: string | null | undefined, now: number): number | null {
  if (!startedAt) return null;
  const t = Date.parse(startedAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, now - t);
}

/** "0:56", "12:04", "1:02:03": the elapsed clock every live surface shows, ticking each second. */
export function fmtClock(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "–:––";
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** "0:56 of 5 min" with a budget, else the plain clock. */
export function clockWithBudget(ms: number | null | undefined, budgetMinutes: number | null | undefined): string {
  const clock = fmtClock(ms);
  return budgetMinutes ? `${clock} of ${budgetMinutes} min` : clock;
}

/** Share of a time budget spent, 0..1. */
export function budgetShare(ms: number | null | undefined, budgetMinutes: number | null | undefined): number {
  if (ms == null || !budgetMinutes) return 0;
  return Math.min(1, Math.max(0, ms / (budgetMinutes * 60_000)));
}

export interface ScenarioProgress {
  done: number;
  total: number;
}

/**
 * How many of a request's scenarios have finished. A fan-out batch counts a child as done when
 * its request ended or its run already wrote the scenario's verdict (the request stays
 * `running` for a few seconds while the worker wraps up, which read "0 / 3" while the run list
 * showed one done). A single-session run counts its verdicts against the scenarios it was
 * given.
 */
export function scenarioProgress(input: {
  /** Batch children; empty or absent for a single-session run. */
  children?: readonly { status: string; run_id?: string | null }[];
  /** Run ids that already have a verdict (`scenario_results`). */
  runsWithVerdict?: ReadonlySet<string>;
  /** A single-session run: how many scenarios it runs (null = all validated, unknown). */
  scenarioCount?: number | null;
  /** A single-session run: verdicts its run has written so far. */
  verdicts?: number;
}): ScenarioProgress | null {
  const children = input.children ?? [];
  if (children.length > 0) {
    let done = 0;
    for (const c of children) {
      const ended = c.status === "completed" || c.status === "failed" || c.status === "cancelled";
      if (ended || (c.run_id && input.runsWithVerdict?.has(c.run_id))) done += 1;
    }
    return { done, total: children.length };
  }
  const total = input.scenarioCount ?? null;
  const verdicts = input.verdicts ?? 0;
  if (total == null || total <= 0) return verdicts > 0 ? { done: verdicts, total: verdicts } : null;
  return { done: Math.min(verdicts, total), total };
}

/** "1 / 3 scenarios". */
export function scenarioProgressLabel(p: ScenarioProgress): string {
  return `${p.done} / ${p.total} ${p.total === 1 ? "scenario" : "scenarios"}`;
}

/** The drafting header's reading counter: files read, else searches run, else nothing (it
 * said "0 files" for a whole session while the drafter read the repository with the shell). */
export function readingLabel(activity: { reads?: number | null; searches?: number | null } | null | undefined): string | null {
  const reads = activity?.reads ?? 0;
  if (reads > 0) return `${reads} ${reads === 1 ? "file" : "files"}`;
  const searches = activity?.searches ?? 0;
  if (searches > 0) return `${searches} ${searches === 1 ? "search" : "searches"}`;
  return null;
}

/** "1 of 5 criteria passed": out of the scenario's own criteria (`expected`), not only the ones
 * judged so far, so a streaming verdict never reads "1 of 3" before it becomes "… of 5" (#170). */
export function criteriaPassedLabel(outcomes: readonly { outcome?: string | null }[], expected?: number | null): string {
  const passed = outcomes.filter((c) => c.outcome === "pass").length;
  const total = Math.max(outcomes.length, expected ?? 0);
  return `${passed} of ${total} ${total === 1 ? "criterion" : "criteria"} passed`;
}
