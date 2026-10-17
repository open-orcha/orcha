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
import { useNavigate, useSearchParams } from "react-router-dom";
import { useToast } from "../../components/ui";
import { isEditingTarget } from "../../components/primitives";
import { Button, ButtonLink, IconButton, Segmented } from "../../components/primitives";
import { CircleIconButton, PageToolbar } from "../../shell/Shell";
import { withCid } from "../../lib/scope";
import { useActingAuthority, useSnapshot } from "../../state/SnapshotProvider";
import { useProjects } from "../../state/projects";
import { repoConnectBlockedReason } from "../github/repoPermissions";
import { EmptyState } from "../../components/primitives";
import { useCodeWriteBlock } from "./writeAccess";
import { Shell } from "../../shell/Shell";
import { extOf } from "../github/browse/browseTypes";
import { highlightLine, type Token } from "../github/browse/highlight";
import {
  BrowseErrorBody,
  BrowseSkeletonPane,
  BrowseTree,
  ContentPaneChrome,
  formatSize,
} from "../shared/browseTree";
import { useBrowseTree } from "../shared/useBrowseTree";
import { getCachedBlob, isCacheableSha, putCachedBlob } from "./blobCache";
import { Breadcrumbs } from "./Breadcrumbs";
import { CodeSpaceLanding } from "./CodeSpaceLanding";
import type { CodeThreadDetailPayload, CodeThreadSummary, CreateThreadResponse } from "./codespaceTypes";
import type { FocusRange } from "./editorLessonFocus";
import type { LineRef } from "./lesson";
import { SelectionLens, type LensRange } from "./SelectionLens";
import { useStartLesson } from "./useStartLesson";
import { DraftsBar } from "./DraftsBar";
import { EditContext, refLabelFor, type EditSource } from "./EditContext";
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
import { RefPicker } from "./RefPicker";
import { IdentifierTokens } from "./symbols/IdentifierTokens";
import { SymbolSearch } from "./symbols/SymbolSearch";
import { ThreadRail, type RailTab } from "./ThreadRail";
import { usePaneWidths } from "./usePaneWidths";
import { useCodeLayout } from "./useCodeLayout";
import { fetchWorktreeBranch, fetchWorktreeFile, type WorktreeFilePayload, fetchWorktreeAvailable } from "./worktreeApi";
import { WorktreeDiffPane } from "./WorktreeDiffPane";
import { browseRawUrl } from "../../components/filePreview/sources";
import "./codespace.css";
import { RepoNotConnected } from "../github/RepoNotConnected";
// Registers the Cmd/Ctrl+K "Files" provider (C-03). extensions.ts imports this
// page eagerly, so the provider is live app-wide from boot; B may move the
// side-effect import into extensions.ts (requests/B.md "From F").
import "./filesSearch";

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

// Scroll a code line to ~1/3 of the viewer's height (Linear/GitHub deep-link
// convention: the anchor sits high enough that the code it introduces is
// visible below it). Falls back to scrollIntoView when the line isn't inside
// the code scroller; jsdom has neither layout nor scrollIntoView, so both
// paths are feature-detected.
export function scrollLineIntoView(line: number, opts: { smooth?: boolean } = {}): void {
  const el = document.querySelector(`[data-cs-line="${line}"]`) as HTMLElement | null;
  if (!el) return;
  const scroller = el.closest(".cs-code-scroll") as HTMLElement | null;
  if (scroller && scroller.clientHeight > 0) {
    const delta = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const top = Math.max(0, scroller.scrollTop + delta - Math.round(scroller.clientHeight / 3));
    // Learn stepping glides (unless the reader asked for reduced motion)
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (typeof scroller.scrollTo === "function") scroller.scrollTo(opts.smooth && !reduce ? { top, behavior: "smooth" } : { top });
    else scroller.scrollTop = top;
    return;
  }
  if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "center" });
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

/** Wide-layout pane visibility (toolbar view toggles), persisted per browser. */
export interface PaneCollapse { tree: boolean; rail: boolean }
const COLLAPSE_KEY = "orcha:cs:collapsed";
export function readPaneCollapse(): PaneCollapse {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "null");
    return { tree: !!(v && v.tree), rail: !!(v && v.rail) };
  } catch {
    return { tree: false, rail: false };
  }
}
function writePaneCollapse(c: PaneCollapse): void {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(c)); } catch { /* private mode */ }
}

