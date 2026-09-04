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
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../../../components/ui";
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
}

export function RepoBrowser({ cid, gitRef, path, htmlUrlBase, onNavigate }: RepoBrowserProps) {
  const { dirCache, expanded, rows, toggleDir, retryDir, filePayload, fileError, fileLoading } = useBrowseTree(cid, gitRef, path);
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
    <div className="rb-wrap">
      <div className="rb-side">
        <div className="rb-search">
          <div className="rb-search-tabs" role="tablist" aria-label="Search mode">
            <button
              type="button"
              role="tab"
              aria-selected={searchMode === "names"}
              className={"rb-search-tab" + (searchMode === "names" ? " on" : "")}
              onClick={() => setSearchMode("names")}
            >
              Names
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={searchMode === "contents"}
              className={"rb-search-tab" + (searchMode === "contents" ? " on" : "")}
              onClick={() => setSearchMode("contents")}
            >
              Contents
            </button>
          </div>
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

        <div className="rb-tree-scroll">
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
        <ContentPane
          gitRef={gitRef}
          path={path}
          loading={fileLoading}
          error={fileError}
          payload={filePayload}
          htmlUrl={htmlUrl}
        />
      </div>
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
  gitRef,
  path,
  loading,
  error,
  payload,
  htmlUrl,
}: {
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
    <ContentPaneChrome gitRef={gitRef} payload={payload} htmlUrl={htmlUrl} extIcon={<Icon name="ext" cls="gl" />}>
      <CodeLines content={payload.content ?? ""} path={payload.path} />
    </ContentPaneChrome>
  );
}
