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
import { Button, ButtonLink } from "../../components/primitives/Button";
import { FilePreview } from "../../components/filePreview/FilePreview";
import { isRichKind, kindFromExt, looksBinaryText } from "../../lib/filePreview";

/* ---- error degrade (same class names GitHubPage/RepoBrowser already use) -
   V2 (G-08): every state names what happened AND offers the recovery that
   actually exists — Retry re-runs the same fetch (callers pass onRetry), the
   not-connected state links to the GitHub hub (which owns Connect repo), and a
   rate limit never pretends to auto-retry when the surface has no refresh
   timer. Titles are unchanged so existing tests/copy keep matching. */
function RetryButton({ onRetry }: { onRetry?: () => void }) {
  if (!onRetry) return null;
  return (
    <Button variant="secondary" size="sm" className="gh-retry" onClick={onRetry}>
      Retry
    </Button>
  );
}
export function BrowseEmptyRepo() {
  return (
    <div className="gh-empty card-empty" role="status">
      <div className="t1">No GitHub repo connected</div>
      <p>Connect this project to a repository to browse its files here.</p>
      <ButtonLink variant="secondary" size="sm" href="/github">Connect a repo</ButtonLink>
    </div>
  );
}
export function BrowseRateLimit({ detail, onRetry }: { detail?: string | null; onRetry?: () => void }) {
  return (
    <div className="gh-empty card-empty" role="alert">
      <div className="t1">GitHub rate limit hit</div>
      <p>
        GitHub is refusing requests for now (too many requests).
        {detail ? " (" + detail + ")" : ""} Try again in a minute.
      </p>
      <RetryButton onRetry={onRetry} />
    </div>
  );
}
/** HTTP 403 that is NOT a rate limit: the token can't read this repo. */
export function BrowseNoAccess({ detail }: { detail?: string | null }) {
  return (
    <div className="gh-empty card-empty" role="alert">
      <div className="t1">GitHub token can&#39;t access this repository</div>
      <p>
        The token Embodent uses is missing, expired, or lacks access to this repo.
        {detail ? " (" + detail + ")" : ""}
      </p>
      <ButtonLink variant="primary" size="sm" href="/settings#tab=github-access">Check GitHub access</ButtonLink>
    </div>
  );
}
export function BrowseNotFound({ what }: { what: string }) {
  return (
    <div className="gh-empty card-empty" role="status">
      <div className="t1">{what} not found</div>
      <p>It may not exist at this ref, or may have been moved or deleted.</p>
    </div>
  );
}
export function BrowseGenericError({ status, detail, onRetry }: { status?: number; detail?: string | null; onRetry?: () => void }) {
  return (
    <div className="gh-empty card-empty" role="alert">
      <div className="t1">Couldn&#39;t load{status && status >= 400 ? " (" + String(status) + ")" : ""}</div>
      <p>{detail ? detail : "Something went wrong talking to GitHub."}</p>
      <RetryButton onRetry={onRetry} />
    </div>
  );
}
export function BrowseErrorBody({ err, what, onRetry }: { err: GhError; what: string; onRetry?: () => void }) {
  if (err.kind === "not_found") return <BrowseNotFound what={what} />;
  if (err.kind === "not_connected") return <BrowseEmptyRepo />;
  if (err.kind === "rate_limited") return <BrowseRateLimit detail={err.detail} onRetry={onRetry} />;
  if (err.kind === "no_access") return <BrowseNoAccess detail={err.detail} />;
  return <BrowseGenericError status={err.status} detail={err.detail} onRetry={onRetry} />;
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
  <svg className="dfv-i" aria-hidden="true" viewBox="0 0 16 16" width={14} height={14} fill="currentColor">
    <path d="M1.75 2.5h4.19l1.55 1.5h6.76c.69 0 1.25.56 1.25 1.25v7c0 .69-.56 1.25-1.25 1.25H1.75c-.69 0-1.25-.56-1.25-1.25v-8.5c0-.69.56-1.25 1.25-1.25Z" />
  </svg>
);
export const FileIcon = () => (
  <svg className="dfv-i" aria-hidden="true" viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.3}>
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
// V2 keyboard contract for the tree (brief §7: every hover/click action also
// reachable by keyboard): rows are focusable treeitems (roving tabindex — only
// the selected row, or the first, is in the Tab order); ↑/↓ move, → expands a
// folder, ← collapses it, Enter/Space activates (open file / toggle folder),
// Home/End jump. Only handled while focus is ON a row, so it never hijacks
// inputs, CodeMirror or terminals.
function onTreeKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
  const target = e.target as HTMLElement;
  if (!target.classList || !target.classList.contains("dfv-r")) return;
  const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(".dfv-r[role=treeitem]"));
  const i = rows.indexOf(target);
  if (i < 0) return;
  const focusAt = (n: number) => {
    const el = rows[Math.max(0, Math.min(rows.length - 1, n))];
    if (el) el.focus();
  };
  const isDir = target.classList.contains("dfv-dir");
  const open = target.getAttribute("aria-expanded") === "true";
  switch (e.key) {
    case "ArrowDown": e.preventDefault(); focusAt(i + 1); break;
    case "ArrowUp": e.preventDefault(); focusAt(i - 1); break;
    case "Home": e.preventDefault(); focusAt(0); break;
    case "End": e.preventDefault(); focusAt(rows.length - 1); break;
    case "ArrowRight":
      if (isDir && !open) { e.preventDefault(); target.click(); }
      break;
    case "ArrowLeft":
      if (isDir && open) { e.preventDefault(); target.click(); }
      break;
    case "Enter":
    case " ":
      e.preventDefault(); target.click(); break;
    default:
  }
}

