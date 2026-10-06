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
import { Button } from "../../components/primitives";
import { useEffect, useRef, useState } from "react";
import { FilesChanged, parseDiffFiles } from "../../components/FilesChanged";
import { BinaryDiffView } from "../../components/filePreview/BinaryDiff";
import { worktreeBlobSource } from "../../components/filePreview/sources";
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
        <span className="cs-worktree-path mono" title={path}>{path}</span>
        <span className="grow" />
        <Button size="sm" variant="ghost" iconRight="arrow" className="cs-worktree-head-link" onClick={onViewAtHead}>
          View file at HEAD
        </Button>
      </div>
      {!payload ? (
        <div className="cs-empty-line" role="status">Loading diff…</div>
      ) : !payload.available ? (
        <div className="cs-empty-line">{payload.detail || "This diff is unavailable."}</div>
      ) : payload.binary ? (
        // HEAD vs the working tree, previewed (images compare before/after)
        <BinaryDiffView
          file={{ path, status: parseDiffFiles(payload.diff || "")[0]?.status || "M" }}
          source={worktreeBlobSource(cid)}
        />
      ) : (
        <>
          {payload.truncated ? (
            <div className="rb-truncated-note muted">Diff truncated — showing a partial view.</div>
          ) : null}
          <FilesChanged diff={payload.diff} blobSource={worktreeBlobSource(cid)} />
        </>
      )}
    </div>
  );
}
