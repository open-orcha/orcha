/**
 * The findings list behind an exploration report: merging, filtering, grouping and
 * windowing, all pure so they are tested without a browser.
 *
 * Why this exists: a real exploration measures ~1,000 findings, and about half of
 * them are the same claim again — the same check on the same element with the same
 * number, seen on another visit to the screen. Rendered one card each, that is a
 * 200,000px page nobody reads. So the list:
 *
 * 1. **filters** the raw findings (severity, check, appearance, screen, text),
 * 2. **merges** what is left into one row per (check, element, metric, appearance),
 *    keeping every occurrence so the detail panel can list the screens,
 * 3. **groups** the rows by check, then by screen, into collapsible groups, and
 * 4. **flattens** that tree into fixed-height items, so the view can render only
 *    the rows in the viewport (`visibleRange`).
 *
 * Filtering happens before merging on purpose: filtering by a screen must shrink a
 * merged row to the occurrences on that screen, not keep showing "×12".
 */
import { auditKindLabel, thresholdDirection, thresholdProgress } from "./exploration";
import { sevOrder, sevRank } from "../../map/kit";
import type { AuditKind, ExplorationFinding, ExplorationReportSummary, Severity } from "./types";

// Merging ---------------------------------------------------------------------

/** One row in the list: identical findings folded together. */
export interface MergedFinding {
  key: string;
  /** The occurrence the row shows: the worst one, first seen. */
  head: ExplorationFinding;
  /** Every occurrence, in the order they were measured. */
  findings: ExplorationFinding[];
  /** Worst severity across the occurrences. */
  severity: Severity;
  kind: AuditKind;
  /** Distinct screens the claim was measured on (`screen_hash`, "?" when unknown). */
  screens: string[];
  confident: boolean;
}

/** What the list calls "the element": label, else identifier, else index, else the sentence. */
export function elementText(f: ExplorationFinding): string {
  return (
    f.element_label?.trim() ||
    f.element_identifier?.trim() ||
    (f.element_index != null ? `Element #${f.element_index}` : "") ||
    f.summary
  );
}

/**
 * Two findings merge when they make the same claim: same check, same element, same
 * measurement against the same threshold, in the same appearance, with the same
 * confidence. The screen is deliberately not part of the key — the same control
 * failing the same way on six screens is one thing to fix, shown as "×6".
 */
export function mergeKey(f: ExplorationFinding): string {
  const element =
    f.element_identifier ?? f.element_label ?? (f.element_index != null ? `#${f.element_index}` : f.summary);
  return [
    f.kind,
    element,
    f.element_label ?? "",
    f.measured ?? "",
    f.threshold ?? "",
    f.unit ?? "",
    f.appearance ?? "*",
    f.confident ? "c" : "u",
  ].join("|");
}

export function mergeFindings(findings: readonly ExplorationFinding[]): MergedFinding[] {
  const byKey = new Map<string, MergedFinding>();
  for (const f of findings) {
    const key = mergeKey(f);
    const screen = f.screen_hash ?? "?";
    const row = byKey.get(key);
    if (!row) {
      byKey.set(key, {
        key,
        head: f,
        findings: [f],
        severity: f.severity,
        kind: f.kind,
        screens: [screen],
        confident: f.confident,
      });
      continue;
    }
    row.findings.push(f);
    if (!row.screens.includes(screen)) row.screens.push(screen);
    if (sevRank(f.severity) < sevRank(row.severity)) {
      row.severity = f.severity;
      row.head = f;
    }
  }
  return [...byKey.values()];
}

export interface Occurrence {
  screen: string;
  step: number | null;
  appearance: string | null;
  /** How many identical findings were recorded at this screen and step. */
  count: number;
  /** Index into `row.findings` of the first of them, for the screenshot. */
  index: number;
}

/**
 * Where a merged row was seen, one entry per (screen, step, appearance): the audit
 * can record the very same finding several times on one visit, and listing
 * "Screen f143a2 · step 72" eight times would be the duplication this list removes.
 */
