/**
 * Shared repo-tree + code-viewer pieces, refactored OUT of
 * cloud/github/browse/RepoBrowser.tsx so Code Space (cloud/codespace/**) can
 * reuse the exact same directory tree, degrade ladder, skeletons, and
 * line-numbered/tokenized content rendering WITHOUT duplicating them or
 * regressing the GitHub page's embedded browser (RepoBrowser.tsx still owns
 * its own state/fetching — it just renders through these pieces now, byte-
 * for-byte the same markup/class names as before the extraction, so
 * RepoBrowser.test.tsx keeps passing unchanged).
 *
 * Nothing here fetches or holds state — pure render components over the
 * browseTypes.ts wire shapes, exactly like the ghlib.ts / browseTypes.ts
 * convention the rest of the GitHub hub follows.
 */
import { useMemo } from "react";
import type { GhError } from "../github/ghlib";
import type { BrowseEntry, BrowseFilePayload } from "../github/browse/browseTypes";
import { highlightLine, type Token } from "../github/browse/highlight";

/* ---- error degrade (same class names GitHubPage/RepoBrowser already use) - */
export function BrowseEmptyRepo() {
  return (
    <div className="gh-empty card-empty">
      <div className="t1">No GitHub repo connected</div>
      <p>Connect this project to a repository to browse its files here.</p>
    </div>
  );
}
export function BrowseRateLimit({ detail }: { detail?: string | null }) {
  return (
    <div className="gh-empty card-empty">
      <div className="t1">GitHub rate limit hit</div>
      <p>Backing off — this quietly retries on the next refresh.{detail ? " (" + detail + ")" : ""}</p>
    </div>
  );
}
export function BrowseNotFound({ what }: { what: string }) {
  return (
    <div className="gh-empty card-empty">
      <div className="t1">{what} not found</div>
      <p>It may not exist at this ref, or may have been moved or deleted.</p>
    </div>
  );
}
export function BrowseGenericError({ status, detail }: { status?: number; detail?: string | null }) {
  return (
    <div className="gh-empty card-empty">
      <div className="t1">Couldn&#39;t load {status ? "(" + String(status) + ")" : ""}</div>
      <p>{detail ? detail : "Something went wrong talking to GitHub."}</p>
    </div>
  );
}
export function BrowseErrorBody({ err, what }: { err: GhError; what: string }) {
  if (err.kind === "not_found") return <BrowseNotFound what={what} />;
  if (err.kind === "not_connected") return <BrowseEmptyRepo />;
  if (err.kind === "rate_limited") return <BrowseRateLimit detail={err.detail} />;
  return <BrowseGenericError status={err.status} detail={err.detail} />;
}

/* ---- skeletons (ork-sk-* shared shimmer classes) --------------------------- */
export function BrowseSkeletonRows() {
  return (
    <div className="ork-sk-wrap" aria-hidden="true">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="ork-sk-row">
          <div className="ork-sk ork-sk-pill"></div>
          <div className="ork-sk-col"><div className="ork-sk-line w60 sm"></div></div>
        </div>
      ))}
    </div>
  );
}
export function BrowseSkeletonPane() {
  return (
    <div className="ork-sk-wrap" aria-hidden="true">
      <div className="ork-sk-line w50 lg"></div>
      <div className="ork-sk-line w80"></div>
      <div className="ork-sk-line w70"></div>
      <div className="ork-sk-block"></div>
      <div className="ork-sk-line w60"></div>
    </div>
  );
}

/* ---- tree node state + row flattening -------------------------------------- */
export interface DirState {
  loading: boolean;
  error: GhError | null;
  entries: BrowseEntry[] | null;
  truncated?: boolean;
}
export interface TreeRow {
  entry: BrowseEntry;
  depth: number;
}

