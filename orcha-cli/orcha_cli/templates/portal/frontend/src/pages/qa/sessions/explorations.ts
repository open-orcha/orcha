/**
 * The shapes the session screens take, and the pure parts every one of them shares: a session as
 * an exploration (its status in phases, its briefing, its charter, its result), the lenses, the
 * charter and walk phrases, what a session studied, and the history's filters. `adapt.ts` builds
 * these from the QA API; `compose.ts` works out the result.
 */
export type { Severity, TargetKind } from "../map/kit";
import type { Severity } from "../map/kit";
import type { QaFinding } from "../qaApi";

/** What kind of job a session is: Orcha's session kinds, shown where a recipe would be. */
export type ExplorationScope = "explore" | "map" | "draft" | "check";

const SCOPE_LABEL: Readonly<Record<ExplorationScope, string>> = { explore: "Exploration", map: "Map the app", draft: "Drafting", check: "Check run" };

export const SCOPE_TIERS: readonly { key: ExplorationScope }[] = [{ key: "explore" }, { key: "map" }, { key: "draft" }, { key: "check" }];

export function scopeLabel(s: ExplorationScope): string {
  return SCOPE_LABEL[s];
}

/** "sign-up" as a name: "Sign up". */
export function featureNameFromKey(key: string): string {
  const words = key.replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
}

/** One finding as the run recorded it, with the stored row behind it (`qa`) for its actions. */
export interface Finding {
  id: string;
  run_id: string;
  seq: number;
  title: string;
  severity: Severity;
  expected: string | null;
  actual: string | null;
  note: string | null;
  fix_prompt: string | null;
  severity_reported?: Severity | null;
  severity_by?: "explorer" | "orcha" | "person" | null;
  severity_reason?: string | null;
  severity_review?: { status: string; reason?: string | null; dimensions?: string[] } | null;
  repro_from_step: number | null;
  repro_to_step: number | null;
  qa: QaFinding;
}

export const LENSES = ["works", "usable", "resilient", "accessible", "visual", "copy", "fast"] as const;
export type Lens = (typeof LENSES)[number];
export const DEFAULT_LENSES: readonly Lens[] = ["works"];

export interface LensMeta {
  key: Lens;
  label: string;
  /** One line under the chip: what the explorer looks for. */
  hint: string;
}

export const LENS_META: readonly LensMeta[] = [
  { key: "works", label: "Works right", hint: "Functional bugs, wrong data, broken flows." },
  { key: "usable", label: "Easy to use", hint: "Friction, confusing steps, dead ends." },
  { key: "resilient", label: "Handles trouble", hint: "Bad input, errors, empty states, a slow or failing backend." },
  { key: "accessible", label: "Accessible", hint: "Labels, contrast, tap targets, screen reader order." },
  { key: "visual", label: "Looks right", hint: "Layout, clipping, dark mode, small screens." },
  { key: "copy", label: "Says it right", hint: "Copy, typos, jargon, tone." },
  { key: "fast", label: "Feels fast", hint: "Slow screens, long spinners." },
];

export function isLens(v: unknown): v is Lens {
  return typeof v === "string" && (LENSES as readonly string[]).includes(v);
}

/** Measured audit checks (`exploration_findings.kind`) shown under a lens. */
export const MEASURED_KIND_LENS: Readonly<Record<string, Lens>> = {
  low_contrast: "accessible",
  tap_target_too_small: "accessible",
  empty_label: "accessible",
  label_equals_identifier: "accessible",
  image_without_label: "accessible",
  missing_identifier: "accessible",
  dark_mode_text_vanishes: "visual",
  dark_mode_no_change: "visual",
  dark_mode_element_missing: "visual",
  dark_mode_image_vanishes: "visual",
  clipped_text: "visual",
  off_screen: "visual",
  overlapping_controls: "visual",
  under_system_inset: "visual",
  inconsistent_screen: "visual",
};

export const EXPLORATION_STATUSES = ["queued", "studying", "exploring", "checking", "done", "failed", "cancelled"] as const;
export type ExplorationStatus = (typeof EXPLORATION_STATUSES)[number];