export function occurrences(row: Pick<MergedFinding, "findings">): Occurrence[] {
  const byKey = new Map<string, Occurrence>();
  row.findings.forEach((f, index) => {
    const key = [f.screen_hash ?? "?", f.step_seq ?? "", f.appearance ?? ""].join("|");
    const cur = byKey.get(key);
    if (cur) cur.count += 1;
    else
      byKey.set(key, {
        screen: f.screen_hash ?? "?",
        step: f.step_seq,
        appearance: f.appearance,
        count: 1,
        index,
      });
  });
  return [...byKey.values()].sort((a, b) => (a.step ?? Infinity) - (b.step ?? Infinity));
}

/** How far the measurement misses, 0 (barely) … 1 (completely); used to sort the worst first. */
function shortfall(f: ExplorationFinding): number {
  const p = thresholdProgress(f);
  return p == null ? 0 : 1 - p;
}

/** Worst severity, then biggest miss, then most occurrences, then by element. */
export function compareMerged(a: MergedFinding, b: MergedFinding): number {
  return (
    sevRank(a.severity) - sevRank(b.severity) ||
    shortfall(b.head) - shortfall(a.head) ||
    b.findings.length - a.findings.length ||
    elementText(a.head).localeCompare(elementText(b.head))
  );
}

// Filtering -------------------------------------------------------------------

export interface FindingFilter {
  /** Empty means every severity. */
  severities: Severity[];
  kind: string | null;
  appearance: string | null;
  screen: string | null;
  query: string;
}

export const EMPTY_FILTER: FindingFilter = {
  severities: [],
  kind: null,
  appearance: null,
  screen: null,
  query: "",
};

export function isFilterActive(filter: FindingFilter): boolean {
  return (
    filter.severities.length > 0 ||
    filter.kind != null ||
    filter.appearance != null ||
    filter.screen != null ||
    filter.query.trim() !== ""
  );
}

/** Toggle one severity in or out of the filter (the severity bar's segments). */
export function toggleSeverity(filter: FindingFilter, severity: Severity): FindingFilter {
  const has = filter.severities.includes(severity);
  return {
    ...filter,
    severities: has
      ? filter.severities.filter((s) => s !== severity)
      : sevOrder.filter((s) => s === severity || filter.severities.includes(s)),
  };
}

export function matchesFilter(f: ExplorationFinding, filter: FindingFilter): boolean {
  if (filter.severities.length > 0 && !filter.severities.includes(f.severity)) return false;
  if (filter.kind != null && f.kind !== filter.kind) return false;
  if (filter.appearance != null && (f.appearance ?? "") !== filter.appearance) return false;
  if (filter.screen != null && (f.screen_hash ?? "?") !== filter.screen) return false;
  const q = filter.query.trim().toLowerCase();
  if (q) {
    const hay = [f.summary, f.element_label, f.element_identifier, auditKindLabel(f.kind), f.kind]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();
    if (!q.split(/\s+/).every((word) => hay.includes(word))) return false;
  }
  return true;
}

export function filterFindings(
  findings: readonly ExplorationFinding[],
  filter: FindingFilter,
): ExplorationFinding[] {
  return isFilterActive(filter) ? findings.filter((f) => matchesFilter(f, filter)) : [...findings];
}

export interface FilterOptions {
  kinds: Array<{ kind: string; label: string; count: number }>;
  appearances: string[];
  screens: Array<{ screen: string; label: string; count: number }>;
}

