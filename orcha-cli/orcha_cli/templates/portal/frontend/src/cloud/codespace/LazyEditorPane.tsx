/**
 * Dynamic-import boundary for EditorPane — CodeSpacePage renders THIS
 * (never EditorPane directly), so the CM6 bundle (@codemirror/*, its
 * language-data grammars) only downloads once a human actually flips the
 * Edit toggle on. A view-only visitor's session never fetches this chunk;
 * verified by the build's code-split output (see the report at the end of
 * the implementation task this file was added for).
 */
import { lazy, Suspense } from "react";
import type { EditorPaneProps } from "./EditorPane";

const RealEditorPane = lazy(() =>
  import("./EditorPane").then((m) => ({ default: m.EditorPane })),
);

export function LazyEditorPane(props: EditorPaneProps) {
  return (
    <Suspense fallback={<div className="none" style={{ padding: 10 }}>Loading editor…</div>}>
      <RealEditorPane {...props} />
    </Suspense>
  );
}
