/**
 * FilesChanged — React port of the app.js GitHub-style "files changed" diff
 * viewer (renderDiff / parseDiffFiles / dfvTreeHtml / dfvPaneHtml), emitting
 * the SAME .dfv class names / markup so the shared stylesheet applies as-is.
 *
 * A unified git diff parses into per-file entries; multi-file diffs render a
 * two-pane widget: a collapsible directory-hierarchy tree (chain-compressed
 * dirs, per-folder file counts, filter box, M/A/D/R status badges) on the
 * left, the selected file's diff (sticky path header, per-file +/- stats) on
 * the right. Diffs without `diff --git` headers fall back to the flat
 * single-blob renderer; single-file diffs skip the sidebar. React component
 * state replaces the vanilla keyed diffViews Map — mount the component keyed
 * by run_id and selection/filter/collapse survive the 3s poll re-renders.
 */
import { useEffect, useMemo, useState } from "react";
import { binaryPatchNewSize, isBinaryDiff, isRichKind, kindFromExt, stripBinaryPayload } from "../lib/filePreview";
import { BinaryDiffView, type BlobSource } from "./filePreview/BinaryDiff";

export type { BlobSource } from "./filePreview/BinaryDiff";

export interface DiffFile {
  path: string;
  old: string;
  status: "M" | "A" | "D" | "R";
  add: number;
  del: number;
  lines: string[];
  /** A binary section ("GIT binary patch" / "Binary files … differ") — its
   *  payload is never rendered as text; the preview layer shows it instead. */
  binary?: boolean;
  /** The new side's size when a binary patch states it (`literal N`). */
  size?: number | null;
}

// V2 a11y: tree rows are keyboard-reachable (Enter/Space activate) and the
// one-letter status badge carries its word as a tooltip (the badge text itself
// stays the bare letter — other surfaces' tests pin it).
const STATUS_WORD: Record<string, string> = { M: "modified", A: "added", D: "deleted", R: "renamed" };
function activateOnKey(e: { key: string; preventDefault: () => void }, fn: () => void) {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); }
}

export function diffLineClass(l: string): string {
  if (
    l.startsWith("+++") ||
    l.startsWith("---") ||
    l.startsWith("diff ") ||
    l.startsWith("index ") ||
    l.startsWith("new file") ||
    l.startsWith("deleted file") ||
    l.startsWith("old mode") ||
    l.startsWith("new mode") ||
    l.startsWith("similarity ") ||
    l.startsWith("rename ") ||
    l.startsWith("Binary files") ||
    l.startsWith("GIT binary patch")
  )
    return "meta";
  if (l.startsWith("@@")) return "hunk";
  if (l.startsWith("+")) return "add";
  if (l.startsWith("-")) return "del";
  return "";
}

export function parseDiffFiles(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  diff.split("\n").forEach((l) => {
    if (l.startsWith("diff --git ")) {
      const m = l.match(/^diff --git "?a\/(.*?)"? "?b\/(.*?)"?$/);
      cur = { path: m ? m[2] : "", old: m ? m[1] : "", status: "M", add: 0, del: 0, lines: [l] };
      files.push(cur);
      return;
    }
    if (!cur) return;
    cur.lines.push(l);
    if (l.startsWith("new file")) cur.status = "A";
    else if (l.startsWith("deleted file")) cur.status = "D";
    else if (l === "GIT binary patch" || /^Binary files .* differ$/.test(l)) {
      cur.binary = true;
      // `--no-index` diffs say "Binary files /dev/null and b/x differ" with no mode line
      if (/^Binary files \/dev\/null and /.test(l) && cur.status === "M") cur.status = "A";
      else if (/ and \/dev\/null differ$/.test(l) && cur.status === "M") cur.status = "D";
    } else if (cur.binary) {
      /* base85 payload / literal|delta headers — counted as neither add nor del */
    } else if (l.startsWith("rename to ")) {
      cur.status = "R";
      cur.path = l.slice(10);
    } else if (l.startsWith("+++ b/")) cur.path = l.slice(6);
    else if (diffLineClass(l) === "add") cur.add++;
    else if (diffLineClass(l) === "del") cur.del++;
  });
  for (const f of files) {
    if (f.binary) {
      f.size = binaryPatchNewSize(f.lines);
      f.add = 0;
      f.del = 0;
    }
  }
  return files;
}

