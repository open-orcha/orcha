import type { TargetKind } from "../map/kit";
import type { ScenarioOutcome } from "./adapt";
import { effectiveStatus, isRetired, runnable, runsInBatch, type StatusRow } from "./scenario-status";

const isPassed = (o: string | null | undefined) => o === "pass";
const isFailed = (o: string | null | undefined) => o === "fail";

/** Which validated scenarios a run on one platform actually runs: pinned there or shared. */
export function validatedScenariosForKind<T extends StatusRow & { status: string; target_kind?: string | null }>(
  scenarios: readonly T[],
  kind: string | null | undefined,
): T[] {
  return scenarios.filter((s) => runsInBatch(s) && (!kind || !s.target_kind || s.target_kind === kind));
}

/** The paused scenarios "All validated" skips on `kind`: New Run lists them as skipped. */
export function pausedScenariosForKind<T extends StatusRow & { target_kind?: string | null }>(
  scenarios: readonly T[],
  kind: string | null | undefined,
): T[] {
  return scenarios.filter((s) => effectiveStatus(s) === "paused" && (!kind || !s.target_kind || s.target_kind === kind));
}

/**
 * What the New Run "Pick" list offers for a run on `kind` (D92): scenarios for that platform or
 * for any platform (drafts included, since picking one is how a draft gets its first run; a
 * paused one too, to try it before resuming it), plus whatever is already picked so a prefilled
 * choice is never hidden. It listed iOS-only and web-only scenarios for an Android target,
 * which the worker would then skip. Retired scenarios never run, so they are not offered.
 */
export function pickableScenarios<T extends StatusRow & { id: string; target_kind?: string | null }>(
  scenarios: readonly T[],
  kind: string | null | undefined,
  picked: readonly string[] = [],
): T[] {
  const keep = new Set(picked);
  return scenarios.filter((s) => (keep.has(s.id) || !kind || !s.target_kind || s.target_kind === kind) && !isRetired(s));
}

/**
 * The scenarios a scenarios run on `kind` runs, as the worker selects them
 * (`fetch_scenarios_for_request`): a pick runs as picked, drafts included (picking a draft is
 * how it gets its first run), minus those pinned to another platform; no pick (`null`) runs
 * every validated scenario for the platform. New Run's "Runs on" summary counted only validated
 * scenarios, so a picked draft read "0 scenarios" beside "1 selected" and then ran anyway.
 */
export function scenariosThatRun<T extends StatusRow & { id: string; status: string; target_kind?: string | null }>(
  scenarios: readonly T[],
  kind: string | null | undefined,
  picked: readonly string[] | null,
): T[] {
  if (!picked) return validatedScenariosForKind(scenarios, kind);
  const keep = new Set(picked);
  // A person's pick: drafts and paused ones run, retired ones never (`runnable`).
  return scenarios.filter((s) => keep.has(s.id) && runnable(s, { picked: true }) && (!kind || !s.target_kind || s.target_kind === kind));
}

/**
 * The picked scenarios a run on `kind` leaves out because they are pinned to another platform,
 * said plainly beside "Runs on" (polish-8): "The 3 picked scenarios are iOS only: none runs on
 * Android.", "1 picked scenario is iOS only and is left out on Android." Null when every pick
 * runs here (or nothing was picked, or the scenarios have not loaded).
 */
export function pickedElsewhereNote(
  scenarios: readonly { id: string; target_kind?: string | null }[],
  kind: TargetKind | null | undefined,
  picked: readonly string[] | null,
): string | null {
  if (!kind || !picked || picked.length === 0 || scenarios.length === 0) return null;
  const keep = new Set(picked);
  const rows = scenarios.filter((s) => keep.has(s.id));
  const away = rows.filter((s) => s.target_kind && s.target_kind !== kind);
  if (away.length === 0) return null;
  const kinds = [...new Set(away.map((s) => s.target_kind as TargetKind))].map((k) => NAMES[k] ?? k);
  const where = kinds.length === 1 ? `${kinds[0]} only` : `for ${kinds.slice(0, -1).join(", ")} or ${kinds.at(-1)} only`;
  const here = NAMES[kind] ?? kind;
  if (away.length === rows.length) {
    return away.length === 1 ? `The picked scenario is ${where}: it does not run on ${here}.` : `The ${away.length} picked scenarios are ${where}: none runs on ${here}.`;
  }
  return `${away.length} picked ${away.length === 1 ? "scenario is" : "scenarios are"} ${where} and ${away.length === 1 ? "is" : "are"} left out on ${here}.`;
}