// Depth-first flattening for render: each dir row is immediately followed by
// its children (recursively) when expanded, by looking up the child dir's
// cached entries in dirCache — rootEntries seeds depth 0. Dirs sort before
// files within a level, both alphabetically (matches FilesChanged's tree).
export function buildVisibleRows(
  dirCache: Record<string, DirState>,
  expanded: Set<string>,
  rootEntries: BrowseEntry[] | null,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const visit = (entries: BrowseEntry[], depth: number) => {
    const dirs = entries.filter((e) => e.type === "dir").slice().sort((a, b) => a.name.localeCompare(b.name));
    const files = entries.filter((e) => e.type === "file").slice().sort((a, b) => a.name.localeCompare(b.name));
    dirs.forEach((d) => {
      rows.push({ entry: d, depth });
      if (expanded.has(d.path)) {
        const child = dirCache[d.path];
        if (child && child.entries) visit(child.entries, depth + 1);
      }
    });
    files.forEach((f) => rows.push({ entry: f, depth }));
  };
  if (rootEntries) visit(rootEntries, 0);
  return rows;
}

export const DirIcon = () => (
  <svg className="dfv-i" viewBox="0 0 16 16" width={14} height={14} fill="currentColor">
    <path d="M1.75 2.5h4.19l1.55 1.5h6.76c.69 0 1.25.56 1.25 1.25v7c0 .69-.56 1.25-1.25 1.25H1.75c-.69 0-1.25-.56-1.25-1.25v-8.5c0-.69.56-1.25 1.25-1.25Z" />
  </svg>
);
export const FileIcon = () => (
  <svg className="dfv-i" viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.3}>
    <path d="M3.5 1.75h6l3 3v9.5a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1V2.75a1 1 0 0 1 1-1Z" />
    <path d="M9.5 1.75v3h3" />
  </svg>
);

/* ---- tree rendering (FilesChanged's .dfv-* row idiom, browse-scoped) ------ */
export interface BrowseTreeProps {
  rows: TreeRow[];
  dirCache: Record<string, DirState>;
  expanded: Set<string>;
  selectedPath: string;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
  // Folder-expand failure retry: a dir row that errored renders as a
  // click-to-retry affordance instead of a dead-end message. Optional so a
  // caller that doesn't wire it still renders (falls back to the plain,
  // unclickable error text) — both current callers (RepoBrowser, Code Space)
  // pass it through useBrowseTree's retryDir.
  onRetryDir?: (path: string) => void;
  // optional per-path decoration appended after the file name (e.g. Code
  // Space's thread-count badge) — RepoBrowser passes nothing (unchanged UI).
  fileBadge?: (path: string) => React.ReactNode;
}
export function BrowseTree({ rows, dirCache, expanded, selectedPath, onToggleDir, onSelectFile, onRetryDir, fileBadge }: BrowseTreeProps) {
  const root = dirCache[""];
  if (root && root.loading && !root.entries) return <BrowseSkeletonRows />;
  if (root && root.error) return <BrowseErrorBody err={root.error} what="Repository" />;
  if (!rows.length) return <div className="none" style={{ padding: 14 }}>No files.</div>;
  return (
    <div className="dfv-tree rb-dfv-tree">
      {rows.map((r) => {
        const isDir = r.entry.type === "dir";
        const open = expanded.has(r.entry.path);
        if (isDir) {
          const state = dirCache[r.entry.path];
          return (
            <div key={"d:" + r.entry.path}>
              <div
                className="dfv-r dfv-dir"
                style={{ paddingLeft: 10 + r.depth * 14 }}
                title={r.entry.path}
                onClick={() => onToggleDir(r.entry.path)}
              >
                <span className="dfv-c">{open ? "▾" : "▸"}</span>
                <DirIcon />
                <span className="dfv-nm">{r.entry.name}</span>
              </div>
              {open && state && state.loading && !state.entries ? (
                <div style={{ paddingLeft: 24 + r.depth * 14 }} className="rb-dir-loading muted">Loading…</div>
              ) : null}
              {open && state && state.error ? (
                onRetryDir ? (
                  <div
                    style={{ paddingLeft: 24 + r.depth * 14 }}
                    className="rb-dir-loading rb-dir-retry muted"
                    role="button"
                    tabIndex={0}
                    onClick={() => onRetryDir(r.entry.path)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onRetryDir(r.entry.path); }}
                  >
                    Couldn&#39;t load this folder — tap to retry
                  </div>
                ) : (
                  <div style={{ paddingLeft: 24 + r.depth * 14 }} className="rb-dir-loading muted">Couldn&#39;t load this folder.</div>
                )
              ) : null}
            </div>
          );
        }
        return (
          <div
            key={"f:" + r.entry.path}
            className={"dfv-r dfv-f" + (r.entry.path === selectedPath ? " on" : "")}
            style={{ paddingLeft: 24 + r.depth * 14 }}
            title={r.entry.path}
            onClick={() => onSelectFile(r.entry.path)}
          >
            <FileIcon />
            <span className="dfv-nm">{r.entry.name}</span>
            {fileBadge ? fileBadge(r.entry.path) : null}
          </div>
        );
      })}
    </div>
  );
}