/* ---- flat fallback (renderFlatDiff parity) -------------------------------- */
function FlatDiff({ diff }: { diff: string }) {
  let add = 0;
  let del = 0;
  const rows = stripBinaryPayload(diff.split("\n")).map((l, i) => {
    const cls = diffLineClass(l);
    if (cls === "add") add++;
    else if (cls === "del") del++;
    return (
      <div key={i} className={"dl " + cls}>
        {l || " "}
      </div>
    );
  });
  return (
    <div className="diff">
      <div className="dstat">
        <span className="a">+{add}</span>
        <span className="d">−{del}</span>
        <span className="muted">unified diff</span>
      </div>
      {rows}
    </div>
  );
}

/* ---- tree building (dfvTreeHtml parity, incl. chain compression) ---------- */
interface TreeNode {
  dirs: Record<string, TreeNode>;
  files: number[]; // indices into files[]
}

function countFiles(node: TreeNode): number {
  let n = node.files.length;
  Object.keys(node.dirs).forEach((d) => {
    n += countFiles(node.dirs[d]);
  });
  return n;
}

const DirIcon = () => (
  <svg className="dfv-i" viewBox="0 0 16 16" width={14} height={14} fill="currentColor">
    <path d="M1.75 2.5h4.19l1.55 1.5h6.76c.69 0 1.25.56 1.25 1.25v7c0 .69-.56 1.25-1.25 1.25H1.75c-.69 0-1.25-.56-1.25-1.25v-8.5c0-.69.56-1.25 1.25-1.25Z" />
  </svg>
);
const FileIcon = () => (
  <svg className="dfv-i" viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.3}>
    <path d="M3.5 1.75h6l3 3v9.5a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1V2.75a1 1 0 0 1 1-1Z" />
    <path d="M9.5 1.75v3h3" />
  </svg>
);

interface TreeRow {
  kind: "dir" | "file";
  key: string;
  label: string; // dir label (chain-compressed) or file basename
  full: string; // dir full path or file path
  depth: number;
  open?: boolean; // dirs
  count?: number; // dirs
  file?: DiffFile; // files
}

function buildTreeRows(files: DiffFile[], q: string, closed: Set<string>, selPath: string): TreeRow[] {
  const query = (q || "").trim().toLowerCase();
  const shown = new Set<number>();
  files.forEach((f, i) => {
    if (!query || f.path.toLowerCase().includes(query)) shown.add(i);
  });
  if (!shown.size) return [];
  const root: TreeNode = { dirs: Object.create(null) as Record<string, TreeNode>, files: [] };
  files.forEach((f, i) => {
    if (!shown.has(i)) return;
    const parts = f.path.split("/");
    let n = root;
    for (let j = 0; j < parts.length - 1; j++)
      n = n.dirs[parts[j]] || (n.dirs[parts[j]] = { dirs: Object.create(null) as Record<string, TreeNode>, files: [] });
    n.files.push(i);
  });
  const rows: TreeRow[] = [];
  const walk = (node: TreeNode, prefix: string, depth: number) => {
    Object.keys(node.dirs)
      .sort()
      .forEach((name) => {
        // GitHub-style chain compression: fold single-child empty dirs into one row.
        let label = name;
        let n = node.dirs[name];
        while (Object.keys(n.dirs).length === 1 && n.files.length === 0) {
          const only = Object.keys(n.dirs)[0];
          label += "/" + only;
          n = n.dirs[only];
        }
        const full = prefix ? prefix + "/" + label : label;
        const open = query ? true : !closed.has(full);
        rows.push({ kind: "dir", key: "d:" + full, label, full, depth, open, count: countFiles(n) });
        if (open) walk(n, full, depth + 1);
      });
    node.files
      .slice()
      .sort((a, b) => (files[a].path.split("/").pop() || "").localeCompare(files[b].path.split("/").pop() || ""))
      .forEach((i) => {
        const f = files[i];
        rows.push({ kind: "file", key: "f:" + f.path, label: f.path.split("/").pop() || f.path, full: f.path, depth, file: f });
      });
  };
  walk(root, "", 0);
  void selPath; // selection highlighting handled at render time
  return rows;
}