export interface BriefingSource {
  kind: "code" | "test" | "scenario" | "doc" | "context" | "memory" | "finding";
  ref: string;
  note?: string;
}

export interface Journey {
  id: string;
  name: string;
  persona?: string;
  steps: string[];
  features?: string[];
}

export const CHARTER_STATUSES = ["planned", "active", "covered", "partial", "blocked", "bug"] as const;
export type CharterStatus = (typeof CHARTER_STATUSES)[number];

export interface CharterItem {
  id: string;
  title: string;
  why: string;
  lens: Lens;
  feature?: string;
  journey_id?: string;
  sources?: BriefingSource[];
  status: CharterStatus;
  note?: string;
  finding_ids?: string[];
  step_seq?: number;
}

export interface ExplorationBriefing {
  app_summary: string;
  personas: { name: string; goal: string }[];
  journeys: Journey[];
  risks: { area: string; why: string }[];
  sources_read: { files: number; tests: number; scenarios: number; docs: number; context: boolean };
  sources?: BriefingSource[];
  suggested_name?: string;
}

export type LensGrade = "good" | "fair" | "poor" | "unknown";
export type ResultSeverity = "blocker" | "major" | "minor" | "cosmetic" | "info";

export interface ResultFinding {
  fingerprint: string;
  lens: Lens;
  severity: ResultSeverity;
  title: string;
  source: "agent" | "measured";
  feature?: string;
  screen?: string;
  step_seq?: number;
  ref_id?: string;
  evidence?: string;
}

/** What a run did for one target feature (`explorations.feature_outcomes`): explored, partly
 * (some worked or found, not all) or not reached; the missions worked ("checked") and left, and
 * the findings that landed there. */
export interface FeatureOutcome {
  key: string;
  name: string;
  outcome: "explored" | "partly" | "not_reached";
  checked: string[];
  left: string[];
  findings: number;
  worst?: ResultSeverity;
  /** Why it stopped (a blocked mission's note), when it was not fully explored. */
  note?: string;
  /** A workflow-paired exploration: the flows walked there, each with its outcome. */
  walked?: { name: string; status: "passed" | "failed" | "unreachable" }[];
  /** Its flows still queued when the run ended. */
  flows_left?: number;
}

/** A session's flows by outcome: `walked` is passed + failed + unreachable, `left` what was
 * still queued. */
export interface WalkCounts {
  total: number;
  walked: number;
  passed: number;
  failed: number;
  unreachable: number;
  left: number;
}

export interface ExplorationResult {
  verdict: string;
  score: number;
  lenses: { lens: Lens; score: number; grade: LensGrade; findings: number }[];
  charter: { total: number; covered: number; partial: number; blocked: number; bug: number };
  journeys?: { id: string; name: string; outcome: "passed" | "failed" | "blocked" | "not_run"; broke_at?: string }[];
  findings: ResultFinding[];
  screens: number;
  steps: number;
  duration_s: number;
  study_s: number;
  cost_usd?: number;
  /** `finding`: the fingerprint of the finding a scenario or fix step came from. */
  next: { kind: "scenario" | "exploration" | "fix"; title: string; detail?: string; feature?: string; recipe?: ExplorationScope; finding?: string }[];
  /** One per target feature, in the order picked (absent before multi-feature Deep dives). */
  features?: FeatureOutcome[];
  /** A workflow-paired exploration's flows. */
  walks?: WalkCounts;
  /** The run stopped early: the outcome, what Orcha saw and the fix. */
  stopped_early?: { code: string; title: string; reason?: string; fix?: string };
}

/** `stopped_early.code` of a run whose explorer left early. */
export const EXPLORER_STOPPED = "EXPLORER_STOPPED";

