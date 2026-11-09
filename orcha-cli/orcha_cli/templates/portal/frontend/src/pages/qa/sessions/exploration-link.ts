/**
 * The way between an exploration and its run (one round trip, wherever a person lands): the
 * run page's "Back to exploration", the runs list's chip, the Running tray's entry and the live
 * wall's tile all name the exploration a run belongs to and say where it is now ("Exploring ·
 * 4:12 left", "Debrief ready"). Pure.
 */
import { EXPLORATION_STATUSES, SCOPE_TIERS, type Exploration, type ExplorationScope, type ExplorationStatus } from "./explorations";
import { qaHref } from "../parts";
import { explorationHref } from "./links";

export { explorationHref };

function isScope(v: unknown): v is ExplorationScope {
  return SCOPE_TIERS.some((t) => t.key === v);
}

/** "4:12" from milliseconds. */
function fmtClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The exploration a run belongs to, as much of it as the way back needs. Plain JSON. */
export interface RunExploration {
  id: string;
  name: string;
  status: ExplorationStatus;
  recipe: Exploration["recipe"];
  minutes: number | null;
  started_at: string | null;
  study_done_at: string | null;
  finished_at: string | null;
  /** How the run serves it: the explorer (each platform's run) or the drafter of a paired one. */
  role: "explorer" | "drafter";
}

const LIVE: ReadonlySet<ExplorationStatus> = new Set(["queued", "studying", "exploring", "checking"]);

/**
 * The run page's breadcrumb when the run is an exploration's: Explore › <exploration> › Run
 * (Runs › Map the app › Run for the map's crawl)
 * (not Runs › Run), each step back a link. Without a project the Explore step is plain text.
 */
export function explorationRunCrumbs(e: Pick<RunExploration, "id" | "name" | "role"> & Partial<Pick<RunExploration, "recipe">>): { label: string; href?: string }[] {
  const map = e.recipe === "map";
  return [
    { label: map ? "Runs" : "Sessions", href: qaHref({ view: "sessions" }) },
    { label: e.name, href: explorationHref(e.id) },
    { label: e.role === "drafter" ? "Drafting run" : "Run" },
  ];
}

/** Still moving (queued, studying, exploring or checking): its chips pulse and its clock ticks. */
export function isExplorationLive(status: ExplorationStatus): boolean {
  return LIVE.has(status);
}

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Milliseconds left in the current phase's time box, or null when it has none (or no start). */
export function phaseLeftMs(
  e: Pick<RunExploration, "status" | "recipe" | "minutes" | "started_at" | "study_done_at">,
  now: number,
): number | null {
  let start: number | null = null;
  let capS: number | null = null;
  if (e.status === "studying") {
    start = ms(e.started_at);
    capS = null;
  } else if (e.status === "exploring") {
    start = ms(e.study_done_at) ?? ms(e.started_at);
    capS = e.minutes != null ? e.minutes * 60 : null;
  }
  if (start == null || capS == null) return null;
  return Math.max(0, capS * 1000 - (now - start));
}

/**
 * Where the exploration is, in a few words: "Queued", "Studying · 0:41 left", "Exploring ·
 * 4:12 left", "Exploring · wrapping up", "Checking", "Debrief ready", "Failed", "Cancelled".
 */
export function explorationPhaseLabel(
  e: Pick<RunExploration, "status" | "recipe" | "minutes" | "started_at" | "study_done_at">,
  now: number,
): string {
  const timed = (word: string) => {
    const left = phaseLeftMs(e, now);
    if (left == null) return word;
    return left > 0 ? `${word} · ${fmtClock(left)} left` : `${word} · wrapping up`;
  };
  switch (e.status) {
    // The words every job page uses (`components/work/words`,).
    case "queued":
      return "Waiting for an agent";
    case "studying":
      return timed("Reading");
    case "exploring":
      return timed(e.recipe === "map" ? "Mapping" : "Exploring");
    case "checking":
      return "Checking what it found";
    case "done":
      return "Done";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Stopped";
  }
}

/** An `explorations` row (raw or parsed) as the way back reads it. */
export function toRunExploration(row: Record<string, unknown>, role: RunExploration["role"]): RunExploration {
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  const status = String(row.status ?? "queued");
  return {
    id: String(row.id),
    name: str(row.name) ?? "Exploration",
    status: (EXPLORATION_STATUSES as readonly string[]).includes(status) ? (status as ExplorationStatus) : "queued",
    recipe: isScope(row.recipe) ? row.recipe : null,
    minutes: typeof row.minutes === "number" ? row.minutes : null,
    started_at: str(row.started_at),
    study_done_at: str(row.study_done_at),
    finished_at: str(row.finished_at),
    role,
  };
}
