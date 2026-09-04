/**
 * resultText — the open-orcha#209 JSONB normalization truth table (port of the
 * cloud vanilla tasks-detail.js resultText). Strings pass through; objects
 * with a conventional text field yield that field; anything else becomes
 * readable pretty-printed JSON — never "[object Object]".
 */
import { describe, expect, it } from "vitest";
import { resultText } from "./resultText";

describe("resultText (open-orcha#209 JSONB normalization)", () => {
  it("null/undefined -> empty string", () => {
    expect(resultText(null)).toBe("");
    expect(resultText(undefined)).toBe("");
  });

  it("strings pass through untouched (including empty and whitespace)", () => {
    expect(resultText("PR #203 opened")).toBe("PR #203 opened");
    expect(resultText("")).toBe("");
    expect(resultText("  spaced  ")).toBe("  spaced  ");
  });

  it("objects with a conventional text field yield that field, in vanilla order", () => {
    expect(resultText({ result: "from result" })).toBe("from result");
    expect(resultText({ summary: "from summary" })).toBe("from summary");
    expect(resultText({ text: "from text" })).toBe("from text");
    expect(resultText({ message: "from message" })).toBe("from message");
    // precedence: result > summary > text > message
    expect(resultText({ message: "m", text: "t", summary: "s", result: "r" })).toBe("r");
    expect(resultText({ message: "m", summary: "s" })).toBe("s");
  });

  it("skips blank/non-string conventional fields and falls to the next", () => {
    expect(resultText({ result: "   ", summary: "kept" })).toBe("kept");
    expect(resultText({ result: 42, text: "kept" })).toBe("kept");
  });

  it("other objects become pretty-printed JSON — never [object Object]", () => {
    const out = resultText({ pr: 203, ok: true });
    expect(out).toBe(JSON.stringify({ pr: 203, ok: true }, null, 2));
    expect(out).not.toContain("[object Object]");
  });

  it("arrays pretty-print too (typeof [] === 'object')", () => {
    expect(resultText(["a", "b"])).toBe(JSON.stringify(["a", "b"], null, 2));
  });

  it("unstringifiable objects (circular) fall back to String(r)", () => {
    const circ: Record<string, unknown> = {};
    circ.self = circ;
    expect(resultText(circ)).toBe(String(circ));
  });

  it("non-object scalars stringify", () => {
    expect(resultText(42)).toBe("42");
    expect(resultText(true)).toBe("true");
  });
});
