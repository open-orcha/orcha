import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTER,
  ITEM_HEIGHT,
  SEVERAL_SCREENS,
  buildListItems,
  checkBars,
  checkTrends,
  elementText,
  filterFindings,
  filterOptions,
  gaugeText,
  indexAt,
  isFilterActive,
  itemOffsets,
  mergeFindings,
  mergeKey,
  nextRowIndex,
  occurrences,
  screenLabel,
  scrollToReveal,
  sparklinePoints,
  toggleSeverity,
  visibleRange,
  type ListItem,
} from "./exploration-list";
import type { AuditKind, ExplorationFinding, ExplorationReport, ExplorationReportSummary } from "./types";

let seq = 0;
function finding(over: Partial<ExplorationFinding> = {}): ExplorationFinding {
  seq += 1;
  return {
    id: `f${seq}`,
    report_id: "r1",
    kind: "low_contrast" as AuditKind,
    severity: "minor",
    summary: '"Add Photo" has 4.0:1 contrast, below the 4.5:1 minimum.',
    measured: 3.97,
    threshold: 4.5,
    unit: "ratio",
    confident: true,
    screen_hash: "aaaaaa111111",
    step_seq: 10,
    frame_path: null,
    rect: null,
    element_index: 3,
    element_label: "Add Photo",
    element_identifier: null,
    appearance: "dark",
    detail: {},
    created_at: "2026-09-01T00:00:00Z",
    ...over,
  };
}

function report(over: Partial<ExplorationReport> = {}): ExplorationReport {
  return {
    id: "r1",
    project_id: "p1",
    target_id: null,
    run_id: null,
    build_id: null,
    app_version: "1.0",
    git_commit: null,
    git_branch: null,
    revision: 1,
    target_kind: "ios",
    appearances: ["light", "dark"],
    screens_seen: 5,
    summary_md: null,
    created_at: "2026-09-01T00:00:00Z",
    ...over,
  };
}

function summary(id: string, createdAt: string, byKind: Record<string, number>): ExplorationReportSummary {
  return {
    report: report({ id, created_at: createdAt }),
    bySeverity: { blocker: 0, major: 0, minor: 0, cosmetic: 0, info: 0 },
    byKind,
    findings: Object.values(byKind).reduce((a, b) => a + b, 0),
    needsLook: 0,
    notes: 0,
    judged: 0,
    judgedBySeverity: { blocker: 0, major: 0, minor: 0, cosmetic: 0, info: 0 },
  };
}

