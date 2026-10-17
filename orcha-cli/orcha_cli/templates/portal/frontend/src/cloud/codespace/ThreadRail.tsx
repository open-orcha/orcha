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
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, HelpTip } from "../../components/primitives";
import { Icon } from "../../components/ui";
import { relTime, trunc } from "../../lib/format";
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
import { LearnTab, type LearnTabProps } from "./LearnTab";
import { LivePanel } from "./LivePanel";
import { RecentThreadsList } from "./RecentThreadsList";
import { OutlineRail } from "./symbols/OutlineRail";
import { ThreadComposer } from "./ThreadComposer";
import { KindChip, ThreadAuthorAvatar, ThreadStatusIcon } from "./threadBits";
import { ThreadView } from "./ThreadView";

export type RailTab = "threads" | "live" | "learn" | "outline" | "changes";
const RAIL_TABS: { key: RailTab; label: string }[] = [
  { key: "threads", label: "Threads" },
  { key: "live", label: "Live" },
  { key: "learn", label: "Learn" },
  { key: "outline", label: "Outline" },
  { key: "changes", label: "Changes" },
];

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
  // V2: the page's no-file landing already lists repo-wide recent threads in
  // the main pane — when set, the rail's Threads tab shows a short hint
  // instead of rendering the SAME list a second time (screen review S3).
  landingOwnsRecent?: boolean;
  // Learn: file/selection context + the page-owned open lesson and editor
  // focus bridge (CodeSpacePage). Optional — without it Learn still lists and
  // opens lessons on its own.
  learn?: Omit<LearnTabProps, "cid" | "agents" | "gitRef" | "path">;
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
  landingOwnsRecent,
  learn,
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
  const wantsRecent = (!path && !landingOwnsRecent) || showRecent;
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

  // Narrow rails scroll the tab strip: fade whichever edge hides a label and
  // keep the selected tab in view (never a hard-cut "Chang" — screen review r1).
  const tabsRef = useRef<HTMLDivElement | null>(null);
  const [tabsEdge, setTabsEdge] = useState<{ overflowing: boolean; atEnd: boolean }>({ overflowing: false, atEnd: false });
  useLayoutEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    const measure = () => {
      const overflowing = el.scrollWidth > el.clientWidth + 1;
      const atEnd = overflowing && el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
      setTabsEdge((p) => (p.overflowing === overflowing && p.atEnd === atEnd ? p : { overflowing, atEnd }));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => { el.removeEventListener("scroll", measure); ro?.disconnect(); };
  }, [dirtyCount]);
  useEffect(() => {
    const el = document.getElementById("cs-rail-tab-" + tab);
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab]);

  // V2: WAI-ARIA tabs keyboard model (roving tabindex; ←/→/Home/End move
  // AND activate — the rail's panels are cheap to switch).
  const onRailTabsKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const i = RAIL_TABS.findIndex((t) => t.key === tab);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % RAIL_TABS.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + RAIL_TABS.length) % RAIL_TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = RAIL_TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const key = RAIL_TABS[next].key;
    onTabChange(key);
    const el = document.getElementById("cs-rail-tab-" + key);
    if (el) el.focus();
  };

  return (
    <aside className="cs-rail" id="cs-rail" aria-label="Threads and code activity" style={width != null ? { width } : undefined}>
      <div
        ref={tabsRef}
        className={"cs-rail-tabs" + (tabsEdge.overflowing ? " is-overflowing" : "") + (tabsEdge.atEnd ? " is-scrolled-end" : "")}
        role="tablist"
        aria-label="Code Space rail"
        onKeyDown={onRailTabsKey}
      >
        {RAIL_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={"cs-rail-tab-" + t.key}
            aria-controls="cs-rail-panel"
            aria-selected={tab === t.key}
            tabIndex={tab === t.key ? 0 : -1}
            className={"cs-rail-tab" + (tab === t.key ? " on" : "")}
            onClick={() => onTabChange(t.key)}
          >
            {t.label}
            {t.key === "changes" && dirtyCount ? <span className="cs-rail-tab-badge" title={dirtyCount + " uncommitted file" + (dirtyCount === 1 ? "" : "s")}>{dirtyCount}</span> : null}
          </button>
        ))}
      </div>
      <div className="cs-rail-body" role="tabpanel" id="cs-rail-panel" aria-labelledby={"cs-rail-tab-" + tab}>
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
              <div className="cs-rail-subhead">
                <span className="cs-rail-subhead-title">On this file</span>
                <Button size="sm" variant="ghost" iconRight="arrow" className="cs-recent-link" onClick={() => setShowRecent(true)}>
                  Recent threads (all files)
                </Button>
              </div>
              <ThreadList threads={threads} agents={agents} onOpen={onOpenThread} onJumpToLine={onJumpToLine} />
            </>
          ) : !path && landingOwnsRecent ? (
            <div className="cs-rail-hint">
              <p>Open a file to see its threads.</p>
              <HelpTip placement="bottom" label="About code threads" tip="Threads anchor to lines of code: open a file and click a line number to ask an agent about it. Recent threads across the repository are listed in the main pane." />
            </div>
          ) : (
            <>
              {path ? (
                <div className="cs-rail-subhead">
                  <Button size="sm" variant="ghost" icon="arrow-left" className="cs-recent-link" onClick={() => setShowRecent(false)} title={"Back to " + path}>
                    Back to {path.slice(path.lastIndexOf("/") + 1)}
                  </Button>
                </div>
              ) : null}
              <RecentThreadsList threads={recentThreads} agents={agents} onOpen={onNavigateToThread} />
            </>
          )
        ) : null}
        {tab === "live" ? (
          <LivePanel cid={cid} agents={agents} onJumpToLine={onJumpToLine} onRaiseHand={onRaiseHandRequested} />
        ) : null}
        {tab === "learn" ? <LearnTab cid={cid} agents={agents} gitRef={gitRef} path={path} onJumpToPinnedSha={onJumpToPinnedSha} {...learn} /> : null}
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

