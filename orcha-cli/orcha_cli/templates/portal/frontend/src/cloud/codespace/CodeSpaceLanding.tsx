/**
 * Code Space nav build, item 2 — the content pane's landing state (no file
 * open yet): recent threads (repo-wide, same fetchRecentThreads +
 * RecentThreadsList the rail's own Recent quick-jump uses — one card, not a
 * reimplementation), recently-viewed files (localStorage via recentFiles.ts,
 * "record on every file open"), and quick actions (search symbols, a tree
 * hint). Same card/list idioms as the rest of the app — .gh-empty/.card-empty
 * degrade shell, .cs-recent-list rows, house `muted`/`none` text classes —
 * nothing new invented.
 */
import { useEffect, useRef, useState } from "react";
import { useSnapshot } from "../../state/SnapshotProvider";
import { relTime } from "../../lib/format";
import { fetchRecentThreads } from "./codespaceApi";
import type { CodeThreadSummary } from "./codespaceTypes";
import { loadRecentFiles, type RecentFileEntry } from "./recentFiles";
import { RecentThreadsList } from "./RecentThreadsList";

export interface CodeSpaceLandingProps {
  cid: string;
  onNavigateToThread: (thread: CodeThreadSummary) => void;
  onOpenFile: (path: string) => void;
  onSearchSymbols: () => void;
  // "browse tree hint" quick action scrolls the tree pane's first row into
  // view with a highlight pulse, pointing a human at the tree instead of
  // leaving them to hunt for it (see CodeSpacePage.tsx's focusTree for why
  // this isn't a real DOM .focus() — BrowseTree's rows aren't focusable).
  onFocusTree: () => void;
}

export function CodeSpaceLanding({ cid, onNavigateToThread, onOpenFile, onSearchSymbols, onFocusTree }: CodeSpaceLandingProps) {
  const { bump } = useSnapshot();
  const [recentThreads, setRecentThreads] = useState<CodeThreadSummary[]>([]);
  const [recentFiles, setRecentFiles] = useState<RecentFileEntry[]>([]);
  const token = useRef(0);

  useEffect(() => {
    const myToken = ++token.current;
    fetchRecentThreads(cid, { n: 8 }).then((res) => {
      if (myToken !== token.current) return;
      if (res.ok) setRecentThreads(res.data.threads);
    });
    // house 3s bump — same cadence every other Code Space list rides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, bump]);

  // Recently-viewed files come from localStorage, recorded by
  // CodeSpacePage.selectFile on every open — re-read whenever the landing
  // (re)mounts, e.g. navigating away and back via breadcrumbs/back button.
  useEffect(() => {
    setRecentFiles(loadRecentFiles(cid));
  }, [cid]);

  return (
    <div className="cs-landing">
      <div className="cs-landing-card">
        <div className="cs-landing-card-head">
          <span className="t1">Quick actions</span>
        </div>
        <div className="cs-landing-actions">
          <button type="button" className="cs-landing-action" onClick={onSearchSymbols}>
            Search symbols <span className="muted">Ctrl/Cmd+P</span>
          </button>
          <button type="button" className="cs-landing-action" onClick={onFocusTree}>
            Browse the file tree <span className="muted">&larr;</span>
          </button>
        </div>
      </div>

      <div className="cs-landing-card">
        <div className="cs-landing-card-head">
          <span className="t1">Recent threads</span>
        </div>
        <RecentThreadsList threads={recentThreads} onOpen={onNavigateToThread} emptyLabel="No threads yet — open a file and start one." />
      </div>

      <div className="cs-landing-card">
        <div className="cs-landing-card-head">
          <span className="t1">Recent files</span>
        </div>
        {!recentFiles.length ? (
          <div className="none" style={{ padding: 10 }}>Files you open will show up here.</div>
        ) : (
          <div className="cs-landing-files">
            {recentFiles.map((f) => (
              <div
                key={f.path}
                className="cs-landing-file-row"
                onClick={() => onOpenFile(f.path)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpenFile(f.path); } }}
              >
                <span className="cs-landing-file-path mono" title={f.path}>{f.path}</span>
                <span className="cs-landing-file-time muted">{relTime(f.viewedAt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