/** An `explorations` row as the site reads it (JSON columns parsed). */
export interface Exploration {
  id: string;
  project_id: string;
  series_id: string;
  name: string;
  name_is_custom: boolean;
  description: string | null;
  recipe: ExplorationScope | null;
  minutes: number | null;
  lenses: Lens[];
  goal: string | null;
  targets: string[];
  context: string | null;
  target_id: string | null;
  environment_id: string | null;
  platform: string | null;
  status: ExplorationStatus;
  request_id: string | null;
  run_id: string | null;
  report_id: string | null;
  briefing: ExplorationBriefing | null;
  charter: CharterItem[];
  result: ExplorationResult | null;
  /** What the Study pack holds (migration 108); null before the worker built it, absent on old reads. */
  study?: StudyManifest | null;
  error: string | null;
  started_at: string | null;
  study_done_at: string | null;
  finished_at: string | null;
  archived_at: string | null;
  pinned_at?: string | null;
  created_at: string;
  updated_at: string;
}

/** How long a name a person can give. */
export const NAME_MAX = 120;

export interface SeriesPlace {
  /** The exploration before this one in its series (any status), or null for the first. */
  previous: Exploration | null;
  /** The newest earlier exploration of the series that has a result, to compare with. */
  previousScored: Exploration | null;
  /** This score minus `previousScored`'s; null when either has no result. */
  delta: number | null;
  /** Scores of the series' explorations with a result, oldest first, up to and including this
   * one (its sparkline). */
  trend: number[];
  /** How many explorations the series has in all. */
  size: number;
}

function byCreated(a: Exploration, b: Exploration): number {
  return a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
}

/** Every exploration's place in its series, keyed by id. */
export function seriesPlaces(rows: readonly Exploration[]): Map<string, SeriesPlace> {
  const bySeries = new Map<string, Exploration[]>();
  for (const e of rows) {
    const list = bySeries.get(e.series_id) ?? [];
    list.push(e);
    bySeries.set(e.series_id, list);
  }
  const out = new Map<string, SeriesPlace>();
  for (const list of bySeries.values()) {
    const sorted = [...list].sort(byCreated);
    const trend: number[] = [];
    let lastScored: Exploration | null = null;
    sorted.forEach((e, i) => {
      const score = e.result?.score;
      const previousScored = lastScored;
      const delta = score != null && previousScored?.result ? Math.round(score - previousScored.result.score) : null;
      if (score != null) {
        trend.push(score);
        lastScored = e;
      }
      out.set(e.id, { previous: sorted[i - 1] ?? null, previousScored, delta, trend: [...trend], size: sorted.length });
    });
  }
  return out;
}

// ---------- the charter and the walks, said the same everywhere ----------

/** How each worked (or blocked) mission is said, in order: the charter's own labels. */
const MISSION_WORDS = [
  ["covered", "covered"],
  ["partial", "partly covered"],
  ["bug", "found a bug"],
  ["blocked", "blocked"],
] as const;

/**
 * The charter's outcome in words, the same in the verdict and on the charter: "2 of 3 missions
 * partly covered, 1 blocked", "1 of 2 missions covered, 1 found a bug", "0 of 3 missions
 * covered". Never "done": a partly covered mission is not done.
 */
export function missionsPhrase(c: ExplorationResult["charter"]): string {
  const total = c.total ?? 0;
  if (!total) return "";
  const noun = total === 1 ? "mission" : "missions";
  const parts = MISSION_WORDS.map(([k, word]) => [c[k] ?? 0, word] as const).filter(([n]) => n > 0);
  if (parts.length === 0) return `0 of ${total} ${noun} covered`;
  const [[n, word], ...rest] = parts;
  return [`${n} of ${total} ${noun} ${word}`, ...rest.map(([m, w]) => `${m} ${w}`)].join(", ");
}

/** "5 of 30 flows walked: 3 passed, 2 failed" (only the outcomes that happened). */
export function walkPhrase(c: WalkCounts | null | undefined): string {
  if (!c?.total) return "";
  const parts = (["passed", "failed", "unreachable"] as const).filter((k) => c[k] > 0).map((k) => `${c[k]} ${k}`);
  return `${c.walked} of ${c.total} ${c.total === 1 ? "flow" : "flows"} walked${parts.length ? `: ${parts.join(", ")}` : ""}`;
}

const MISSIONS_DONE = /^\d+ of \d+ missions? done$/;

