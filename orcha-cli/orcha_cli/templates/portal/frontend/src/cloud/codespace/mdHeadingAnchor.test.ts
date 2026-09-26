import { describe, expect, it } from "vitest";
import { extractHeadingLines, normalizeHeadingText, resolveHeadingLine } from "./mdHeadingAnchor";

describe("extractHeadingLines", () => {
  it("extracts #, ##, ### headings with 1-based source line numbers, in order", () => {
    const raw = "# Title\n\nSome text.\n\n## Section A\n\nMore text.\n\n### Sub B\n";
    expect(extractHeadingLines(raw)).toEqual([
      { line: 1, text: "Title" },
      { line: 5, text: "Section A" },
      { line: 9, text: "Sub B" },
    ]);
  });

  it("ignores non-heading lines and #### (h4+, out of mdText's #{1,3} range)", () => {
    const raw = "#### Not a heading (4 hashes)\nplain line\n# Real heading\n";
    expect(extractHeadingLines(raw)).toEqual([{ line: 3, text: "Real heading" }]);
  });

  it("allows up to 3 leading spaces before the hashes (matches mdText's regex)", () => {
    const raw = "   # Indented heading\n";
    expect(extractHeadingLines(raw)).toEqual([{ line: 1, text: "Indented heading" }]);
  });

  it("requires whitespace after the hashes — '#NoSpace' is not a heading", () => {
    const raw = "#NoSpace\n# Real\n";
    expect(extractHeadingLines(raw)).toEqual([{ line: 2, text: "Real" }]);
  });

  it("returns an empty array for empty/non-string input", () => {
    expect(extractHeadingLines("")).toEqual([]);
    expect(extractHeadingLines(undefined as unknown as string)).toEqual([]);
  });
});

describe("normalizeHeadingText", () => {
  it("strips bold/italic/code markup and lowercases + collapses whitespace", () => {
    expect(normalizeHeadingText("**Bold**  Title")).toBe("bold title");
    expect(normalizeHeadingText("*Italic* and _also italic_")).toBe("italic and also italic");
    expect(normalizeHeadingText("`inline code` here")).toBe("inline code here");
  });

  it("treats already-flattened rendered text (no markup) as equal to its source", () => {
    expect(normalizeHeadingText("Plain Heading")).toBe(normalizeHeadingText("Plain Heading"));
  });
});

describe("resolveHeadingLine", () => {
  const raw = "# Title\n\nSome **bold** text.\n\n## Section A\n\nMore text.\n\n## Section A\n";

  it("resolves the Nth rendered heading to its source line when text matches", () => {
    expect(resolveHeadingLine(raw, 0, "Title")).toEqual({ resolved: true, line: 1 });
    expect(resolveHeadingLine(raw, 1, "Section A")).toEqual({ resolved: true, line: 5 });
  });

  it("matches against the FLATTENED rendered text (markup already stripped by the renderer)", () => {
    const rawBold = "# **Bold** Title\n";
    expect(resolveHeadingLine(rawBold, 0, "Bold Title")).toEqual({ resolved: true, line: 1 });
  });

  it("resolves duplicate-text headings positionally (each occurrence maps to its own line)", () => {
    expect(resolveHeadingLine(raw, 2, "Section A")).toEqual({ resolved: true, line: 9 });
  });

  it("falls back when the DOM index has no corresponding extracted heading", () => {
    expect(resolveHeadingLine(raw, 99, "Nonexistent")).toEqual({ resolved: false, reason: "index_out_of_range" });
  });

  it("falls back on a text mismatch rather than anchoring to a possibly-wrong line", () => {
    expect(resolveHeadingLine(raw, 0, "Completely Different Text")).toEqual({ resolved: false, reason: "text_mismatch" });
  });
});
