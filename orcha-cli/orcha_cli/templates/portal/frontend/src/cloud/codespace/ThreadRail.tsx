/**
 * The right rail: Threads (Phase 1, current-file scoped) / Live (Phase 2) /
 * Learn (Phase 4) / Outline (Phase 3) / Changes (working-tree, local run
 * addendum) tabs. Threads-tab list polls on the house 3s bump; anchor chips
 * jump to lines, count badges optional via the tree's fileBadge slot
 * (CodeSpacePage wires that separately). Outline (symbols/OutlineRail.tsx)
 * is scoped to whatever file is currently open, exactly like the Threads
 * tab. Changes (ChangesTab.tsx) is repo-wide (not file-scoped) and owns its
 * own ~5s poll independent of the house bump — see that component's doc
 * comment.
 *
 * Item 3 — when no file is open, the Threads tab's list is replaced by a
 * repo-wide "Recent" section (newest threads across every path); when a file
 * IS open, a compact "Recent" link sits above the per-file list so the
 * quick-jump is always one click away, not just on the empty-file state.
 *
 * Item 5 — posting a thread (or a raise-hand) swaps the rail straight into
 * that thread's ThreadView, seeded with the CreateThreadResponse the POST
 * already returned — no loading flash, no waiting for the next 3s poll.
 */
import { useEffect, useRef, useState } from "react";
import { useSnapshot } from "../../state/SnapshotProvider";
import type { Agent } from "../../types";
import { ChangesTab } from "./ChangesTab";
import { fetchRecentThreads, fetchThreads } from "./codespaceApi";
import {
  anchorLabel,
  kindLabel,
  shortSha,
  type CodeThreadDetailPayload,
  type CodeThreadSummary,
  type CreateThreadResponse,
} from "./codespaceTypes";
import { LearnTab } from "./LearnTab";
import { LivePanel } from "./LivePanel";
import { RecentThreadsList } from "./RecentThreadsList";
import { OutlineRail } from "./symbols/OutlineRail";
import { ThreadComposer } from "./ThreadComposer";
import { ThreadView } from "./ThreadView";

export type RailTab = "threads" | "live" | "learn" | "outline" | "changes";

export interface ThreadRailProps {
  cid: string;
  // NOT named "ref" — that's a reserved JSX/React prop (element refs); see
  // RepoBrowser.tsx's identical convention/comment for `gitRef`.
  gitRef: string;
  path: string;
  agents: Agent[];
  tab: RailTab;
  onTabChange: (tab: RailTab) => void;
  // composer open state is driven by the code viewer's gutter click
  composerSelection: { start: number; end: number } | null;
  // Item 2 — composerSelection is {start:1,end:1} for BOTH an actual line-1
  // gutter click AND the Rendered view's "Discuss this document" affordance;
  // this flag disambiguates them so the composer never mislabels a real
  // line-1 selection as the whole document (or vice versa).
  composerWholeDocument?: boolean;
  onComposerClose: () => void;
  onJumpToLine: (line: number) => void;
  onJumpToPinnedSha?: (sha: string) => void;
  openThreadId: string | null;
  onOpenThread: (id: string | null) => void;
  onThreadsLoaded?: (threads: CodeThreadSummary[]) => void;
  // Phase 2 raise-hand hands off a composer pre-tagged at a specific agent —
  // rendered in the Threads tab (same composer, no free @agent picker).
  raiseHand: { agentId: string; line: number } | null;
  onRaiseHandDone: () => void;
  // fired from the Live tab's patch-card "raise hand" button; the parent page
  // owns the raiseHand state (so it can also switch the rail to Threads).
  onRaiseHandRequested?: (agentId: string, line: number) => void;
  // Item 3 — a Recent-tab row was clicked: open that thread's file at its
  // anchor with the thread selected. Optional so existing mounts/tests that
  // don't wire it still render (Recent rows simply no-op without it, matching
  // every other optional callback's convention in this file).
  onNavigateToThread?: (thread: CodeThreadSummary) => void;
  // Changes tab (working-tree, local run addendum) — cid-scoped, not
  // file-scoped, so it's wired independently of `path`/`gitRef`.
  // selectedWorktreePath highlights the currently-open working-tree diff (if
  // any) in the Changes list; onOpenWorktreeDiff/onDirtyCountChange are
  // optional so existing mounts/tests that don't wire the Changes tab still
  // render everything else unchanged.
  selectedWorktreePath?: string | null;
  onOpenWorktreeDiff?: (path: string) => void;
  onDirtyCountChange?: (count: number) => void;
  // Panel improvements item 1 — resizable panes: CodeSpacePage owns the
  // persisted width (usePaneWidths.ts) and passes it straight through so
  // `.cs-rail` itself (not a wrapper) carries the inline width, matching
  // .cs-tree-pane's own convention.
  width?: number;
}

