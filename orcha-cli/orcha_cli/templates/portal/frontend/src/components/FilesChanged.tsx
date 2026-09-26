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

export interface DiffFile {
  path: string;
  old: string;
  status: "M" | "A" | "D" | "R";
  add: number;
  del: number;
  lines: string[];
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
    l.startsWith("Binary files")
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
    else if (l.startsWith("rename to ")) {
      cur.status = "R";
      cur.path = l.slice(10);
    } else if (l.startsWith("+++ b/")) cur.path = l.slice(6);
    else if (diffLineClass(l) === "add") cur.add++;
    else if (diffLineClass(l) === "del") cur.del++;
  });
  return files;
}

/* ---- flat fallback (renderFlatDiff parity) -------------------------------- */
function FlatDiff({ diff }: { diff: string }) {
  let add = 0;
  let del = 0;
  const rows = diff.split("\n").map((l, i) => {
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
function FilePane({ file }: { file: DiffFile | undefined }) {
  if (!file) return null;
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
export function FilesChanged({ diff, preparsed }: { diff?: string | null | undefined; preparsed?: DiffFile[] }) {
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
      if (e.key === "Escape") setFull(false);
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
        <div className="dfv-tree">
          {rows.length ? (
            rows.map((r) =>
              r.kind === "dir" ? (
                <div
                  key={r.key}
                  className="dfv-r dfv-dir"
                  data-dfv-dir={r.full}
                  style={{ paddingLeft: 10 + r.depth * 14 }}
                  title={r.full}
                  onClick={() => toggleDir(r.full)}
                >
                  <span className="dfv-c">{r.open ? "▾" : "▸"}</span>
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
                  onClick={() => setSelPath(r.file!.path)}
                >
                  <FileIcon />
                  <span className="dfv-nm">{r.label}</span>
                  <span className={"dfv-b " + r.file!.status}>{r.file!.status}</span>
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
        <span className="dfv-n">
          {files.length} file{files.length === 1 ? "" : "s"} changed
        </span>
        <span className="a">+{addT}</span>
        <span className="d">−{delT}</span>
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
          <FilePane file={sel} />
        </div>
      </div>
    </div>
  );
}
