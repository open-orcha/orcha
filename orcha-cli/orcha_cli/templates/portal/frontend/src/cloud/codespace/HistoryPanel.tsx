/**
 * File-header "History" popover — small "History" button opens a list of
 * commits that touched the current file (short sha, summary, relative
 * time); clicking one re-opens the file at that sha (the viewer already
 * supports arbitrary refs via ?ref=). Local-binding only; the caller
 * (CodeSpacePage) hides the button entirely when the payload comes back
 * unavailable, so this component's own "unavailable" render only fires for
 * the brief window between mount and the first fetch resolving, or for a
 * genuine per-request failure (bad ref) after the button was already shown
 * for a DIFFERENT ref that WAS available.
 */
import { useEffect, useRef, useState } from "react";
import { relTime } from "../../lib/format";
import { fetchFileHistory, type FileHistoryCommit, type FileHistoryPayload } from "./worktreeApi";

export interface HistoryPanelProps {
  cid: string;
  path: string;
  gitRef: string;
  onSelectCommit: (sha: string) => void;
  onClose: () => void;
}

export function HistoryPanel({ cid, path, gitRef, onSelectCommit, onClose }: HistoryPanelProps) {
  const [payload, setPayload] = useState<FileHistoryPayload | null>(null);
  const token = useRef(0);

  useEffect(() => {
    const myToken = ++token.current;
    setPayload(null);
    fetchFileHistory(cid, path, { ref: gitRef }).then((data) => {
      if (myToken !== token.current) return;
      setPayload(data);
    });
  }, [cid, path, gitRef]);

  return (
    <div className="cs-history-popover" role="dialog" aria-label="File history">
      <div className="cs-history-head">
        <span>History</span>
        <button type="button" className="cs-history-close" aria-label="Close history" onClick={onClose}>
          ×
        </button>
      </div>
      {!payload ? (
        <div className="none" style={{ padding: 10 }}>Loading history…</div>
      ) : !payload.available ? (
        <div className="none" style={{ padding: 10 }}>{payload.detail || "History is unavailable."}</div>
      ) : !payload.commits || !payload.commits.length ? (
        <div className="none" style={{ padding: 10 }}>No history found for this file.</div>
      ) : (
        <div className="cs-history-list">
          {payload.commits.map((c: FileHistoryCommit) => (
            <div
              key={c.sha}
              className="cs-history-row"
              onClick={() => onSelectCommit(c.sha)}
              title={c.summary}
            >
              <span className="tag mono cs-history-sha">{c.short}</span>
              <span className="cs-history-summary">{c.summary}</span>
              <span className="grow" />
              <span className="muted cs-history-time">{relTime(c.committed_at)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
