/**
 * Thread gutter markers for the CM6 editors (EditorPane / DraftEditorPane):
 * the read-only viewer paints an accent dot in the gutter of every line a
 * code thread anchors to (CodeSpacePage `.cs-gutter-dot`); Edit mode must
 * keep the same markers so toggling Edit never makes the threads "vanish".
 *
 * Implemented as a `gutterLineClass` provider (a class on the line-number
 * gutter element, painted by editorTheme.ts) held in a StateField, so the
 * markers follow the text through edits (`RangeSet.map`) and can be replaced
 * when the thread list refreshes (`setThreadLines` effect).
 */
import { RangeSet, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { GutterMarker, gutterLineClass } from "@codemirror/view";

export const THREAD_LINE_CLASS = "cs-cm-thread-line";

class ThreadLineMarker extends GutterMarker {
  elementClass = THREAD_LINE_CLASS;
}
const MARK = new ThreadLineMarker();

/** Pure: 1-based line numbers → a sorted RangeSet at each line's start (out-of-range lines dropped). */
export function buildThreadMarks(doc: Text, lines: readonly number[]): RangeSet<GutterMarker> {
  const valid = Array.from(new Set(lines)).filter((l) => Number.isInteger(l) && l >= 1 && l <= doc.lines).sort((a, b) => a - b);
  return RangeSet.of(valid.map((l) => MARK.range(doc.line(l).from)));
}

export const setThreadLines = StateEffect.define<number[]>();

const threadMarksField = StateField.define<RangeSet<GutterMarker>>({
  create: () => RangeSet.empty,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const e of tr.effects) if (e.is(setThreadLines)) next = buildThreadMarks(tr.state.doc, e.value);
    return next;
  },
  provide: (f) => gutterLineClass.from(f),
});

/** The extension; `initial` is read at state creation (a getter so a re-created state picks up the latest lines). */
export function threadMarks(initial: () => readonly number[]): Extension {
  return threadMarksField.init((state) => buildThreadMarks(state.doc, initial()));
}
