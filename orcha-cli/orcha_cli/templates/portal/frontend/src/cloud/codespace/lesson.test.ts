import { describe, expect, it } from "vitest";
import { lessonParts, localRefs, parseLesson, parseLineRefs, questionTitle, refLabel, stepTarget } from "./lesson";

const span = (refs: { start: number; end: number; path?: string }[]) => refs.map((r) => (r.path ? r.path + ":" : "") + r.start + "-" + r.end);

describe("parseLineRefs", () => {
  it("reads L-refs in every spelling", () => {
    expect(span(parseLineRefs("see L24, then L24-32 and L40–L44, also #L50-L52"))).toEqual(["24-24", "24-32", "40-44", "50-52"]);
  });

  it("reads 'line N' / 'lines N–M' / 'lines N to M' / 'lines N and M'", () => {
    expect(span(parseLineRefs("On line 7 we start; lines 24–32 loop; lines 40 to 45 exit; lines 50 and 51 log."))).toEqual(["7-7", "24-32", "40-45", "50-51"]);
  });

  it("reads file:line refs and keeps their path", () => {
    expect(span(parseLineRefs("compare src/state/Store.ts:24-30 with util.py:9"))).toEqual(["src/state/Store.ts:24-30", "util.py:9-9"]);
  });

  it("folds refs to the CURRENT file into local refs", () => {
    const refs = parseLineRefs("Shell.tsx:23 and src/shell/Shell.tsx:30-32", "src/shell/Shell.tsx");
    expect(refs.map((r) => r.path)).toEqual([undefined, undefined]);
    expect(span(refs)).toEqual(["23-23", "30-32"]);
  });

  it("does not double-count a file ref as a bare number, and dedupes", () => {
    expect(span(parseLineRefs("a.ts:12 then L12 then a.ts:12", "x.ts"))).toEqual(["a.ts:12-12", "12-12"]);
  });

  it("ignores words that merely contain L+digits and nonsense numbers", () => {
    expect(parseLineRefs("HTML5 and CSS3, L0 and version v2.1")).toEqual([]);
  });

  it("a reversed range collapses to its start", () => {
    expect(span(parseLineRefs("L32-24"))).toEqual(["32-32"]);
  });

  it("localRefs keeps only refs that point at the lesson's file", () => {
    const refs = parseLineRefs("L3 and other.ts:4 and Shell.tsx:5");
    expect(span(localRefs(refs, "src/Shell.tsx"))).toEqual(["3-3", "Shell.tsx:5-5"]);
  });

  it("refLabel", () => {
    expect(refLabel({ start: 4, end: 4 })).toBe("L4");
    expect(refLabel({ start: 4, end: 9 })).toBe("L4–9");
  });
});

const STRUCTURED = `# How ⌘K reaches the palette
> Shell listens once and broadcasts a custom event.

## Steps
1. **Register once** (L19-20) — the effect has an empty dependency list.
2. **Match the chord** (L21) metaKey || ctrlKey covers both platforms.
   It also lower-cases the key.
3. **Broadcast** — dispatching \`orcha:palette\` on lines 23–24 decouples Shell.
4. Clean up: the returned function removes it (see util/keys.ts:8).

## Key concepts
- Effect cleanup
- Custom DOM events: a browser primitive

## Follow-ups
- What happens when CodeMirror has focus?
- How would a second listener interact?
`;

describe("parseLesson — the nudged step format", () => {
  const lesson = parseLesson(STRUCTURED, { path: "src/shell/Shell.tsx" });

  it("title, summary, structured", () => {
    expect(lesson.title).toBe("How ⌘K reaches the palette");
    expect(lesson.summary).toBe("Shell listens once and broadcasts a custom event.");
    expect(lesson.structured).toBe(true);
  });

  it("steps with titles, bodies (continuations kept) and their refs", () => {
    expect(lesson.steps.map((s) => s.title)).toEqual(["Register once", "Match the chord", "Broadcast", "Clean up"]);
    expect(lesson.steps[0].body).toBe("the effect has an empty dependency list.");
    expect(lesson.steps[1].body).toContain("metaKey || ctrlKey covers both platforms.");
    expect(lesson.steps[1].body).toContain("It also lower-cases the key.");
    expect(span(lesson.steps[0].refs)).toEqual(["19-20"]);
    expect(span(lesson.steps[1].refs)).toEqual(["21-21"]);
    expect(span(lesson.steps[2].refs)).toEqual(["23-24"]);
    expect(span(lesson.steps[3].refs)).toEqual(["util/keys.ts:8-8"]);
  });

  it("key concepts (trailing explanations trimmed) and follow-ups", () => {
    expect(lesson.concepts).toEqual(["Effect cleanup", "Custom DOM events"]);
    expect(lesson.followUps).toEqual(["What happens when CodeMirror has focus?", "How would a second listener interact?"]);
  });

  it("accepts ### sub-headings as steps inside a Steps section", () => {
    const l = parseLesson("# T\n## Walkthrough\n### Setup\nLines 1-4 import things.\n### Render\nL10 renders.\n", {});
    expect(l.structured).toBe(true);
    expect(l.steps.map((s) => s.title)).toEqual(["Setup", "Render"]);
  });

  it("a numbered list with no Steps heading still counts as steps", () => {
    const l = parseLesson("Here is how it works.\n\n1. First (L1-2) loads.\n2. Then L5 renders.\n", {});
    expect(l.structured).toBe(true);
    expect(l.summary).toBe("Here is how it works.");
    expect(l.steps).toHaveLength(2);
    expect(span(l.steps[1].refs)).toEqual(["5-5"]);
  });

  it("ignores numbered lines inside code fences", () => {
    const l = parseLesson("# T\n## Steps\n1. **A** (L1) a\n```\n2. not a step\n```\n2. **B** (L2) b\n", {});
    expect(l.steps.map((s) => s.title)).toEqual(["A", "B"]);
  });
});

