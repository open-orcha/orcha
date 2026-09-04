import { describe, expect, it } from "vitest";
import type { LogEvent } from "../../lib/classify";
import { extractLiveEdits, groupLiveEditsByFile } from "./liveEdits";

function toolEvent(name: string, input: unknown): LogEvent {
  return { type: "tool", label: "tool", text: name, detail: JSON.stringify(input) };
}

describe("extractLiveEdits", () => {
  it("extracts a Write tool call into an all-add patch", () => {
    const events = [toolEvent("Write", { file_path: "src/a.ts", content: "line1\nline2" })];
    const edits = extractLiveEdits(events);
    expect(edits).toHaveLength(1);
    expect(edits[0].kind).toBe("write");
    expect(edits[0].filePath).toBe("src/a.ts");
    expect(edits[0].lines).toEqual(["+line1", "+line2"]);
    expect(edits[0].add).toBe(2);
    expect(edits[0].del).toBe(0);
  });

  it("extracts an Edit tool call into del-then-add lines", () => {
    const events = [toolEvent("Edit", { file_path: "src/b.ts", old_string: "old1\nold2", new_string: "new1" })];
    const edits = extractLiveEdits(events);
    expect(edits[0].kind).toBe("edit");
    expect(edits[0].lines).toEqual(["-old1", "-old2", "+new1"]);
    expect(edits[0].add).toBe(1);
    expect(edits[0].del).toBe(2);
  });

  it("extracts a MultiEdit tool call by concatenating every sub-edit", () => {
    const events = [
      toolEvent("MultiEdit", {
        file_path: "src/c.ts",
        edits: [
          { old_string: "foo", new_string: "bar" },
          { old_string: "baz", new_string: "qux\nquux" },
        ],
      }),
    ];
    const edits = extractLiveEdits(events);
    expect(edits[0].kind).toBe("multiedit");
    expect(edits[0].lines).toEqual(["-foo", "+bar", "-baz", "+qux", "+quux"]);
    expect(edits[0].add).toBe(3);
    expect(edits[0].del).toBe(2);
  });

  it("ignores non-edit tool calls", () => {
    const events = [toolEvent("Bash", { command: "ls" }), toolEvent("Read", { file_path: "x.ts" })];
    expect(extractLiveEdits(events)).toEqual([]);
  });

  it("ignores narrate/think/result/done rows", () => {
    const events: LogEvent[] = [
      { type: "narrate", label: "narration", text: "hi" },
      { type: "think", label: "thinking", text: "(thinking)" },
      { type: "done", label: "run-complete", text: "ended" },
    ];
    expect(extractLiveEdits(events)).toEqual([]);
  });

  it("skips a tool call with no file_path or malformed JSON", () => {
    const events = [
      { type: "tool", label: "tool", text: "Write", detail: "{not json" } as LogEvent,
      toolEvent("Edit", { old_string: "a", new_string: "b" }), // no file_path
    ];
    expect(extractLiveEdits(events)).toEqual([]);
  });

  it("preserves stream order via seq", () => {
    const events = [
      toolEvent("Write", { file_path: "a.ts", content: "x" }),
      { type: "narrate", label: "narration", text: "thinking" } as LogEvent,
      toolEvent("Edit", { file_path: "b.ts", old_string: "y", new_string: "z" }),
    ];
    const edits = extractLiveEdits(events);
    expect(edits.map((e) => e.seq)).toEqual([0, 2]);
  });
});

describe("groupLiveEditsByFile", () => {
  it("groups multiple edits to the same file into one card, summing add/del", () => {
    const events = [
      toolEvent("Write", { file_path: "a.ts", content: "one\ntwo" }),
      toolEvent("Edit", { file_path: "a.ts", old_string: "one", new_string: "uno" }),
      toolEvent("Write", { file_path: "b.ts", content: "hi" }),
    ];
    const cards = groupLiveEditsByFile(extractLiveEdits(events));
    const aCard = cards.find((c) => c.filePath === "a.ts")!;
    expect(aCard.edits).toHaveLength(2);
    expect(aCard.add).toBe(3); // 2 (write) + 1 (edit new_string)
    expect(aCard.del).toBe(1); // 1 (edit old_string)
  });

  it("orders cards by most-recently-touched file first", () => {
    const events = [
      toolEvent("Write", { file_path: "old.ts", content: "x" }),
      toolEvent("Write", { file_path: "new.ts", content: "y" }),
    ];
    const cards = groupLiveEditsByFile(extractLiveEdits(events));
    expect(cards.map((c) => c.filePath)).toEqual(["new.ts", "old.ts"]);
  });

  it("returns an empty array for no edits", () => {
    expect(groupLiveEditsByFile([])).toEqual([]);
  });
});
