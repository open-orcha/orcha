/**
 * RepoBrowser — the GitHub repo file browser's "Files" sub-view: an
 * IDE-style three-part surface (lazy directory tree, Names/Contents search,
 * line-numbered content pane) mounted by GitHubPage under ?browse=1&ref=&path=.
 *
 * Owns ONLY this directory (src/cloud/github/browse/**) plus one integration
 * point in GitHubPage.tsx (see that file's diff). Talks to the browse/{tree,
 * file,search} endpoints (CONTRACT — browseTypes.ts doc, implemented on a
 * parallel branch) through browseApi.ts, which classifies every failure
 * through the SAME ghlib.ts error ladder the rest of the hub uses — so
 * not_connected/rate_limited/not_found degrade through the shared
 * cloud/shared/browseTree.tsx components (extracted from here so Code Space
 * (cloud/codespace/**) can reuse the identical tree/skeleton/error/content
 * rendering without duplicating it — same class names / copy either way).
 *
 * State lives here (not in GitHubPage) — the tree's expanded-dir set, the
 * search mode/query, and the selected file all reset only when `ref` changes,
 * never on the 3s snapshot poll (this component doesn't ride that poll at
 * all: it only fetches on mount / ref change / user interaction).
 */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button, Popover, Segmented } from "../../../components/primitives";
import { Icon } from "../../../components/ui";
import { browseRawUrl } from "../../../components/filePreview/sources";
import {
  BrowseErrorBody,
  BrowseSkeletonPane,
  BrowseSkeletonRows,
  BrowseTree,
  CodeLines,
  ContentPaneChrome,
  DirIcon,
  FileIcon,
} from "../../shared/browseTree";
import { useBrowseTree } from "../../shared/useBrowseTree";
import type { GhError } from "../ghlib";
import { fetchSearch } from "./browseApi";
import {
  baseName,
  parentOf,
  type BrowseEntry,
  type BrowseContentResult,
  type BrowseFilePayload,
  type BrowseNameResult,
  type BrowseSearchMode,
} from "./browseTypes";
import { useDebouncedValue } from "./useDebounce";
import "./browse.css";

/* ---- search result row shapes --------------------------------------------- */
function isContentResult(r: BrowseNameResult | BrowseContentResult): r is BrowseContentResult {
  return Array.isArray((r as BrowseContentResult).matches);
}

export interface RepoBrowserProps {
  cid: string;
  // NOT named "ref" — that's a reserved JSX/React prop (element refs), so a
  // prop of that name never reaches the component; React swallows it and
  // throws "ref was specified as a string" instead.
  gitRef: string;
  path: string; // "" = no file selected
  htmlUrlBase?: string | null; // e.g. "https://github.com/acme/app" — for "view on GitHub" links
  onNavigate: (next: { ref?: string; path?: string }) => void;
  /** leading slot of the ref/path bar (the host's back button) — keeps the
   *  browser ONE surface with the panel instead of a bar stacked above it */
  leading?: ReactNode;
}

