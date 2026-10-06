/**
 * Learn — pure helpers: the quick-start builder, the CM6 lesson-focus
 * decorations, the selection → line-range mapping behind the floating lens, and
 * the remembered lesson titles.
 */
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildLessonFocus, LESSON_DIMMED_CLASS, LESSON_FOCUS_CLASS, lessonFocus, lessonFocusSpec } from "./editorLessonFocus";
import { buildQuickStarts } from "./learnQuickStarts";
import { _resetLessonTitles, lessonTitleFor, rememberLessonTitle } from "./lessonTitles";
import { selectionLines } from "./SelectionLens";

describe("buildQuickStarts", () => {
  it("no file open → a repo tour anchored at README.md", () => {
    const qs = buildQuickStarts({ path: "" });
    expect(qs.map((q) => q.id)).toEqual(["tour"]);
    expect(qs[0]).toMatchObject({ kind: "teach", path: "README.md", start: 1, end: 1 });
  });

  it("a file → explain (whole file) · why exists · folder tour", () => {
    const qs = buildQuickStarts({ path: "src/shell/Shell.tsx", lineCount: 40 });
    expect(qs.map((q) => q.id)).toEqual(["explain-file", "why-exists", "tour"]);
    expect(qs[0]).toMatchObject({ kind: "teach", start: 1, end: 40, label: "Explain this file" });
    expect(qs[1]).toMatchObject({ kind: "why", start: 1, end: 1 });
    expect(qs[2].label).toBe("Give me a tour of src/shell/");
    expect(qs[2].body).toContain("src/shell/ folder");
  });

  it("a root-level file tours the repo", () => {
    expect(buildQuickStarts({ path: "main.go", lineCount: 3 })[2].label).toBe("Give me a tour of this repo");
  });

  it("a selection leads with teach/why on exactly those lines", () => {
    const qs = buildQuickStarts({ path: "a.ts", lineCount: 9, selection: { start: 7, end: 7 } });
    expect(qs[0]).toMatchObject({ id: "teach-selection", kind: "teach", start: 7, end: 7, label: "Teach me the concept at line 7" });
    expect(qs[1]).toMatchObject({ id: "why-selection", kind: "why", start: 7, end: 7 });
    expect(qs[0].body).toContain("a.ts line 7");
  });
});

describe("editorLessonFocus (CM6)", () => {
  const doc = EditorState.create({ doc: Array.from({ length: 10 }, (_, i) => "line " + (i + 1)).join("\n") }).doc;

  it("builds one line decoration per focused line, clamped to the document", () => {
    const set = buildLessonFocus(doc, [{ start: 3, end: 4 }, { start: 9, end: 40 }, { start: 50, end: 60 }]);
    const lines: number[] = [];
    set.between(0, doc.length, (from) => { lines.push(doc.lineAt(from).number); });
    expect(lines).toEqual([3, 4, 9, 10]);
    expect(buildLessonFocus(doc, null).size).toBe(0);
  });

  it("the extension glows focused lines and dims the editor; clearing removes both", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({ state: EditorState.create({ doc, extensions: [lessonFocus(() => null)] }), parent });
    expect(view.dom.classList.contains(LESSON_DIMMED_CLASS)).toBe(false);
    view.dispatch(lessonFocusSpec(view.state.doc, [{ start: 2, end: 3 }]));
    expect(view.dom.classList.contains(LESSON_DIMMED_CLASS)).toBe(true);
    expect(view.dom.querySelectorAll("." + LESSON_FOCUS_CLASS).length).toBe(2);
    view.dispatch(lessonFocusSpec(view.state.doc, null));
    expect(view.dom.classList.contains(LESSON_DIMMED_CLASS)).toBe(false);
    expect(view.dom.querySelectorAll("." + LESSON_FOCUS_CLASS).length).toBe(0);
    view.destroy();
    parent.remove();
  });
});

describe("selectionLines (floating lens)", () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement("div");
    root.innerHTML = [1, 2, 3, 4].map((n) => `<div data-cs-line="${n}"><span class="cs-line-text">code ${n}</span></div>`).join("");
    document.body.appendChild(root);
  });
  afterEach(() => { root.remove(); window.getSelection()?.removeAllRanges(); });

  const select = (a: Node, ao: number, b: Node, bo: number) => {
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    const r = document.createRange();
    r.setStart(a, ao);
    r.setEnd(b, bo);
    sel.addRange(r);
    return sel;
  };
  const text = (n: number) => root.querySelector(`[data-cs-line="${n}"] span`)!.firstChild!;

  it("maps a multi-line selection to its line range", () => {
    expect(selectionLines(select(text(2), 1, text(4), 3), root)).toEqual({ start: 2, end: 4 });
  });

  it("collapsed / outside selections are ignored", () => {
    expect(selectionLines(select(text(2), 1, text(2), 1), root)).toBeNull();
    const outside = document.createElement("p");
    outside.textContent = "elsewhere";
    document.body.appendChild(outside);
    expect(selectionLines(select(outside.firstChild!, 0, outside.firstChild!, 4), root)).toBeNull();
    outside.remove();
    expect(selectionLines(null, root)).toBeNull();
  });
});

describe("lessonTitles", () => {
  beforeEach(() => { localStorage.clear(); _resetLessonTitles(); });

  it("remembers titles across reloads and survives broken storage", () => {
    rememberLessonTitle("t1", "How caching works");
    _resetLessonTitles();
    expect(lessonTitleFor("t1")).toBe("How caching works");
    localStorage.setItem("orcha:cs:lesson-titles", "{not json");
    _resetLessonTitles();
    expect(lessonTitleFor("t1")).toBeNull();
  });
});
