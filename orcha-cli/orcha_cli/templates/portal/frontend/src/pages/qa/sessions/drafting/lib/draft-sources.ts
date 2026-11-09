/**
 * What scenario drafting reads, as Run check offers it:
 *
 *   code  the repository only
 *   past  the repository plus the project's completed explorations (the newest three)
 *   new   the repository, and a new exploration the same agent walks first in the same task;
 *         what it drafts joins the same review list
 *
 * Without a repository the code is left out ("Past explorations", "A new exploration").
 * Also the view model of the new exploration on the page: its stage and one status line.
 */
import { isOpenPhase, type DraftingPhase } from "./drafting-route";
import type { DraftSources, RequestActivity, TargetKind } from "./types";

export type DraftChoice = "code" | "past" | "new";

/** An exploration this recent is good enough to draft from without walking the app again. */
export const RECENT_EXPLORATION_DAYS = 7;
const DAY_MS = 86_400_000;

const KIND_LABEL: Record<TargetKind, string> = { ios: "iOS", android: "Android", web: "Web", desktop: "Desktop" };

/** What `GET C/drafting/sources` reports. */
export interface ExplorationSummary {
  /** Completed explorations with at least one step (what a drafter can read). */
  count: number;
  /** When the newest one ran. */
  latest: string | null;
  /** Its platform. */
  latestKind?: TargetKind | null;
  /** Exploration reports written for the project. */
  reports?: number;
  /** Per platform, most explored first. */
  kinds?: { kind: TargetKind; count: number; latest: string | null }[];
}

export function isRecentExploration(latest: string | null | undefined, now: number): boolean {
  if (!latest) return false;
  const t = Date.parse(latest);
  return Number.isFinite(t) && now - t <= RECENT_EXPLORATION_DAYS * DAY_MS;
}

/**
 * The option selected when the picker opens: past explorations when a recent one exists
 * (≤ 7 days), else a new exploration when there is a platform to walk, else the code.
 */
