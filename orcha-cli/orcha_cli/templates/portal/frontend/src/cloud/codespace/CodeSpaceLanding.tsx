/**
 * Code Space nav build, item 2 — the content pane's landing state (no file
 * open yet): recent threads (repo-wide, same fetchRecentThreads +
 * RecentThreadsList the rail's own Recent quick-jump uses — one card, not a
 * reimplementation) and recently-viewed files (localStorage via
 * recentFiles.ts, "record on every file open"). The old "Quick actions" row
 * (Search symbols / Browse files) is gone: it repeated the toolbar's symbol
 * search and the tree right next to it (D12, screen review r1). Same card/list idioms as the rest of the app — .gh-empty/.card-empty
 * degrade shell, .cs-recent-list rows, house `muted`/`none` text classes —
 * nothing new invented.
 */
import { useEffect, useRef, useState } from "react";
import { Icon } from "../../components/ui";
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
}

export function CodeSpaceLanding({ cid, onNavigateToThread, onOpenFile }: CodeSpaceLandingProps) {
  const { snap, bump } = useSnapshot();
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

  // V2 (screen review S3): flat hairline sections, no card-in-card; the
  // repo-wide recent threads live HERE only (the rail shows a hint instead of
  // repeating the same list — see ThreadRail's landingOwnsRecent).
  return (
    <div className="cs-landing">
      <section className="cs-landing-section" aria-labelledby="cs-landing-threads-h">
        <h2 className="cs-landing-h" id="cs-landing-threads-h"><span>Recent threads</span>{recentThreads.length ? <span className="cs-landing-count tnum" aria-hidden="true">{recentThreads.length}</span> : null}</h2>
        <RecentThreadsList threads={recentThreads} agents={snap?.agents} onOpen={onNavigateToThread} emptyLabel="No threads yet. Click a line number in any file to start one." />
      </section>

      <section className="cs-landing-section" aria-labelledby="cs-landing-files-h">
        <h2 className="cs-landing-h" id="cs-landing-files-h"><span>Recent files</span>{recentFiles.length ? <span className="cs-landing-count tnum" aria-hidden="true">{recentFiles.length}</span> : null}</h2>
        {!recentFiles.length ? (
          <div className="cs-empty-line">Files you open will show up here.</div>
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
                <Icon name="code" cls="v2-ico cs-landing-file-ico" />
                <span className="cs-landing-file-path mono" title={f.path}>{f.path}</span>
                <span className="cs-landing-file-time muted">{relTime(f.viewedAt)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
