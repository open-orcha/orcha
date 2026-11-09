import { describe, expect, it } from "vitest";
import type { RecordingCommand } from "./recording";
import {
  inputRows,
  personInputCount,
  previewOffset,
  unsettled,
  type PendingInput,
} from "./recording-inputs";

function stored(id: string, seq: number, status: RecordingCommand["status"] = "pending"): RecordingCommand {
  return { id, seq, kind: "swipe", args: { x: 1, y: 1, dx: 0, dy: 100 }, status, result: null };
}

function input(localId: number, command: RecordingCommand | null, sentAtSeq = 3): PendingInput {
  return { localId, kind: "swipe", args: { x: 1, y: 1, dx: 0, dy: 100 }, preview: { x: 0, y: -50 }, sentAtSeq, command };
}

describe("inputRows", () => {
  it("shows an input the moment it is made, then as its stored row", () => {
    const a = stored("a", 1, "done");
    const rows = inputRows([a], [input(1, a), input(2, stored("b", 2)), input(3, null)]);
    expect(rows.map((r) => [r.key, r.seq, r.status])).toEqual([
      ["a", 1, "done"],
      ["b", 2, "pending"],
      ["local-3", null, "sending"],
    ]);
  });
});

describe("personInputCount", () => {
  it("counts the person's inputs, not the Finish that ended the recording (#472)", () => {
    const taps = [1, 2, 3, 4].map((seq) => ({ ...stored(`t${seq}`, seq, "done"), kind: "tap" as const }));
    expect(personInputCount([...taps, { ...stored("f", 5, "done"), kind: "finish" }])).toBe(4);
    expect(personInputCount([{ ...stored("f", 1, "done"), kind: "finish" }])).toBe(0);
    expect(personInputCount([])).toBe(0);
  });
});

describe("unsettled", () => {
  it("keeps an input until it was played and a newer frame is on screen", () => {
    const pending = input(1, stored("a", 1));
    const sending = input(2, null);
    expect(unsettled([pending, sending], [stored("a", 1)], 9)).toHaveLength(2);
    // Played, but the frame on screen is still the one it was made on.
    expect(unsettled([pending], [stored("a", 1, "done")], 3)).toHaveLength(1);
    expect(unsettled([pending], [stored("a", 1, "done")], 5)).toHaveLength(0);
    expect(unsettled([pending], [stored("a", 1, "failed")], 4)).toHaveLength(0);
  });

  it("settles an input once a live frame taken after its command ran is on screen", () => {
    const played = input(1, stored("a", 4, "done"));
    // The recorded frame is still the one it was made on, but the live stream shows command 4.
    expect(unsettled([played], [stored("a", 4, "done")], 3, 3)).toHaveLength(1);
    expect(unsettled([played], [stored("a", 4, "done")], 3, 4)).toHaveLength(0);
    // Not played yet: a live frame never settles it.
    expect(unsettled([input(2, stored("b", 5))], [stored("b", 5)], 3, 9)).toHaveLength(1);
  });

  it("adds up the slide of what is still in flight", () => {
    expect(previewOffset([input(1, null), input(2, null)], { x: 3, y: 4 })).toEqual({ x: 3, y: -96 });
  });
});