describe("parseLesson — plain prose fallback", () => {
  const PROSE = "Good question. Shell never imports the palette; line 23 dispatches an event.\n\nThat keeps the dependency pointing one way. The listener on lines 19–28 only knows a chord.\n\nThe cost is discoverability — search for the event name.";
  const lesson = parseLesson(PROSE, { path: "src/shell/Shell.tsx", fallbackTitle: "Why dispatch a custom event instead of opening the palette directly?" });

  it("one step per paragraph, each with its own refs", () => {
    expect(lesson.structured).toBe(false);
    expect(lesson.steps).toHaveLength(3);
    expect(span(lesson.steps[0].refs)).toEqual(["23-23"]);
    expect(span(lesson.steps[1].refs)).toEqual(["19-28"]);
    expect(lesson.steps[2].refs).toEqual([]);
    expect(lesson.steps.every((s) => s.title === "")).toBe(true);
  });

  it("title from the question; no summary (it would repeat step 1)", () => {
    expect(lesson.title).toBe("Why dispatch a custom event instead of opening the palette directly?");
    expect(lesson.summary).toBe("");
  });

  it("a single-line answer is still a one-step lesson; empty input never throws", () => {
    expect(parseLesson("It caches the result.", {}).steps).toHaveLength(1);
    const empty = parseLesson("", {});
    expect(empty.steps).toEqual([]);
    expect(empty.title).toBe("Lesson");
  });

  it("keeps fenced code inside a paragraph step", () => {
    const l = parseLesson("Look at this:\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nDone.", {});
    expect(l.steps).toHaveLength(3);
    expect(l.steps[1].body).toContain("const b = 2;");
  });
});

describe("questionTitle / lessonParts", () => {
  it("first sentence, trimmed of filler, capitalised, capped", () => {
    expect(questionTitle("please explain src/a.ts: what it does. And more.")).toBe("Explain src/a.ts: what it does");
    expect(questionTitle("Why is this capped at three?")).toBe("Why is this capped at three?");
    expect(questionTitle("")).toBe("Lesson");
    expect(questionTitle("x".repeat(200)).length).toBeLessThanOrEqual(72);
  });

  it("question = first message, answer = first agent message after it", () => {
    const msgs = [
      { is_human: true, body: "Q" },
      { is_human: true, body: "more context" },
      { is_human: false, body: "A1" },
      { is_human: false, body: "A2" },
    ];
    const { question, answer } = lessonParts(msgs);
    expect(question?.body).toBe("Q");
    expect(answer?.body).toBe("A1");
    expect(lessonParts([{ is_human: true, body: "Q" }]).answer).toBeNull();
    expect(lessonParts(undefined).question).toBeNull();
  });
});

describe("stepTarget (full-page follow)", () => {
  it("prefers the lesson's own file, else the first other file with all of its ranges", () => {
    const refs = (t: string) => ({ refs: parseLineRefs(t, "src/a.ts") });
    expect(stepTarget(refs("L2-3 and b.ts:5"), "src/a.ts")).toEqual({ path: "src/a.ts", ranges: [{ start: 2, end: 3 }] });
    expect(stepTarget(refs("see b.ts:5-6, c.ts:1 and b.ts:9"), "src/a.ts")).toEqual({ path: "b.ts", ranges: [{ start: 5, end: 6 }, { start: 9, end: 9 }] });
    expect(stepTarget(refs("no lines here"), "src/a.ts")).toBeNull();
    expect(stepTarget(undefined, "src/a.ts")).toBeNull();
  });
});