/**
 * The verdict as the site says it. An older result said its missions as "2 of 3
 * missions done", which the charter contradicted ("0 of 3 covered"): that part is said as the
 * charter says it (`missionsPhrase`). With `walks` (a workflow-paired exploration whose result
 * did not count them), what was walked is said after the bugs, and the missions only when one
 * was worked or blocked. A result that counts its walks already says all this.
 */
export function displayVerdict(result: Pick<ExplorationResult, "verdict" | "charter" | "walks">, walks?: WalkCounts | null): string {
  // A malformed stored result may have no verdict: nothing to say then.
  if (typeof result.verdict !== "string") return result.verdict;
  const parts = result.verdict.split(" · ");
  const extra = result.walks ? null : walks;
  const c = result.charter;
  const touched = (c?.covered ?? 0) + (c?.partial ?? 0) + (c?.bug ?? 0) + (c?.blocked ?? 0);
  const out: string[] = [];
  for (const p of parts) {
    if (!MISSIONS_DONE.test(p)) {
      out.push(p);
      continue;
    }
    if (extra?.total && !touched) continue;
    out.push(missionsPhrase(c));
  }
  const walked = walkPhrase(extra);
  if (walked) out.splice(Math.min(1, out.length), 0, walked);
  return out.join(" · ");
}

// What it studied ------------------------------------------------------------------------------

export const STUDY_KINDS = [
  "code",
  "tests",
  "docs",
  "scenarios",
  "features",
  "app_map",
  "context",
  "memory",
  "findings",
  "history",
] as const;
export type StudySourceKind = (typeof STUDY_KINDS)[number];

/** One real name in a source: a repo path, a test title (with its file), a scenario, a memory note. */
export interface StudyItem {
  name: string;
  /** Repo-relative path, for code, tests and docs: what a `Read` of the explorer is matched to. */
  path?: string;
  /** A feature's or an app map screen's key. */
  key?: string;
  /** A short second line: test framework, scenario status, memory kind, finding severity, verdict. */
  detail?: string;
  /** When an earlier exploration ran. */
  at?: string;
  /** A target feature of this exploration. */
  target?: boolean;
}

export interface StudySource {
  kind: StudySourceKind;
  /** How many there are in all (files, test titles, scenarios, notes); `items` names the first few. */
  count: number;
  items: StudyItem[];
  /** Tests: the files the titles are in. */
  files?: number;
  /** Findings: the exploration they were left open by. */
  from?: string;
}

export interface StudyManifest {
  version: number;
  /** A repository was scanned: the explorer can read the app's code. */
  repo: boolean;
  /** The pack's size in characters. */
  bytes: number;
  /** Only the sources with something in them. */
  sources: StudySource[];
  /** What the explorer said it read, in `submit_briefing`. */
  reported?: { sources_read?: ExplorationBriefing["sources_read"]; sources?: BriefingSource[] };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function text(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

export function studySource(m: StudyManifest | null | undefined, kind: StudySourceKind): StudySource | null {
  return m?.sources.find((s) => s.kind === kind) ?? null;
}

// Screens -------------------------------------------------------------------------------------

/** One screen the session showed while the explorer studied: what the page or screen said. */
export interface StudyScreen {
  seq: number;
  /** Web: the page's address and title. */
  url: string | null;
  title: string | null;
  /** What can be tapped or clicked, by label (`screen` step args). */
  anchors: string[];
  /** The visible texts, in reading order. */
  texts: string[];
  frame_path: string | null;
}

/** Screens kept for the Study face (the study only shows its first few). */
export const STUDY_SCREENS_KEPT = 12;
const LIST_KEPT = 40;

function strings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const s of v) {
    if (typeof s !== "string") continue;
    const t = s.replace(/\s+/g, " ").trim();
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= LIST_KEPT) break;
  }
  return out;
}