/** What the filter menus offer: only values the findings actually contain, biggest first. */
export function filterOptions(findings: readonly ExplorationFinding[]): FilterOptions {
  const kinds = new Map<string, number>();
  const appearances = new Set<string>();
  const screens = new Map<string, { count: number; step: number | null }>();
  for (const f of findings) {
    kinds.set(f.kind, (kinds.get(f.kind) ?? 0) + 1);
    if (f.appearance) appearances.add(f.appearance);
    const s = f.screen_hash ?? "?";
    const cur = screens.get(s) ?? { count: 0, step: null };
    cur.count += 1;
    if (f.step_seq != null && (cur.step == null || f.step_seq < cur.step)) cur.step = f.step_seq;
    screens.set(s, cur);
  }
  return {
    kinds: [...kinds.entries()]
      .map(([kind, count]) => ({ kind, label: auditKindLabel(kind), count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    appearances: [...appearances].sort(),
    screens: [...screens.entries()]
      .map(([screen, v]) => ({ screen, label: screenLabel(screen, v.step), count: v.count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
  };
}

// Labels ----------------------------------------------------------------------

/**
 * A screen has no name in the data — only a perceptual hash and the step it was
 * first seen at — so it reads as `Screen 3f9a2c · step 14`, which is at least
 * stable and lets a reader match it to the run.
 */
export function screenLabel(screenHash: string | null, step?: number | null): string {
  if (!screenHash || screenHash === "?") return step != null ? `Unknown screen · step ${step}` : "Unknown screen";
  const short = screenHash.slice(0, 6);
  return step != null ? `Screen ${short} · step ${step}` : `Screen ${short}`;
}

/** First step a screen was seen at, among these findings. */
function firstStep(findings: readonly ExplorationFinding[], screen: string): number | null {
  let step: number | null = null;
  for (const f of findings) {
    if ((f.screen_hash ?? "?") === screen && f.step_seq != null && (step == null || f.step_seq < step)) {
      step = f.step_seq;
    }
  }
  return step;
}

/**
 * The compact gauge text for a row: `3.97 → 4.5` for a floor to reach,
 * `48 → ≤0` for a ceiling not to exceed. The unit rides separately so the row can
 * mute it, and a `ratio`/`:1` unit is dropped as noise. Null for boolean checks.
 */
export function gaugeText(
  f: Pick<ExplorationFinding, "kind" | "measured" | "threshold" | "unit">,
): { measured: string; threshold: string | null; unit: string | null } | null {
  if (f.measured == null) return null;
  const num = (v: number) => String(Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100);
  const unit = f.unit && f.unit !== "ratio" && !f.unit.startsWith(":") ? f.unit : null;
  const threshold =
    f.threshold == null ? null : `${thresholdDirection(f.kind) === "at-most" ? "≤" : ""}${num(f.threshold)}`;
  return { measured: num(f.measured), threshold, unit };
}

// Grouping and flattening -----------------------------------------------------

/** A top-level block of the list (Measured / Needs a look; New / Gone / Unchanged). */
export interface ListSection {
  key: string;
  title: string;
  description?: string;
  /** Dot colour hint for the header; the view maps it to a token. */
  tone?: "worse" | "better" | "same" | "muted";
  findings: readonly ExplorationFinding[];
}

/** Row heights in px. Fixed so the window maths is exact without measuring the DOM. */
export const ITEM_HEIGHT = {
  section: 44,
  check: 34,
  screen: 28,
  row: 36,
} as const;

export const SEVERAL_SCREENS = "*several*";

export type ListItem =
  | { type: "section"; id: string; section: ListSection; count: number; rows: number }
  | {
      type: "check";
      id: string;
      sectionKey: string;
      kind: AuditKind;
      label: string;
      count: number;
      rows: number;
      collapsed: boolean;
      bySeverity: Record<Severity, number>;
    }
  | {
      type: "screen";
      id: string;
      sectionKey: string;
      screen: string;
      label: string;
      count: number;
      rows: number;
      collapsed: boolean;
    }
  | { type: "row"; id: string; sectionKey: string; row: MergedFinding };

export function itemHeight(item: ListItem): number {
  return ITEM_HEIGHT[item.type];
}

function emptySeverity(): Record<Severity, number> {
  return { blocker: 0, major: 0, minor: 0, cosmetic: 0, info: 0 };
}

/**
 * Sections → checks → screens → merged rows, flattened in display order.
 *
 * Within a check, rows seen on more than one screen go under "Several screens"
 * first — a control failing the same way everywhere is usually one shared
 * component, the highest-leverage fix — then each screen, busiest first.
 * A collapsed group still emits its header (with counts) but none of its children.
 * Empty sections are dropped.
 */
export function buildListItems(
  sections: readonly ListSection[],
  collapsed: ReadonlySet<string> = new Set(),
): ListItem[] {
  const out: ListItem[] = [];
  for (const section of sections) {
    if (section.findings.length === 0) continue;
    const rows = mergeFindings(section.findings);
    const sectionItem: ListItem = {
      type: "section",
      id: `s:${section.key}`,
      section,
      count: section.findings.length,
      rows: rows.length,
    };
    out.push(sectionItem);

    const byKind = new Map<AuditKind, MergedFinding[]>();
    for (const r of rows) {
      const list = byKind.get(r.kind) ?? [];
      list.push(r);
      byKind.set(r.kind, list);
    }
    const kinds = [...byKind.entries()]
      .map(([kind, list]) => ({ kind, list, count: list.reduce((n, r) => n + r.findings.length, 0) }))
      .sort((a, b) => b.count - a.count || auditKindLabel(a.kind).localeCompare(auditKindLabel(b.kind)));

    for (const { kind, list, count } of kinds) {
      const checkId = `c:${section.key}:${kind}`;
      const bySeverity = emptySeverity();
      for (const r of list) for (const f of r.findings) bySeverity[f.severity] += 1;
      const checkCollapsed = collapsed.has(checkId);
      out.push({
        type: "check",
        id: checkId,
        sectionKey: section.key,
        kind,
        label: auditKindLabel(kind),
        count,
        rows: list.length,
        collapsed: checkCollapsed,
        bySeverity,
      });
      if (checkCollapsed) continue;

      const byScreen = new Map<string, MergedFinding[]>();
      for (const r of list) {
        const screen = r.screens.length > 1 ? SEVERAL_SCREENS : r.screens[0];
        const bucket = byScreen.get(screen) ?? [];
        bucket.push(r);
        byScreen.set(screen, bucket);
      }
      const screens = [...byScreen.entries()]
        .map(([screen, bucket]) => ({
          screen,
          bucket: bucket.sort(compareMerged),
          count: bucket.reduce((n, r) => n + r.findings.length, 0),
        }))
        .sort(
          (a, b) =>
            Number(b.screen === SEVERAL_SCREENS) - Number(a.screen === SEVERAL_SCREENS) ||
            b.count - a.count ||
            a.screen.localeCompare(b.screen),
        );

      for (const { screen, bucket, count: screenCount } of screens) {
        const screenId = `g:${section.key}:${kind}:${screen}`;
        const screenCollapsed = collapsed.has(screenId);
        out.push({
          type: "screen",
          id: screenId,
          sectionKey: section.key,
          screen,
          label:
            screen === SEVERAL_SCREENS
              ? "Several screens"
              : screenLabel(screen, firstStep(section.findings, screen)),
          count: screenCount,
          rows: bucket.length,
          collapsed: screenCollapsed,
        });
        if (screenCollapsed) continue;
        for (const row of bucket) {
          out.push({ type: "row", id: `r:${section.key}:${row.key}`, sectionKey: section.key, row });
        }
      }
    }
  }
  return out;
}

/** Every collapsible group id in the list, for "collapse all". */
export function groupIds(items: readonly ListItem[]): string[] {
  return items.filter((i) => i.type === "check").map((i) => i.id);
}

// Windowing -------------------------------------------------------------------

/** `offsets[i]` is the top of item `i`; the last entry is the total height. */
export function itemOffsets(items: readonly ListItem[]): number[] {
  const offsets = new Array<number>(items.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < items.length; i++) offsets[i + 1] = offsets[i] + itemHeight(items[i]);
  return offsets;
}

/** Index of the item containing `y` (binary search over `offsets`). */
export function indexAt(offsets: readonly number[], y: number): number {
  const n = offsets.length - 1;
  if (n <= 0) return 0;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The slice `[start, end)` of items to render for a viewport at `scrollTop` of
 * height `viewport`, padded by `overscan` items each side so fast scrolling does
 * not flash blank rows.
 */
export function visibleRange(
  offsets: readonly number[],
  scrollTop: number,
  viewport: number,
  overscan = 8,
): { start: number; end: number } {
  const n = offsets.length - 1;
  if (n <= 0) return { start: 0, end: 0 };
  const first = indexAt(offsets, Math.max(0, scrollTop));
  const last = indexAt(offsets, Math.max(0, scrollTop + viewport - 1));
  return { start: Math.max(0, first - overscan), end: Math.min(n, last + 1 + overscan) };
}

/**
 * The scrollTop that brings item `i` fully into view, or null when it already is.
 * Used by j/k so the selection never leaves the viewport.
 */
export function scrollToReveal(
  offsets: readonly number[],
  index: number,
  scrollTop: number,
  viewport: number,
  margin = 0,
): number | null {
  const top = offsets[index];
  const bottom = offsets[index + 1];
  if (top == null || bottom == null) return null;
  if (top - margin < scrollTop) return Math.max(0, top - margin);
  if (bottom + margin > scrollTop + viewport) return bottom + margin - viewport;
  return null;
}

/**
 * The next selectable row from `current` in direction `step` (+1 j, -1 k). With no
 * current selection, j picks the first row and k the last. Stays put at the ends.
 */
export function nextRowIndex(items: readonly ListItem[], current: number, step: 1 | -1): number {
  if (current < 0 || current >= items.length) {
    const order = step === 1 ? items.keys() : [...items.keys()].reverse();
    for (const i of order) if (items[i].type === "row") return i;
    return -1;
  }
  for (let i = current + step; i >= 0 && i < items.length; i += step) {
    if (items[i].type === "row") return i;
  }
  return current;
}

// Charts ----------------------------------------------------------------------

export interface CheckBar {
  kind: string;
  label: string;
  total: number;
  bySeverity: Record<Severity, number>;
}

/** Findings per check, stacked by severity, most first — the one-exploration chart. */
export function checkBars(findings: readonly ExplorationFinding[]): CheckBar[] {
  const byKind = new Map<string, CheckBar>();
  for (const f of findings) {
    const bar = byKind.get(f.kind) ?? {
      kind: f.kind,
      label: auditKindLabel(f.kind),
      total: 0,
      bySeverity: emptySeverity(),
    };
    bar.total += 1;
    bar.bySeverity[f.severity] += 1;
    byKind.set(f.kind, bar);
  }
  return [...byKind.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}

export interface CheckTrend {
  kind: string;
  label: string;
  /** Count per exploration, oldest first. */
  values: number[];
  latest: number;
  previous: number;
  /** `latest - previous`; positive is worse. */
  delta: number;
  /** Percentage change, rounded; null when the previous count was 0. */
  deltaPct: number | null;
}

/**
 * One sparkline per check across explorations — the two-or-more chart. Every check
 * any exploration touched is included (a check that dropped to 0 is the good news),
 * sorted by its latest count, then by its history.
 */
export function checkTrends(summaries: readonly ExplorationReportSummary[]): CheckTrend[] {
  const ordered = [...summaries].sort(
    (a, b) =>
      Date.parse(a.report.created_at) - Date.parse(b.report.created_at) ||
      a.report.revision - b.report.revision,
  );
  const kinds = new Set<string>();
  for (const s of ordered) for (const [k, n] of Object.entries(s.byKind)) if (n > 0) kinds.add(k);
  return [...kinds]
    .map((kind) => {
      const values = ordered.map((s) => s.byKind[kind] ?? 0);
      const latest = values[values.length - 1] ?? 0;
      const previous = values.length > 1 ? values[values.length - 2] : latest;
      const delta = latest - previous;
      return {
        kind,
        label: auditKindLabel(kind),
        values,
        latest,
        previous,
        delta,
        deltaPct: previous > 0 ? Math.round((delta / previous) * 100) : null,
      };
    })
    .sort(
      (a, b) =>
        b.latest - a.latest ||
        b.values.reduce((x, y) => x + y, 0) - a.values.reduce((x, y) => x + y, 0) ||
        a.label.localeCompare(b.label),
    );
}

/** SVG polyline points for a sparkline in a `width × height` box (y grows down). */
export function sparklinePoints(values: readonly number[], width: number, height: number, pad = 2): string {
  if (values.length === 0) return "";
  const max = Math.max(1, ...values);
  const inner = height - pad * 2;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  return values
    .map((v, i) => {
      const x = values.length > 1 ? i * step : width / 2;
      const y = pad + inner - (v / max) * inner;
      return `${Math.round(x * 100) / 100},${Math.round(y * 100) / 100}`;
    })
    .join(" ");
}
