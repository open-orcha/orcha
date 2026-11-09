/**
 * Exploration reports — pure shaping behind the reader UI. No I/O here:
 * `adapt-report.ts` builds the rows, these turn them into the numbers and
 * groupings the views render.
 *
 * Spec: docs/superpowers/specs/2026-09-15-exploratory-reports-design.md §3.7.
 *
 * Two rules this module encodes, because getting either wrong turns the feature
 * into a liar:
 *
 * 1. **Measured vs. judged.** Findings and notes never merge into one list, one
 *    count, or one severity roll-up. `counts` counts findings only; notes are
 *    counted separately and never carry a severity.
 * 2. **Confident vs. not.** `confident === false` means the number is right but
 *    the reading of it is not (text over a photo, a gradient background). Those
 *    are partitioned out by `partitionByConfidence` and presented as "needs a
 *    look" — never rolled into the severity totals a reader treats as failures.
 */
import { sevRank } from "../../map/kit";
import type {
  AuditKind,
  ExplorationFinding,
  Finding,
  ExplorationNote,
  ExplorationNoteKind,
  ExplorationReport,
  ExplorationReportSummary,
  Severity,
} from "./types";

// Labels ----------------------------------------------------------------------

/** Human label for an audit kind. Falls back to the raw enum value un-underscored. */
const AUDIT_KIND_LABELS: Record<AuditKind, string> = {
  dark_mode_text_vanishes: "Text vanishes in dark mode",
  dark_mode_no_change: "Screen ignores dark mode",
  dark_mode_element_missing: "Element missing in one mode",
  dark_mode_image_vanishes: "Image vanishes in dark mode",
  low_contrast: "Low contrast",
  clipped_text: "Clipped text",
  off_screen: "Off screen",
  overlapping_controls: "Overlapping controls",
  tap_target_too_small: "Tap target too small",
  under_system_inset: "Under a system inset",
  inconsistent_screen: "Inconsistent screen",
  empty_label: "Empty accessibility label",
  label_equals_identifier: "Label is the identifier",
  image_without_label: "Image without a label",
  missing_identifier: "Missing accessibility identifier",
};

export function auditKindLabel(kind: string): string {
  return (
    AUDIT_KIND_LABELS[kind as AuditKind] ??
    kind.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())
  );
}

/**
 * Which family a kind belongs to. The reader groups by this because a dark-mode
 * failure and a missing accessibility identifier are read by different people for
 * different reasons, even though both are measured the same way.
 */
export type AuditGroup = "appearance" | "layout" | "accessibility";

const GROUP_OF: Record<AuditKind, AuditGroup> = {
  dark_mode_text_vanishes: "appearance",
  dark_mode_no_change: "appearance",
  dark_mode_element_missing: "appearance",
  dark_mode_image_vanishes: "appearance",
  low_contrast: "appearance",
  clipped_text: "layout",
  off_screen: "layout",
  overlapping_controls: "layout",
  tap_target_too_small: "layout",
  under_system_inset: "layout",
  inconsistent_screen: "layout",
  empty_label: "accessibility",
  label_equals_identifier: "accessibility",
  image_without_label: "accessibility",
  missing_identifier: "accessibility",
};

export const AUDIT_GROUPS: readonly AuditGroup[] = [
  "appearance",
  "layout",
  "accessibility",
];

export const AUDIT_GROUP_LABELS: Record<AuditGroup, string> = {
  appearance: "Light & dark",
  layout: "Layout & reach",
  accessibility: "Accessibility",
};

export function auditGroup(kind: string): AuditGroup {
  return GROUP_OF[kind as AuditKind] ?? "layout";
}

export const NOTE_KIND_LABELS: Record<ExplorationNoteKind, string> = {
  impression: "Impression",
  usability: "Usability",
  idea: "Idea",
  improvement: "Improvement",
  needs_info: "Needs info",
};

/** Appearance chips read as words, not enum values. */
export function appearanceLabel(appearance: string): string {
  return appearance.replace(/^./, (c) => c.toUpperCase());
}

// Counting --------------------------------------------------------------------

const EMPTY_SEVERITY: Record<Severity, number> = {
  blocker: 0,
  major: 0,
  minor: 0,
  cosmetic: 0,
  info: 0,
};

