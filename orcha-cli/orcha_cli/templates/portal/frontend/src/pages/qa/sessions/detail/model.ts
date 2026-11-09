/**
 * Pure models behind a session's page. Everything the detail page decides
 * without touching the DOM lives here, so it can be tested on its own: which face a row shows,
 * the phase timeline, the charter's progress, how a journey is drawn, how the report groups
 * its findings per lens, and how live change-feed updates fold into the page's state.
 */
import {
  LENS_META,
  MEASURED_KIND_LENS,
  missionsPhrase,
  STUDY_SCREENS_KEPT,
  featureNameFromKey,
  studySource,
  type CharterItem,
  type CharterStatus,
  type Exploration,
  type ExplorationBriefing,
  type ExplorationResult,
  type Journey,
  type Lens,
  type ResultFinding,
  type ResultSeverity,
  type StudyManifest,
  type StudyScreen,
} from "../explorations";
import type { Finding } from "../explorations";
/** A queued session's place in line and the agent it waits for. */
export interface QueuePlace {
  position: number | null;
  waiting: string | null;
  /** Waiting for a device another run holds: which, and who has it. */
  device?: string | null;
  used_by?: string | null;
}

/** What the queued face says: the agent it waits for and its place in line. */
export function queuedWords(q: QueuePlace): { title: string; body: string } {
  if (q.device) {
    return {
      title: `Waiting for ${q.device}${q.used_by ? ` · used by ${q.used_by}` : ""}`,
      body: q.position == null || q.position === 1 ? "Next in line. It starts by itself when the device is free." : `Number ${q.position} in line. It starts by itself when the device is free.`,
    };
  }
  const who = q.waiting ?? "an agent";
  return {
    title: q.waiting ? `Waiting for ${q.waiting}` : "Waiting for an agent",
    body:
      q.position == null || q.position === 1
        ? `It starts on its own as soon as ${who} picks up the task.`
        : `Number ${q.position} in line. It starts on its own as soon as ${who} picks up the task.`,
  };
}

export interface PassFrame {
  seq: number;
  frame_path: string;
}

// Faces ---------------------------------------------------------------------------------------

/**
 * What the page shows for a row. Running rows get mission control (one face per phase), a
 * finished row its report, and a failed or cancelled row a clear ended state.
 */
export type DetailFace = "queued" | "study" | "explore" | "check" | "report" | "ended";

export function selectFace(e: Pick<Exploration, "status">): DetailFace {
  switch (e.status) {
    case "queued":
      return "queued";
    case "studying":
      return "study";
    case "exploring":
      return "explore";
    case "checking":
      return "check";
    case "failed":
    case "cancelled":
      return "ended";
    case "done":
      return "report";
  }
}

/** True for the faces that are still moving (mission control): the page listens live. */
export function isRunningFace(face: DetailFace): boolean {
  return face === "queued" || face === "study" || face === "explore" || face === "check";
}

// Phase timeline ------------------------------------------------------------------------------

export const PHASES = [
  { key: "study", label: "Study" },
  { key: "explore", label: "Explore" },
  { key: "check", label: "Check" },
  { key: "debrief", label: "Debrief" },
] as const;
export type PhaseKey = (typeof PHASES)[number]["key"];
export type PhaseState = "done" | "active" | "todo";

/** The state of each phase for a status: everything before the current phase is done. */
export function phaseStates(status: Exploration["status"]): { key: PhaseKey; label: string; state: PhaseState }[] {
  const current: number =
    status === "queued" || status === "studying"
      ? 0
      : status === "exploring"
        ? 1
        : status === "checking"
          ? 2
          : 3;
  const finished = status === "done";
  return PHASES.map((p, i) => ({
    key: p.key,
    label: p.label,
    state: i < current || (finished && i === current) ? "done" : i === current && status !== "queued" ? "active" : "todo",
  }));
}

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Time spent and allowed in the current phase, for the timeline's caption and the budget bar.
 * Study has no allowance of its own; exploring gets the session's minutes. `null`
 * fields mean "not known yet" (no start time, or a custom run with no cap).
 */