const NAMES: Record<TargetKind, string> = { ios: "iOS", android: "Android", web: "Web", desktop: "Desktop" };

/** The picked scenario ids that still run on `kind`: switching a schedule's target from iOS to
 * web drops the iOS-only picks instead of saving a schedule that skips them silently. Before
 * the scenarios have loaded nothing is dropped. A paused pick stays (the schedule skips it, and
 * says so, until it resumes). */
export function picksForKind<T extends StatusRow & { id: string; status: string; target_kind?: string | null }>(
  ids: readonly string[],
  scenarios: readonly T[],
  kind: string | null | undefined,
): string[] {
  if (scenarios.length === 0) return [...ids];
  const keep = new Set([...validatedScenariosForKind(scenarios, kind), ...pausedScenariosForKind(scenarios, kind)].map((s) => s.id));
  return ids.filter((id) => keep.has(id));
}

// Platform scope ---------------------------------------------------------------------------
//
// A scenario is either **one platform** (pinned: `target_kind` set, it runs only there) or
// **all platforms** (shared: `target_kind` null, it runs on every platform of the project). Its
// status is per platform: the newest result on a run of each platform it applies to, and
// whether a replay trace exists for that platform (`scenario_traces` is one row per
// `(scenario_id, target_kind)`).

const PLATFORM_ORDER: readonly TargetKind[] = ["web", "ios", "android", "desktop"];

/** The project's platform kinds in a stable order (web, iOS, Android, desktop), each once. */
export function projectKinds(targets: readonly { kind: TargetKind }[]): TargetKind[] {
  const have = new Set(targets.map((t) => t.kind));
  return PLATFORM_ORDER.filter((k) => have.has(k));
}

/** The platforms a scenario applies to: its pin, or every platform of the project. A pin to a
 * platform the project no longer has still shows (so it can be fixed). */
export function scenarioKinds(targetKind: TargetKind | null | undefined, kinds: readonly TargetKind[]): TargetKind[] {
  return targetKind ? [targetKind] : [...kinds];
}

/** Whether the Scenarios tab's platform filter shows a scenario: "All" shows everything, a
 * platform shows what runs there (pinned to it, or shared). */
export function inPlatformFilter(targetKind: TargetKind | null | undefined, filter: TargetKind | null): boolean {
  return !filter || !targetKind || targetKind === filter;
}

/** Counts for the platform filter: `all`, and per project platform what runs there. */
export function platformFilterCounts(
  scenarios: readonly { target_kind?: TargetKind | null }[],
  kinds: readonly TargetKind[],
): { all: number } & Partial<Record<TargetKind, number>> {
  const out: { all: number } & Partial<Record<TargetKind, number>> = { all: scenarios.length };
  for (const k of kinds) out[k] = scenarios.filter((s) => inPlatformFilter(s.target_kind, k)).length;
  return out;
}

/** One result row with the platform it ran on: `runs.created_at` orders them. */
export interface PlatformResultRow {
  scenario_id: string;
  outcome: ScenarioOutcome;
  kind: TargetKind | null;
  at: string | null;
  /** The result's reason, for `platformFitByKind`. */
  reason?: string | null;
}

export type OutcomesByKind = Record<string, Partial<Record<TargetKind, ScenarioOutcome>>>;

/** The newest outcome per scenario and platform (rows with no platform are skipped). */
export function latestOutcomesByKind(rows: readonly PlatformResultRow[]): OutcomesByKind {
  const best = new Map<string, { at: string; outcome: ScenarioOutcome }>();
  for (const r of rows) {
    if (!r.kind) continue;
    const key = `${r.scenario_id}\u0000${r.kind}`;
    const at = r.at ?? "";
    const cur = best.get(key);
    if (!cur || at >= cur.at) best.set(key, { at, outcome: r.outcome });
  }
  const out: OutcomesByKind = {};
  for (const [key, v] of best) {
    const [id, kind] = key.split("\u0000") as [string, TargetKind];
    (out[id] ??= {})[kind] = v.outcome;
  }
  return out;
}