export function CodeSpacePage() {
  const { snap, cid, identity, error: snapError, refresh } = useSnapshot();
  // the project list names a project whose snapshot failed (unreachable state)
  const { list: projectList } = useProjects();
  // e2e-permissions-16: Connect repo is owner-or-manage_repo server-side
  const connectBlock = repoConnectBlockedReason(useActingAuthority(), identity);
  const toast = useToast();
  // viewer / non-member: every Code Space write is refused server-side
  const writeBlock = useCodeWriteBlock();
  const [searchParams, setSearchParams] = useSearchParams();

  const gitRef = searchParams.get("ref") || "HEAD";
  const path = searchParams.get("path") || "";
  const lineParam = searchParams.get("line");
  const threadParam = searchParams.get("thread");
  // Learn deep link: ?lesson=<threadId> (the lesson open in the rail),
  // &view=full (full-page lesson mode) and &step=N (1-based; omitted = step 1).
  const openLessonId = searchParams.get("lesson");
  const lessonFull = !!openLessonId && searchParams.get("view") === "full";
  const stepParam = Number(searchParams.get("step"));
  const lessonInitialStep = Number.isFinite(stepParam) && stepParam >= 1 ? Math.floor(stepParam) - 1 : 0;
  const routerNavigate = useNavigate();

  const { widths, dragTree, dragRail, resetTree, resetRail } = usePaneWidths();
  const dragStateRef = useRef<{ pane: "tree" | "rail"; startX: number } | null>(null);

  // V2 responsive layout (screen review S6): wide = three inline panes;
  // medium = the rail becomes an overlay drawer; narrow = single-pane file
  // view with Files / Threads drawers toggled from the header.
  const [shellEl, setShellEl] = useState<HTMLDivElement | null>(null);
  const layout = useCodeLayout(shellEl, widths.tree, widths.rail);
  const [treeOpen, setTreeOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  // Wide layouts can hide the tree / rail from the toolbar's circular view
  // toggles (Linear's panel toggles); the choice persists per browser.
  const [collapsed, setCollapsed] = useState<PaneCollapse>(readPaneCollapse);
  useEffect(() => { writePaneCollapse(collapsed); }, [collapsed]);
  // Landing (no file open): the rail has nothing file-scoped to show, so on
  // wide layouts it starts hidden and the landing gets the room (D12 — no
  // column holding only a help sentence). The Threads-panel toggle still
  // opens it (Live / Changes stay one click away); this is session-only and
  // never overwrites the persisted per-browser choice.
  const [landingRail, setLandingRail] = useState(false);
  const railHidden = collapsed.rail || (!path && !landingRail);
  // any action that needs the rail (composer, thread, raise-hand) reveals it:
  // opens the drawer on medium/narrow, un-hides it on wide.
  const revealRail = useCallback(() => {
    if (layoutRef.current !== "wide") { setRailOpen(true); setTreeOpen(false); }
    else { setCollapsed((c) => (c.rail ? { ...c, rail: false } : c)); setLandingRail(true); }
  }, []);
  const toggleWideRail = useCallback(() => {
    if (railHidden) { setCollapsed((c) => (c.rail ? { ...c, rail: false } : c)); setLandingRail(true); }
    else if (!path) setLandingRail(false);
    else setCollapsed((c) => ({ ...c, rail: true }));
  }, [railHidden, path]);
  const closeDrawers = useCallback(() => { setTreeOpen(false); setRailOpen(false); }, []);
  useEffect(() => {
    if (layout === "wide") { setTreeOpen(false); setRailOpen(false); }
    else if (layout === "medium") setTreeOpen(false);
  }, [layout]);

  const { dirCache, expanded, rows, toggleDir, retryDir, retryFile, filePayload, fileError, fileLoading } = useBrowseTree(cid || "", gitRef, path);

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
  // Learn: the lesson open in the rail's Learn tab (page-owned so the gutter's
  // lesson markers and the floating Teach · Why lens can open one), a seed for a
  // lesson just created here, the current step's cited lines (glow + dim), and
  // the latest text selection (sticky per file) for the quick starts.
  const [lessonSeed, setLessonSeed] = useState<CodeThreadDetailPayload | null>(null);
  const [lessonFocus, setLessonFocus] = useState<{ path: string; ranges: FocusRange[] } | null>(null);
  const [textSel, setTextSel] = useState<LensRange | null>(null);
  const [codeBodyEl, setCodeBodyEl] = useState<HTMLDivElement | null>(null);
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

  // V2 edit-context strip: the REAL local branch name (never invented — only
  // shown when GET …/worktree/branch answers available with a branch).
  const [worktreeBranch, setWorktreeBranch] = useState<string | null>(null);
  useEffect(() => {
    setWorktreeBranch(null);
    if (!cid || !worktreeAvailable) return;
    let cancelled = false;
    fetchWorktreeBranch(cid)
      .then((b) => { if (!cancelled && b && b.available && b.branch) setWorktreeBranch(b.branch); })
      .catch(() => { /* branch label is optional — the strip falls back to "HEAD" */ });
    return () => { cancelled = true; };
  }, [cid, worktreeAvailable]);

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
  // A binary payload has nothing to edit — no Edit toggle that would only
  // flip the bar to "Editing" over "Binary file not shown." (parity extra).
  const openIsBinary = !!filePayload && filePayload.path === path && !!filePayload.binary;
  const canEdit = (worktreeAvailable || githubEditable) && gitRef === "HEAD" && !!path && !openIsBinary;
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
    if (!cid || !path || writeBlock) return;
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
  }, [cid, path, worktreeAvailable, githubEditable, filePayload, writeBlock]);

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
    setTextSel(null);
  }, [path]);

  // deep-linked ?line= / ?thread= scrolls once the file paints: the open
  // thread's first line when its range is known (fileThreads arrives after
  // the file), else ?line=. Keyed so the 3 s snapshot bump never re-scrolls
  // a human who has since scrolled away.
  const openThreadRange = useMemo(() => {
    if (!openThreadId) return null;
    const t = fileThreads.find((ft) => ft.id === openThreadId && ft.path === path);
    return t ? { start: t.start_line, end: Math.max(t.start_line, t.end_line) } : null;
  }, [openThreadId, fileThreads, path]);
  const deepScrollKey = useRef("");
  useEffect(() => {
    if (!filePayload || filePayload.path !== path) return;
    if (!lineParam && !openThreadRange) return;
    const ln = openThreadRange ? openThreadRange.start : Number(lineParam);
    if (!Number.isFinite(ln) || ln < 1) return;
    const key = path + "|" + ln + "|" + (threadParam || "");
    if (deepScrollKey.current === key) return;
    deepScrollKey.current = key;
    // after paint: the rows for a just-fetched file mount in this commit
    requestAnimationFrame(() => scrollLineIntoView(ln));
  }, [filePayload, path, lineParam, threadParam, openThreadRange]);

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

  // Several URL writes can land in ONE commit (a lesson step mirrors ?step=
  // while full page follows it to another ?path=); setSearchParams' updater
  // sees the render's params, so each write builds on the latest one instead.
  const latestParamsRef = useRef(searchParams);
  const seenParamsRef = useRef(searchParams);
  if (seenParamsRef.current !== searchParams) { seenParamsRef.current = searchParams; latestParamsRef.current = searchParams; }
  const navigate = useCallback((next: {
    ref?: string; path?: string; line?: number | null; thread?: string | null;
    lesson?: string | null; view?: "full" | null; step?: string | null;
  }, replace = false) => {
    {
      const p = new URLSearchParams(latestParamsRef.current);
      if (next.ref !== undefined) { if (next.ref) p.set("ref", next.ref); else p.delete("ref"); }
      if (next.path !== undefined) { if (next.path) p.set("path", next.path); else p.delete("path"); }
      if (next.line !== undefined) { if (next.line != null) p.set("line", String(next.line)); else p.delete("line"); }
      if (next.thread !== undefined) { if (next.thread) p.set("thread", next.thread); else p.delete("thread"); }
      if (next.lesson !== undefined) { if (next.lesson) p.set("lesson", next.lesson); else p.delete("lesson"); }
      if (next.view !== undefined) { if (next.view) p.set("view", next.view); else p.delete("view"); }
      if (next.step !== undefined) { if (next.step) p.set("step", next.step); else p.delete("step"); }
      latestParamsRef.current = p;
      setSearchParams(p, { replace });
    }
  }, [setSearchParams]);

  const openDraftFile = useCallback((p: string) => {
    setSelection(null);
    setComposerOpen(false);
    setWorktreePath(null);
    setHistoryOpen(false);
    setTreeOpen(false);
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
    setTreeOpen(false);
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
    closeDrawers();
    navigate({ path: p, line: null, thread: null });
  }, [navigate, closeDrawers]);

  // History row click: re-open the CURRENT file at the picked commit's sha —
  // the committed-file viewer already supports an arbitrary ref via ?ref=.
  const openFileAtHistorySha = useCallback((sha: string) => {
    setWorktreePath(null);
    setHistoryOpen(false);
    navigate({ ref: sha, line: null }, false);
  }, [navigate]);

  const jumpToLine = useCallback((line: number) => {
    if (layoutRef.current !== "wide") setRailOpen(false);
    navigate({ line }, true);
    scrollLineIntoView(line);
  }, [navigate]);

  // Learn — open a lesson in the rail (navigating to its file when needed). The
  // open lesson lives in the URL (?lesson=), so reload / share restores it.
  // `opts.full` opens it straight into full page (a SECOND history entry, pushed
  // once ?lesson= has landed, so Back exits full page before leaving the lesson).
  const pendingFullRef = useRef<string | null>(null);
  const openLesson = useCallback((t: CodeThreadSummary | null, seed?: CodeThreadDetailPayload | null, opts?: { full?: boolean }) => {
    setLessonSeed(seed ?? null);
    if (!t) { setLessonFocus(null); navigate({ lesson: null, view: null, step: null }, true); return; }
    setRailTab("learn");
    pendingFullRef.current = opts?.full ? t.id : null;
    const move = t.path !== path;
    if (t.id === openLessonId && !move) { if (opts?.full && !lessonFull) { pendingFullRef.current = null; navigate({ view: "full" }, false); } return; }
    navigate({ lesson: t.id, step: null, ...(move ? { path: t.path, line: null, thread: null } : {}) }, !move);
  }, [path, navigate, openLessonId, lessonFull]);

  // Learn — full-page lesson mode (?view=full). Entering pushes a history entry
  // so browser Back exits full page first; the in-page exits (button, F, Esc)
  // pop that same entry when this session pushed it, else just drop the param
  // (a reloaded / shared full-page link has nothing of ours to pop).
  const fullPushedRef = useRef(false);
  const lessonStepRef = useRef(lessonInitialStep);
  const enterLessonFull = useCallback(() => {
    if (!openLessonId || lessonFull) return;
    fullPushedRef.current = true;
    setRailTab("learn");
    setTreeOpen(false);
    setRailOpen(false);
    navigate({ view: "full" }, false);
  }, [openLessonId, lessonFull, navigate]);
  const exitLessonFull = useCallback(() => {
    if (!lessonFull) return;
    if (fullPushedRef.current) { fullPushedRef.current = false; routerNavigate(-1); }
    else navigate({ view: null }, true);
  }, [lessonFull, navigate, routerNavigate]);
  const toggleLessonFull = useCallback(() => {
    if (lessonFull) exitLessonFull();
    else enterLessonFull();
  }, [lessonFull, enterLessonFull, exitLessonFull]);
  useEffect(() => {
    if (!openLessonId) return;
    setRailTab("learn");
    if (pendingFullRef.current === openLessonId) { pendingFullRef.current = null; enterLessonFull(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openLessonId]);
  const onLessonStepChange = useCallback((step: number) => {
    lessonStepRef.current = step;
    const want = step > 0 ? String(step + 1) : null;
    if (latestParamsRef.current.get("step") !== want) navigate({ step: want }, true);
  }, [navigate]);
  // Presenter mode (full page, wide only): the app sidebar hides too.
  const [lessonPresent, setLessonPresent] = useState(false);
  // leaving full page (any route: button, F, Esc, Back) plays the exit motion,
  // drops presenter mode and re-mirrors the CURRENT step (Back restored the
  // pre-full entry, whose ?step= may be stale).
  const [lessonFullExit, setLessonFullExit] = useState(false);
  const wasFullRef = useRef(lessonFull);
  useEffect(() => {
    if (lessonFull) setRailTab("learn");
    if (wasFullRef.current && !lessonFull) {
      fullPushedRef.current = false;
      setLessonPresent(false);
      if (openLessonId) {
        const want = lessonStepRef.current > 0 ? String(lessonStepRef.current + 1) : null;
        if (latestParamsRef.current.get("step") !== want) navigate({ step: want }, true);
      }
      setLessonFullExit(true);
      const t = window.setTimeout(() => setLessonFullExit(false), 520);
      wasFullRef.current = lessonFull;
      return () => window.clearTimeout(t);
    }
    wasFullRef.current = lessonFull;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lessonFull]);
  // Esc exits full page (never while typing, inside an editor, a menu or a dialog)
  useEffect(() => {
    if (!lessonFull) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as Element | null;
      if (isEditingTarget(t) || (t && (t as HTMLElement).closest?.('.cm-editor, [role="menu"], [role="dialog"], [role="listbox"]'))) return;
      e.preventDefault();
      exitLessonFull();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [lessonFull, exitLessonFull]);

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
    revealRail();
  }, [revealRail]);

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
    revealRail();
  }, [revealRail]);

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
    revealRail();
  }, [revealRail]);

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
    revealRail();
  }, [revealRail]);

  // Workspace symbol search result navigation (header search AND identifier
  // click both land here): switch to the clicked file at the symbol's line.
  const navigateToSymbol = useCallback((symbolPath: string, line: number) => {
    setSelection(null);
    setComposerOpen(false);
    setWorktreePath(null);
    setHistoryOpen(false);
    setTreeOpen(false);
    navigate({ path: symbolPath, line, thread: null }, false);
    scrollLineIntoView(line);
  }, [navigate]);

  const onIdentifierClick = useCallback((word: string) => {
    setSymbolPrefill(word);
    setSymbolPrefillToken((n) => n + 1);
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
    setTreeOpen(false);
    revealRail();
  }, [navigate, revealRail]);

  const agents = snap?.agents ?? [];
  const htmlUrl = null; // Code Space has no repo html_url context handy here; the file pane omits the GitHub link.

  const gutterDotsForLine = useMemo(() => {
    const m = new Map<number, CodeThreadSummary[]>();
    fileThreads.forEach((t) => {
      // Learn: teach/why threads get their own spark marker (lessonMarks) —
      // a whole-file "Explain this file" lesson must not dot every line.
      if (t.kind === "teach" || t.kind === "why") return;
      for (let ln = t.start_line; ln <= t.end_line; ln++) {
        const list = m.get(ln) || [];
        list.push(t);
        m.set(ln, list);
      }
    });
    return m;
  }, [fileThreads]);
  // the same thread-dot lines, handed to the CM6 editor so Edit mode keeps
  // the gutter markers the read view shows (no layout shift on toggle).
  // (plus each lesson's first line, so lessons stay marked in the editor too)
  const threadLineNumbers = useMemo(() => {
    const set = new Set(gutterDotsForLine.keys());
    fileThreads.forEach((t) => { if (t.kind === "teach" || t.kind === "why") set.add(t.start_line); });
    return Array.from(set).sort((a, b) => a - b);
  }, [gutterDotsForLine, fileThreads]);

  // Learn — gutter lesson markers: a spark at each teach/why thread's first line
  // (click opens the lesson), and a faint tint on the lines a SHORT lesson covers
  // (whole-file lessons would tint every line, so they only get the marker).
  const lessonMarks = useMemo(() => {
    const starts = new Map<number, CodeThreadSummary>();
    const covered = new Set<number>();
    fileThreads.forEach((t) => {
      if (t.path !== path || (t.kind !== "teach" && t.kind !== "why")) return;
      if (!starts.has(t.start_line)) starts.set(t.start_line, t);
      if (t.end_line - t.start_line <= 40) for (let ln = t.start_line; ln <= t.end_line; ln++) covered.add(ln);
    });
    return { starts, covered };
  }, [fileThreads, path]);

  // Learn — the active lesson step's lines, for THIS file only.
  const focusHere = lessonFocus && lessonFocus.path === path ? lessonFocus.ranges : null;
  const focusLines = useMemo(() => {
    const set = new Set<number>();
    (focusHere ?? []).forEach((r) => { for (let ln = r.start; ln <= Math.max(r.start, r.end); ln++) set.add(ln); });
    return set;
  }, [focusHere]);
  const focusStarts = useMemo(() => new Set((focusHere ?? []).map((r) => r.start)), [focusHere]);
  const focusScrollKey = focusHere ? path + "|" + focusHere.map((r) => r.start + "-" + r.end).join(",") : "";
  useEffect(() => {
    if (!focusHere || !focusHere.length) return;
    const first = Math.min(...focusHere.map((r) => r.start));
    requestAnimationFrame(() => scrollLineIntoView(first, { smooth: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusScrollKey, filePayload]);

  const onLessonFocus = useCallback((ranges: FocusRange[] | null, p: string) => {
    setLessonFocus(ranges && ranges.length ? { path: p, ranges } : null);
  }, []);
  // Full page follows the step: a step citing another file opens THAT file
  // (replace — stepping never piles up history entries).
  useEffect(() => {
    if (!lessonFull || !lessonFocus || lessonFocus.path === path) return;
    setWorktreePath(null);
    setSelection(null);
    setComposerOpen(false);
    navigate({ path: lessonFocus.path, line: null, thread: null }, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lessonFull, lessonFocus?.path]);
  const onOpenFileRef = useCallback((ref: LineRef) => {
    if (!ref.path) return;
    setSelection(null);
    setComposerOpen(false);
    setWorktreePath(null);
    navigate({ path: ref.path, line: ref.start, thread: null }, false);
    requestAnimationFrame(() => scrollLineIntoView(ref.start, { smooth: true }));
  }, [navigate]);

  // Learn — the floating lens (text selection) + gutter marker entry points.
  const { start: startLesson, busy: lensBusy, blocked: lensBlocked } = useStartLesson(cid || "", gitRef, agents);
  const lessonCreated = useCallback((res: CreateThreadResponse | null) => {
    if (!res) return;
    setFileThreads((prev) => [res.thread, ...prev.filter((t) => t.id !== res.thread.id)]);
    openLesson(res.thread, { thread: res.thread, messages: [res.message] });
    revealRail();
  }, [openLesson, revealRail]);
  const lensAsk = useCallback((kind: "teach" | "why", r: LensRange) => {
    const where = r.start === r.end ? "line " + r.start : "lines " + r.start + "–" + r.end;
    const file = path.slice(path.lastIndexOf("/") + 1);
    const body = kind === "teach"
      ? `Teach me the concept in ${file} ${where}: what it is, how this code uses it, and what to read next.`
      : `Why is ${file} ${where} written this way? Walk me through the decision and the alternatives.`;
    void startLesson({ kind, path, start: r.start, end: r.end, body }, null, "lens").then(lessonCreated);
  }, [path, startLesson, lessonCreated]);
  const lensCompose = useCallback((r: LensRange) => {
    anchorLineRef.current = r.start;
    setSelection(rangeFrom(r.start, r.end));
    setComposerWholeDocument(false);
    setComposerOpen(true);
    setRailTab("threads");
    setOpenThreadId(null);
    setRaiseHand(null);
    revealRail();
  }, [revealRail]);

  // Panel improvements item 1 — resizable tree/code/rail panes. Native
  // Pointer Events via DOCUMENT-level listeners registered for the
  // duration of a drag (not React's onPointerMove/onPointerUp on the
  // divider itself) — the cursor routinely leaves the divider's own 6px hit
  // area mid-drag, and document listeners keep tracking it regardless,
  // without needing setPointerCapture (which jsdom doesn't implement — see
  // scrollLineIntoView's identical feature-detect precedent elsewhere in
  // this file for the general house convention). No drag library — this
  // codebase adds zero new dependencies for UI interactions like this.
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

  // V2 keyboard resize (brief §7 — every pointer-only affordance also works
  // from the keyboard): ←/→ nudge the focused divider 16 px (Shift = 64 px),
  // Home/Enter reset it. Same dragTree/dragRail math as the pointer path.
  const onDividerKey = useCallback((pane: "tree" | "rail") => (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    const drag = pane === "tree" ? dragTree : dragRail;
    if (e.key === "ArrowLeft") { e.preventDefault(); drag(-step); }
    else if (e.key === "ArrowRight") { e.preventDefault(); drag(step); }
    else if (e.key === "Home" || e.key === "Enter") { e.preventDefault(); (pane === "tree" ? resetTree : resetRail)(); }
  }, [dragTree, dragRail, resetTree, resetRail]);

  const editSource: EditSource = worktreeAvailable ? "worktree" : githubEditable ? "github" : "readonly";
  const backToHead = useCallback(() => {
    setWorktreePath(null);
    setHistoryOpen(false);
    navigate({ ref: "HEAD", line: null }, false);
  }, [navigate]);
  const fileName = path ? path.slice(path.lastIndexOf("/") + 1) : "";
  const pickRef = useCallback((ref: string) => {
    setWorktreePath(null);
    setHistoryOpen(false);
    navigate({ ref, line: null }, false);
  }, [navigate]);

  if (!cid) return null;

  // "No GitHub repo connected" is a PAGE state, not a tree-pane state: one
  // centered empty state with the primary Connect action, instead of a tree
  // column message beside a center pane still offering symbol search.
  const rootError = dirCache[""]?.error;
  // C18: "No repository connected" only for a project with NO bound repo. A
  // bound repo that browse still can't reach (no usable token) names the repo
  // and points at GitHub access — never "connect a repo" when one is connected.
  const boundRepo = (snap?.container as { github_repo?: string | null } | undefined)?.github_repo || null;
  const cantReachRepo = boundRepo && (rootError?.kind === "not_connected" || rootError?.kind === "no_access") ? boundRepo : null;
  // the server's own reason when it names the access problem (no_token / 403);
  // a "not connected" detail would contradict the bound repo, so it's dropped
  const cantReachDetail = rootError?.kind === "no_access" && rootError.detail ? rootError.detail : null;
  const notConnected = rootError?.kind === "not_connected" && !cantReachRepo;
  // wave4 review: an unreachable project (5xx) is ONE page state — not a
  // tree-rail "Couldn't load (503)" + raw DB text beside a landing that
  // claims "No threads yet" as if the project were empty.
  const unreachable = !notConnected && ((rootError?.kind === "error" && (rootError.status ?? 0) >= 500) || (!snap && !!snapError && !!rootError));
  // parity r2: a failed snapshot has no container name, but the (reachable)
  // project list does — name the project like the header / stale bar do
  const unreachableName = snap?.container?.name || (projectList || []).find((p) => p.id === cid)?.name || null;
  const unreachableDetail = [rootError?.status ? "HTTP " + rootError.status : null, rootError?.detail || snapError || null].filter(Boolean).join(" · ");
  const drawerOpen = !lessonFull && layout !== "wide" && (railOpen || (layout === "narrow" && treeOpen));
  const threadCount = fileThreads.length;

  // The ONE file bar (EditContext): breadcrumbs left, state · ref · file
  // controls right. File controls only exist once THIS path's payload landed.
  const fileReady = !!filePayload && filePayload.path === path && !fileLoading && !fileError;
  const fileActions = fileReady && filePayload ? (
    <div className="cs-file-actions">
      <span className="cs-file-size tnum" title={filePayload.size + " bytes"}>{formatSize(filePayload.size)}</span>
      {!editMode && isMd && !lessonFull ? (
        <>
          {viewMode === "rendered" ? (
            <Button
              size="sm"
              variant="ghost"
              pill
              icon="plus"
              className="cs-discuss-doc-btn"
              onClick={onDiscussDocument}
              title="Start a thread anchored to this whole document"
            >
              Discuss this document
            </Button>
          ) : null}
          <Segmented
            size="sm"
            label="View mode"
            className="cs-view-toggle"
            value={viewMode}
            onChange={(k) => setViewMode(k as ViewMode)}
            // r3: icon-only (label kept for AT, title as tooltip) so the
            // toggle stops squeezing the ref picker down to "f…" on .md files.
            items={[
              { key: "raw", icon: "code", label: <span className="cs-view-toggle-label">Raw</span>, title: "Raw source" },
              { key: "rendered", icon: "eye", label: <span className="cs-view-toggle-label">Rendered</span>, title: "Rendered markdown" },
            ]}
          />
        </>
      ) : null}
      {worktreeAvailable ? (
        <span className="cs-history-anchor">
          <IconButton
            size="sm"
            icon="clock"
            label="Commit history"
            className="cs-history-btn"
            onClick={() => setHistoryOpen((v) => !v)}
            aria-expanded={historyOpen}
            pressed={historyOpen}
          />
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
      {canEdit ? (
        <Button
          size="sm"
          variant={editMode ? "secondary" : "ghost"}
          pill
          icon="pencil"
          className={"cs-edit-toggle-btn" + (editMode ? " on" : "")}
          onClick={editMode ? exitEditMode : enterEditMode}
          disabled={!editMode && !!writeBlock}
          title={editMode ? "Stop editing and return to the read-only view" : writeBlock || "Edit this file"}
          aria-pressed={editMode}
        >
          {editMode ? "Editing" : "Edit"}
          {editorDirty ? <span className="cs-edit-dirty-dot" aria-label="Unsaved changes" /> : null}
        </Button>
      ) : null}
    </div>
  ) : null;

  // D5 filter row under the panel header: symbol search + Recent on the
  // left, circular pane toggles on the right (only when a pane is a drawer).
  const toolbar = notConnected || cantReachRepo || unreachable ? undefined : (
    <PageToolbar
      label="Code Space"
      className={"cs-toolbar is-" + layout}
      end={
        layout === "wide" ? (
          <>
            <CircleIconButton
              icon="folder"
              label="File tree"
              className="cs-pane-toggle"
              pressed={!collapsed.tree}
              aria-controls="cs-tree-pane"
              onClick={() => setCollapsed((c) => ({ ...c, tree: !c.tree }))}
            />
            <CircleIconButton
              icon="sidebar"
              label="Threads panel"
              className="cs-pane-toggle cs-rail-toggle"
              pressed={!railHidden}
              aria-controls="cs-rail"
              onClick={toggleWideRail}
            />
          </>
        ) : (
          <>
            {layout === "narrow" ? (
              <CircleIconButton
                icon="folder"
                label={treeOpen ? "Hide files" : "Show files"}
                className="cs-pane-toggle"
                pressed={treeOpen}
                aria-controls="cs-tree-pane"
                onClick={() => { setRailOpen(false); setTreeOpen((v) => !v); }}
              />
            ) : null}
            <CircleIconButton
              icon="sidebar"
              label={railOpen ? "Hide threads" : "Show threads, live edits, outline and changes"}
              className="cs-pane-toggle cs-rail-toggle"
              pressed={railOpen}
              badge={threadCount || undefined}
              aria-controls="cs-rail"
              onClick={() => { setTreeOpen(false); setRailOpen((v) => !v); }}
            />
          </>
        )
      }
    >
      <SymbolSearch
        cid={cid}
        gitRef={gitRef}
        onNavigate={navigateToSymbol}
        prefill={symbolPrefill}
        prefillToken={symbolPrefillToken}
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
    </PageToolbar>
  );

  // Full-page lesson: presenter mode only exists at wide widths; the narrow
  // single column shows each step's lines inline (the loaded file = the step's).
  const presentOn = lessonPresent && lessonFull && layout === "wide";
  const lessonPeek = lessonFull && layout === "narrow" && fileReady && filePayload && !filePayload.binary
    ? { path: filePayload.path, content: filePayload.content ?? "" }
    : null;

  return (
    <Shell
      page="code"
      title="Code Space"
      crumbs={path ? [{ label: fileName, title: path }] : undefined}
      toolbar={lessonFull ? undefined : toolbar}
      flush
    >
      {presentOn ? <PresentMode /> : null}
      <div className="cs-shell" ref={setShellEl} data-layout={layout}>
        {notConnected ? (
          // the ONE shared not-connected state (same copy + CTA as the GitHub hub);
          // cs-not-connected keeps Code Space's tuned vertical placement
          <RepoNotConnected className="cs-not-connected" to={withCid("/github?connect=1", cid)} disabledReason={connectBlock} />
        ) : cantReachRepo ? (
          <div className="cs-unreachable" id="csCantReachRepo">
            <EmptyState
              icon="alert"
              title={"Can't reach " + cantReachRepo}
              body={cantReachDetail
                ? <>{cantReachDetail.charAt(0).toUpperCase() + cantReachDetail.slice(1)}.</>
                : <>Embodent has no GitHub token that can read this repository. Add or check one in Settings › Integrations.</>}
              action={<ButtonLink variant="secondary" size="sm" href={withCid("/settings", cid) + "#tab=github-access"}>Check GitHub access</ButtonLink>}
            />
          </div>
        ) : unreachable ? (
          <div className="cs-unreachable">
            <EmptyState
              icon="alert"
              title={"Can't reach " + (unreachableName || "this project")}
              body={
                <>
                  Embodent couldn&#39;t load this project&#39;s code. It may still be starting, or its database may be down.
                  {/* the Shell's stale bar already carries Details + Retry for a
                      failed snapshot — never the same fact twice (D12) */}
                  {unreachableDetail && !snapError ? (
                    <details className="cs-unreachable-details">
                      <summary>Details</summary>
                      <code>{unreachableDetail}</code>
                    </details>
                  ) : null}
                </>
              }
              action={snapError ? undefined : <Button variant="secondary" icon="refresh" onClick={() => { retryDir(""); void refresh(); }}>Retry</Button>}
            />
          </div>
        ) : (
        <>
        <div
          className={"cs-body" + (lessonFull ? " is-lesson-full" : (treeOpen ? " tree-open" : "") + (railOpen ? " rail-open" : "")
            + (layout === "wide" && collapsed.tree ? " tree-collapsed" : "") + (layout === "wide" && railHidden ? " rail-collapsed" : ""))
            + (lessonFullExit ? " is-lesson-exit" : "") + (presentOn ? " is-presenting" : "")}
          onKeyDown={(e) => {
            if (e.key !== "Escape" || !drawerOpen || e.defaultPrevented) return;
            const t = e.target as HTMLElement;
            if (t.closest("textarea, input, .cm-editor")) return;
            closeDrawers();
          }}
        >
          <div className="cs-tree-pane" id="cs-tree-pane" style={{ width: widths.tree }}>
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
                    return n ? <span className="cs-tree-badge" aria-label={n + " thread" + (n === 1 ? "" : "s")}>{n}</span> : null;
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
            title="Drag or use ←/→ to resize; double-click or Home to reset"
            tabIndex={0}
            aria-valuenow={widths.tree}
            onPointerDown={startDrag("tree")}
            onDoubleClick={resetTree}
            onKeyDown={onDividerKey("tree")}
          />

          <div className="cs-code-pane">
            {path && !worktreePath ? (
              <EditContext
                source={editSource}
                gitRef={gitRef}
                branch={worktreeBranch}
                editing={editMode}
                dirty={editorDirty}
                draftCount={drafts.length}
                onBackToHead={backToHead}
                lead={<Breadcrumbs path={path} onOpenDir={openDirInTree} />}
                actions={fileActions}
                refSlot={
                  <RefPicker
                    cid={cid}
                    gitRef={gitRef}
                    label={refLabelFor(editSource, gitRef, worktreeBranch)}
                    onPick={pickRef}
                    onOpenHistory={worktreeAvailable ? () => setHistoryOpen(true) : undefined}
                  />
                }
              />
            ) : null}
            {/* always mounted: it renders nothing without drafts, but keeps a
                successful propose's "Opened PR #N" notice after the drafts it
                sent are cleared (CODE-062) */}
            <DraftsBar
              cid={cid}
              gitRef="HEAD"
              drafts={drafts}
              onOpenDraft={openDraftFile}
              onDraftsChanged={refreshDrafts}
            />
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
                  rawUrl={browseRawUrl(cid, cachedPreview!.ref, cachedPreview!.path)}
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
                <BrowseErrorBody err={fileError} what="File" onRetry={retryFile} />
              ) : filePayload ? (
                <ContentPaneChrome
                  gitRef={gitRef}
                  payload={filePayload}
                  htmlUrl={htmlUrl}
                  // images / PDF / media / fonts preview natively (never while editing)
                  rawUrl={editMode ? null : browseRawUrl(cid, filePayload.ref || gitRef, filePayload.path)}
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
                        threadLines={threadLineNumbers}
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
                        threadLines={threadLineNumbers}
                        focusRanges={focusHere}
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
                      focusRanges={focusHere}
                    />
                  ) : isMd && viewMode === "rendered" && !lessonFull ? (
                    <MdRenderedPane
                      content={filePayload.content ?? ""}
                      path={path}
                      onOpenPath={selectFile}
                      onDiscussHeading={onDiscussHeading}
                      onAmbiguousHeading={onAmbiguousHeading}
                    />
                  ) : (
                    <>
                    <div ref={setCodeBodyEl} className={"rb-code mono" + (focusLines.size ? " has-lesson-focus" : "")}>
                      {(filePayload.content ?? "").split("\n").map((line, i) => {
                        const lineNo = i + 1;
                        const threadsHere = gutterDotsForLine.get(lineNo) || [];
                        const selected = isLineSelected(selection, lineNo);
                        const inThread = !!openThreadRange && lineNo >= openThreadRange.start && lineNo <= openThreadRange.end;
                        const tokens: Token[] = highlightLine(line, filePayload.path);
                        const lessonHere = lessonMarks.starts.get(lineNo);
                        const focused = focusLines.has(lineNo);
                        return (
                          <div
                            key={lineNo}
                            className={"cs-line" + (selected ? " selected" : "")
                              + (inThread ? " in-thread" + (lineNo === openThreadRange!.start ? " thread-start" : "") + (lineNo === openThreadRange!.end ? " thread-end" : "") : "")
                              + (focused ? " lesson-focus" + (focusStarts.has(lineNo) ? " lesson-focus-start" : "") + (!focusLines.has(lineNo + 1) ? " lesson-focus-end" : "") : "")
                              + (lessonMarks.covered.has(lineNo) ? " lesson-covered" : "")}
                            data-cs-line={lineNo}
                          >
                            <span
                              className="cs-gutter"
                              // C14c: keyboard reachable — Enter/Space starts a thread
                              // here (Shift extends the range), same as a click.
                              role="button"
                              tabIndex={0}
                              aria-label={"Start a thread on line " + lineNo}
                              onClick={(e) => {
                                // Learn: the spark marker opens that lesson instead of a new thread
                                if (lessonHere && (e.target as Element).closest?.(".cs-gutter-lesson")) { openLesson(lessonHere); revealRail(); return; }
                                onGutterClick(lineNo, e.shiftKey);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  onGutterClick(lineNo, e.shiftKey);
                                }
                              }}
                              title="Click to start a thread, shift-click to extend the range"
                            >
                              <span className="cs-gutter-add" aria-hidden="true">+</span>
                              {lessonHere ? (
                                <span className="cs-gutter-lesson" title={"Lesson: " + (lessonHere.first_message || "open lesson") + " — click to open"} aria-hidden="true">
                                  <svg viewBox="0 0 10 10"><path d="M5 .9 6.05 3.95 9.1 5 6.05 6.05 5 9.1 3.95 6.05.9 5 3.95 3.95z" fill="currentColor" /></svg>
                                </span>
                              ) : threadsHere.length ? <span className="cs-gutter-dot" /> : null}
                              {lineNo}
                            </span>
                            <span className="cs-line-text">
                              <IdentifierTokens tokens={tokens} onIdentifierClick={onIdentifierClick} />
                            </span>
                          </div>
                        );
                      })}
                    </div>
                    <SelectionLens
                      root={codeBodyEl}
                      disabled={!!writeBlock}
                      busy={!!lensBusy || !!lensBlocked}
                      onTeach={(r) => lensAsk("teach", r)}
                      onWhy={(r) => lensAsk("why", r)}
                      onAsk={lensCompose}
                      onRangeChange={setTextSel}
                    />
                    </>
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
            title="Drag or use ←/→ to resize; double-click or Home to reset"
            tabIndex={0}
            aria-valuenow={widths.rail}
            onPointerDown={startDrag("rail")}
            onDoubleClick={resetRail}
            onKeyDown={onDividerKey("rail")}
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
              landingOwnsRecent
              learn={{
                lineCount: fileLineCount,
                selection: selection ?? textSel,
                openLessonId,
                onOpenLesson: openLesson,
                lessonSeed,
                onFocusLines: onLessonFocus,
                onOpenFileRef,
                lessonFull,
                onToggleLessonFull: toggleLessonFull,
                lessonPresent: presentOn,
                onToggleLessonPresent: layout === "wide" ? () => setLessonPresent((v) => !v) : undefined,
                lessonInitialStep,
                onLessonStepChange,
                lessonPeek,
              }}
            />
          </ErrorBoundary>
          {drawerOpen ? <div className="cs-scrim" aria-hidden="true" onClick={closeDrawers} /> : null}
        </div>
        </>
        )}
      </div>
    </Shell>
  );
}

/** Presenter mode: hides the app sidebar (html[data-lesson-present], codespace.css)
 *  for as long as it is mounted. */
function PresentMode() {
  useEffect(() => {
    const el = document.documentElement;
    el.setAttribute("data-lesson-present", "");
    return () => el.removeAttribute("data-lesson-present");
  }, []);
  return null;
}