export function RepoBrowser({ cid, gitRef, path, htmlUrlBase, onNavigate, leading }: RepoBrowserProps) {
  const { dirCache, expanded, rows, toggleDir, retryDir, filePayload, fileError, fileLoading } = useBrowseTree(cid, gitRef, path);
  // V2: a DIRECTORY path (?path=src) is a folder, not a file — once its
  // parent's listing says so, the pane lists the folder's entries and the
  // tree expands it (instead of the old "HEAD src 108 B" pseudo-file view).
  const parentEntries = path ? dirCache[parentOf(path)]?.entries ?? null : null;
  const isDir = !!path && (!!dirCache[path]?.entries || !!(parentEntries && parentEntries.some((e) => e.path === path && e.type === "dir")));
  // at phone width the tree is hidden (it listed the same entries twice, above
  // the listing) — so the repo root is listed in the pane there, making the
  // breadcrumb + listing the one navigator. Wide screens keep the tree as the
  // root navigator and the "select a file" hint (no duplicate listing).
  const narrow = useNarrow();
  const showListing = isDir || (!path && narrow);
  useEffect(() => {
    if (isDir && !expanded.has(path)) toggleDir(path);
    // expand once per path; later collapses are the user's choice
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDir, path]);
  // reveal the selected row in the (scrollable) tree
  const treeRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = treeRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    el?.scrollIntoView?.({ block: "nearest" });
  }, [path, rows.length]);
  const [searchMode, setSearchMode] = useState<BrowseSearchMode>("names");
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);
  const [searchResults, setSearchResults] = useState<(BrowseNameResult | BrowseContentResult)[] | null>(null);
  const [searchError, setSearchError] = useState<GhError | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [defaultBranchOnly, setDefaultBranchOnly] = useState(false);
  const searchToken = useRef(0);

  // ---- search (debounced; names filters paths, contents shows match lines)
  useEffect(() => {
    const q = debouncedQuery.trim();
    if (!q) { setSearchResults(null); setSearchError(null); setSearchLoading(false); return; }
    const myToken = ++searchToken.current;
    setSearchLoading(true);
    fetchSearch(cid, gitRef, q, searchMode).then((res) => {
      if (myToken !== searchToken.current) return;
      setSearchLoading(false);
      if (!res.ok) { setSearchError(res.error); setSearchResults(null); return; }
      setSearchError(null);
      setSearchResults(res.data.results || []);
      setDefaultBranchOnly(!!res.data.default_branch_only);
    });
  }, [cid, gitRef, debouncedQuery, searchMode]);

  const selectFile = useCallback((p: string, line?: number) => {
    onNavigate({ path: p });
    if (line != null) {
      // jump to line once the pane renders it (see the effect below)
      pendingLineRef.current = line;
    }
  }, [onNavigate]);

  const pendingLineRef = useRef<number | null>(null);
  useEffect(() => {
    if (filePayload && pendingLineRef.current != null) {
      const ln = pendingLineRef.current;
      pendingLineRef.current = null;
      const el = document.querySelector(`[data-browse-line="${ln}"]`);
      if (el) el.scrollIntoView({ block: "center" });
    }
  }, [filePayload]);

  const htmlUrl = htmlUrlBase && path ? `${htmlUrlBase}/blob/${encodeURIComponent(gitRef)}/${path}` : htmlUrlBase;

  return (
    <div className={"rb-wrap" + (query.trim() ? " is-searching" : "")}>
      <div className="rb-bar">
        {leading}
        <RefPicker gitRef={gitRef} onPick={(ref) => onNavigate({ ref, path })} />
        <PathCrumbs path={path} onPick={(p) => onNavigate({ path: p })} />
      </div>
      <div className="rb-body">
      <div className="rb-side">
        <div className="rb-search">
          <Segmented
            size="sm"
            label="Search mode"
            className="rb-search-seg"
            value={searchMode}
            onChange={(k) => setSearchMode(k as BrowseSearchMode)}
            items={[{ key: "names", label: "Names" }, { key: "contents", label: "Contents" }]}
          />
          <input
            className="rb-search-in"
            type="search"
            placeholder={searchMode === "names" ? "Search file paths…" : "Search file contents…"}
            spellCheck={false}
            autoComplete="off"
            value={query}
            aria-label="Search repo files"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <div className="rb-tree-scroll" ref={treeRef}>
          {query.trim() ? (
            <SearchResults
              loading={searchLoading}
              error={searchError}
              results={searchResults}
              defaultBranchOnly={defaultBranchOnly}
              onPick={selectFile}
            />
          ) : (
            <BrowseTree rows={rows} dirCache={dirCache} expanded={expanded} selectedPath={path} onToggleDir={toggleDir} onRetryDir={retryDir} onSelectFile={(p) => selectFile(p)} />
          )}
        </div>
      </div>

      <div className="rb-main">
        {showListing ? (
          <DirListing
            path={path}
            entries={dirCache[path]?.entries ?? null}
            loading={!!dirCache[path]?.loading}
            error={dirCache[path]?.error ?? null}
            onPick={(p) => onNavigate({ path: p })}
            onRetry={() => retryDir(path)}
          />
        ) : (
          <ContentPane
            cid={cid}
            gitRef={gitRef}
            path={path}
            loading={fileLoading}
            error={fileError}
            payload={filePayload}
            htmlUrl={htmlUrl}
          />
        )}
      </div>
      </div>
    </div>
  );
}

