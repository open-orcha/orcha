import { describe, expect, it } from "vitest";
import { diffStats, lineDiff, withContext } from "./textDiff";
import { changedSummary, formatValue, historyQuery, actorName, type ConfigRevision } from "./configHistoryModel";

describe("lineDiff", () => {
  it("marks a changed line as del + add and keeps the rest", () => {
    const ops = lineDiff("a\nb\nc", "a\nB\nc");
    expect(ops).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "same", text: "c" },
    ]);
    expect(diffStats(ops)).toEqual({ added: 1, removed: 1 });
  });

  it("handles insertions, deletions, empty and identical input", () => {
    expect(diffStats(lineDiff("a\nc", "a\nb\nc"))).toEqual({ added: 1, removed: 0 });
    expect(diffStats(lineDiff("a\nb\nc", "a\nc"))).toEqual({ added: 0, removed: 1 });
    expect(lineDiff("", "x")).toEqual([{ kind: "add", text: "x" }]);
    expect(lineDiff(null, null)).toEqual([]);
    expect(diffStats(lineDiff("same\ntext", "same\ntext"))).toEqual({ added: 0, removed: 0 });
    expect(lineDiff("a\r\nb", "a\nb").every((o) => o.kind === "same")).toBe(true);
  });

  it("collapses long unchanged runs into gaps around the change", () => {
    const before = Array.from({ length: 20 }, (_, i) => "L" + i).join("\n");
    const after = before.replace("L10", "L10!");
    const rows = withContext(lineDiff(before, after), 2);
    expect(rows[0]).toEqual({ kind: "gap", count: 8 });
    expect(rows.filter((r) => r.kind !== "gap")).toHaveLength(6); // 2 ctx + del + add + 2 ctx
    expect(rows[rows.length - 1]).toEqual({ kind: "gap", count: 7 });
  });
});

describe("config history formatting", () => {
  it("says what null MEANS per field (unset is not empty)", () => {
    expect(formatValue("auto_wake_interval_secs", null)).toBe("Off");
    expect(formatValue("auto_wake_interval_secs", 600)).toBe("Every 10 min");
    expect(formatValue("auto_wake_interval_secs", 3600)).toBe("Hourly");
    expect(formatValue("autonomy_override", null)).toBe("Inherit project");
    expect(formatValue("autonomy_override", "pr")).toBe("PR");
    expect(formatValue("reasoning_effort", null)).toBe("Default");
    expect(formatValue("model", "claude-opus-5")).toBe("Opus 5");
    expect(formatValue("provider", "codex")).toBe("Codex");
    expect(formatValue("role", null)).toBe("Not set");
  });

  it("builds the list query from a filter", () => {
    expect(historyQuery("all")).toBe("limit=30");
    expect(historyQuery("system_prompt", 7)).toBe("field=system_prompt&before=7&limit=30");
    expect(historyQuery("restore")).toBe("kind=restore&limit=30");
  });

  it("summarises changed fields (derived last-hidden) and names the actor truthfully", () => {
    const r: ConfigRevision = {
      revision_no: 3, kind: "change", source: "model", actor: null, restored_from: null, reason: null,
      redacted_fields: [], created_at: null,
      changes: [
        { field: "model", before: "claude-opus-5", after: "gpt-5.6-sol" },
        { field: "provider", before: "claude", after: "codex", derived: true },
      ],
    };
    expect(changedSummary(r)).toBe("model");
    expect(actorName(r)).toBe("Unattributed");
    expect(actorName({ ...r, actor: { agent_id: "h1", alias: "Boss", kind: "human" } })).toBe("Boss");
  });
});