/** A `screen` step as a study screen; null for any other step or one without anything on it. */
export function studyScreenFromStep(step: { seq: number; kind?: string | null; args?: unknown; frame_path?: string | null }): StudyScreen | null {
  if (step.kind !== "screen") return null;
  let args = step.args;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      args = null;
    }
  }
  const a = isRecord(args) ? args : {};
  const page = isRecord(a.page) ? a.page : a;
  const screen: StudyScreen = {
    seq: step.seq,
    url: text(page.url) ?? null,
    title: text(page.title) ?? null,
    anchors: strings(a.anchors),
    texts: strings(a.texts),
    frame_path: step.frame_path ?? null,
  };
  if (!screen.url && !screen.title && !screen.anchors.length && !screen.texts.length && !screen.frame_path) return null;
  return screen;
}

// Status --------------------------------------------------------------------------

/** Still going: queued, or in one of the four phases before the result. */
export const LIVE_STATUSES: readonly ExplorationStatus[] = ["queued", "studying", "exploring", "checking"];

export function isLive(status: ExplorationStatus): boolean {
  return LIVE_STATUSES.includes(status);
}

/** The words every job page uses (`components/work/words`). */
export const STATUS_LABEL: Readonly<Record<ExplorationStatus, string>> = {
  queued: "Queued",
  studying: "Reading",
  exploring: "Exploring",
  checking: "Checking what it found",
  done: "Done",
  failed: "Failed",
  cancelled: "Stopped",
};

/** The status word for a row: a map or a check that is walking is not "exploring". */
export function statusWord(e: { status: ExplorationStatus; recipe?: string | null }): string {
  if (e.status !== "exploring") return STATUS_LABEL[e.status];
  return e.recipe === "map" ? "Mapping" : e.recipe === "check" ? "Checking" : e.recipe === "draft" ? "Drafting" : STATUS_LABEL.exploring;
}

export function shortDate(iso: string | Date, timeZone?: string | null): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(timeZone ? { timeZone } : {}) });
}

// Filters ----------------------------------------------------------------------------

/**
 * A session that failed only because no device was free: nothing was explored, so it is no
 * failed exploration. It reads "Couldn't get a device" and stays out of the counts.
 */
export function noDevice(e: Pick<Exploration, "status" | "error">): boolean {
  return e.status === "failed" && /in use by another agent|\bno (?:free |available |booted )?(?:\w+ )?(?:device|emulator|simulator)\b/i.test(e.error ?? "");
}
export const NO_DEVICE_LABEL = "Couldn't get a device";

export type StatusFilter = "all" | "running" | "done" | "failed";
export type ArchivedFilter = "hide" | "only" | "all";

export interface HistoryFilters {
  q?: string;
  /** A recipe key, "custom" (no recipe), or empty for every recipe. */
  recipe?: ExplorationScope | "custom" | "";
  lens?: Lens | "";
  status?: StatusFilter;
  archived?: ArchivedFilter;
}

function matchesStatus(e: Pick<Exploration, "status" | "error">, f: StatusFilter): boolean {
  const { status } = e;
  if (f === "all") return true;
  if (f === "running") return isLive(status);
  if (f === "done") return status === "done";
  return (status === "failed" || status === "cancelled") && !noDevice(e);
}

/**
 * The explorations the history shows for these filters, in the order given (newest first from
 * the loader). Search matches the name, the goal, the notes and the recipe's label, every word.
 */
export function filterExplorations(rows: readonly Exploration[], f: HistoryFilters): Exploration[] {
  const words = (f.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((e) => {
    const archived = e.archived_at != null;
    if ((f.archived ?? "hide") === "hide" && archived) return false;
    if (f.archived === "only" && !archived) return false;
    if (f.recipe === "custom" ? e.recipe != null : f.recipe ? e.recipe !== f.recipe : false) return false;
    if (f.lens && !e.lenses.includes(f.lens)) return false;
    if (!matchesStatus(e, f.status ?? "all")) return false;
    if (words.length > 0) {
      const hay = [e.name, e.goal ?? "", e.description ?? "", e.recipe ? scopeLabel(e.recipe) : "custom"].join(" ").toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

export function hasActiveFilters(f: HistoryFilters): boolean {
  return Boolean(f.q || f.recipe || f.lens || (f.status && f.status !== "all") || (f.archived && f.archived !== "hide"));
}