// The rail is ~320px: the meta line keeps kind · lines · addressee only; the
// message count lives in the row tooltip + accessible name (screen review r2:
// "3 messag" / "1 m" were hard-clipped).
function msgCount(n: number): string {
  return n + " message" + (n === 1 ? "" : "s");
}

function ThreadList({
  threads,
  agents,
  onOpen,
  onJumpToLine,
}: {
  threads: CodeThreadSummary[];
  agents: Agent[];
  onOpen: (id: string) => void;
  onJumpToLine: (line: number) => void;
}) {
  if (!threads.length) {
    return (
      <div className="cs-rail-hint">
        <Icon name="plus" cls="v2-ico" />
        <p>No threads on this file yet. Click a line number to start one.</p>
      </div>
    );
  }
  // Linear Inbox rows (D10/D12): round author avatar · first line (the
  // opening message when the list carries it, else kind + anchor) · ONE
  // muted meta line · status glyph + age on the right. Two lines max.
  return (
    <div className="cs-thread-list">
      {threads.map((t) => {
        const anchor = (
          <button
            type="button"
            className="anchor mono"
            title={"Jump to line " + t.start_line}
            onClick={(e) => { e.stopPropagation(); onJumpToLine(t.start_line); }}
          >
            L{anchorLabel(t.start_line, t.end_line)}
          </button>
        );
        const kindTag = <KindChip kind={t.kind} />;
        return (
          <div
            key={t.id}
            className={"cs-thread-chip kind-" + t.kind}
            role="button"
            tabIndex={0}
            aria-label={kindLabel(t.kind) + " thread at line " + anchorLabel(t.start_line, t.end_line) + ", " + t.status + (t.message_count ? ", " + msgCount(t.message_count) : "")}
            title={t.message_count ? msgCount(t.message_count) + (t.created_by_alias ? " · started by @" + t.created_by_alias : "") : undefined}
            onClick={() => onOpen(t.id)}
            onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onOpen(t.id); } }}
          >
            <span className="cs-thread-av">
              <ThreadAuthorAvatar alias={t.created_by_alias} id={t.created_by_agent_id} kind={t.kind} agents={agents} />
            </span>
            <div className="cs-thread-main">
              <div className="row1">
                {t.first_message ? (
                  <span className="body-preview" title={t.first_message}>{trunc(t.first_message, 140)}</span>
                ) : (
                  <>{kindTag}{anchor}</>
                )}
              </div>
              <div className="cs-thread-meta">
                {t.first_message ? <>{kindTag}{anchor}</> : null}
                {t.blob_match === false ? (
                  <span className="outdated-chip" title={"The file changed since this thread was pinned to " + shortSha(t.sha)}>
                    <Icon name="alert" cls="v2-ico" /> Outdated<span className="v2-sr"> — pinned to</span> <span className="mono">{shortSha(t.sha)}</span>
                  </span>
                ) : null}
                {t.tagged_alias ? (
                  <span className="cs-thread-who" title={(t.created_by_alias ? "@" + t.created_by_alias + " " : "") + "→ @" + t.tagged_alias}>→ @{t.tagged_alias}</span>
                ) : t.created_by_alias ? <span className="cs-thread-who">@{t.created_by_alias}</span> : null}
              </div>
            </div>
            <div className="cs-thread-side">
              <ThreadStatusIcon status={t.status} />
              <span className="cs-thread-time">{relTime(t.updated_at || t.created_at)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