/** true at ≤860px (the browse.css breakpoint that hides the tree) */
const NARROW_QUERY = "(max-width: 860px)";
export function useNarrow(): boolean {
  const mq = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(NARROW_QUERY) : null;
  const [narrow, setNarrow] = useState(() => !!mq?.matches);
  useEffect(() => {
    if (!mq) return;
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return narrow;
}

/* ---- ref picker (V2): the ref is a real control, not a static chip ---------
   No branch-list endpoint exists, so it offers the default branch, the
   current ref, and a free-form branch / tag / SHA field. */
export function RefPicker({ gitRef, onPick }: { gitRef: string; onPick: (ref: string) => void }) {
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const pick = (r: string) => { setOpen(false); if (r && r !== gitRef) onPick(r); };
  const submit = (e: FormEvent) => { e.preventDefault(); pick(draft.trim()); };
  const label = gitRef === "HEAD" ? "Default branch" : gitRef;
  return (
    <>
      <Button
        ref={anchor}
        variant="secondary"
        size="sm"
        icon="git"
        iconRight="chev"
        className="rb-ref-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={"Ref: " + gitRef}
        onClick={() => { setDraft(""); setOpen((o) => !o); }}
      >
        {label}
      </Button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label="Choose a ref" role="dialog" className="rb-ref-pop" trap>
        <div className="rb-ref-list">
          <button type="button" className={"rb-ref-opt" + (gitRef === "HEAD" ? " on" : "")} onClick={() => pick("HEAD")}>
            <Icon name="git" cls="v2-ico" /><span>Default branch</span><span className="rb-ref-k mono">HEAD</span>
          </button>
          {gitRef !== "HEAD" ? (
            <button type="button" className="rb-ref-opt on" onClick={() => pick(gitRef)}>
              <Icon name="check" cls="v2-ico" /><span className="mono">{gitRef}</span>
            </button>
          ) : null}
        </div>
        <form className="rb-ref-form" onSubmit={submit}>
          <input
            className="rb-search-in"
            placeholder="Branch, tag or commit SHA"
            aria-label="Branch, tag or commit SHA"
            spellCheck={false}
            autoComplete="off"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button type="submit" size="sm" variant="primary" disabled={!draft.trim()}>Go</Button>
        </form>
      </Popover>
    </>
  );
}

/* ---- path crumbs: repo root / dir / dir / file ---------------------------- */
function PathCrumbs({ path, onPick }: { path: string; onPick: (p: string) => void }) {
  const parts = path ? path.split("/") : [];
  return (
    <nav className="rb-crumbs mono" aria-label="Path">
      <button type="button" className="rb-crumb" onClick={() => onPick("")} aria-current={!path ? "page" : undefined}>root</button>
      {parts.map((seg, i) => {
        const p = parts.slice(0, i + 1).join("/");
        const last = i === parts.length - 1;
        return (
          <span key={p} className="rb-crumb-seg">
            <span className="rb-crumb-sep" aria-hidden="true">/</span>
            {last
              ? <span className="rb-crumb cur" aria-current="page" title={p}>{seg}</span>
              : <button type="button" className="rb-crumb" onClick={() => onPick(p)}>{seg}</button>}
          </span>
        );
      })}
    </nav>
  );
}

/* ---- directory listing (a dir path's content pane) ------------------------- */
function DirListing({ path, entries, loading, error, onPick, onRetry }: {
  path: string; entries: BrowseEntry[] | null; loading: boolean; error: GhError | null;
  onPick: (p: string) => void; onRetry: () => void;
}) {
  if (error) return <BrowseErrorBody err={error} what="Folder" onRetry={onRetry} />;
  if (!entries || loading) return <BrowseSkeletonRows />;
  const sorted = [...entries].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return (
    <div className="rb-dir">
      {/* the folder name is already the breadcrumb's last segment (D12) —
          the head carries only the count */}
      <div className="rb-file-head rb-dir-head"><span className="v2-grow" /><span className="rb-file-size muted" title={(path ? baseName(path) + "/" : "Repository root") + " · " + entries.length + " item" + (entries.length !== 1 ? "s" : "")}>{entries.length} item{entries.length !== 1 ? "s" : ""}</span></div>
      {sorted.length ? (
        <ul className="rb-dir-list">
          {sorted.map((e) => (
            <li key={e.path}>
              <button type="button" className="rb-dir-row" onClick={() => onPick(e.path)}>
                {e.type === "dir" ? <DirIcon /> : <FileIcon />}
                <span className="rb-dir-name">{e.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : <div className="rb-empty-pane muted">This folder is empty.</div>}
    </div>
  );
}

/* ---- search results -------------------------------------------------------- */
function SearchResults({
  loading,
  error,
  results,
  defaultBranchOnly,
  onPick,
}: {
  loading: boolean;
  error: GhError | null;
  results: (BrowseNameResult | BrowseContentResult)[] | null;
  defaultBranchOnly: boolean;
  onPick: (path: string, line?: number) => void;
}) {
  if (loading && !results) return <BrowseSkeletonRows />;
  if (error) return <BrowseErrorBody err={error} what="Search" />;
  if (!results || !results.length) return <div className="none" style={{ padding: 14 }}>No matches.</div>;
  return (
    <div className="rb-search-results">
      {defaultBranchOnly ? (
        <div className="rb-search-note muted">Contents search runs against the default branch only.</div>
      ) : null}
      {results.map((r) =>
        isContentResult(r) ? (
          <div key={r.path} className="rb-result-file">
            <div className="rb-result-path mono" title={r.path} onClick={() => onPick(r.path)}>
              <FileIcon /> {r.path}
            </div>
            {r.matches.map((m, i) => (
              <div key={i} className="rb-result-match" onClick={() => onPick(r.path, m.line)}>
                <span className="rb-result-line mono">{m.line}</span>
                <span className="rb-result-text mono">{m.text}</span>
              </div>
            ))}
          </div>
        ) : (
          <div key={r.path} className="rb-result-name mono" title={r.path} onClick={() => onPick(r.path)}>
            {r.type === "dir" ? <DirIcon /> : <FileIcon />} {r.path}
          </div>
        ),
      )}
    </div>
  );
}

/* ---- content pane: sticky header + line-numbered, tokenized content ------- */
function ContentPane({
  cid,
  gitRef,
  path,
  loading,
  error,
  payload,
  htmlUrl,
}: {
  cid: string;
  gitRef: string;
  path: string;
  loading: boolean;
  error: GhError | null;
  payload: BrowseFilePayload | null;
  htmlUrl?: string | null;
}) {
  if (!path) {
    return <div className="rb-empty-pane muted">Select a file to view its contents.</div>;
  }
  if (loading && !payload) return <BrowseSkeletonPane />;
  if (error) return <BrowseErrorBody err={error} what="File" />;
  if (!payload) return <BrowseSkeletonPane />;

  return (
    <ContentPaneChrome gitRef={gitRef} payload={payload} htmlUrl={htmlUrl} extIcon={<Icon name="ext" cls="gl" />} hidePath rawUrl={browseRawUrl(cid, payload.ref || gitRef, payload.path)}>
      <CodeLines content={payload.content ?? ""} path={payload.path} />
    </ContentPaneChrome>
  );
}
