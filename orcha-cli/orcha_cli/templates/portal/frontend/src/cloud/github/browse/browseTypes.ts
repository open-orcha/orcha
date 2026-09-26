/**
 * Repo file browser — wire shapes for the browse/{tree,file,search} endpoints
 * (portal_backend/github_browse_routes.py — built on a parallel branch,
 * CONTRACT frozen here). No DOM, no fetch — pure types + tiny pure helpers so
 * the rest of browse/** stays a thin render layer over deterministic shapes,
 * matching the ghlib.ts convention used by the rest of the GitHub hub.
 */

export type BrowseEntryType = "dir" | "file";

export interface BrowseEntry {
  name: string;
  path: string;
  type: BrowseEntryType;
  size?: number;
}

export interface BrowseTreePayload {
  ref: string;
  path: string;
  entries: BrowseEntry[];
  truncated?: boolean;
}

export interface BrowseFilePayload {
  /** The file's git blob sha at this ref (GitHub-bound reads; absent on older
   *  servers/local reads) — the P4 draft editor's base_hash for REAL propose-time
   *  drift checks instead of the null no-claim fallback. */
  blob_sha?: string | null;
  ref: string;
  path: string;
  content?: string; // OMITTED by the backend when binary:true
  size: number;
  truncated?: boolean;
  binary?: boolean;
  encoding?: string;
}

export type BrowseSearchMode = "names" | "contents";

export interface BrowseNameResult {
  path: string;
  type: BrowseEntryType;
}

export interface BrowseMatchLine {
  line: number;
  text: string;
}

export interface BrowseContentResult {
  path: string;
  matches: BrowseMatchLine[];
}

export interface BrowseSearchPayload {
  results: (BrowseNameResult | BrowseContentResult)[];
  default_branch_only?: boolean;
}

/* ---- path helpers ---------------------------------------------------------
   Pure, tested in browseTypes.test.ts — the tree keys entries by parent dir
   path ("" = repo root) so a lazy-expand only ever asks for one dir's slice. */
export function parentOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? "" : path.slice(0, idx);
}

export function baseName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx < 0 ? path : path.slice(idx + 1);
}

export function extOf(path: string): string {
  const base = baseName(path);
  const idx = base.lastIndexOf(".");
  return idx <= 0 ? "" : base.slice(idx + 1).toLowerCase();
}

export function joinPath(dir: string, name: string): string {
  return dir ? dir + "/" + name : name;
}

// Depth used for tree-row indentation — "" (root) is depth 0.
export function depthOf(path: string): number {
  if (!path) return 0;
  return path.split("/").length;
}