/** `{blocker: 1, major: 3, …}` over anything that carries a severity. */
export function countSeverity(rows: readonly { severity: Severity }[]): Record<Severity, number> {
  const out: Record<Severity, number> = { ...EMPTY_SEVERITY };
  for (const r of rows) out[r.severity] = (out[r.severity] ?? 0) + 1;
  return out;
}

/** `{blocker: 1, major: 3, …}` over measured findings. Notes are never counted here. */
export function countBySeverity(
  findings: readonly ExplorationFinding[],
): Record<Severity, number> {
  return countSeverity(findings);
}

/**
 * `{kind: n}` — the numbers that trend across versions. Mirrors
 * `counts_by_kind` in `src/orcha/audit/report.py`.
 */
export function countByKind(
  findings: readonly ExplorationFinding[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of findings) out[f.kind] = (out[f.kind] ?? 0) + 1;
  return out;
}

/**
 * Split findings into the ones whose interpretation is trustworthy and the ones
 * that only warrant a human glance. The second list must never be presented as
 * failures — that is the whole point of the `confident` column.
 */
export function partitionByConfidence(findings: readonly ExplorationFinding[]): {
  confident: ExplorationFinding[];
  needsLook: ExplorationFinding[];
} {
  const confident: ExplorationFinding[] = [];
  const needsLook: ExplorationFinding[] = [];
  for (const f of findings) (f.confident ? confident : needsLook).push(f);
  return { confident, needsLook };
}

/** Worst severity first, then by how badly the measurement missed its threshold. */
export function sortFindings(
  findings: readonly ExplorationFinding[],
): ExplorationFinding[] {
  return [...findings].sort((a, b) => {
    const s = sevRank(a.severity) - sevRank(b.severity);
    if (s !== 0) return s;
    const ka = auditKindLabel(a.kind);
    const kb = auditKindLabel(b.kind);
    if (ka !== kb) return ka.localeCompare(kb);
    return (a.element_label ?? "").localeCompare(b.element_label ?? "");
  });
}

/** Findings of one report grouped by family, each already sorted. Empty groups are dropped. */
export function groupFindings(
  findings: readonly ExplorationFinding[],
): Array<{ group: AuditGroup; findings: ExplorationFinding[] }> {
  const buckets = new Map<AuditGroup, ExplorationFinding[]>();
  for (const f of findings) {
    const g = auditGroup(f.kind);
    const list = buckets.get(g) ?? [];
    list.push(f);
    buckets.set(g, list);
  }
  return AUDIT_GROUPS.filter((g) => (buckets.get(g)?.length ?? 0) > 0).map((g) => ({
    group: g,
    findings: sortFindings(buckets.get(g) ?? []),
  }));
}

/** A list row: the report plus every count a reader decides on before clicking. */
export function summarize(
  report: ExplorationReport,
  findings: readonly ExplorationFinding[],
  notes: readonly ExplorationNote[],
  judged: readonly Finding[] = [],
): ExplorationReportSummary {
  const { needsLook } = partitionByConfidence(findings);
  return {
    report,
    bySeverity: countBySeverity(findings),
    byKind: countByKind(findings),
    findings: findings.length,
    needsLook: needsLook.length,
    notes: notes.length,
    judged: judged.length,
    judgedBySeverity: countSeverity(judged),
  };
}

// Revisions -------------------------------------------------------------------

/** One app version and every exploration of it, newest revision first. */
export interface VersionGroup {
  /** `null` app_version renders as "unversioned" — it still has to be reachable. */
  version: string | null;
  reports: ExplorationReportSummary[];
  /** When the newest revision of this version was explored. */
  latestAt: string;
}

/**
 * Group report summaries by app version, newest version first, newest revision
 * first within a version. This is the version rail: revisions tied to app
 * versions and dates, per the spec.
 *
 * Ordering is by the newest exploration of a version rather than by version
 * string, because version strings are not reliably comparable (`1.10` vs. `1.9`,
 * `latest`) and the date always is.
 */
export function groupByVersion(
  summaries: readonly ExplorationReportSummary[],
): VersionGroup[] {
  const buckets = new Map<string, ExplorationReportSummary[]>();
  for (const s of summaries) {
    const key = s.report.app_version ?? "";
    const list = buckets.get(key) ?? [];
    list.push(s);
    buckets.set(key, list);
  }
  const groups: VersionGroup[] = [];
  for (const [key, list] of buckets) {
    const reports = [...list].sort(
      (a, b) =>
        b.report.revision - a.report.revision ||
        Date.parse(b.report.created_at) - Date.parse(a.report.created_at),
    );
    groups.push({
      version: key === "" ? null : key,
      reports,
      latestAt: reports[0]?.report.created_at ?? "",
    });
  }
  return groups.sort((a, b) => Date.parse(b.latestAt) - Date.parse(a.latestAt));
}

