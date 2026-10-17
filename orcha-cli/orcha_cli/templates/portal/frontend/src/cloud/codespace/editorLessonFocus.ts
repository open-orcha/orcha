/**
 * Learn — lesson-step focus for the CM6 editors (EditorPane: edit mode and the
 * large-file read-only view). Stepping through a lesson glows the lines the
 * current step cites and dims everything else, the same effect the hand-rolled
 * read view paints with `.cs-line.lesson-focus` (CodeSpacePage).
 *
 * - glow: a `Decoration.line` class on every focused line (cheap: only the cited
 *   lines carry a decoration, never the whole document);
 * - dim: ONE editor-level class (`cm-lesson-dimmed`) while any focus is active —
 *   CSS dims `.cm-line:not(.cm-lesson-focus)` — so a 20k-line file doesn't need a
 *   decoration per unfocused line;
 * - scroll: setting a focus also scrolls its first line to the centre.
 *
 * Decorations are held in a StateField, so they map through edits and are
 * replaced wholesale by the `setLessonFocus` effect (null clears).
 */
import { RangeSetBuilder, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

export interface FocusRange {
  start: number;
  end: number;
}

export const LESSON_FOCUS_CLASS = "cm-lesson-focus";
export const LESSON_DIMMED_CLASS = "cm-lesson-dimmed";

const focusLine = Decoration.line({ class: LESSON_FOCUS_CLASS });
const focusFirst = Decoration.line({ class: LESSON_FOCUS_CLASS + " cm-lesson-focus-start" });

/** Pure: 1-based ranges → sorted line decorations (clamped; out-of-range dropped). */
export function buildLessonFocus(doc: Text, ranges: readonly FocusRange[] | null): DecorationSet {
  if (!ranges || !ranges.length) return Decoration.none;
  const lines = new Set<number>();
  const starts = new Set<number>();
  for (const r of ranges) {
    const s = Math.max(1, Math.floor(r.start));
    const e = Math.min(doc.lines, Math.floor(Math.max(r.start, r.end)));
    if (s > doc.lines) continue;
    starts.add(s);
    for (let l = s; l <= e; l++) lines.add(l);
  }
  const b = new RangeSetBuilder<Decoration>();
  Array.from(lines).sort((a, c) => a - c).forEach((l) => {
    const from = doc.line(l).from;
    b.add(from, from, starts.has(l) ? focusFirst : focusLine);
  });
  return b.finish();
}

export const setLessonFocus = StateEffect.define<FocusRange[] | null>();

const lessonFocusField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const e of tr.effects) if (e.is(setLessonFocus)) next = buildLessonFocus(tr.state.doc, e.value);
    return next;
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    EditorView.editorAttributes.from(f, (set): Record<string, string> => (set.size ? { class: LESSON_DIMMED_CLASS } : {})),
  ],
});

/** The extension; `initial` is read at state creation (a getter, like threadMarks). */
export function lessonFocus(initial: () => readonly FocusRange[] | null): Extension {
  return lessonFocusField.init((state) => buildLessonFocus(state.doc, initial()));
}

/** Transaction spec that sets the focus AND centres its first line (null = clear). */
export function lessonFocusSpec(doc: Text, ranges: FocusRange[] | null) {
  const first = ranges && ranges.length ? Math.min(...ranges.map((r) => r.start)) : null;
  const effects: StateEffect<unknown>[] = [setLessonFocus.of(ranges && ranges.length ? ranges : null)];
  if (first != null && first >= 1 && first <= doc.lines) {
    effects.push(EditorView.scrollIntoView(doc.line(first).from, { y: "center" }));
  }
  return { effects };
}
