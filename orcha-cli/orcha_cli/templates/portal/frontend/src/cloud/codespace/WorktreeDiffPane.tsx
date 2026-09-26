/**
 * Working-tree diff viewer — the center-pane "viewing mode" the Changes tab
 * opens a file into (alongside the committed-file viewer CodeSpacePage
 * already has). Renders the file's unified diff against HEAD with the
 * EXISTING FilesChanged component in single-file mode (it accepts a raw
 * `diff` string and skips its own sidebar when there's only one file — see
 * FilesChanged.tsx's own doc comment), behind a clear "Uncommitted changes"
 * banner plus a "view file at HEAD" link back to the normal committed-file
 * viewer for the same path.
 */
import { useEffect, useRef, useState } from "react";
import { FilesChanged } from "../../components/FilesChanged";
import { fetchWorktreeDiff, type WorktreeDiffPayload } from "./worktreeApi";

export interface WorktreeDiffPaneProps {
  cid: string;
  path: string;
  onViewAtHead: () => void;
}

export function WorktreeDiffPane({ cid, path, onViewAtHead }: WorktreeDiffPaneProps) {
  const [payload, setPayload] = useState<WorktreeDiffPayload | null>(null);
  const token = useRef(0);

  useEffect(() => {
    const myToken = ++token.current;
    setPayload(null);
    fetchWorktreeDiff(cid, path).then((data) => {
      if (myToken !== token.current) return;
      setPayload(data);
    });
  }, [cid, path]);

  return (
    <div className="cs-worktree-diff">
      <div className="cs-worktree-banner">
        <span className="cs-worktree-banner-label">Uncommitted changes</span>
        <span className="cs-worktree-path mono">{path}</span>
        <span className="grow" />
        <button type="button" className="cs-worktree-head-link" onClick={onViewAtHead}>
          view file at HEAD
        </button>
      </div>
      {!payload ? (
        <div className="none" style={{ padding: 10 }}>Loading diff…</div>
      ) : !payload.available ? (
        <div className="none" style={{ padding: 10 }}>{payload.detail || "This diff is unavailable."}</div>
      ) : payload.binary ? (
        <div className="muted" style={{ padding: 10, fontSize: 13 }}>Binary file not shown.</div>
      ) : (
        <>
          {payload.truncated ? (
            <div className="rb-truncated-note muted">Diff truncated — showing a partial view.</div>
          ) : null}
          <FilesChanged diff={payload.diff} />
        </>
      )}
    </div>
  );
}