/**
 * The exploration before `reportId` that it can be compared with: strictly older by date
 * (falling back to revision within the same instant), on the same platform, and of the same
 * target when one exists. This is what "the previous exploration" in the diff means.
 *
 * Like with like (D79): a web exploration measures nothing an iOS one measures (no
 * accessibility audit on web yet), so diffing the two read "Missing accessibility identifier
 * 0 ↓100%", an improvement that was only a different platform. A report with no previous one
 * of its platform has no diff at all.
 */
export function previousOf(
  summaries: readonly ExplorationReportSummary[],
  reportId: string,
): ExplorationReportSummary | null {
  const ordered = [...summaries].sort(
    (a, b) =>
      Date.parse(b.report.created_at) - Date.parse(a.report.created_at) ||
      b.report.revision - a.report.revision,
  );
  const i = ordered.findIndex((s) => s.report.id === reportId);
  if (i === -1) return null;
  const current = ordered[i].report;
  const older = ordered.slice(i + 1).filter((s) => (s.report.target_kind ?? null) === (current.target_kind ?? null));
  if (current.target_id) {
    const sameTarget = older.find((s) => s.report.target_id === current.target_id);
    if (sameTarget) return sameTarget;
  }
  return older[0] ?? null;
}

// Diff ------------------------------------------------------------------------

/**
 * Per-kind change between two reports: **positive is worse, negative is better**.
 * Mirrors `diff_counts` in `src/orcha/audit/report.py`, including its reason for
 * unioning the keys — a check that found nothing this time must show as a real
 * improvement (`8 → 0`, delta `-8`) rather than silently vanishing from the
 * comparison.
 */
export function diffCounts(
  previous: Readonly<Record<string, number>>,
  current: Readonly<Record<string, number>>,
): Record<string, number> {
  const keys = [...new Set([...Object.keys(previous), ...Object.keys(current)])].sort();
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = (current[k] ?? 0) - (previous[k] ?? 0);
  return out;
}

export interface KindDelta {
  kind: string;
  label: string;
  group: AuditGroup;
  previous: number;
  current: number;
  /** Positive is worse, negative is better — the `diff_counts` convention. */
  delta: number;
}

/**
 * Every kind either report touched: regressions first (worst first), then
 * improvements (best first), then the unchanged.
 *
 * Unchanged rows sink to the bottom rather than sorting by delta alone, because a
 * `0` between a `+1` and a `-2` is noise sitting between two signals — and a
 * version comparison is read for what moved.
 */
export function kindDeltas(
  previous: Readonly<Record<string, number>>,
  current: Readonly<Record<string, number>>,
): KindDelta[] {
  const deltas = diffCounts(previous, current);
  return Object.entries(deltas)
    .map(([kind, delta]) => ({
      kind,
      label: auditKindLabel(kind),
      group: auditGroup(kind),
      previous: previous[kind] ?? 0,
      current: current[kind] ?? 0,
      delta,
    }))
    .sort((a, b) => {
      const rank = (d: number) => (d > 0 ? 0 : d < 0 ? 1 : 2);
      const r = rank(a.delta) - rank(b.delta);
      if (r !== 0) return r;
      // Within regressions, biggest first (+3 before +1); within improvements,
      // biggest first too (-8 before -1) — in both cases the largest movement leads.
      if (a.delta !== b.delta) return Math.abs(b.delta) - Math.abs(a.delta);
      return a.label.localeCompare(b.label);
    });
}

/**
 * The identity of a finding across explorations. Two findings are "the same
 * finding" when the same check fired on the same element of the same screen —
 * the measured value is expected to move between runs, so it is deliberately not
 * part of the key.
 *
 * Falls back through identifier → label → element index so an app with no
 * accessibility identifiers (exactly the app this audit exists to find) still
 * produces a stable-enough key to diff on.
 */
export function findingKey(f: ExplorationFinding): string {
  const element =
    f.element_identifier ??
    f.element_label ??
    (f.element_index != null ? `#${f.element_index}` : "?");
  return [f.kind, f.screen_hash ?? "?", element, f.appearance ?? "*"].join("|");
}