export function phaseClock(
  e: Pick<Exploration, "status" | "recipe" | "minutes" | "started_at" | "study_done_at">,
  now: number,
): { elapsedS: number | null; capS: number | null; fraction: number | null; overS: number } {
  let start: number | null = null;
  let cap: number | null = null;
  if (e.status === "studying") {
    start = ms(e.started_at);
    cap = null;
  } else if (e.status === "exploring") {
    start = ms(e.study_done_at) ?? ms(e.started_at);
    cap = e.minutes != null ? e.minutes * 60 : null;
  } else if (e.status === "checking") {
    start = ms(e.study_done_at) ?? ms(e.started_at);
    cap = e.minutes != null ? e.minutes * 60 : null;
  }
  const elapsedS = start == null ? null : Math.max(0, Math.round((now - start) / 1000));
  const fraction = elapsedS != null && cap ? Math.min(1, elapsedS / cap) : null;
  // A study past its allowance: the exploring clock has started either way (the worker moves the
  // exploration on at the cap); until that lands, say it ran over rather than count past the cap.
  const overS = e.status === "studying" && elapsedS != null && cap ? Math.max(0, elapsedS - cap) : 0;
  return { elapsedS, capS: cap, fraction, overS };
}

/** "1:05" style clock for the timeline. */
export function fmtClock(seconds: number | null): string {
  if (seconds == null) return "–:––";
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Charter -------------------------------------------------------------------------------------

/** Settled outcomes: a mission that is no longer planned or in progress. */
export const SETTLED: ReadonlySet<CharterStatus> = new Set(["covered", "partial", "blocked", "bug"]);

export const CHARTER_LABEL: Record<CharterStatus, string> = {
  planned: "Planned",
  active: "In progress",
  covered: "Covered",
  partial: "Partly covered",
  blocked: "Blocked",
  bug: "Bug found",
};

export interface CharterProgress {
  total: number;
  settled: number;
  counts: Record<CharterStatus, number>;
  /** The mission being worked on: the first `active` one, else (while exploring) the first
   * still planned, else none. */
  activeId: string | null;
  /** 0..1 */
  fraction: number;
}

export function charterProgress(items: readonly CharterItem[], exploring = true): CharterProgress {
  const counts: Record<CharterStatus, number> = { planned: 0, active: 0, covered: 0, partial: 0, blocked: 0, bug: 0 };
  for (const it of items) counts[it.status] = (counts[it.status] ?? 0) + 1;
  const settled = items.filter((it) => SETTLED.has(it.status)).length;
  const active =
    items.find((it) => it.status === "active") ?? (exploring ? items.find((it) => it.status === "planned") : undefined);
  return {
    total: items.length,
    settled,
    counts,
    activeId: active?.id ?? null,
    fraction: items.length ? settled / items.length : 0,
  };
}

/** The charter's missions as the summary, the report and the cards say them: "1 of 2
 * missions partly covered, 1 blocked". Never "2 of 2 done": a partly covered or blocked mission
 * is not done (QA 2026-10-28, Slate b8ce528b). */
export function charterPhrase(p: Pick<CharterProgress, "total" | "counts">): string {
  const { covered, partial, bug, blocked } = p.counts;
  return missionsPhrase({ total: p.total, covered, partial, bug, blocked });
}

/** What the missions that are not plainly covered came to: "1 partly covered, 1 blocked". */
export function charterOthers(p: Pick<CharterProgress, "counts">): string {
  const words: [number, string][] = [
    [p.counts.partial, "partly covered"],
    [p.counts.bug, "found a bug"],
    [p.counts.blocked, "blocked"],
  ];
  return words
    .filter(([n]) => n > 0)
    .map(([n, w]) => `${n} ${w}`)
    .join(", ");
}

// Journeys ------------------------------------------------------------------------------------

export type JourneyOutcome = NonNullable<ExplorationResult["journeys"]>[number]["outcome"];
export type JourneyStepState = "passed" | "failed" | "blocked" | "not_reached" | "todo";

export interface JourneyPath {
  id: string;
  name: string;
  persona: string | null;
  outcome: JourneyOutcome;
  steps: { label: string; state: JourneyStepState }[];
  /** Where it broke, when the explorer said so and no step matched it. */
  brokeNote: string | null;
  brokeIndex: number | null;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Index of the step `brokeAt` names: an exact match, else one that contains the other. */
function matchStep(steps: readonly string[], brokeAt: string): number {
  const b = norm(brokeAt);
  if (!b) return -1;
  const exact = steps.findIndex((s) => norm(s) === b);
  if (exact !== -1) return exact;
  return steps.findIndex((s) => {
    const n = norm(s);
    return n !== "" && (n.includes(b) || b.includes(n));
  });
}

/**
 * Each journey as a path of steps: passed up to where it broke, the broken step failed (or
 * blocked), the rest never reached. Journeys the result has no outcome for are `not_run`. The
 * briefing's journeys give the steps; a result journey the briefing does not know is drawn as
 * a single step.
 */
export function journeyPaths(
  briefingJourneys: readonly Journey[] | null | undefined,
  resultJourneys: ExplorationResult["journeys"] | null | undefined,
): JourneyPath[] {
  const outcomes = new Map((resultJourneys ?? []).map((j) => [j.id, j]));
  const known = new Set<string>();
  const out: JourneyPath[] = [];
  const build = (id: string, name: string, persona: string | null, steps: readonly string[]): JourneyPath => {
    const r = outcomes.get(id);
    const outcome: JourneyOutcome = r?.outcome ?? "not_run";
    const labels = steps.length ? steps : [name];
    let brokeIndex: number | null = null;
    let brokeNote: string | null = null;
    let states: JourneyStepState[];
    if (outcome === "passed") states = labels.map(() => "passed");
    else if (outcome === "not_run") states = labels.map(() => "todo");
    else {
      const idx = r?.broke_at ? matchStep(labels, r.broke_at) : -1;
      const at = idx === -1 ? labels.length - 1 : idx;
      if (idx === -1 && r?.broke_at) brokeNote = r.broke_at;
      brokeIndex = at;
      states = labels.map((_, i) => (i < at ? "passed" : i === at ? (outcome === "blocked" ? "blocked" : "failed") : "not_reached"));
    }
    return {
      id,
      name: r?.name || name,
      persona,
      outcome,
      steps: labels.map((label, i) => ({ label, state: states[i] })),
      brokeNote,
      brokeIndex,
    };
  };
  for (const j of briefingJourneys ?? []) {
    known.add(j.id);
    out.push(build(j.id, j.name, j.persona ?? null, j.steps ?? []));
  }
  for (const r of resultJourneys ?? []) {
    if (!known.has(r.id)) out.push(build(r.id, r.name, null, []));
  }
  return out;
}

// Findings by lens ----------------------------------------------------------------------------

const SEV_ORDER: readonly ResultSeverity[] = ["blocker", "major", "minor", "cosmetic", "info"];
export function sevIndex(s: ResultSeverity): number {
  const i = SEV_ORDER.indexOf(s);
  return i === -1 ? SEV_ORDER.length : i;
}

export function lensLabel(lens: Lens): string {
  return LENS_META.find((m) => m.key === lens)?.label ?? lens;
}

/** Points a blocked mission takes off the overall score (`explorations.BLOCKED_ITEM_PENALTY`). */
export const BLOCKED_MISSION_POINTS = 10;

/**
 * Why the overall ring differs from the lens scores beside it, or null when it does not: the
 * overall is the graded lenses' average less 10 per blocked mission (`compose_result`), so Slate
 * 200b36b0 read "80" next to "Works right 90" with nothing saying why (QA 2026-10-28).
 * "Overall 80: Works right's 90, less 10 for 1 blocked mission."
 */
export function scoreNote(result: Pick<ExplorationResult, "score" | "lenses" | "charter">): string | null {
  const graded = result.lenses.filter((l) => l.grade !== "unknown");
  const blocked = result.charter?.blocked ?? 0;
  if (!graded.length || !blocked) return null;
  const avg = Math.round(graded.reduce((n, l) => n + l.score, 0) / graded.length);
  if (avg === result.score) return null;
  const from = graded.length === 1 ? `${lensLabel(graded[0].lens)}'s ${avg}` : `the lenses' average of ${avg}`;
  const off = Math.min(avg, BLOCKED_MISSION_POINTS * blocked);
  return `Overall ${result.score}: ${from}, less ${off} for ${blocked} blocked ${blocked === 1 ? "mission" : "missions"}.`;
}

/** The lenses a report shows: the ones picked, in the canonical order. */
export function pickedLenses(lenses: readonly Lens[] | null | undefined, result: ExplorationResult | null): Lens[] {
  const picked = new Set<Lens>(lenses && lenses.length ? lenses : ["works"]);
  for (const l of result?.lenses ?? []) picked.add(l.lens);
  return LENS_META.map((m) => m.key).filter((k) => picked.has(k));
}

export interface MeasuredGroup {
  /** The check, as a reader names it ("Low contrast"). */
  label: string;
  severity: ResultSeverity;
  /** Occurrences across every screen. */
  count: number;
  screens: { screen: string; count: number; finding: ResultFinding }[];
}

export interface LensFindings {
  lens: Lens;
  agent: ResultFinding[];
  measured: MeasuredGroup[];
  total: number;
}

const COUNT_PATTERNS: readonly RegExp[] = [/\s*[×x]\s*(\d+)\s*$/i, /\s*\((\d+)\)\s*$/, /^\s*(\d+)\s*[×x]?\s+/i];

/**
 * A measured title without its occurrence count, and the count: the backend writes one
 * finding per kind and screen with the count in the title ("Low contrast ×4", "Low contrast
 * (4)", "4 low contrast"). No count means one.
 */
export function splitCount(title: string): { label: string; count: number } {
  for (const re of COUNT_PATTERNS) {
    const m = re.exec(title);
    if (m) {
      const label = title.replace(re, "").trim();
      return { label: label.charAt(0).toUpperCase() + label.slice(1), count: Number(m[1]) || 1 };
    }
  }
  return { label: title.trim(), count: 1 };
}

/** A measured kind key ("low_contrast") as words, for grouping by kind when titles vary. */
function kindOf(f: ResultFinding): string | null {
  for (const kind of Object.keys(MEASURED_KIND_LENS)) {
    if (f.fingerprint.includes(kind) || norm(f.title).includes(kind.replace(/_/g, " "))) return kind;
  }
  return null;
}

/**
 * The report's findings for each picked lens: the agent's own findings first (most severe
 * first), then the measured checks collapsed into one row per check, listing the screens it
 * failed on. Findings of lenses that were not picked are dropped: they are stored, never
 * shown. Measured checks only ever show under Accessible and Looks right.
 */
export function findingsByLens(result: ExplorationResult | null, picked: readonly Lens[]): LensFindings[] {
  const findings = result?.findings ?? [];
  return picked.map((lens) => {
    const mine = findings.filter((f) => f.lens === lens);
    const agent = mine
      .filter((f) => f.source === "agent")
      .sort((a, b) => sevIndex(a.severity) - sevIndex(b.severity) || (a.step_seq ?? 0) - (b.step_seq ?? 0));
    const groups = new Map<string, MeasuredGroup>();
    for (const f of mine) {
      if (f.source !== "measured") continue;
      const { label, count } = splitCount(f.title);
      const key = kindOf(f) ?? norm(label);
      const g = groups.get(key) ?? { label, severity: f.severity, count: 0, screens: [] };
      g.count += count;
      if (sevIndex(f.severity) < sevIndex(g.severity)) g.severity = f.severity;
      const screen = f.screen || f.feature || "Unnamed screen";
      const existing = g.screens.find((s) => s.screen === screen);
      if (existing) existing.count += count;
      else g.screens.push({ screen, count, finding: f });
      groups.set(key, g);
    }
    const measured = [...groups.values()].sort((a, b) => sevIndex(a.severity) - sevIndex(b.severity) || b.count - a.count);
    for (const g of measured) g.screens.sort((a, b) => b.count - a.count || a.screen.localeCompare(b.screen));
    return { lens, agent, measured, total: agent.length + measured.length };
  });
}

/** The lens tab holding the finding a `#finding-<fingerprint>` link points at, or null when no picked lens has it. */
export function lensForFingerprint(groups: readonly LensFindings[], fingerprint: string): Lens | null {
  for (const g of groups) {
    if (g.agent.some((f) => f.fingerprint === fingerprint)) return g.lens;
    if (g.measured.some((m) => m.screens.some((s) => s.finding.fingerprint === fingerprint))) return g.lens;
  }
  return null;
}

/** The lens tab to open first: the first with an agent finding, else with anything, else the first. */
export function defaultLens(groups: readonly LensFindings[]): Lens | null {
  return (groups.find((g) => g.agent.length > 0) ?? groups.find((g) => g.total > 0) ?? groups[0])?.lens ?? null;
}

// Live state ----------------------------------------------------------------------------------

export interface LiveState {
  exploration: Exploration;
  /** The run's agent findings (`findings`), oldest first. */
  findings: Finding[];
  /** Frames of the run's steps, oldest first. */
  frames: PassFrame[];
  /** The run's first screens (page, anchors, texts), oldest first: the Study face reads them. */
  screens: StudyScreen[];
  /** Step count and whether the newest step's frame was withheld. */
  steps: number;
  withheld: boolean;
}

export type LiveAction =
  | { type: "exploration"; row: Exploration }
  | { type: "findings"; rows: Finding[] }
  | { type: "finding"; row: Finding }
  | { type: "step"; seq: number; frame_path: string | null; withheld: boolean; screen?: StudyScreen | null };

/**
 * Folds one change-feed update into the page state. An older row never replaces a newer one
 * (the feed can deliver a refetch out of order), findings dedupe by id, frames by step seq.
 */
export function liveReducer(state: LiveState, action: LiveAction): LiveState {
  switch (action.type) {
    case "exploration": {
      const cur = state.exploration;
      if (action.row.id !== cur.id) return state;
      if (action.row.updated_at && cur.updated_at && action.row.updated_at < cur.updated_at) return state;
      return { ...state, exploration: action.row };
    }
    case "findings": {
      const byId = new Map(state.findings.map((f) => [f.id, f]));
      for (const f of action.rows) byId.set(f.id, f);
      return { ...state, findings: [...byId.values()].sort((a, b) => a.seq - b.seq) };
    }
    case "finding":
      return liveReducer(state, { type: "findings", rows: [action.row] });
    case "step": {
      const newest = action.seq >= state.steps;
      let frames = state.frames;
      if (action.frame_path && !frames.some((f) => f.seq === action.seq)) {
        frames = [...frames, { seq: action.seq, frame_path: action.frame_path }].sort((a, b) => a.seq - b.seq);
      }
      let screens = state.screens;
      if (action.screen && screens.length < STUDY_SCREENS_KEPT && !screens.some((s) => s.seq === action.seq)) {
        screens = [...screens, action.screen].sort((a, b) => a.seq - b.seq);
      }
      return {
        ...state,
        frames,
        screens,
        steps: Math.max(state.steps, action.seq),
        withheld: newest ? action.withheld : state.withheld,
      };
    }
  }
}

/** The run findings newest first, for the side rail (where the newest lands on top). */
export function railFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => b.seq - a.seq);
}

