/**
 * Dynamic-import boundary for DraftEditorPane — same rationale as
 * LazyEditorPane.tsx: CodeSpacePage renders THIS, never DraftEditorPane
 * directly, so the CM6 bundle only downloads once a human flips the pencil
 * on for a GitHub-bound (draft-mode) file. A view-only visitor, and a
 * local-binding visitor who never leaves the (separate) worktree editor
 * path, never fetches this chunk.
 */
import { lazy, Suspense } from "react";
import type { DraftEditorPaneProps } from "./DraftEditorPane";

const RealDraftEditorPane = lazy(() =>
  import("./DraftEditorPane").then((m) => ({ default: m.DraftEditorPane })),
);

export function LazyDraftEditorPane(props: DraftEditorPaneProps) {
  return (
    <Suspense fallback={<div className="none" style={{ padding: 10 }}>Loading editor…</div>}>
      <RealDraftEditorPane {...props} />
    </Suspense>
  );
}