export function defaultDraftChoice({
  hasRepo,
  explorations,
  hasTarget,
  now,
}: {
  hasRepo: boolean;
  explorations: ExplorationSummary | null;
  hasTarget: boolean;
  now: number;
}): DraftChoice {
  if ((explorations?.count ?? 0) > 0 && isRecentExploration(explorations?.latest, now)) return "past";
  if (hasTarget) return "new";
  if (hasRepo) return "code";
  return (explorations?.count ?? 0) > 0 ? "past" : "code";
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** "9 explorations · last Oct 3 on Web" (and the report count when there are reports). */
export function explorationsLine(ex: ExplorationSummary | null): string {
  if (ex == null) return "Checking explorations…";
  if (ex.count === 0) return "No explorations yet";
  const noun = ex.count === 1 ? "exploration" : "explorations";
  const reports = ex.reports ? ` (${ex.reports} ${ex.reports === 1 ? "report" : "reports"})` : "";
  const when = ex.latest ? ` · last ${shortDate(ex.latest)}` : "";
  const where = ex.latestKind ? ` on ${KIND_LABEL[ex.latestKind]}` : "";
  return `${ex.count} ${noun}${reports}${when}${where}`;
}

/** "iOS 5 · Web 4": the platforms explored, when there is more than one. */
export function explorationKindsLine(ex: ExplorationSummary | null): string | null {
  const kinds = ex?.kinds ?? [];
  if (kinds.length < 2) return null;
  return kinds.map((k) => `${KIND_LABEL[k.kind]} ${k.count}`).join(" · ");
}

export interface DraftChoiceOption {
  value: DraftChoice;
  label: string;
  /** One muted line under the label. */
  detail: string;
  disabled: boolean;
}

export function draftChoiceOptions({
  hasRepo,
  explorations,
  hasTarget,
}: {
  hasRepo: boolean;
  explorations: ExplorationSummary | null;
  hasTarget: boolean;
}): DraftChoiceOption[] {
  const none = explorations != null && explorations.count === 0;
  return [
    {
      value: "code",
      label: "Code only",
      detail: hasRepo ? "Routes, screens, forms and auth flows in the repository." : "Add a repository to the project first.",
      disabled: !hasRepo,
    },
    {
      value: "past",
      label: hasRepo ? "Code + past explorations" : "Past explorations",
      detail: none ? "No explorations yet" : `${explorationsLine(explorations)}. The newest three are read.`,
      disabled: none,
    },
    {
      value: "new",
      label: hasRepo ? "Code + a new exploration" : "A new exploration",
      detail: !hasTarget
        ? "Add a platform to the project first."
        : hasRepo
          ? "Walks the app first, then drafts from the code and the screens it reached."
          : "Explores the app, then drafts from what it saw.",
      disabled: !hasTarget,
    },
  ];
}

/**
 * The drafting request queued right away: what it reads, or null when there is none (a new
 * exploration without a repository — its follow-up pass is the only drafting).
 */
export function choiceSources(choice: DraftChoice, hasRepo: boolean): DraftSources | null {
  if (choice === "code") return "code";
  if (choice === "past") return hasRepo ? "both" : "exploration";
  return hasRepo ? "code" : null;
}

export function canStartChoice(
  choice: DraftChoice,
  { hasRepo, explorations, hasTarget }: { hasRepo: boolean; explorations: ExplorationSummary | null; hasTarget: boolean },
): boolean {
  if (choice === "code") return hasRepo;
  if (choice === "past") return (explorations?.count ?? 0) > 0;
  return hasTarget;
}

export function startLabel(choice: DraftChoice, hasRepo: boolean): string {
  if (choice === "code") return "Draft from the code";
  if (choice === "past") return hasRepo ? "Draft from code and past explorations" : "Draft from past explorations";
  return hasRepo ? "Draft and explore" : "Explore, then draft";
}

/** The choice a reopened drafting request was started with. */
export function choiceForRequest(sources: DraftSources | null, hasExploration: boolean): DraftChoice {
  if (hasExploration) return "new";
  return sources === "code" || sources == null ? "code" : "past";
}

// ---------- the new exploration on the page ----------

/** The exploratory request queued with the drafting (the fields the page reads). */
export interface ExplorationPassRequest {
  id: string;
  status: string;
  created_at: string;
  started_at: string | null;
  finished_at?: string | null;
  minutes: number | null;
  run_id: string | null;
  error: string | null;
  target_kind: TargetKind;
  locator: string;
  /** The device it runs on, by name. */
  device?: string | null;
  /** Why it is still queued. */
  waiting_reason?: string | null;
  summary?: unknown;
  cancel_requested_at?: string | null;
  progress?: RequestActivity | null;
  /** The exploration's run as the page last read it. */
  run?: ExplorationRunInfo | null;
}

/** What the page reads of the exploration's run. */
export interface ExplorationRunInfo {
  /** `runs.status`: running | completed | failed | cancelled. */
  status: string;
  /** Blocker findings filed on it. */
  blockers: number;
  /** The first blocker's title ("App crashes at launch"), when there is one. */
  blockerTitle: string | null;
  /** The first blocker's screenshot (a step's `frame_path`), when it has one. */
  blockerFrame?: string | null;
  /** The device it runs on. */
  deviceName?: string | null;
}

/** One screenshot the exploration's run uploaded so far. */
export interface PassFrame {
  seq: number;
  frame_path: string;
}

/** The drafting that works from it. */
export interface FollowUpRequest {
  id: string;
  status: string;
  error: string | null;
  summary?: { drafted?: number } | null;
}

export type FollowUpRecord =
  | { status: "queued"; request_id: string }
  | { status: "skipped"; reason: string }
  /** One of several platforms explored together: drafted once the last of them finishes. */
  | { status: "waiting"; reason: string };

/** `summary.follow_up` on the exploration: which drafting works from it. */
export function followUpRecord(summary: unknown): FollowUpRecord | null {
  let s = summary;
  if (typeof s === "string") {
    try {
      s = JSON.parse(s);
    } catch {
      return null;
    }
  }
  const f = (s as { follow_up?: unknown } | null)?.follow_up as Record<string, unknown> | undefined;
  if (!f || typeof f !== "object") return null;
  if (f.status === "queued" && typeof f.request_id === "string") return { status: "queued", request_id: f.request_id };
  if (f.status === "skipped") return { status: "skipped", reason: typeof f.reason === "string" ? f.reason : "Not drafted." };
  if (f.status === "waiting") return { status: "waiting", reason: typeof f.reason === "string" ? f.reason : "" };
  return null;
}

export type ExplorationPassStage =
  | "queued" // waiting for an agent
  | "exploring"
  | "handoff" // finished; the drafting from it has not started
  | "drafting" // the follow-up drafting is queued or running
  | "done" // the follow-up drafting finished
  | "draft-failed" // the follow-up drafting failed or was stopped
  | "skipped" // finished, but nothing was drafted from it (budget, no screens, drafting stopped)
  | "failed"
  | "cancelled";

/** Still moving: the page keeps polling and offers Stop. */
export function isOpenPassStage(stage: ExplorationPassStage | null): boolean {
  return stage === "queued" || stage === "exploring" || stage === "handoff" || stage === "drafting";
}

export function explorationPassStage(e: ExplorationPassRequest, followUp: FollowUpRequest | null): ExplorationPassStage {
  if (e.status === "queued") return "queued";
  // The run ended but its session is still closing: no longer exploring, so no live view and
  // no running clock.
  if (e.status === "running") return e.run && e.run.status !== "running" ? "handoff" : "exploring";
  if (e.status === "cancelled") return "cancelled";
  if (e.status === "failed") return "failed";
  const record = followUpRecord(e.summary);
  if (record?.status === "skipped") return "skipped";
  if (!record || record.status === "waiting") return "handoff";
  if (!followUp || followUp.status === "queued" || followUp.status === "running") return "drafting";
  return followUp.status === "completed" ? "done" : "draft-failed";
}

/** "2:10" */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The new exploration's one status line ("Exploring FleetMate on Web · 3 screens · 2:10 of 5:00"). */
export function explorationPassLine({
  e,
  followUp,
  projectName,
  screens,
  drafted,
  now,
}: {
  e: ExplorationPassRequest;
  followUp: FollowUpRequest | null;
  projectName: string;
  /** Distinct screens seen so far. */
  screens: number;
  /** Drafts the follow-up has written so far. */
  drafted: number;
  now: number;
}): string {
  const line = passStageLine({ e, followUp, projectName, screens, drafted, now });
  const stage = explorationPassStage(e, followUp);
  const blockers = e.run?.blockers ?? 0;
  if (blockers === 0 || stage === "queued" || stage === "exploring") return line;
  // A blocker is why the exploration ended early (a crash at launch): say so first.
  const what = e.run?.blockerTitle ? `: ${e.run.blockerTitle}` : "";
  return `Exploration ended${what} (${blockers} ${blockers === 1 ? "blocker" : "blockers"}) · ${line}`;
}

/** A queued phone exploration whose device another run holds (`worker_busy`). */
export function passWaitsForDevice(e: Pick<ExplorationPassRequest, "status" | "target_kind" | "waiting_reason">): boolean {
  if (e.status !== "queued" || (e.target_kind !== "ios" && e.target_kind !== "android")) return false;
  return e.waiting_reason === "worker_busy";
}

function passStageLine({
  e,
  followUp,
  projectName,
  screens,
  drafted,
  now,
}: {
  e: ExplorationPassRequest;
  followUp: FollowUpRequest | null;
  projectName: string;
  screens: number;
  drafted: number;
  now: number;
}): string {
  const where = KIND_LABEL[e.target_kind] ?? e.target_kind;
  const stage = explorationPassStage(e, followUp);
  switch (stage) {
    case "queued":
      // Another run holds its device: it waits for that device, as the exploration's own page
      // says ("Waiting for a device"), not for an agent.
      if (passWaitsForDevice(e)) {
        const device = e.device || "a device";
        return `Exploration of ${projectName} on ${where} waiting for ${device}: it starts as soon as that device is free`;
      }
      return `Exploration of ${projectName} on ${where} queued, waiting for an agent`;
    case "exploring": {
      if (e.cancel_requested_at) return "Stopping the exploration…";
      // Getting the device ready: the budget hasn't started, so no clock and no "Exploring" yet.
      if (isPassSettingUp(e)) return `Starting the exploration for ${projectName} on ${where}…`;
      const parts = [`Exploring ${projectName} on ${where}`, `${screens} ${screens === 1 ? "screen" : "screens"}`];
      const started = e.started_at;
      if (started) {
        const spent = now - Date.parse(started);
        const budget = (e.minutes ?? 0) * 60_000;
        parts.push(budget > 0 ? `${clock(Math.min(spent, budget))} of ${clock(budget)}` : clock(spent));
      }
      return parts.join(" · ");
    }
    case "handoff":
      if (e.status === "running") return "Exploration ended · wrapping up…";
      return followUpRecord(e.summary)?.status === "waiting"
        ? `Exploration on ${where} finished · drafting once the other platforms finish…`
        : "Exploration finished · queueing the drafting from it…";
    case "drafting":
      return followUp?.status === "running"
        ? `Drafting from the new exploration… ${drafted} drafted`
        : "Drafting from the new exploration…";
    case "done": {
      const n = followUp?.summary?.drafted ?? drafted;
      return n === 0 ? "Drafted from the new exploration · nothing new" : `Drafted from the new exploration · ${n} more`;
    }
    case "draft-failed":
      return followUp?.status === "cancelled"
        ? "Drafting from the new exploration was stopped"
        : `Drafting from the new exploration failed: ${followUp?.error ?? "unknown error"}`;
    case "skipped": {
      const record = followUpRecord(e.summary);
      return record?.status === "skipped" ? record.reason : "Not drafted from the exploration.";
    }
    case "failed":
      return `Exploration failed${e.error ? `: ${e.error}` : ""} · nothing was drafted from it`;
    case "cancelled":
      return "Exploration cancelled · nothing was drafted from it";
  }
}

/** A running exploration still resolving, building or installing the app: its time budget
 * hasn't started, and there is nothing on the device to watch yet. */
export function isPassSettingUp(e: ExplorationPassRequest): boolean {
  return e.status === "running" && e.started_at === null;
}

/** The tag a follow-up draft wears in the review list: "from exploration Oct 5". */
export function explorationTag(e: Pick<ExplorationPassRequest, "created_at" | "started_at">): string {
  return `from exploration ${shortDate(e.started_at ?? e.created_at)}`;
}

/**
 * The page's one phase (stage rail, Stop, status glyph) from the drafting from code and the
 * new exploration: open while either is; without a code pass, the exploration alone.
 */
export function combinedPhase(code: DraftingPhase, pass: ExplorationPassStage | null): DraftingPhase {
  if (pass == null) return code;
  const passOpen = isOpenPassStage(pass);
  if (code === "idle") {
    if (pass === "queued") return "queued";
    if (passOpen) return "running";
    if (pass === "done") return "completed";
    return pass === "cancelled" ? "cancelled" : "failed";
  }
  if (isOpenPhase(code)) return code;
  return passOpen ? "running" : code;
}

/** Whether the status bar speaks for the exploration rather than the drafting from code. */
export function passLeadsStatus(code: DraftingPhase, pass: ExplorationPassStage | null): boolean {
  if (pass == null) return false;
  if (code === "idle") return true;
  return !isOpenPhase(code) && code !== "failed" && isOpenPassStage(pass);
}