/** One cell of a scenario's per-platform status strip. */
export interface PlatformStatus {
  kind: TargetKind;
  /** Newest result on this platform; null = never run here. */
  outcome: ScenarioOutcome | null;
  /** A replay trace exists for this platform. */
  traced: boolean;
  /** The newest result could not be judged because the checks do not fit here. */
  noFit?: boolean;
}

/** The status strip: one cell per platform the scenario applies to. */
export function scenarioPlatformStatus(
  scenario: { id: string; target_kind?: TargetKind | null },
  kinds: readonly TargetKind[],
  outcomes: OutcomesByKind,
  traces: Readonly<Record<string, readonly TargetKind[]>>,
  fit: FitByKind = {},
): PlatformStatus[] {
  const mine = outcomes[scenario.id] ?? {};
  const traced = new Set(traces[scenario.id] ?? []);
  return scenarioKinds(scenario.target_kind, kinds).map((kind) => ({
    kind,
    outcome: mine[kind] ?? null,
    traced: traced.has(kind),
    noFit: (mine[kind] === "inconclusive" && fit[scenario.id]?.[kind]?.noFit) || undefined,
  }));
}

/** "Sign in (iOS)" → "Sign in" when the scenario is pinned: the pin is shown as a chip, so the
 * name does not repeat it. A shared scenario's name is left as is. */
export function displayScenarioName(name: string, targetKind: TargetKind | null | undefined): string {
  if (!targetKind) return name;
  const stripped = name.replace(/\s*[([]\s*(?:web|ios|android)\s*(?:only)?\s*[)\]]\s*$/i, "").trim();
  return stripped || name;
}

// Checks that do not fit a platform -----------------------------------------------------------
//
// A shared scenario runs on every platform, and its checks may only hold on one of them. The run
// agent then says `inconclusive` with the note "criteria don't fit": no verdict, and a run spent
// to learn it. What a run on a platform said decides here, plus the
// stored `platform_wording` flag (labels only one platform's screens showed).
// All of it only informs a person: nothing here fails, blocks or skips a run.