/* ---- code content: line-numbered, tokenized ------------------------------- */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

export interface CodeLinesProps {
  content: string;
  path: string;
  // Code Space overrides the plain .rb-line/.rb-lineno rendering with its own
  // gutter affordance (thread dot / add button / selection) per line; when
  // omitted this renders byte-identical to the original RepoBrowser markup.
  renderLine?: (lineNo: number, tokens: Token[]) => React.ReactNode;
}
export function CodeLines({ content, path, renderLine }: CodeLinesProps) {
  // defensive: a malformed/partial payload (e.g. content missing) renders as
  // an empty file rather than crashing the page.
  const lines = useMemo(() => (typeof content === "string" ? content.split("\n") : []), [content]);
  return (
    <div className="rb-code mono">
      {lines.map((line, i) => {
        const lineNo = i + 1;
        const tokens: Token[] = highlightLine(line, path);
        if (renderLine) return <div key={lineNo}>{renderLine(lineNo, tokens)}</div>;
        return (
          <div key={lineNo} className="rb-line" data-browse-line={lineNo}>
            <span className="rb-lineno">{lineNo}</span>
            <span className="rb-line-text">
              {tokens.length
                ? tokens.map((t, ti) => (
                    <span key={ti} className={t.kind === "plain" ? undefined : "rb-tok-" + t.kind}>
                      {t.text}
                    </span>
                  ))
                : " "}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Render a line's tokens (shared by the default CodeLines row and Code Space's custom gutter row). */
export function TokenSpans({ tokens }: { tokens: Token[] }) {
  if (!tokens.length) return <>{" "}</>;
  return (
    <>
      {tokens.map((t, ti) => (
        <span key={ti} className={t.kind === "plain" ? undefined : "rb-tok-" + t.kind}>
          {t.text}
        </span>
      ))}
    </>
  );
}

/* ---- content pane header + binary/truncated degrade (shared shell) -------- */
export interface ContentPaneChromeProps {
  gitRef: string;
  payload: BrowseFilePayload;
  htmlUrl?: string | null;
  // rendered inside each "View on GitHub" link, after the text (RepoBrowser
  // passes the shared <Icon name="ext"/> glyph for exact pre-refactor parity;
  // Code Space omits it — no behavioral difference, both are aria-hidden).
  extIcon?: React.ReactNode;
  // optional slot appended to the file-head row, after the size chip (Code
  // Space's Raw/Rendered markdown toggle; RepoBrowser passes nothing —
  // byte-identical header when omitted).
  headerExtra?: React.ReactNode;
  children?: React.ReactNode; // the actual code body (CodeLines or a custom gutter render)
}
export function ContentPaneChrome({ gitRef, payload, htmlUrl, extIcon, headerExtra, children }: ContentPaneChromeProps) {
  return (
    <>
      <div className="rb-file-head">
        <span className="tag rb-ref-chip mono">{gitRef}</span>
        <span className="rb-file-path mono" title={payload.path}>{payload.path}</span>
        <span className="rb-file-size muted">{formatSize(payload.size)}</span>
        {headerExtra}
      </div>
      {payload.binary ? (
        <div className="rb-binary muted">
          Binary file not shown.
          {htmlUrl ? <> <a href={htmlUrl} target="_blank" rel="noopener noreferrer">View on GitHub {extIcon}</a></> : null}
        </div>
      ) : (
        <>
          {payload.truncated ? (
            <div className="rb-truncated-note muted">
              File truncated — showing a partial view.
              {htmlUrl ? <> <a href={htmlUrl} target="_blank" rel="noopener noreferrer">View on GitHub {extIcon}</a></> : null}
            </div>
          ) : null}
          {children}
        </>
      )}
    </>
  );
}
