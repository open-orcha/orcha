/**
 * Code Space — full-page route `/code` (docs/orcha-code-space-design.md):
 * three panes — directory tree + search | code viewer | thread rail — using
 * the FULL viewport height (the embedded GitHub browser's cramped-pane
 * complaint; see codespace.css's `.content:has(.cs-shell)` override), panes
 * independently scrollable. Deep links: `/code?ref=&path=&line=&thread=`.
 *
 * Reuses the shared tree/file-fetch state (cloud/shared/useBrowseTree.ts) and
 * tree/skeleton/error rendering (cloud/shared/browseTree.tsx) extracted from
 * RepoBrowser.tsx — the GitHub page's embedded browser keeps working
 * unchanged (see that file's test suite, still green). Only the code-viewer
 * BODY differs here: each line gets a gutter affordance (hover "+" to open
 * the thread composer, a persistent dot when a thread already anchors there)
 * instead of RepoBrowser's plain line-number gutter.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useToast } from "../../components/ui";
import { useSnapshot } from "../../state/SnapshotProvider";
import { Shell } from "../../shell/Shell";
import { extOf } from "../github/browse/browseTypes";
import { highlightLine, type Token } from "../github/browse/highlight";
import {
  BrowseErrorBody,
  BrowseSkeletonPane,
  BrowseTree,
  ContentPaneChrome,
} from "../shared/browseTree";
import { useBrowseTree } from "../shared/useBrowseTree";
import { getCachedBlob, isCacheableSha, putCachedBlob } from "./blobCache";
import { Breadcrumbs } from "./Breadcrumbs";
import { CodeSpaceLanding } from "./CodeSpaceLanding";
import type { CodeThreadSummary } from "./codespaceTypes";
import { DraftsBar } from "./DraftsBar";
import { getDraft, listDrafts, putDraft, type DraftListEntry } from "./draftStore";
import { ErrorBoundary } from "./ErrorBoundary";
import { fetchGithubEditable } from "./githubEditApi";
import { isLineSelected, rangeFrom, singleLine, type LineSelection } from "./gutter";
import { HistoryPanel } from "./HistoryPanel";
import { LazyDraftEditorPane } from "./LazyDraftEditorPane";
import { LazyEditorPane } from "./LazyEditorPane";
import { MdRenderedPane } from "./MdRenderedPane";
import { recordFileView } from "./recentFiles";
import { RecentFilesDropdown } from "./RecentFilesDropdown";
import { IdentifierTokens } from "./symbols/IdentifierTokens";
import { SymbolSearch } from "./symbols/SymbolSearch";
import { ThreadRail, type RailTab } from "./ThreadRail";
import { usePaneWidths } from "./usePaneWidths";
import { fetchWorktreeFile, type WorktreeFilePayload, fetchWorktreeAvailable } from "./worktreeApi";
import { WorktreeDiffPane } from "./WorktreeDiffPane";
import "./codespace.css";

// Item 1 — Markdown files render through the house Md component (esc-first,
// safe inline markdown) by default; a small Raw|Rendered toggle in the
// content-pane header lets a human drop back to line-anchored Raw mode.
//
// Item 2 (thread conversations on rendered markdown) — Rendered mode has no
// gutter lines (there's no 1:1 line mapping over rendered prose blocks), but
// it's NOT anchor-dead: a "Discuss this document" header affordance opens
// the composer with a FILE-LEVEL anchor (start_line=1, end_line=1), and each
// rendered heading gets its own hover affordance that resolves to that
// heading's SOURCE line (MdRenderedPane.tsx / mdHeadingAnchor.ts) — falling
// back to the file-level anchor, with an explanatory note, on any ambiguity.
type ViewMode = "raw" | "rendered";
function isMarkdownPath(path: string): boolean {
  return extOf(path) === "md";
}

// jsdom has no scrollIntoView (RequestsPage.tsx / AgentsPage.tsx's same
// feature-detect precedent) — production browsers always have it.
function scrollLineIntoView(line: number): void {
  const el = document.querySelector(`[data-cs-line="${line}"]`);
  if (el && typeof (el as HTMLElement).scrollIntoView === "function") {
    (el as HTMLElement).scrollIntoView({ block: "center" });
  }
}

// Item 3 — breadcrumb segment click: scroll that directory's tree row into
// view and give it a brief highlight pulse ("filters" the tree to it without
// hiding siblings — BrowseTree/browseTree.tsx is a SHARED component owned by
// the GitHub browse surface too, so this stays a self-contained DOM nudge in
// codespace/** rather than a new prop threaded through shared code). The dir
// row's title attribute already carries its full path (BrowseTree's own
// convention) — reused here rather than inventing a new data-attribute.
function pulseTreeRow(dirPath: string): void {
  const selector = dirPath
    ? `.cs-tree-pane .dfv-dir[title="${CSS.escape(dirPath)}"]`
    : ".cs-tree-pane .rb-tree-scroll";
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return;
  if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
  el.classList.add("cs-tree-row-pulse");
  window.setTimeout(() => el.classList.remove("cs-tree-row-pulse"), 900);
}

const LARGE_FILE_LINES = 1500;

export function CodeSpacePage() {
  const { snap, cid } = useSnapshot();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const gitRef = searchParams.get("ref") || "HEAD";
  const path = searchParams.get("path") || "";
  const lineParam = searchParams.get("line");
  const threadParam = searchParams.get("thread");

  const { dirCache, expanded, rows, toggleDir, retryDir, filePayload, fileError, fileLoading } = useBrowseTree(cid || "", gitRef, path);

  // sha-keyed blob cache (blobCache.ts) — FAST loading for ref-PINNED reads
  // only (gitRef is a real immutable commit sha, e.g. after opening History
  // — isCacheableSha rejects "HEAD" and branch names, which are moving refs
  // and must always hit the network). Two independent effects:
  //  - write-through: every real filePayload that lands under a cacheable
  //    sha gets stored, keyed by (cid, sha, path).
  //  - read-through fast-path: BEFORE the network fetch resolves (while
  //    useBrowseTree's fileLoading is true), a cache hit paints instantly
  //    into cachedPreview; the render below prefers the real filePayload
  //    once it arrives and otherwise falls back to this preview so a
  //    previously-viewed pinned file never re-shows a loading skeleton.
  const [cachedPreview, setCachedPreview] = useState<{ path: string; ref: string; content?: string; truncated: boolean; binary: boolean } | null>(null);
  useEffect(() => {
    if (!filePayload || !isCacheableSha(gitRef)) return;
    putCachedBlob(cid || "", gitRef, filePayload.path, {
      content: filePayload.content,
      truncated: !!filePayload.truncated,
      binary: !!filePayload.binary,
    });
  }, [cid, gitRef, filePayload]);
  useEffect(() => {
    setCachedPreview(null);
    if (!cid || !path || !isCacheableSha(gitRef)) return;
    let cancelled = false;
    getCachedBlob(cid, gitRef, path).then((hit) => {
      if (cancelled || !hit) return;
      setCachedPreview({ path, ref: gitRef, content: hit.content, truncated: hit.truncated, binary: hit.binary });
    });
    return () => { cancelled = true; };
  }, [cid, gitRef, path]);
  // Only used while the real fetch hasn't landed yet for THIS (ref, path) —
  // the instant filePayload arrives it's preferred outright, cache or not.
  // Orca-style large-file handling: the hand-rolled read-only pane tokenizes
  // EVERY line synchronously on every render (highlightLine × N) — fine to a
  // point, a multi-second main-thread stall past it. Above this threshold the
  // read-only view swaps to the CM6 editor in readOnly mode instead: virtualized
  // rendering + incremental highlighting, so a 20k-line file opens instantly.
  // Tradeoff: thread-gutter anchors aren't offered in that mode (same as edit
  // mode) — the file is at least instantly READABLE, which wins.
  const fileLineCount = useMemo(
    () => (filePayload?.content ? filePayload.content.split("\n").length : 0),
    [filePayload],
  );

  const showCachedPreview = !filePayload && fileLoading && cachedPreview && cachedPreview.path === path && cachedPreview.ref === gitRef;

  const [selection, setSelection] = useState<LineSelection | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  // Item 2 — true when the open composer's {start:1,end:1} selection is the
  // Rendered view's FILE-LEVEL anchor ("Discuss this document" affordance, or
  // an ambiguous-heading fallback), not an actual Raw-mode line-1 click —
  // disambiguates the two so ThreadComposer never mislabels one as the other.
  const [composerWholeDocument, setComposerWholeDocument] = useState(false);
  const anchorLineRef = useRef<number | null>(null);
  const [railTab, setRailTab] = useState<RailTab>("threads");
  const [openThreadId, setOpenThreadId] = useState<string | null>(threadParam);
  const [fileThreads, setFileThreads] = useState<CodeThreadSummary[]>([]);
  const [raiseHand, setRaiseHand] = useState<{ agentId: string; line: number } | null>(null);
  // Identifier click (Phase 3, best-effort v1): prefills the header's
  // SymbolSearch with the clicked word — "Find symbol", never "go to
  // definition". prefillToken forces a re-trigger even on a repeat click of
  // the same word.
  const [symbolPrefill, setSymbolPrefill] = useState<string | undefined>(undefined);
  const [symbolPrefillToken, setSymbolPrefillToken] = useState(0);

  // Working-tree changes (local run addendum) — `worktreePath` set means the
  // center pane is showing THAT path's uncommitted diff (WorktreeDiffPane)
  // instead of the normal committed-file viewer; null is the normal state.
  // `worktreeAvailable` gates the file header's History button (local-
  // binding only — a single cheap fetch per cid, not the Changes tab's own
  // ~5s poll, since the page only needs a yes/no here, not a live count).
  const [worktreePath, setWorktreePath] = useState<string | null>(null);
  const [worktreeAvailable, setWorktreeAvailable] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  useEffect(() => {
    if (!cid) return;
    let cancelled = false;
    fetchWorktreeAvailable(cid).then((available) => {
      if (cancelled) return;
      setWorktreeAvailable(available);
    });
    return () => { cancelled = true; };
  }, [cid]);

  // Phase 4 — GitHub-bound editing: a container with no writable worktree
  // (worktreeAvailable=false) can still offer local-draft editing when the
  // bound repo answers editable:true (code/github/editable). Probed once per
  // cid, and ONLY once worktreeAvailable's own probe has resolved false —
  // a local-binding container never needs this second round trip at all.
  const [githubEditable, setGithubEditable] = useState(false);
  useEffect(() => {
    if (!cid || worktreeAvailable) { setGithubEditable(false); return; }
    let cancelled = false;
    fetchGithubEditable(cid).then((available) => {
      if (cancelled) return;
      setGithubEditable(available);
    });
    return () => { cancelled = true; };
  }, [cid, worktreeAvailable]);

  // Edit toggle (Item 3, editor build) — a pencil/eye affordance in the file
  // header that swaps the read-only viewer for EditorPane. Two independent
  // editable paths converge on the same toggle:
  //   - LOCAL-binding (worktreeAvailable, same signal History uses): writes
  //     go straight to the worktree (EditorPane/editorSave.ts).
  //   - GITHUB-binding (githubEditable): writes go to a local IndexedDB
  //     draft (draftStore.ts/DraftEditorPane.tsx) — never the network —
  //     until a human explicitly proposes them (DraftsBar's Propose panel).
  // Both require viewing the default ref (gitRef === "HEAD" — anything else
  // is a pinned historical sha, read-only by definition: there's no "save"
  // for a past commit, and no "propose" against a moving target either).
  // Resets to view mode on every file switch so opening a new file never
  // inherits the previous file's edit state.
  const [editMode, setEditMode] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);
  const [editorFile, setEditorFile] = useState<WorktreeFilePayload | null>(null);
  const [draftMode, setDraftMode] = useState(false); // true while THIS edit session is draft-backed (github mode)
  const [draftContent, setDraftContent] = useState<string | null>(null);
  const [draftBaseHash, setDraftBaseHash] = useState<string | null>(null);
  const canEdit = (worktreeAvailable || githubEditable) && gitRef === "HEAD" && !!path;
  useEffect(() => {
    setEditMode(false);
    setEditorDirty(false);
    setEditorFile(null);
    setDraftMode(false);
    setDraftContent(null);
    setDraftBaseHash(null);
  }, [path, cid]);

  // Drafts bar — lists every local draft for (cid, "HEAD"), independent of
  // whichever file is currently open. draftsToken bumps to force a re-list
  // after any write (autosave, discard, propose, reload-base) since
  // draftStore has no live-subscription mechanism (IndexedDB, like
  // blobCache.ts, is a plain get/put store).
  const [drafts, setDrafts] = useState<DraftListEntry[]>([]);
  const [draftsToken, setDraftsToken] = useState(0);
  const refreshDrafts = useCallback(() => setDraftsToken((n) => n + 1), []);
  useEffect(() => {
    if (!cid) { setDrafts([]); return; }
    let cancelled = false;
    listDrafts(cid, "HEAD").then((list) => {
      if (!cancelled) setDrafts(list);
    });
    return () => { cancelled = true; };
  }, [cid, draftsToken]);

  const enterEditMode = useCallback(() => {
    if (!cid || !path) return;
    if (!worktreeAvailable && githubEditable) {
      // GitHub mode: seed from an existing draft if one exists, else the
      // already-loaded read-only filePayload — never a network read (there's
      // no worktree to read from on a GitHub-bound container).
      setDraftMode(true);
      setEditMode(true);
      getDraft(cid, "HEAD", path).then((draft) => {
        const base = filePayload?.path === path ? (filePayload.content ?? "") : "";
        setDraftContent(draft?.content ?? base);
        // A fresh draft claims the loaded payload's blob sha as its base (real
        // drift protection server-side); an existing draft keeps its own claim.
        setDraftBaseHash(draft ? draft.baseHash : (filePayload?.path === path ? filePayload.blob_sha ?? null : null));
        setEditorDirty(!!draft && draft.content !== base);
      });
      return;
    }
    setEditorFile(null);
    setEditMode(true);
    fetchWorktreeFile(cid, path).then((data) => setEditorFile(data));
  }, [cid, path, worktreeAvailable, githubEditable, filePayload]);

  const exitEditMode = useCallback(() => {
    setEditMode(false);
  }, []);

  // GitHub-mode autosave landing: DraftEditorPane debounces edits and calls
  // this with the buffer's current text — write-through to IndexedDB, then
  // recompute dirty against the read-only payload this file view loaded.
  const onDraftChange = useCallback((content: string) => {
    if (!cid || !path) return;
    const base = filePayload?.path === path ? (filePayload.content ?? "") : "";
    setEditorDirty(content !== base);
    putDraft(cid, "HEAD", path, { content, baseHash: draftBaseHash }).then(refreshDrafts);
  }, [cid, path, filePayload, draftBaseHash, refreshDrafts]);

  // If the draft backing the CURRENTLY OPEN draft-mode file disappears out
  // from under it (discarded via the drafts bar, or cleared by a successful
  // Propose) drop back to the read-only view rather than leaving a phantom
  // "editing" toggle on with nothing left to autosave. Guarded on
  // `draftExisted`: entering edit mode on a fresh file has NO draft yet (the
  // first draft is written on the first keystroke's autosave), so without
  // this the effect would close edit mode the instant the pencil opened it.
  const draftExistedRef = useRef(false);
  useEffect(() => {
    if (!draftMode || !path) { draftExistedRef.current = false; return; }
    const present = drafts.some((d) => d.path === path);
    if (present) { draftExistedRef.current = true; return; }
    if (!draftExistedRef.current) return; // never had a draft yet — don't close
    draftExistedRef.current = false;
    setEditMode(false);
    setDraftMode(false);
    setDraftContent(null);
    setDraftBaseHash(null);
    setEditorDirty(false);
  }, [drafts, draftMode, path]);

  // openDraftFile navigates first (path-change effect resets editMode to
  // false), then this effect re-enters edit mode once the new path's
  // filePayload has actually landed — avoids seeding the draft editor from
  // the PREVIOUS file's filePayload for one paint.
  const pendingDraftOpenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pendingDraftOpenRef.current) return;
    if (pendingDraftOpenRef.current !== path) return;
    if (!filePayload || filePayload.path !== path) return;
    pendingDraftOpenRef.current = null;
    enterEditMode();
    // enterEditMode is recreated per filePayload/path; only fire on the
    // (path, filePayload) pair actually settling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, filePayload]);

  // Item 1 — Raw|Rendered toggle: Rendered is the default ONLY for .md files;
  // every other extension only ever sees Raw (the toggle itself is hidden for
  // them). Re-derives per file so navigating from a .md file to a non-.md
  // file (or vice versa) always lands on the right default instead of
  // carrying over the previous file's choice.
  const isMd = isMarkdownPath(path);
  const [viewMode, setViewMode] = useState<ViewMode>(isMd ? "rendered" : "raw");
  useEffect(() => {
    setViewMode(isMarkdownPath(path) ? "rendered" : "raw");
  }, [path]);

  // deep-linked ?line= scrolls to that line once the file paints.
  useEffect(() => {
    if (!filePayload || !lineParam) return;
    const ln = Number(lineParam);
    if (!Number.isFinite(ln)) return;
    scrollLineIntoView(ln);
  }, [filePayload, lineParam]);

  // Item 2/3 — "recently viewed files": record on every file open, regardless
  // of entry point (tree click, breadcrumb, symbol nav, thread nav, recent-
  // files dropdown/landing card, deep link, or browser back/forward all
  // funnel through the SAME ?path= URL state) — a single effect keyed on
  // (cid, path) is the one place that's guaranteed to fire exactly once per
  // distinct file open, never on tab-switch/line-jump/thread-open (those
  // don't change path). recentFilesToken bumps so the header dropdown (a
  // separate mount reading its own localStorage snapshot) re-reads instead of
  // going stale for the component's lifetime.
  const [recentFilesToken, setRecentFilesToken] = useState(0);
  useEffect(() => {
    if (!cid || !path) return;
    recordFileView(cid, path);
    setRecentFilesToken((n) => n + 1);
  }, [cid, path]);

  const navigate = useCallback((next: { ref?: string; path?: string; line?: number | null; thread?: string | null }, replace = false) => {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      if (next.ref !== undefined) { if (next.ref) p.set("ref", next.ref); else p.delete("ref"); }
      if (next.path !== undefined) { if (next.path) p.set("path", next.path); else p.delete("path"); }
      if (next.line !== undefined) { if (next.line != null) p.set("line", String(next.line)); else p.delete("line"); }
      if (next.thread !== undefined) { if (next.thread) p.set("thread", next.thread); else p.delete("thread"); }
      return p;
    }, { replace });
  }, [setSearchParams]);

  const openDraftFile = useCallback((p: string) => {
    setSelection(null);
    setComposerOpen(false);
    setWorktreePath(null);
    setHistoryOpen(false);
    navigate({ ref: "HEAD", path: p, line: null, thread: null });
    // enterEditMode fires from the pendingDraftOpenRef effect above once the
    // new file's payload + editable gating are in place — mirrors how
    // selectFile leaves editMode itself to the path-change reset effect.
    pendingDraftOpenRef.current = p;
  }, [navigate]);

  const selectFile = useCallback((p: string) => {
    setSelection(null);
    setComposerOpen(false);
    setWorktreePath(null);
    setHistoryOpen(false);
    navigate({ path: p, line: null, thread: null });
  }, [navigate]);

  // Changes tab row click: open that path's UNCOMMITTED diff in the center
  // pane (WorktreeDiffPane), alongside the normal committed-file viewer —
  // navigates ?path= too (so the tree/breadcrumb/header stay in sync and a
  // reload doesn't lose the file context) but leaves ?ref=/?line= alone,
  // since a working-tree diff has no single "line" to deep-link to yet.
  const openWorktreeDiff = useCallback((p: string) => {
    setSelection(null);
    setComposerOpen(false);
    setHistoryOpen(false);
    setWorktreePath(p);
    navigate({ path: p, line: null, thread: null });
  }, [navigate]);

  // History row click: re-open the CURRENT file at the picked commit's sha —
  // the committed-file viewer already supports an arbitrary ref via ?ref=.
  const openFileAtHistorySha = useCallback((sha: string) => {
    setWorktreePath(null);
    setHistoryOpen(false);
    navigate({ ref: sha, line: null }, false);
  }, [navigate]);

  const jumpToLine = useCallback((line: number) => {
    navigate({ line }, true);
    scrollLineIntoView(line);
  }, [navigate]);

  const jumpToPinnedSha = useCallback((sha: string) => {
    navigate({ ref: sha }, true);
  }, [navigate]);

  // Item 2(c) — rendered blocks don't map 1:1 to source lines, so a thread
  // opened from the rail while Rendered is active switches to Raw AT THE
  // THREAD'S ANCHOR (the only mode that can actually show/highlight it), with
  // a small note explaining the jump. Only fires for an id belonging to a
  // thread ON THIS FILE (fileThreads, already loaded for the tree badge) —
  // closing (id=null), a raise-hand thread, or a just-created optimistic open
  // (openCreatedThread, always Raw already since the composer that made it
  // only ever anchors a real line) don't match any fileThreads row and no-op
  // harmlessly here.
  const openThread = useCallback((id: string | null) => {
    setOpenThreadId(id);
    navigate({ thread: id }, true);
    if (id && viewMode === "rendered") {
      const t = fileThreads.find((ft) => ft.id === id);
      if (t) {
        setViewMode("raw");
        toast("Switched to Raw to show this thread's anchor", "");
        scrollLineIntoView(t.start_line);
      }
    }
  }, [navigate, viewMode, fileThreads, toast]);

  const onGutterClick = useCallback((line: number, shiftKey: boolean) => {
    if (shiftKey && anchorLineRef.current != null) {
      setSelection(rangeFrom(anchorLineRef.current, line));
    } else {
      anchorLineRef.current = line;
      setSelection(singleLine(line));
    }
    setComposerWholeDocument(false);
    setComposerOpen(true);
    setRailTab("threads");
    setOpenThreadId(null);
    setRaiseHand(null);
  }, []);

  // Item 2 — Rendered mode's "Discuss this document" header affordance: opens
  // the SAME composer the gutter uses, anchored file-level (start=end=1),
  // clearly labeled by composerWholeDocument so it never reads as "line 1".
  const onDiscussDocument = useCallback(() => {
    setSelection(singleLine(1));
    setComposerWholeDocument(true);
    setComposerOpen(true);
    setRailTab("threads");
    setOpenThreadId(null);
    setRaiseHand(null);
  }, []);

  // Item 2 — a rendered heading resolved to its source line (mdHeadingAnchor
  // .ts): anchor the composer there, same as a Raw-mode gutter click on that
  // line, but never Raw's own state (Rendered stays Rendered — Raw is ONLY
  // entered explicitly by the toggle or a thread-rail jump).
  const onDiscussHeading = useCallback((line: number) => {
    setSelection(singleLine(line));
    setComposerWholeDocument(false);
    setComposerOpen(true);
    setRailTab("threads");
    setOpenThreadId(null);
    setRaiseHand(null);
  }, []);

  // Item 2 — a heading click that couldn't be confidently resolved to a
  // source line (count/text mismatch — see mdHeadingAnchor.ts) falls back to
  // the file-level anchor rather than risk anchoring to the wrong line; the
  // toast is the "tooltip saying so" the spec calls for, surfaced at the
  // moment of the click since a hover-only tooltip can't explain a decision
  // made at click time.
  const onAmbiguousHeading = useCallback(() => {
    toast("Couldn't match that heading to a source line — discussing the whole document instead", "warn");
    onDiscussDocument();
  }, [onDiscussDocument, toast]);

  // Usability sweep papercut: closing the composer (Escape, or its own
  // Cancel button) left the just-picked line's ".cs-line.selected" highlight
  // stuck in the code pane with no way to clear it short of clicking another
  // line — canceling should leave the pane exactly as if nothing had been
  // picked yet.
  const closeComposer = useCallback(() => {
    setComposerOpen(false);
    setComposerWholeDocument(false);
    setSelection(null);
  }, []);

  const onRaiseHand = useCallback((agentId: string, line: number) => {
    setRaiseHand({ agentId, line });
    setRailTab("threads");
    setOpenThreadId(null);
    setComposerOpen(false);
    setSelection(null);
  }, []);

  // Workspace symbol search result navigation (header search AND identifier
  // click both land here): switch to the clicked file at the symbol's line.
  const navigateToSymbol = useCallback((symbolPath: string, line: number) => {
    setSelection(null);
    setComposerOpen(false);
    setWorktreePath(null);
    setHistoryOpen(false);
    navigate({ path: symbolPath, line, thread: null }, false);
    scrollLineIntoView(line);
  }, [navigate]);

  const onIdentifierClick = useCallback((word: string) => {
    setSymbolPrefill(word);
    setSymbolPrefillToken((n) => n + 1);
  }, []);

  // Item 2 — landing state's "Search symbols" quick action: focuses/opens the
  // header SymbolSearch WITHOUT a prefill (a plain open, unlike identifier
  // click). Cmd/Ctrl+P already does this itself (SymbolSearch's own document
  // keydown listener) — this bumps the same open affordance via a prop so it
  // also works as a mouse-driven action from the landing card.
  const [symbolFocusToken, setSymbolFocusToken] = useState(0);
  const focusSymbolSearch = useCallback(() => {
    setSymbolFocusToken((n) => n + 1);
  }, []);

  // Item 3 — breadcrumb segment click: make sure that directory is expanded
  // in the tree (toggleDir is a TOGGLE, so only call it if not already open —
  // clicking a currently-open ancestor's crumb must never collapse it), then
  // scroll/pulse its row so the click has a visible destination.
  const openDirInTree = useCallback((dirPath: string) => {
    if (!expanded.has(dirPath)) toggleDir(dirPath);
    // scroll after the (possibly async) row exists — a microtask is enough
    // for already-cached dirs; freshly-expanded ones settle on the next
    // fetch-driven render, which re-queries by title and no-ops harmlessly
    // if the row isn't painted yet.
    requestAnimationFrame(() => pulseTreeRow(dirPath));
  }, [expanded, toggleDir]);

  // Item 4 — landing state's "Browse the file tree" quick action: scrolls the
  // first row into view with a brief highlight pulse. Deliberately NOT a
  // .focus() call (usability-sweep correction) — BrowseTree's rows
  // (cloud/shared/browseTree.tsx, owned by the GitHub browse surface too)
  // are plain unfocusable <div>s with no tabIndex, so calling .focus() on one
  // is a silent no-op that would have made this "quick action" a lie for
  // keyboard users; a visible pulse is honest about what it actually does.
  const focusTree = useCallback(() => {
    const el = document.querySelector(".cs-tree-pane .dfv-r") as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView?.({ block: "center" });
    el.classList.add("cs-tree-row-pulse");
    window.setTimeout(() => el.classList.remove("cs-tree-row-pulse"), 900);
  }, []);

  // Item 3 — Recent tab row click: open that thread's file at its anchor line
  // WITH the thread itself selected (unlike navigateToSymbol, which clears
  // ?thread= — here the whole point is landing straight in the thread view).
  const navigateToThread = useCallback((t: CodeThreadSummary) => {
    setSelection(null);
    setComposerOpen(false);
    setWorktreePath(null);
    setHistoryOpen(false);
    setRailTab("threads");
    setOpenThreadId(t.id);
    navigate({ path: t.path, line: t.start_line, thread: t.id }, false);
    scrollLineIntoView(t.start_line);
  }, [navigate]);

  const agents = snap?.agents ?? [];
  const htmlUrl = null; // Code Space has no repo html_url context handy here; the file pane omits the GitHub link.

  const gutterDotsForLine = useMemo(() => {
    const m = new Map<number, CodeThreadSummary[]>();
    fileThreads.forEach((t) => {
      for (let ln = t.start_line; ln <= t.end_line; ln++) {
        const list = m.get(ln) || [];
        list.push(t);
        m.set(ln, list);
      }
    });
    return m;
  }, [fileThreads]);

  // Panel improvements item 1 — resizable tree/code/rail panes. Native
  // Pointer Events via DOCUMENT-level listeners registered for the
  // duration of a drag (not React's onPointerMove/onPointerUp on the
  // divider itself) — the cursor routinely leaves the divider's own 6px hit
  // area mid-drag, and document listeners keep tracking it regardless,
  // without needing setPointerCapture (which jsdom doesn't implement — see
  // scrollLineIntoView's identical feature-detect precedent elsewhere in
  // this file for the general house convention). No drag library — this
  // codebase adds zero new dependencies for UI interactions like this.
  const { widths, dragTree, dragRail, resetTree, resetRail } = usePaneWidths();
  const dragStateRef = useRef<{ pane: "tree" | "rail"; startX: number } | null>(null);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const st = dragStateRef.current;
      if (!st) return;
      const delta = e.clientX - st.startX;
      st.startX = e.clientX;
      // dragRail negates the delta INTERNALLY (usePaneWidths.ts's own doc
      // comment) — pass the raw pointer delta unmodified for both panes.
      if (st.pane === "tree") dragTree(delta);
      else dragRail(delta);
    };
    const onUp = () => {
      dragStateRef.current = null;
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
  }, [dragTree, dragRail]);

  const startDrag = useCallback((pane: "tree" | "rail") => (e: React.PointerEvent<HTMLDivElement>) => {
    dragStateRef.current = { pane, startX: e.clientX };
  }, []);

  if (!cid) return null;

  return (
    <Shell page="code" title="Code Space" ctx={snap?.container?.name}>
      <div className="cs-shell">
        <div className="cs-head">
          <SymbolSearch
            cid={cid}
            gitRef={gitRef}
            onNavigate={navigateToSymbol}
            prefill={symbolPrefill}
            prefillToken={symbolPrefillToken}
            focusToken={symbolFocusToken}
            path={path}
          />
          {path ? (
            <RecentFilesDropdown
              cid={cid}
              currentPath={path}
              onOpenFile={selectFile}
              refreshToken={recentFilesToken}
            />
          ) : null}
        </div>
        <div className="cs-body">
          <div className="cs-tree-pane" style={{ width: widths.tree }}>
            <div className="rb-tree-scroll">
              <ErrorBoundary label="tree">
                <BrowseTree
                  rows={rows}
                  dirCache={dirCache}
                  expanded={expanded}
                  selectedPath={path}
                  onToggleDir={toggleDir}
                  onRetryDir={retryDir}
                  onSelectFile={selectFile}
                  fileBadge={(p) => {
                    const n = fileThreads.filter((t) => t.path === p).length;
                    return n ? <span className="cs-tree-badge">{n}</span> : null;
                  }}
                />
              </ErrorBoundary>
            </div>
          </div>

          <div
            className="cs-divider cs-divider-tree"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize file tree pane"
            title="Drag to resize, double-click to reset"
            onPointerDown={startDrag("tree")}
            onDoubleClick={resetTree}
          />

          <div className="cs-code-pane">
            {drafts.length > 0 ? (
              <DraftsBar
                cid={cid}
                gitRef="HEAD"
                drafts={drafts}
                onOpenDraft={openDraftFile}
                onDraftsChanged={refreshDrafts}
              />
            ) : null}
            <div className="cs-code-scroll">
              <ErrorBoundary label="content" key={path}>
              {worktreePath ? (
                <WorktreeDiffPane
                  cid={cid}
                  path={worktreePath}
                  onViewAtHead={() => setWorktreePath(null)}
                />
              ) : !path ? (
                <CodeSpaceLanding
                  cid={cid}
                  onNavigateToThread={navigateToThread}
                  onOpenFile={selectFile}
                  onSearchSymbols={focusSymbolSearch}
                  onFocusTree={focusTree}
                />
              ) : showCachedPreview ? (
                // blobCache.ts fast-path — a previously-viewed, ref-PINNED
                // (immutable sha) file paints instantly from IndexedDB while
                // the network re-fetch (still fired, for correctness) is in
                // flight, instead of the skeleton below. Reuses the SAME
                // read-only chrome/body a real filePayload renders — no
                // gutter-affordance/thread-anchor differences, this is
                // purely a perceived-latency win for immutable content.
                <ContentPaneChrome
                  gitRef={cachedPreview!.ref}
                  payload={{ ref: cachedPreview!.ref, path: cachedPreview!.path, content: cachedPreview!.content, size: (cachedPreview!.content ?? "").length, truncated: cachedPreview!.truncated, binary: cachedPreview!.binary }}
                  htmlUrl={htmlUrl}
                  headerExtra={<Breadcrumbs path={path} onOpenDir={openDirInTree} />}
                >
                  <div className="rb-code mono">
                    {(cachedPreview!.content ?? "").split("\n").map((line, i) => (
                      <div key={i + 1} className="cs-line" data-cs-line={i + 1}>
                        <span className="cs-gutter">{i + 1}</span>
                        <span className="cs-line-text">{line}</span>
                      </div>
                    ))}
                  </div>
                </ContentPaneChrome>
              ) : fileLoading || (filePayload && filePayload.path !== path) ? (
                // BUG 3 root-cause fix — the old guard (fileLoading &&
                // !filePayload) only blocked stale content on the very
                // FIRST load. Switching files sets fileLoading=true but
                // filePayload still holds the PREVIOUS file until the fetch
                // resolves, so the previous file's lines/gutter rendered
                // under the NEW file's path/breadcrumb for one paint — a
                // gutter click in that window anchored a composer to the
                // wrong path/line. `fileLoading` ALONE now gates the
                // skeleton on every load, first or not; the
                // `filePayload.path !== path` clause is a second
                // independent guard against the same class of bug if
                // fileLoading and path ever race each other in the future.
                <BrowseSkeletonPane />
              ) : fileError ? (
                <BrowseErrorBody err={fileError} what="File" />
              ) : filePayload ? (
                <ContentPaneChrome
                  gitRef={gitRef}
                  payload={filePayload}
                  htmlUrl={htmlUrl}
                  headerExtra={
                    <>
                      <Breadcrumbs path={path} onOpenDir={openDirInTree} />
                      {worktreeAvailable ? (
                        <span className="cs-history-anchor">
                          <button
                            type="button"
                            className="cs-history-btn"
                            onClick={() => setHistoryOpen((v) => !v)}
                            title="Show this file's commit history"
                            aria-expanded={historyOpen}
                          >
                            History
                          </button>
                          {historyOpen ? (
                            <HistoryPanel
                              cid={cid}
                              path={path}
                              gitRef={gitRef}
                              onSelectCommit={openFileAtHistorySha}
                              onClose={() => setHistoryOpen(false)}
                            />
                          ) : null}
                        </span>
                      ) : null}
                      {!editMode && isMd ? (
                        <>
                          {viewMode === "rendered" ? (
                            <button
                              type="button"
                              className="cs-discuss-doc-btn"
                              onClick={onDiscussDocument}
                              title="Start a thread anchored to this whole document"
                            >
                              Discuss this document
                            </button>
                          ) : null}
                          <div className="cs-view-toggle" role="group" aria-label="View mode">
                            <button
                              type="button"
                              className={"cs-view-toggle-btn" + (viewMode === "raw" ? " on" : "")}
                              onClick={() => setViewMode("raw")}
                            >
                              Raw
                            </button>
                            <button
                              type="button"
                              className={"cs-view-toggle-btn" + (viewMode === "rendered" ? " on" : "")}
                              onClick={() => setViewMode("rendered")}
                            >
                              Rendered
                            </button>
                          </div>
                        </>
                      ) : null}
                      {canEdit ? (
                        <button
                          type="button"
                          className={"cs-edit-toggle-btn" + (editMode ? " on" : "")}
                          onClick={editMode ? exitEditMode : enterEditMode}
                          title={editMode ? "Stop editing" : "Edit this file"}
                          aria-pressed={editMode}
                        >
                          {editMode ? (
                            /* eye (Lucide outline) — "back to view mode" */
                            <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" />
                              <circle cx="12" cy="12" r="3" />
                            </svg>
                          ) : (
                            /* pencil (Lucide outline) — "edit this file" */
                            <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
                              <path d="m15 5 4 4" />
                            </svg>
                          )}
                          {editorDirty ? <span className="cs-edit-dirty-dot" aria-label="Unsaved changes" /> : null}
                        </button>
                      ) : null}
                    </>
                  }
                >
                  {editMode && draftMode ? (
                    draftContent == null ? (
                      <div className="none" style={{ padding: 10 }}>Loading file…</div>
                    ) : filePayload?.binary ? (
                      <div className="muted" style={{ padding: 10, fontSize: 13 }}>Binary file — editing isn't supported.</div>
                    ) : (
                      <LazyDraftEditorPane
                        key={path}
                        cid={cid}
                        path={path}
                        initialContent={draftContent}
                        onDraftChange={onDraftChange}
                      />
                    )
                  ) : editMode ? (
                    !editorFile ? (
                      <div className="none" style={{ padding: 10 }}>Loading file…</div>
                    ) : !editorFile.available ? (
                      <div className="none" style={{ padding: 10 }}>{editorFile.detail || "Editing is unavailable."}</div>
                    ) : editorFile.binary ? (
                      <div className="muted" style={{ padding: 10, fontSize: 13 }}>Binary file — editing isn't supported.</div>
                    ) : (
                      <LazyEditorPane
                        cid={cid}
                        path={path}
                        initialContent={editorFile.content ?? ""}
                        contentHash={editorFile.content_hash ?? null}
                        onDirty={setEditorDirty}
                      />
                    )
                  ) : !isMd && fileLineCount > LARGE_FILE_LINES ? (
                    <LazyEditorPane
                      cid={cid}
                      path={path}
                      initialContent={filePayload.content ?? ""}
                      contentHash={null}
                      readOnly
                      onDirty={() => {}}
                    />
                  ) : isMd && viewMode === "rendered" ? (
                    <MdRenderedPane
                      content={filePayload.content ?? ""}
                      onDiscussHeading={onDiscussHeading}
                      onAmbiguousHeading={onAmbiguousHeading}
                    />
                  ) : (
                    <div className="rb-code mono">
                      {(filePayload.content ?? "").split("\n").map((line, i) => {
                        const lineNo = i + 1;
                        const threadsHere = gutterDotsForLine.get(lineNo) || [];
                        const selected = isLineSelected(selection, lineNo);
                        const tokens: Token[] = highlightLine(line, filePayload.path);
                        return (
                          <div
                            key={lineNo}
                            className={"cs-line" + (selected ? " selected" : "")}
                            data-cs-line={lineNo}
                          >
                            <span
                              className="cs-gutter"
                              onClick={(e) => onGutterClick(lineNo, e.shiftKey)}
                              title="Click to start a thread, shift-click to extend the range"
                            >
                              <span className="cs-gutter-add" aria-hidden="true">+</span>
                              {threadsHere.length ? <span className="cs-gutter-dot" /> : null}
                              {lineNo}
                            </span>
                            <span className="cs-line-text">
                              <IdentifierTokens tokens={tokens} onIdentifierClick={onIdentifierClick} />
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </ContentPaneChrome>
              ) : (
                <BrowseSkeletonPane />
              )}
              </ErrorBoundary>
            </div>
          </div>

          <div
            className="cs-divider cs-divider-rail"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize thread rail pane"
            title="Drag to resize, double-click to reset"
            onPointerDown={startDrag("rail")}
            onDoubleClick={resetRail}
          />

          <ErrorBoundary label="rail">
            <ThreadRail
              cid={cid}
              gitRef={gitRef}
              path={path}
              agents={agents}
              tab={railTab}
              onTabChange={setRailTab}
              composerSelection={composerOpen ? selection : null}
              composerWholeDocument={composerOpen ? composerWholeDocument : undefined}
              onComposerClose={closeComposer}
              onJumpToLine={jumpToLine}
              onJumpToPinnedSha={jumpToPinnedSha}
              openThreadId={openThreadId}
              onOpenThread={openThread}
              onThreadsLoaded={setFileThreads}
              raiseHand={raiseHand}
              onRaiseHandDone={() => setRaiseHand(null)}
              onRaiseHandRequested={onRaiseHand}
              onNavigateToThread={navigateToThread}
              selectedWorktreePath={worktreePath}
              onOpenWorktreeDiff={openWorktreeDiff}
              width={widths.rail}
            />
          </ErrorBoundary>
        </div>
      </div>
    </Shell>
  );
}