const NO_FIT_NOTE = /^\s*criteria (?:don['’]t|do not) fit\b/i;

/** A result whose run said the checks do not fit: an `inconclusive` result with the agent's
 * note. A note about one examples row is about that row's data, not the platform; "sign-in
 * failed … and criteria don't fit" names another cause first, so it does not count either. */
export function criteriaDontFit(outcome: ScenarioOutcome | string | null | undefined, reason: string | null | undefined): boolean {
  return outcome === "inconclusive" && !!reason && NO_FIT_NOTE.test(reason) && !/\bexample row\b/i.test(reason);
}

/** The agent's note without its "criteria don't fit:" prefix, the headline says that already. */
export function noFitWhy(reason: string): string {
  const text = reason.trim().replace(/^criteria (?:don['’]t|do not) fit\s*:\s*/i, "");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What a batch row says under a scenario whose run said so. */
export function noFitLine(kind: TargetKind): string {
  return `These checks don't fit ${NAMES[kind]}, so ${NAMES[kind]} can't judge them. No verdict, not a failure.`;
}

/** What a platform's newest telling result says about the checks. */
export interface PlatformFit {
  /** The run said they do not fit. */
  noFit: boolean;
  /** It passed there (a warning included). */
  passed: boolean;
  /** The note of a `noFit` result. */
  reason: string | null;
}

export type FitByKind = Record<string, Partial<Record<TargetKind, PlatformFit>>>;

/**
 * Per scenario and platform, the newest result that says whether the checks can be judged there:
 * a verdict (they were judged) or "criteria don't fit". Blocked, needs setup and other
 * no-verdict results (an empty accessibility tree, a sign-in that failed) say nothing about the
 * checks and are left out, so device trouble neither raises this nor clears it.
 */
export function platformFitByKind(rows: readonly PlatformResultRow[]): FitByKind {
  const newest = new Map<string, string>();
  const out: FitByKind = {};
  for (const r of rows) {
    const noFit = criteriaDontFit(r.outcome, r.reason);
    if (!r.kind || !(noFit || isPassed(r.outcome) || isFailed(r.outcome))) continue;
    const key = `${r.scenario_id}\u0000${r.kind}`;
    const at = r.at ?? "";
    if ((newest.get(key) ?? "") > at) continue;
    newest.set(key, at);
    (out[r.scenario_id] ??= {})[r.kind] = { noFit, passed: isPassed(r.outcome), reason: noFit ? (r.reason ?? null) : null };
  }
  return out;
}

export interface FitWarning {
  /** The platforms the checks do not fit. */
  misfit: TargetKind[];
  /** The one platform left to limit it to; null when several are, so only a split helps. */
  limitTo: TargetKind | null;
  text: string;
  detail: string;
}

function nameList(kinds: readonly TargetKind[]): string {
  const names = kinds.map((k) => NAMES[k]);
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function isKind(v: unknown): v is TargetKind {
  return typeof v === "string" && v in NAMES;
}

/**
 * Why a shared scenario's checks fit only some of its platforms, or null. Careful by design, a
 * false warning on a good scenario is worse than none:
 * - a run said "criteria don't fit" on a platform, nothing has judged them there since, and
 *   another platform still judges them. On no platform judged, the wording may be the problem
 *   rather than the platform, so this stays quiet and the status strip says what each run said;
 * - or no run has said so yet, but the `platform_wording` flag found labels only one platform
 *   shows, and no other platform has passed since.
 * A flag a person dismissed ("Keep on all platforms") silences both. "Uses iOS labels" is only
 * said of a platform that passes: one that fails judged the checks but did not back the labels.
 */
export function platformFitWarning(
  scenario: StatusRow & { id: string; target_kind?: TargetKind | null },
  kinds: readonly TargetKind[],
  fit: FitByKind,
  flags: readonly { kind: string; detail?: Record<string, unknown>; dismissed_at?: string | null }[],
): FitWarning | null {
  if (scenario.target_kind || kinds.length < 2 || isRetired(scenario)) return null;
  const flag = flags.find((f) => f.kind === "platform_wording");
  if (flag?.dismissed_at) return null;
  const mine = fit[scenario.id] ?? {};
  const misfit = kinds.filter((k) => mine[k]?.noFit);
  const judged = kinds.filter((k) => mine[k]?.noFit === false);
  if (misfit.length > 0 && judged.length > 0) {
    const passed = judged.filter((k) => mine[k]?.passed);
    const names = nameList(misfit);
    return {
      misfit,
      limitTo: judged.length === 1 ? judged[0] : null,
      text: passed.length > 0 ? `These checks use ${nameList(passed)} labels, so ${names} can't judge them.` : `These checks don't fit ${names}, so ${names} can't judge them.`,
      detail: `Last ${NAMES[misfit[0]]} run: ${noFitWhy(mine[misfit[0]]?.reason ?? "")}`,
    };
  }
  const owner = flag?.detail?.suggested_kind;
  if (!isKind(owner) || !kinds.includes(owner)) return null;
  const others = kinds.filter((k) => k !== owner && !mine[k]?.passed);
  if (others.length === 0) return null;
  const shown = (flag?.detail?.only_on as Record<string, unknown> | undefined)?.[owner];
  const labels = Array.isArray(shown) ? shown.slice(0, 3).map((l) => `"${String(l)}"`) : [];
  return {
    misfit: others,
    limitTo: owner,
    text: `These checks use ${NAMES[owner]} labels, so ${nameList(others)} may not be able to judge them.`,
    detail: `Seen only on ${NAMES[owner]}: ${labels.join(", ")}.`,
  };
}

/** The draft a split makes for one platform: "Guest browse properties (Android)". */
export function splitDraftName(name: string, kind: TargetKind): string {
  return `${displayScenarioName(name, kind)} (${NAMES[kind]})`;
}