export function BrowseTree({ rows, dirCache, expanded, selectedPath, onToggleDir, onSelectFile, onRetryDir, fileBadge }: BrowseTreeProps) {
  const root = dirCache[""];
  if (root && root.loading && !root.entries) return <BrowseSkeletonRows />;
  if (root && root.error) {
    return <BrowseErrorBody err={root.error} what="Repository" onRetry={onRetryDir ? () => onRetryDir("") : undefined} />;
  }
  if (!rows.length) return <div className="none" style={{ padding: 14 }}>No files.</div>;
  // roving tabindex: the selected file row, else the first row, is tabbable
  const selectedVisible = rows.some((r) => r.entry.type === "file" && r.entry.path === selectedPath);
  return (
    <div className="dfv-tree rb-dfv-tree" role="tree" aria-label="Repository files" onKeyDown={onTreeKeyDown}>
      {rows.map((r, idx) => {
        const isDir = r.entry.type === "dir";
        const open = expanded.has(r.entry.path);
        const tabbable = selectedVisible ? (!isDir && r.entry.path === selectedPath) : idx === 0;
        if (isDir) {
          const state = dirCache[r.entry.path];
          // a folder can be the selection too (the folder-listing view)
          const dirSelected = r.entry.path === selectedPath;
          return (
            <div key={"d:" + r.entry.path} role="none">
              <div
                className={"dfv-r dfv-dir" + (dirSelected ? " on" : "")}
                role="treeitem"
                aria-level={r.depth + 1}
                aria-expanded={open}
                aria-selected={dirSelected}
                tabIndex={tabbable ? 0 : -1}
                style={{ paddingLeft: 10 + r.depth * 14 }}
                title={r.entry.path}
                onClick={() => onToggleDir(r.entry.path)}
              >
                <svg className={"dfv-c" + (open ? " is-open" : "")} viewBox="0 0 10 10" width={10} height={10} aria-hidden="true">
                  <path d="M3.5 2 7 5l-3.5 3" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <DirIcon />
                <span className="dfv-nm">{r.entry.name}</span>
              </div>
              {open && state && state.loading && !state.entries ? (
                <div style={{ paddingLeft: 24 + r.depth * 14 }} className="rb-dir-loading muted" role="status">Loading…</div>
              ) : null}
              {open && state && state.error ? (
                onRetryDir ? (
                  <div
                    style={{ paddingLeft: 24 + r.depth * 14 }}
                    className="rb-dir-loading rb-dir-retry muted"
                    role="button"
                    tabIndex={0}
                    onClick={() => onRetryDir(r.entry.path)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onRetryDir(r.entry.path); } }}
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
        const selected = r.entry.path === selectedPath;
        return (
          <div
            key={"f:" + r.entry.path}
            className={"dfv-r dfv-f" + (selected ? " on" : "")}
            role="treeitem"
            aria-level={r.depth + 1}
            aria-selected={selected}
            tabIndex={tabbable ? 0 : -1}
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
  // drop the path from the header when the host already shows it (RepoBrowser's
  // breadcrumb) — a fact is never shown twice (D12)
  hidePath?: boolean;
  children?: React.ReactNode; // the actual code body (CodeLines or a custom gutter render)
  /** The file's raw-bytes URL (browse/raw at this ref). With it, images, SVG,
   *  PDF, media and fonts render natively and other binaries get a sized
   *  Download card; without it a binary keeps the one-line notice. */
  rawUrl?: string | null;
}
export function ContentPaneChrome({ gitRef, payload, htmlUrl, extIcon, headerExtra, hidePath, children, rawUrl }: ContentPaneChromeProps) {
  const kind = kindFromExt(payload.path);
  // a payload the server didn't flag but whose text is really binary is never dumped
  const binary = !!payload.binary || looksBinaryText(payload.content);
  const preview = !!rawUrl && (binary || kind === "binary" || (!!kind && isRichKind(kind)));
  return (
    <>
      <div className="rb-file-head">
        <span className="tag rb-ref-chip mono">{gitRef}</span>
        {hidePath ? <span className="v2-grow" /> : <span className="rb-file-path mono" title={payload.path}>{payload.path}</span>}
        <span className="rb-file-size muted">{formatSize(payload.size)}</span>
        {headerExtra}
      </div>
      {preview ? (
        <FilePreview
          url={rawUrl!}
          path={payload.path}
          // an unknown extension (null): the response's MIME + a byte sniff decide
          kind={kind}
          sizeHint={payload.size}
          sourceView={kind === "svg" && !binary ? <div className="fp-svg-code">{children}</div> : undefined}
        />
      ) : binary ? (
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