/* ---- the selected file's pane (dfvPaneHtml parity) ------------------------ */
/** A file whose change the preview layer shows (binary, or a rich media kind
 *  — e.g. an image the host can serve both sides of). */
function previewable(file: DiffFile, blobSource?: BlobSource | null): boolean {
  if (file.binary || isBinaryDiff(file.lines)) return true;
  const k = kindFromExt(file.path);
  // an SVG text diff stays a text diff; other rich kinds never carry useful text
  return !!blobSource && !!k && isRichKind(k) && k !== "svg";
}

function FilePane({ file, blobSource }: { file: DiffFile | undefined; blobSource?: BlobSource | null }) {
  if (!file) return null;
  if (previewable(file, blobSource)) {
    return (
      <>
        <div className="dfv-ph">
          <span className="dfv-path mono">{file.path}</span>
          <span className="muted dfv-bin">binary</span>
        </div>
        <div className="dfv-preview">
          <BinaryDiffView key={file.path} file={file} source={blobSource} />
        </div>
      </>
    );
  }
  return (
    <>
      <div className="dfv-ph">
        <span className="dfv-path mono">{file.path}</span>
        <span className="a">+{file.add}</span>
        <span className="d">−{file.del}</span>
      </div>
      <div className="dfv-code">
        {file.lines.map((l, i) => (
          <div key={i} className={"dl " + diffLineClass(l)}>
            {l || " "}
          </div>
        ))}
      </div>
    </>
  );
}

/* ---- the widget ----------------------------------------------------------- */
// Accepts EITHER a raw unified git diff (`diff`) or pre-parsed per-file
// entries (`preparsed`, e.g. GitHub API file patches) — same tree/filter/
// badges UI over both.
/** `hideSummary`: the host already states "N files changed +a −d" (e.g. the
 *  agent conversation's "Changed N files" card) — drop the viewer's own count
 *  line so the fact is shown once (D12); the maximize control stays. */
/** `blobSource`: where each side's bytes live (a run / working-tree / ref raw
 *  route) — binary and media files then preview (images compare before/after);
 *  without it they show a compact "binary file" card, never their payload. */