export function ThreadRail({
  cid,
  gitRef,
  path,
  agents,
  tab,
  onTabChange,
  composerSelection,
  composerWholeDocument,
  onComposerClose,
  onJumpToLine,
  onJumpToPinnedSha,
  openThreadId,
  onOpenThread,
  onThreadsLoaded,
  raiseHand,
  onRaiseHandDone,
  onRaiseHandRequested,
  onNavigateToThread,
  selectedWorktreePath,
  onOpenWorktreeDiff,
  onDirtyCountChange,
  width,
}: ThreadRailProps) {
  const { bump } = useSnapshot();
  const [threads, setThreads] = useState<CodeThreadSummary[]>([]);
  const [recentThreads, setRecentThreads] = useState<CodeThreadSummary[]>([]);
  const [showRecent, setShowRecent] = useState(false);
  const [dirtyCount, setDirtyCount] = useState(0);
  // Item 5 — optimistic seed for the thread ThreadView is about to open
  // (set right when a composer's POST resolves; cleared once the rail moves
  // on to a DIFFERENT thread id, a fresh open thread has no stale seed).
  const [openSeed, setOpenSeed] = useState<CodeThreadDetailPayload | null>(null);
  const token = useRef(0);
  const recentToken = useRef(0);

  useEffect(() => {
    if (!path) { setThreads([]); return; }
    const myToken = ++token.current;
    fetchThreads(cid, { ref: gitRef, path }).then((res) => {
      if (myToken !== token.current) return;
      if (res.ok) {
        setThreads(res.data.threads);
        onThreadsLoaded?.(res.data.threads);
      }
    });
    // house 3s bump — the rail's thread list rides the same poll cadence
    // every other mutation surface does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, gitRef, path, bump]);

  // BUG 3 fix — showRecent is UI state scoped to "am I looking at this
  // file's own threads, or the repo-wide Recent list". Switching to a
  // DIFFERENT file must always land back on that file's own list — carrying
  // over showRecent=true stranded the rail on "Recent threads (all files)"
  // after a file switch (user-reported screenshot: rail lost the current
  // file's context after thread interaction).
  useEffect(() => {
    setShowRecent(false);
  }, [path]);

  // Recent quick-jump: fetched whenever no file is open (it's the default
  // view then) OR the human explicitly toggled the compact "Recent" link
  // while a file IS open.
  const wantsRecent = !path || showRecent;
  useEffect(() => {
    if (!wantsRecent) return;
    const myToken = ++recentToken.current;
    fetchRecentThreads(cid, { n: 20 }).then((res) => {
      if (myToken !== recentToken.current) return;
      if (res.ok) setRecentThreads(res.data.threads);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cid, wantsRecent, bump]);

  const openCreatedThread = (created: CreateThreadResponse) => {
    setOpenSeed({ thread: created.thread, messages: [created.message] });
    onOpenThread(created.thread.id);
  };

  return (
    <aside className="cs-rail" style={width != null ? { width } : undefined}>
      <div className="cs-rail-tabs" role="tablist" aria-label="Code Space rail">
        <button type="button" role="tab" aria-selected={tab === "threads"} className={"cs-rail-tab" + (tab === "threads" ? " on" : "")} onClick={() => onTabChange("threads")}>
          Threads
        </button>
        <button type="button" role="tab" aria-selected={tab === "live"} className={"cs-rail-tab" + (tab === "live" ? " on" : "")} onClick={() => onTabChange("live")}>
          Live
        </button>
        <button type="button" role="tab" aria-selected={tab === "learn"} className={"cs-rail-tab" + (tab === "learn" ? " on" : "")} onClick={() => onTabChange("learn")}>
          Learn
        </button>
        <button type="button" role="tab" aria-selected={tab === "outline"} className={"cs-rail-tab" + (tab === "outline" ? " on" : "")} onClick={() => onTabChange("outline")}>
          Outline
        </button>
        <button type="button" role="tab" aria-selected={tab === "changes"} className={"cs-rail-tab" + (tab === "changes" ? " on" : "")} onClick={() => onTabChange("changes")}>
          Changes
          {dirtyCount ? <span className="cs-rail-tab-badge">{dirtyCount}</span> : null}
        </button>
      </div>
      <div className="cs-rail-body">
        {tab === "threads" ? (
          openThreadId ? (
            <ThreadView
              threadId={openThreadId}
              onBack={() => { onOpenThread(null); setOpenSeed(null); }}
              onJumpToPinnedSha={onJumpToPinnedSha}
              seed={openSeed && openSeed.thread.id === openThreadId ? openSeed : undefined}
            />
          ) : raiseHand ? (
            <ThreadComposer
              cid={cid}
              gitRef={gitRef}
              path={path}
              startLine={raiseHand.line}
              endLine={raiseHand.line}
              agents={agents}
              preTaggedAgentId={raiseHand.agentId}
              onCreated={(created) => { onRaiseHandDone(); openCreatedThread(created); }}
              onCancel={onRaiseHandDone}
            />
          ) : composerSelection ? (
            <ThreadComposer
              cid={cid}
              gitRef={gitRef}
              path={path}
              startLine={composerSelection.start}
              endLine={composerSelection.end}
              agents={agents}
              wholeDocument={composerWholeDocument}
              onCreated={(created) => { onComposerClose(); openCreatedThread(created); }}
              onCancel={onComposerClose}
            />
          ) : path && !showRecent ? (
            <>
              <button type="button" className="cs-recent-link" onClick={() => setShowRecent(true)}>
                Recent threads (all files)
              </button>
              <ThreadList threads={threads} onOpen={onOpenThread} onJumpToLine={onJumpToLine} />
            </>
          ) : (
            <>
              {path ? (
                <button type="button" className="cs-recent-link" onClick={() => setShowRecent(false)}>
                  &larr; Back to {path}
                </button>
              ) : null}
              <RecentThreadsList threads={recentThreads} onOpen={onNavigateToThread} />
            </>
          )
        ) : null}
        {tab === "live" ? (
          <LivePanel cid={cid} agents={agents} onJumpToLine={onJumpToLine} onRaiseHand={onRaiseHandRequested} />
        ) : null}
        {tab === "learn" ? <LearnTab cid={cid} agents={agents} /> : null}
        {tab === "outline" ? <OutlineRail cid={cid} gitRef={gitRef} path={path} onJumpToLine={onJumpToLine} /> : null}
        {tab === "changes" ? (
          <ChangesTab
            cid={cid}
            selectedPath={selectedWorktreePath}
            onOpenChange={(p) => onOpenWorktreeDiff?.(p)}
            onDirtyCountChange={(count) => { setDirtyCount(count); onDirtyCountChange?.(count); }}
          />
        ) : null}
      </div>
    </aside>
  );
}

function ThreadList({
  threads,
  onOpen,
  onJumpToLine,
}: {
  threads: CodeThreadSummary[];
  onOpen: (id: string) => void;
  onJumpToLine: (line: number) => void;
}) {
  if (!threads.length) return <div className="none" style={{ padding: 10 }}>No threads on this file yet.</div>;
  return (
    <>
      {threads.map((t) => (
        <div key={t.id} className="cs-thread-chip" onClick={() => onOpen(t.id)}>
          <div className="row1">
            <span className={"kind-tag " + t.kind}>{kindLabel(t.kind)}</span>
            <span
              className="anchor mono"
              onClick={(e) => { e.stopPropagation(); onJumpToLine(t.start_line); }}
            >
              :{anchorLabel(t.start_line, t.end_line)}
            </span>
            <span className="grow" />
            <span className="status-tag">{t.status}</span>
          </div>
          {t.blob_match === false ? (
            <div className="outdated-chip">outdated — pinned to {shortSha(t.sha)}</div>
          ) : null}
        </div>
      ))}
    </>
  );
}