// Study ---------------------------------------------------------------------------------------

/** The features the study names: targets, then the charter's and the journeys' features. */
export function studyFeatures(e: Pick<Exploration, "targets" | "charter" | "briefing">): string[] {
  const out: string[] = [];
  const add = (k: string | undefined | null) => {
    if (k && !out.includes(k)) out.push(k);
  };
  for (const t of e.targets) add(t);
  for (const c of e.charter) add(c.feature);
  for (const j of e.briefing?.journeys ?? []) for (const f of j.features ?? []) add(f);
  return out;
}

/** The source counts of a briefing as labelled tiles, the ones with nothing left out. */
export function sourceTiles(read: ExplorationBriefing["sources_read"] | null | undefined) {
  if (!read) return [];
  const tiles = [
    { key: "files", label: "Code files", value: read.files },
    { key: "tests", label: "Tests", value: read.tests },
    { key: "scenarios", label: "Scenarios", value: read.scenarios },
    { key: "docs", label: "Docs", value: read.docs },
  ];
  return [...tiles, ...(read.context ? [{ key: "context", label: "Your context", value: 1 }] : [])];
}

/** "6 code files, 12 tests and 2 docs" (empty kinds left out). */
function listed(parts: readonly string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * The report's "Read …" line: what the explorer worked from. The study hands it a
 * digest of the app (the Study pack: code, tests, scenarios, docs, the app map), so that is
 * said first, "Worked from Orcha's study: a 24 KB digest of 487 code files, 467 tests, 47
 * scenarios, 4 docs and 125 app map screens."; what the explorer then opened itself follows
 * only when it opened something ("It opened 6 code files and 2 docs itself."). Without a
 * study (an exploration from before it) only what it opened, and nothing when that is nothing:
 * never "Read 0 code files, 0 tests, 0 scenarios, 0 docs".
 */
export function readLine(
  study: StudyManifest | null | undefined,
  read: ExplorationBriefing["sources_read"] | null | undefined,
  contextAttached: boolean,
): string | null {
  const n = (k: "code" | "tests" | "scenarios" | "docs" | "app_map") => studySource(study, k)?.count ?? 0;
  const pack = listed(
    [
      n("code") ? count(n("code"), "code file") : "",
      n("tests") ? count(n("tests"), "test") : "",
      n("scenarios") ? count(n("scenarios"), "scenario") : "",
      n("docs") ? count(n("docs"), "doc") : "",
      n("app_map") ? count(n("app_map"), "app map screen") : "",
    ].filter(Boolean),
  );
  const opened = listed(
    [
      read?.files ? count(read.files, "code file") : "",
      read?.tests ? count(read.tests, "test") : "",
      read?.scenarios ? count(read.scenarios, "scenario") : "",
      read?.docs ? count(read.docs, "doc") : "",
    ].filter(Boolean),
  );
  const context = contextAttached && read?.context ? "the context you attached" : "";
  if (pack) {
    const kb = study && study.bytes >= 1000 ? `a ${Math.round(study.bytes / 1000)} KB digest of ` : "a digest of ";
    const head = `Worked from Embodent's study: ${kb}${pack}${context ? `, and ${context}` : ""}.`;
    return opened ? `${head} It opened ${opened} itself.` : head;
  }
  if (opened) return `Read ${opened}${context ? `, and ${context}` : ""}.`;
  return context ? `Read ${context}.` : null;
}

/** A feature of the exploration's own project for the walk scene's example: a target
 * first (as the study named it), else the first feature the study listed. */
export function exampleFeatureOf(e: Pick<Exploration, "study" | "targets">): string | null {
  const items = studySource(e.study, "features")?.items ?? [];
  const target = items.find((i) => i.target);
  if (target) return target.name;
  if (e.targets[0]) return featureNameFromKey(e.targets[0]);
  return items[0]?.name ?? null;
}

// Header --------------------------------------------------------------------------------------

/** How long a finished exploration took, as its header says it: from its start to its finish
 * (study, explore and review), as the live clock counted it and the History list says it. The
 * explorer's own minutes are the report's "Explored" figure. Without both timestamps, the
 * result's count, else the run's. */
export function tookSeconds(
  e: { started_at?: string | null; finished_at?: string | null; result?: { duration_s?: number | null } | null },
  run?: { duration_s?: number | null } | null,
): number | null {
  const start = e.started_at ? Date.parse(e.started_at) : NaN;
  const end = e.finished_at ? Date.parse(e.finished_at) : NaN;
  if (Number.isFinite(start) && Number.isFinite(end) && end >= start) return Math.round((end - start) / 1000);
  return e.result?.duration_s ?? run?.duration_s ?? null;
}

