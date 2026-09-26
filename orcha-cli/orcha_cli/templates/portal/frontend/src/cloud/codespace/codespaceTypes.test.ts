import { describe, expect, it } from "vitest";
import {
  anchorLabel,
  groupByPath,
  kindLabel,
  learnThreads,
  shortSha,
  THREAD_TEMPLATES,
  type CodeThreadSummary,
} from "./codespaceTypes";

function thread(overrides: Partial<CodeThreadSummary>): CodeThreadSummary {
  return {
    id: "t1", ref: "HEAD", sha: "abc1234def", path: "a.ts",
    start_line: 1, end_line: 1, kind: "question", status: "open",
    created_at: "now", updated_at: "now",
    ...overrides,
  };
}

describe("shortSha", () => {
  it("truncates to 7 chars", () => {
    expect(shortSha("abc1234def")).toBe("abc1234");
  });
  it("returns empty string for null/undefined", () => {
    expect(shortSha(null)).toBe("");
    expect(shortSha(undefined)).toBe("");
  });
});

describe("anchorLabel", () => {
  it("renders a single line as just the number", () => {
    expect(anchorLabel(12, 12)).toBe("12");
  });
  it("renders a range as start-end", () => {
    expect(anchorLabel(12, 18)).toBe("12-18");
  });
});

describe("kindLabel", () => {
  it("maps every kind to its display label", () => {
    expect(kindLabel("question")).toBe("Question");
    expect(kindLabel("why")).toBe("Why");
    expect(kindLabel("teach")).toBe("Teach");
    expect(kindLabel("note")).toBe("Note");
  });
});

describe("THREAD_TEMPLATES", () => {
  it("has exactly the four spec templates in order", () => {
    expect(THREAD_TEMPLATES.map((t) => t.kind)).toEqual(["question", "why", "teach", "note"]);
    expect(THREAD_TEMPLATES.map((t) => t.label)).toEqual([
      "How does this work?",
      "Why this decision?",
      "Teach me this concept",
      "Note",
    ]);
  });
});

describe("groupByPath", () => {
  it("groups threads by path, preserving order within each group", () => {
    const threads = [
      thread({ id: "a", path: "x.ts" }),
      thread({ id: "b", path: "y.ts" }),
      thread({ id: "c", path: "x.ts" }),
    ];
    const grouped = groupByPath(threads);
    expect(Array.from(grouped.keys())).toEqual(["x.ts", "y.ts"]);
    expect(grouped.get("x.ts")!.map((t) => t.id)).toEqual(["a", "c"]);
  });
});

describe("learnThreads", () => {
  it("keeps only teach and why threads", () => {
    const threads = [
      thread({ id: "a", kind: "teach" }),
      thread({ id: "b", kind: "why" }),
      thread({ id: "c", kind: "question" }),
      thread({ id: "d", kind: "note" }),
    ];
    expect(learnThreads(threads).map((t) => t.id)).toEqual(["a", "b"]);
  });
});