describe("merging duplicates", () => {
  it("folds the same claim on several screens into one row", () => {
    const rows = mergeFindings([
      finding({ screen_hash: "s1" }),
      finding({ screen_hash: "s2" }),
      finding({ screen_hash: "s2", step_seq: 40 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].findings).toHaveLength(3);
    expect(rows[0].screens).toEqual(["s1", "s2"]);
  });

  it("keeps different metrics, appearances, checks and elements apart", () => {
    const rows = mergeFindings([
      finding(),
      finding({ measured: 2.09 }),
      finding({ appearance: "light" }),
      finding({ kind: "tap_target_too_small" }),
      finding({ element_label: "Cancel" }),
      finding({ confident: false }),
    ]);
    expect(rows).toHaveLength(6);
  });

  it("heads the row with its worst occurrence", () => {
    const rows = mergeFindings([finding({ severity: "minor" }), finding({ severity: "major", id: "worst" })]);
    expect(rows[0].severity).toBe("major");
    expect(rows[0].head.id).toBe("worst");
  });

  it("lists where a row was seen once per screen and step", () => {
    const [row] = mergeFindings([
      finding({ screen_hash: "s1", step_seq: 72 }),
      finding({ screen_hash: "s1", step_seq: 72 }),
      finding({ screen_hash: "s2", step_seq: 30 }),
    ]);
    expect(occurrences(row)).toEqual([
      { screen: "s2", step: 30, appearance: "dark", count: 1, index: 2 },
      { screen: "s1", step: 72, appearance: "dark", count: 2, index: 0 },
    ]);
  });

  it("keys on identifier before label so a relabelled control still merges per label", () => {
    expect(mergeKey(finding({ element_identifier: "btn" }))).not.toBe(mergeKey(finding()));
  });

  it("names the element by label, then identifier, then index", () => {
    expect(elementText(finding())).toBe("Add Photo");
    expect(elementText(finding({ element_label: null, element_identifier: "plus" }))).toBe("plus");
    expect(elementText(finding({ element_label: null, element_index: 7 }))).toBe("Element #7");
  });
});

describe("filtering", () => {
  const all = [
    finding({ severity: "major", kind: "off_screen", appearance: "light", screen_hash: "s1" }),
    finding({ severity: "minor", screen_hash: "s2" }),
    finding({ severity: "cosmetic", kind: "missing_identifier", element_label: "Chores tab", screen_hash: "s2" }),
  ];

  it("passes everything through an empty filter", () => {
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
    expect(filterFindings(all, EMPTY_FILTER)).toHaveLength(3);
  });

  it("filters by severity, check, appearance and screen", () => {
    expect(filterFindings(all, { ...EMPTY_FILTER, severities: ["major", "cosmetic"] })).toHaveLength(2);
    expect(filterFindings(all, { ...EMPTY_FILTER, kind: "off_screen" })).toHaveLength(1);
    expect(filterFindings(all, { ...EMPTY_FILTER, appearance: "dark" })).toHaveLength(2);
    expect(filterFindings(all, { ...EMPTY_FILTER, screen: "s2" })).toHaveLength(2);
  });

  it("searches the sentence, element and check name, every word", () => {
    expect(filterFindings(all, { ...EMPTY_FILTER, query: "chores" })).toHaveLength(1);
    expect(filterFindings(all, { ...EMPTY_FILTER, query: "missing chores" })).toHaveLength(1);
    expect(filterFindings(all, { ...EMPTY_FILTER, query: "off screen" })).toHaveLength(1);
    expect(filterFindings(all, { ...EMPTY_FILTER, query: "nothing-like-this" })).toHaveLength(0);
  });

  it("toggles severities in display order", () => {
    const a = toggleSeverity(EMPTY_FILTER, "minor");
    const b = toggleSeverity(a, "blocker");
    expect(b.severities).toEqual(["blocker", "minor"]);
    expect(toggleSeverity(b, "minor").severities).toEqual(["blocker"]);
  });

  it("offers only values present, busiest first", () => {
    const opts = filterOptions(all);
    // Ties sort by label.
    expect(opts.kinds.map((k) => k.kind)).toEqual(["low_contrast", "missing_identifier", "off_screen"]);
    expect(opts.appearances).toEqual(["dark", "light"]);
    expect(opts.screens[0]).toMatchObject({ screen: "s2", count: 2 });
  });
});

describe("labels", () => {
  it("names screens by short hash and first step", () => {
    expect(screenLabel("abcdef123456", 14)).toBe("Screen abcdef · step 14");
    expect(screenLabel(null)).toBe("Unknown screen");
  });

  it("formats the compact gauge, muting ratio units", () => {
    expect(gaugeText(finding())).toEqual({ measured: "3.97", threshold: "4.5", unit: null });
    expect(gaugeText(finding({ kind: "off_screen", measured: 48, threshold: 0, unit: "px" }))).toEqual({
      measured: "48",
      threshold: "≤0",
      unit: "px",
    });
    expect(gaugeText(finding({ measured: null }))).toBeNull();
  });
});

function types(items: ListItem[]): string {
  return items.map((i) => i.type[0]).join("");
}

describe("grouping by check, then screen", () => {
  const findings = [
    // Same claim on two screens -> one merged row under "Several screens".
    finding({ screen_hash: "s1" }),
    finding({ screen_hash: "s2" }),
    // One-screen claims.
    finding({ element_label: "Cancel", screen_hash: "s1" }),
    finding({ kind: "missing_identifier", element_label: "Tab", measured: null, threshold: null, screen_hash: "s1" }),
  ];

  it("emits section, check, screen and row items in order", () => {
    const items = buildListItems([{ key: "measured", title: "Measured", findings }]);
    expect(types(items)).toBe("scsrsrcsr");
    const check = items[1];
    expect(check.type === "check" && check.kind).toBe("low_contrast");
    expect(check.type === "check" && check.count).toBe(3);
    expect(check.type === "check" && check.rows).toBe(2);
    const several = items[2];
    expect(several.type === "screen" && several.screen).toBe(SEVERAL_SCREENS);
    expect(several.type === "screen" && several.label).toBe("Several screens");
  });

  it("hides the children of a collapsed group but keeps its header", () => {
    const items = buildListItems([{ key: "measured", title: "Measured", findings }], new Set(["c:measured:low_contrast"]));
    expect(types(items)).toBe("sccsr");
    const collapsedScreen = buildListItems(
      [{ key: "measured", title: "Measured", findings }],
      new Set([`g:measured:low_contrast:${SEVERAL_SCREENS}`]),
    );
    expect(types(collapsedScreen)).toBe("scssrcsr");
  });

  it("drops empty sections", () => {
    const items = buildListItems([
      { key: "a", title: "A", findings: [] },
      { key: "b", title: "B", findings: [finding()] },
    ]);
    expect(items[0].type === "section" && items[0].section.key).toBe("b");
  });
});

describe("windowing", () => {
  const items = buildListItems([
    {
      key: "m",
      title: "M",
      findings: Array.from({ length: 1000 }, (_, i) => finding({ element_label: `el ${i}` })),
    },
  ]);
  const offsets = itemOffsets(items);

  it("adds up fixed heights", () => {
    expect(offsets[0]).toBe(0);
    expect(offsets[items.length]).toBe(
      ITEM_HEIGHT.section + ITEM_HEIGHT.check + ITEM_HEIGHT.screen + 1000 * ITEM_HEIGHT.row,
    );
  });

  it("finds the item under a y offset", () => {
    expect(indexAt(offsets, 0)).toBe(0);
    expect(indexAt(offsets, ITEM_HEIGHT.section)).toBe(1);
    expect(indexAt(offsets, 1e9)).toBe(items.length - 1);
  });

  it("renders only the viewport plus overscan", () => {
    const { start, end } = visibleRange(offsets, 10_000, 600, 5);
    expect(end - start).toBeLessThan(40);
    expect(offsets[start]).toBeLessThanOrEqual(10_000);
    expect(offsets[end]).toBeGreaterThanOrEqual(10_600);
    expect(visibleRange([0], 0, 600)).toEqual({ start: 0, end: 0 });
  });

  it("scrolls just enough to reveal an item", () => {
    expect(scrollToReveal(offsets, 3, 0, 600)).toBeNull();
    const far = 500;
    const top = scrollToReveal(offsets, far, 0, 600)!;
    expect(top + 600).toBe(offsets[far + 1]);
    expect(scrollToReveal(offsets, 3, 5000, 600)).toBe(offsets[3]);
  });

  it("moves the selection over rows only", () => {
    expect(nextRowIndex(items, -1, 1)).toBe(3);
    expect(nextRowIndex(items, -1, -1)).toBe(items.length - 1);
    expect(nextRowIndex(items, 3, 1)).toBe(4);
    expect(nextRowIndex(items, 3, -1)).toBe(3);
    expect(nextRowIndex(items, items.length - 1, 1)).toBe(items.length - 1);
  });
});

describe("charts", () => {
  it("ranks checks by count, stacked by severity", () => {
    const bars = checkBars([
      finding({ severity: "major" }),
      finding({ severity: "minor" }),
      finding({ kind: "off_screen", severity: "blocker" }),
    ]);
    expect(bars.map((b) => b.kind)).toEqual(["low_contrast", "off_screen"]);
    expect(bars[0].bySeverity).toMatchObject({ major: 1, minor: 1 });
    expect(bars[0].total).toBe(2);
  });

  it("trends each check oldest first with a delta against the previous exploration", () => {
    const trends = checkTrends([
      summary("b", "2026-09-02T00:00:00Z", { low_contrast: 368, off_screen: 0 }),
      summary("a", "2026-09-01T00:00:00Z", { low_contrast: 418, off_screen: 4 }),
    ]);
    expect(trends[0]).toMatchObject({ kind: "low_contrast", values: [418, 368], latest: 368, delta: -50, deltaPct: -12 });
    // A check that went to zero is kept: that is the good news.
    expect(trends[1]).toMatchObject({ kind: "off_screen", latest: 0, delta: -4, deltaPct: -100 });
  });

  it("has no percentage when a check is new", () => {
    const [t] = checkTrends([
      summary("a", "2026-09-01T00:00:00Z", {}),
      summary("b", "2026-09-02T00:00:00Z", { clipped_text: 3 }),
    ]);
    expect(t).toMatchObject({ delta: 3, deltaPct: null });
  });

  it("draws sparkline points inside the box", () => {
    expect(sparklinePoints([0, 10], 100, 20, 2)).toBe("0,18 100,2");
    expect(sparklinePoints([5], 100, 20, 2)).toBe("50,2");
    expect(sparklinePoints([], 100, 20)).toBe("");
  });
});
