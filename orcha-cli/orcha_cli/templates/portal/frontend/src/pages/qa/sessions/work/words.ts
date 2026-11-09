/**
 * "Orcha at work": the words every job page shares, in one place. A job is anything
 * where Orcha works on the app on its own: an exploration (each recipe), the map's crawl,
 * drafting scenarios (from code, past explorations or a new one, for the gaps or one feature)
 * and building suites. Every page, button, run list row and pill names a job the same way and
 * says what it is doing with the same verbs, so the pages read as one product.
 */
import { scopeLabel, type ExplorationScope } from "../explorations";

// Phases ------------------------------------------------------------------------------------

/** The one phase vocabulary of every job. A job shows only the phases it has. */
export const WORK_PHASES = ["read", "explore", "draft", "review", "run"] as const;
export type WorkPhase = (typeof WORK_PHASES)[number];

export const PHASE_LABEL: Readonly<Record<WorkPhase, string>> = {
  read: "Read",
  explore: "Explore",
  draft: "Draft",
  review: "Review",
  run: "Run",
};

/** What each phase is, for a screen reader and the bar's tooltip. */
export const PHASE_HINT: Readonly<Record<WorkPhase, string>> = {
  read: "Embodent reads what describes the app: its code, tests, map and past explorations",
  explore: "Embodent uses the app on a device or in a browser",
  draft: "Embodent writes scenarios from what it read and saw",
  review: "What came out, ready for you to look at",
  run: "Run what you accepted",
};

export type WorkJob = "exploration" | "exploration-drafts" | "drafting" | "drafting-exploration" | "suites";

/** The phases a job has, in order. */
export function phasesFor(job: WorkJob): readonly WorkPhase[] {
  switch (job) {
    case "exploration":
      return ["read", "explore", "review"];
    case "exploration-drafts":
      return ["read", "explore", "draft", "review"];
    case "drafting":
      return ["read", "draft", "review", "run"];
    case "drafting-exploration":
      return ["read", "explore", "draft", "review", "run"];
    case "suites":
      return ["read", "draft", "review"];
  }
}

export type PhaseState = "done" | "active" | "todo";

/** Each phase of `phases` with its state, from the current one (`null`: not started yet;
 * `"finished"`: every phase done). */
export function phaseStates(
  phases: readonly WorkPhase[],
  current: WorkPhase | null | "finished",
): { key: WorkPhase; label: string; state: PhaseState }[] {
  const at = current === "finished" ? phases.length : current == null ? -1 : phases.indexOf(current);
  return phases.map((key, i) => ({
    key,
    label: PHASE_LABEL[key],
    state: at < 0 ? "todo" : i < at ? "done" : i === at ? "active" : "todo",
  }));
}

/** An exploration's status as a phase of the bar: studying reads, exploring and checking
 * explore (checking is the explorer re-checking its findings), done is the review. */
export function explorationPhase(status: string): WorkPhase | null | "finished" {
  switch (status) {
    case "queued":
      return null;
    case "studying":
      return "read";
    case "exploring":
    case "checking":
      return "explore";
    case "done":
      return "review";
    default:
      return null;
  }
}

// Status ------------------------------------------------------------------------------------

export type WorkStatus = "idle" | "queued" | "preparing" | "running" | "done" | "failed" | "stopped";

/** The status word on the title row: one set of words for every job. `waiting` names what a
 * queued job waits for when it is not a worker ("Waiting for a device"). */
export function statusLabel(status: WorkStatus, doing?: string | null, waiting?: string | null): string {
  switch (status) {
    case "idle":
      return "Not started";
    case "queued":
      return waiting || "Waiting for an agent";
    case "preparing":
      return "Getting the device ready";
    case "running":
      return doing || "Working";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
  }
}

/** An exploration row's status as a job status. */
export function explorationWorkStatus(status: string): WorkStatus {
  if (status === "queued") return "queued";
  if (status === "done") return "done";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "stopped";
  return "running";
}

/** What an exploration is doing, as the status word says it. */
export function explorationDoing(status: string, recipe?: string | null): string | null {
  switch (status) {
    case "studying":
      return "Reading";
    case "exploring":
      return recipe === "map" ? "Mapping" : recipe === "check" ? "Checking" : "Exploring";
    case "checking":
      return "Checking what it found";
    default:
      return null;
  }
}

/** A request row's status (`run_requests.status`) as a job status. */
export function requestWorkStatus(status: string | null | undefined): WorkStatus {
  if (status === "running") return "running";
  if (status === "completed") return "done";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "stopped";
  return "queued";
}

// Names -------------------------------------------------------------------------------------

/** An exploration's job name by recipe: the same words as the composer's recipe cards. */
export function recipeJobName(recipe: ExplorationScope | null | undefined): string {
  return recipe ? scopeLabel(recipe) : "Custom";
}