export interface FindingDiff {
  /** In the current report, absent from the previous one. */
  added: ExplorationFinding[];
  /** In the previous report, gone from the current one. */
  removed: ExplorationFinding[];
  /** In both — the current row, since that is the live measurement. */
  unchanged: ExplorationFinding[];
}

/** What is new, what is gone, what is unchanged between two explorations. */
export function diffFindings(
  previous: readonly ExplorationFinding[],
  current: readonly ExplorationFinding[],
): FindingDiff {
  const prevKeys = new Set(previous.map(findingKey));
  const currKeys = new Set(current.map(findingKey));
  return {
    added: sortFindings(current.filter((f) => !prevKeys.has(findingKey(f)))),
    removed: sortFindings(previous.filter((f) => !currKeys.has(findingKey(f)))),
    unchanged: sortFindings(current.filter((f) => prevKeys.has(findingKey(f)))),
  };
}

// Trend -----------------------------------------------------------------------

export interface TrendPoint {
  /** `day` because the chart layer's `ChartLineChart` keys its x-axis on that name. */
  day: string;
  /** Label for the x-axis: the app version plus its revision, e.g. `1.4 r2`. */
  label: string;
  reportId: string;
  [kind: string]: string | number;
}

/**
 * Per-kind counts across explorations, oldest first — the trend line. The x-axis
 * is exploration order, not calendar time: two explorations a month apart and two
 * an hour apart are both "one step", because what a reader compares is versions,
 * not dates.
 */
export function trendSeries(
  summaries: readonly ExplorationReportSummary[],
  kinds: readonly string[],
): TrendPoint[] {
  const ordered = [...summaries].sort(
    (a, b) =>
      Date.parse(a.report.created_at) - Date.parse(b.report.created_at) ||
      a.report.revision - b.report.revision,
  );
  return ordered.map((s) => {
    const point: TrendPoint = {
      day: s.report.id,
      label: revisionLabel(s.report),
      reportId: s.report.id,
    };
    for (const kind of kinds) point[kind] = s.byKind[kind] ?? 0;
    return point;
  });
}

/**
 * The kinds worth plotting: those that ever reached a non-zero count, most
 * findings first, capped at `limit` so the legend stays readable. The spec calls
 * out accessibility-identifier and contrast counts specifically; this keeps those
 * at the top naturally, since they are the high-count checks, without hardcoding
 * them and hiding whatever else an app is actually failing.
 */
export function trendKinds(
  summaries: readonly ExplorationReportSummary[],
  limit = 4,
): string[] {
  const totals = new Map<string, number>();
  for (const s of summaries) {
    for (const [kind, n] of Object.entries(s.byKind)) {
      totals.set(kind, (totals.get(kind) ?? 0) + n);
    }
  }
  return [...totals.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([kind]) => kind);
}

// Formatting ------------------------------------------------------------------

/** `1.4 r2`, or `1.4` for the first revision; `unversioned` when there is no version. */
export function revisionLabel(report: ExplorationReport): string {
  const version = report.app_version ?? "unversioned";
  return report.revision > 1 ? `${version} r${report.revision}` : version;
}

/**
 * A measurement as text, always with its unit: `2.9:1 (needs 4.5:1)`,
 * `31 pt (needs 44 pt)`. Returns null when there is nothing numeric to show —
 * some checks are boolean (an element is missing or it is not), and inventing a
 * number for those would be worse than showing none.
 */
/** Countable units whose singular differs; anything absent is left alone. */
const SINGULAR_UNITS: Readonly<Record<string, string>> = {
  chars: "char",
  ids: "id",
  labels: "label",
  elements: "element",
  screens: "screen",
};