export function FilesChanged({ diff, preparsed, hideSummary, blobSource }: { diff?: string | null | undefined; preparsed?: DiffFile[]; hideSummary?: boolean; blobSource?: BlobSource | null }) {
  const files = useMemo(
    () => (preparsed && preparsed.length ? preparsed : diff && diff.trim() ? parseDiffFiles(diff) : []),
    [diff, preparsed],
  );
  const [selPath, setSelPath] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  // Full-view mode: the widget expands to a fixed overlay so a big diff can be
  // reviewed without the surrounding PR chrome; Esc or the ✕ collapses back.
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      // An inner popover/menu that already handled this Escape wins. Otherwise
      // the full view consumes it (preventDefault) so page-level "Escape closes
      // the task detail" handlers leave the detail open (parity TSK-129).
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      setFull(false);
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden"; // the overlay owns scrolling
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [full]);

  if (!files.length && (!diff || !diff.trim()))
    return (
      <div className="muted" style={{ padding: 10, fontSize: 13 }}>
        No net change (empty diff).
      </div>
    );
  if (!files.length || files.some((f) => !f.path)) return <FlatDiff diff={diff || ""} />;

  // selection falls back to the first file whenever the stored path vanishes
  // (renderDiff parity: `st.files.find(...) || st.files[0]`).
  const sel = (selPath != null && files.find((f) => f.path === selPath)) || files[0];
  const addT = files.reduce((s, f) => s + f.add, 0);
  const delT = files.reduce((s, f) => s + f.del, 0);
  const rows = buildTreeRows(files, q, closed, sel.path);

  const toggleDir = (full: string) => {
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(full)) next.delete(full);
      else next.add(full);
      return next;
    });
  };

  const side =
    files.length > 1 ? (
      <div className="dfv-side">
        <input
          className="dfv-filter"
          type="text"
          placeholder="Filter files…"
          value={q}
          aria-label="Filter changed files"
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="dfv-tree" role="tree" aria-label="Changed files">
          {rows.length ? (
            rows.map((r) =>
              r.kind === "dir" ? (
                <div
                  key={r.key}
                  className="dfv-r dfv-dir"
                  data-dfv-dir={r.full}
                  style={{ paddingLeft: 10 + r.depth * 14 }}
                  title={r.full}
                  role="treeitem"
                  aria-expanded={r.open}
                  tabIndex={0}
                  onClick={() => toggleDir(r.full)}
                  onKeyDown={(e) => activateOnKey(e, () => toggleDir(r.full))}
                >
                  <span className="dfv-c" aria-hidden="true">{r.open ? "▾" : "▸"}</span>
                  <DirIcon />
                  <span className="dfv-nm">{r.label}</span>
                  <span className="dfv-ct">{r.count}</span>
                </div>
              ) : (
                <div
                  key={r.key}
                  className={"dfv-r dfv-f" + (r.file!.path === sel.path ? " on" : "")}
                  data-dfv-file={r.file!.path}
                  style={{ paddingLeft: 24 + r.depth * 14 }}
                  title={`${r.file!.path} · +${r.file!.add} −${r.file!.del}`}
                  role="treeitem"
                  aria-selected={r.file!.path === sel.path}
                  tabIndex={0}
                  onClick={() => setSelPath(r.file!.path)}
                  onKeyDown={(e) => activateOnKey(e, () => setSelPath(r.file!.path))}
                >
                  <FileIcon />
                  <span className="dfv-nm">{r.label}</span>
                  <span className={"dfv-b " + r.file!.status} title={STATUS_WORD[r.file!.status] || r.file!.status}>
                    {r.file!.status}
                  </span>
                </div>
              ),
            )
          ) : (
            <div className="muted" style={{ padding: 10, fontSize: 12 }}>
              No files match.
            </div>
          )}
        </div>
      </div>
    ) : null;

  return (
    <div className={"dfv" + (full ? " dfv-full" : "")}>
      <div className="dfv-top">
        {hideSummary ? null : (
          <>
            <span className="dfv-n">
              {files.length} file{files.length === 1 ? "" : "s"} changed
            </span>
            <span className="a">+{addT}</span>
            <span className="d">−{delT}</span>
          </>
        )}
        <button
          type="button"
          className="dfv-max"
          aria-label={full ? "Collapse diff to the PR view" : "Expand diff to full view"}
          title={full ? "Collapse (Esc)" : "Expand to full view"}
          onClick={() => setFull((v) => !v)}
        >
          {full ? (
            <svg viewBox="0 0 20 20" width={15} height={15} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
          ) : (
            <svg viewBox="0 0 20 20" width={15} height={15} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 4H4v4M12 4h4v4M8 16H4v-4M12 16h4v-4" />
            </svg>
          )}
        </button>
      </div>
      <div className="dfv-body">
        {side}
        <div className="dfv-main">
          <FilePane file={sel} blobSource={blobSource} />
        </div>
      </div>
    </div>
  );
}