/**
 * A drafting job's name from its focus (`run_requests.focus`): what the button that started it
 * says. "Draft the gaps" (the map's gaps), "Draft scenarios for Onboarding" (one feature or one
 * place on the map), "Draft failure scenarios", else "Draft scenarios".
 */
export function draftingJobName(focus: string | null | undefined, label?: string | null): string {
  if (focus === "map:gaps") return "Draft the gaps";
  if (focus === "failures") return "Draft failure scenarios";
  if (focus?.startsWith("feature:") || focus?.startsWith("map:")) {
    return label ? `Draft scenarios for ${label}` : "Draft scenarios for this feature";
  }
  return "Draft scenarios";
}

export const SUITES_JOB_NAME = "Build suites";

// Counters and the calm line ------------------------------------------------------------------

/** "84 files read · 66 searches": the reading counters, both of them, so the header never
 * shows one number while the log tells another. Null before anything was read. */
export function readCounts(activity: { reads?: number | null; searches?: number | null } | null | undefined): string | null {
  const reads = activity?.reads ?? 0;
  const searches = activity?.searches ?? 0;
  const parts: string[] = [];
  if (reads > 0) parts.push(`${reads} ${reads === 1 ? "file" : "files"} read`);
  if (searches > 0) parts.push(`${searches} ${searches === 1 ? "search" : "searches"}`);
  return parts.length ? parts.join(" · ") : null;
}

/** The newest file Orcha opened, from the activity: its last read file, else the path of a
 * "Reading …" note. Null when it has not opened one yet. */
export function newestFile(activity: { read_files?: readonly string[] | null; note?: string | null } | null | undefined): string | null {
  const files = activity?.read_files ?? [];
  const last = files[files.length - 1];
  if (last) return last;
  const note = activity?.note ?? "";
  return note.startsWith("Reading ") && !note.startsWith("Reading the ") ? note.slice("Reading ".length).trim() || null : null;
}

/** A path as the eye reads it: the file name, with its folder after it when there is one. */
export function shortPath(path: string): { name: string; dir: string } {
  const clean = path.replace(/\/+$/, "");
  const i = clean.lastIndexOf("/");
  return i < 0 ? { name: clean, dir: "" } : { name: clean.slice(i + 1), dir: clean.slice(0, i) };
}

/**
 * The stage a drafting job is at, from data only and never going backwards: reading until the
 * first draft lands, drafting after. The agent's last tool call (a search between two drafts)
 * no longer turns the card into "Mapping the repository" while drafts are landing.
 */
export type DraftingStage = "queued" | "reading" | "drafting" | "done" | "failed" | "stopped";

export function draftingStage({ status, drafted }: { status: string | null | undefined; drafted: number }): DraftingStage {
  const s = requestWorkStatus(status);
  if (s === "queued" || s === "preparing") return "queued";
  if (s === "done") return "done";
  if (s === "failed") return "failed";
  if (s === "stopped") return "stopped";
  return drafted > 0 ? "drafting" : "reading";
}

export const DRAFTING_STAGE_LABEL: Readonly<Record<DraftingStage, string>> = {
  queued: "Waiting for an agent",
  reading: "Reading",
  drafting: "Drafting",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

/**
 * The calm line under a live drafting job, so a quiet minute never reads as stuck: what is
 * normal right now. "Reading 84 files: the first drafts usually land within a few minutes".
 */
export function calmLine({
  stage,
  reads,
  drafted,
  sources,
}: {
  stage: DraftingStage;
  reads: number;
  drafted: number;
  /** What it reads: "code", "exploration" (past explorations only) or "both". */
  sources?: string | null;
}): string | null {
  if (stage === "queued") return "The agent picks this up as soon as it is free.";
  if (stage === "reading") {
    const what = reads > 0 ? `Reading ${reads} ${reads === 1 ? "file" : "files"}` : sources === "exploration" ? "Reading the explorations" : "Reading the code";
    return `${what}: the first drafts usually land within a few minutes.`;
  }
  if (stage === "drafting") {
    return `${drafted} drafted so far. More land every minute or so until Embodent has covered what it read.`;
  }
  return null;
}

// Time --------------------------------------------------------------------------------------

/** "4:26", "1:02:05": a running clock. */
export function fmtClock(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "0:00";
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** "8m 44s", "1h 02m", "42s": how long a finished job took. */
export function fmtTook(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Seconds between two ISO times (or until `now`), null when the start is unknown. */
export function secondsBetween(from: string | null | undefined, to: string | number | null | undefined): number | null {
  if (!from) return null;
  const a = Date.parse(from);
  const b = typeof to === "number" ? to : to ? Date.parse(to) : NaN;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, (b - a) / 1000);
}

/** "$2.48": a model cost, null when unknown. */
export function fmtCost(usd: number | null | undefined): string | null {
  if (usd == null || !Number.isFinite(usd) || usd < 0) return null;
  return usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}