export function formatMeasurement(
  finding: Pick<ExplorationFinding, "kind" | "measured" | "threshold" | "unit">,
): { measured: string; threshold: string | null; requirement: string | null } | null {
  if (finding.measured == null) return null;
  const unit = finding.unit ?? "";
  const fmt = (v: number) => {
    const rounded = Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100;
    if (!unit) return String(rounded);
    // A ratio unit joins tight (`2.9:1`); every other unit takes a space, and a
    // countable unit is singularised at one, because "needs 1 chars" is the kind
    // of small wrongness that makes a reader doubt the number beside it.
    // Only the units that really are plural nouns are listed — blindly stripping
    // a trailing "s" would turn "px" into "p".
    if (unit.startsWith(":")) return `${rounded}${unit}`;
    const word =
      Math.abs(rounded) === 1 && SINGULAR_UNITS[unit] ? SINGULAR_UNITS[unit] : unit;
    return `${rounded} ${word}`;
  };
  const threshold = finding.threshold == null ? null : fmt(finding.threshold);
  return {
    measured: fmt(finding.measured),
    threshold,
    // Worded, not a bare number: "needs 4.5:1" is a floor to reach, "budget 0 px"
    // is a ceiling not to exceed, and a reader must not have to guess which.
    requirement:
      threshold == null
        ? null
        : `${thresholdDirection(finding.kind) === "at-most" ? "budget" : "needs"} ${threshold}`,
  };
}

/**
 * How a check reads its number. Some checks want the measurement *at or above* a
 * floor (contrast ratio, tap-target size, label length); others want it *at or
 * below* a ceiling (pixels clipped, pixels off-screen, pixels of overlap).
 *
 * This matters because a progress bar drawn as `measured / threshold` is actively
 * misleading for the second family: "48 px past the viewport against a 0 px
 * budget" would render as a full bar, reading like a pass. Encoding the direction
 * lets the bar always mean the same thing — how much of the requirement is met.
 */
export type ThresholdDirection = "at-least" | "at-most";

const AT_MOST_KINDS: ReadonlySet<string> = new Set([
  "clipped_text",
  "off_screen",
  "overlapping_controls",
  "under_system_inset",
  "dark_mode_no_change",
]);

export function thresholdDirection(kind: string): ThresholdDirection {
  return AT_MOST_KINDS.has(kind) ? "at-most" : "at-least";
}

/**
 * How much of the requirement the measurement meets, in `0..1`, or null when
 * there is nothing meaningful to draw.
 *
 * - `at-least` (needs ≥ threshold): the fraction of the floor reached. 2.9 against
 *   4.5 is 0.64 — visibly two thirds of the way, which is the honest picture.
 * - `at-most` (needs ≤ threshold, and the threshold is almost always 0): there is
 *   no ratio to take, so this returns 0 for any violation — the bar reads empty,
 *   meaning "none of this requirement is met", and the number beside it carries
 *   the magnitude. A fake denominator would invent precision that does not exist.
 */
export function thresholdProgress(
  finding: Pick<ExplorationFinding, "kind" | "measured" | "threshold">,
): number | null {
  const { measured, threshold } = finding;
  if (measured == null || threshold == null) return null;
  if (thresholdDirection(finding.kind) === "at-most") {
    return measured <= threshold ? 1 : 0;
  }
  if (threshold <= 0) return null;
  return Math.min(1, Math.max(0, measured / threshold));
}

/** `[x1,y1,x2,y2]` → a valid, non-degenerate rect, or null. */
export function normalizeRect(
  rect: readonly number[] | null | undefined,
): { x: number; y: number; w: number; h: number } | null {
  if (!rect || rect.length < 4) return null;
  const [x1, y1, x2, y2] = rect;
  if (![x1, y1, x2, y2].every((v) => Number.isFinite(v))) return null;
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const w = Math.abs(x2 - x1);
  const h = Math.abs(y2 - y1);
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

// Crashed runs ------------------------------------------------------------------

/** First line of `summary_md` when the app crashed (`src/orcha/audit/error_screens.py`). */
export const APP_CRASHED_MARKER = "<!-- orcha:app-crashed -->";

/**
 * Splits a report's summary into the crash notice (null when the app did not crash) and the
 * markdown to render, without the marker. A crashed run's error screens are never measured,
 * so the reader must see "the app crashed" before any count.
 */
export function crashNotice(summaryMd: string | null): { crash: string | null; summary: string | null } {
  if (!summaryMd || !summaryMd.startsWith(APP_CRASHED_MARKER)) return { crash: null, summary: summaryMd };
  const rest = summaryMd.slice(APP_CRASHED_MARKER.length).replace(/^\s*\n/, "");
  const quote = rest.match(/^>\s?(.*)$/m)?.[1] ?? "";
  const crash = quote.replace(/\*\*/g, "").trim() || "The app crashed.";
  return { crash, summary: rest.trim() ? rest : null };
}
