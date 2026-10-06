/**
 * Working-tree changes + file history + the editor's read/write/commit/push
 * surface — fetch wrappers over code_workingtree_routes.py's CONTRACT
 * (docs/orcha-cloud-local-run.md addendum, agentic-era IDE features).
 * Local-binding only; every route degrades honestly to
 * {available:false, reason:"github_source"} on a GitHub-bound container —
 * callers render that as "hidden" (History, the Edit toggle) or a
 * disabled-state card (Changes tab), never an error.
 *
 *   GET  /api/containers/{cid}/code/worktree/changes
 *   GET  /api/containers/{cid}/code/worktree/diff?path=
 *   GET  /api/containers/{cid}/code/file/history?path=&ref=&n=
 *   GET  /api/containers/{cid}/code/worktree/file?path=
 *   PUT  /api/containers/{cid}/code/worktree/file
 *   POST /api/containers/{cid}/code/worktree/commit
 *   POST /api/containers/{cid}/code/worktree/push
 *   GET  /api/containers/{cid}/code/worktree/branch
 */
export type WorktreeFileStatus = "M" | "A" | "D" | "R" | "??";

export interface WorktreeChangedFile {
  path: string;
  status: WorktreeFileStatus;
  additions: number | null;
  deletions: number | null;
  orig_path?: string | null;
  /** set by servers that flag binary files explicitly */
  binary?: boolean;
}

export interface WorktreeChangesSummary {
  files: number;
  additions: number;
  deletions: number;
}

export interface WorktreeChangesPayload {
  available: boolean;
  /** First-scan-in-progress (total cache miss server-side): the scan runs in a
   *  background thread and this payload carries no rows yet — fast-poll until
   *  it clears rather than treating the empty list as "clean tree". */
  scanning?: boolean;
  reason?: string;
  detail?: string;
  dirty?: boolean;
  files?: WorktreeChangedFile[];
  summary?: WorktreeChangesSummary;
}

export interface WorktreeDiffPayload {
  available: boolean;
  reason?: string;
  detail?: string;
  path?: string;
  diff?: string;
  binary?: boolean;
  truncated?: boolean;
}

export interface FileHistoryCommit {
  sha: string;
  short: string;
  summary: string;
  author: string;
  committed_at: string;
}

export interface FileHistoryPayload {
  available: boolean;
  reason?: string;
  detail?: string;
  path?: string;
  commits?: FileHistoryCommit[];
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  return (await r.json()) as T;
}

/** A write that failed at the HTTP layer (403/404/500, a proxy's non-JSON
 *  502, or the network itself) — distinct from the route's own honest
 *  {ok:false, reason:"nothing_committed" | "drift" | …} payloads, which only
 *  ever come back as 200s. `status` is 0 for a network failure. */
export interface HttpFailure {
  ok: false;
  reason: "http";
  status: number;
  detail: string;
}

/** FastAPI error bodies are {detail: string | [{msg}]}; anything else (an
 *  HTML 502 page, an empty body) falls back to the status line. */
function errorDetail(body: unknown, status: number, statusText: string): string {
  const d = (body as { detail?: unknown } | null)?.detail;
  if (typeof d === "string" && d.trim()) return d.trim();
  if (Array.isArray(d)) {
    const msgs = d.map((x) => (x && typeof x === "object" && "msg" in x ? String((x as { msg: unknown }).msg) : "")).filter(Boolean);
    if (msgs.length) return msgs.join("; ");
  }
  return ("HTTP " + status + (statusText ? " " + statusText : "")).trim();
}

/** Never rejects: a non-ok response or a non-JSON body resolves to an
 *  HttpFailure so callers can always clear their busy state and say what
 *  went wrong (screen review r3: a 403/500 commit used to read as
 *  "Nothing to commit", and a non-JSON 502 left the button stuck). */
async function sendJson<T>(url: string, method: string, body: unknown): Promise<T | HttpFailure> {
  let r: Response;
  try {
    r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, reason: "http", status: 0, detail: e instanceof Error && e.message ? e.message : "Network error" };
  }
  let parsed: unknown = null;
  let parsedOk = false;
  try {
    parsed = await r.json();
    parsedOk = true;
  } catch {
    parsedOk = false;
  }
  if (!r.ok || !parsedOk || parsed == null || typeof parsed !== "object") {
    return { ok: false, reason: "http", status: r.status, detail: errorDetail(parsed, r.status, r.statusText) };
  }
  return parsed as T;
}

/* ---- editor read/write ----------------------------------------------------
 * The worktree file endpoint is ALWAYS fresh (never sha-cached, unlike the
 * ref-pinned blob reads blobCache.ts covers) — it's reading/writing the live
 * working tree, which an agent can change out from under the editor at any
 * moment; that's exactly what the drift contract exists to catch. */
export interface WorktreeFilePayload {
  available: boolean;
  reason?: string;
  detail?: string;
  path?: string;
  content?: string;
  binary?: boolean;
  truncated?: boolean;
  content_hash?: string;
  exists?: boolean;
}

export function fetchWorktreeFile(cid: string, path: string): Promise<WorktreeFilePayload> {
  const q = new URLSearchParams({ path });
  return getJson<WorktreeFilePayload>(
    "/api/containers/" + encodeURIComponent(cid) + "/code/worktree/file?" + q.toString(),
  );
}

export type SaveFileResult =
  | { ok: true; content_hash: string }
  | { ok: false; reason: "drift" | "exists" | "too_large" | "write_failed"; current_hash?: string }
  | HttpFailure;

export function saveWorktreeFile(
  cid: string,
  path: string,
  content: string,
  baseHash: string | null,
): Promise<SaveFileResult> {
  return sendJson<SaveFileResult>(
    "/api/containers/" + encodeURIComponent(cid) + "/code/worktree/file",
    "PUT",
    { path, content, base_hash: baseHash },
  );
}

/* ---- commit / push --------------------------------------------------------- */
export type CommitResult =
  | { ok: true; sha: string; short: string }
  | { ok: false; reason: "nothing_committed" }
  | HttpFailure;

export function commitWorktree(
  cid: string,
  paths: string[],
  message: string,
  opts: { author_name?: string; author_email?: string } = {},
): Promise<CommitResult> {
  return sendJson<CommitResult>(
    "/api/containers/" + encodeURIComponent(cid) + "/code/worktree/commit",
    "POST",
    { paths, message, ...opts },
  );
}

export interface PushResult {
  ok: boolean;
  detail?: string;
}

export async function pushWorktree(cid: string): Promise<PushResult> {
  const res = await sendJson<PushResult>("/api/containers/" + encodeURIComponent(cid) + "/code/worktree/push", "POST", {});
  if ("reason" in res && res.reason === "http") return { ok: false, detail: "Couldn't push: " + res.detail };
  return res as PushResult;
}

export interface WorktreeBranchPayload {
  available: boolean;
  reason?: string;
  detail?: string;
  branch?: string;
  sha?: string;
  ahead?: number;
  behind?: number;
  remote?: string;
}

export function fetchWorktreeBranch(cid: string): Promise<WorktreeBranchPayload> {
  return getJson<WorktreeBranchPayload>("/api/containers/" + encodeURIComponent(cid) + "/code/worktree/branch");
}

export function fetchWorktreeChanges(cid: string): Promise<WorktreeChangesPayload> {
  return getJson<WorktreeChangesPayload>(
    "/api/containers/" + encodeURIComponent(cid) + "/code/worktree/changes",
  );
}

export function fetchWorktreeDiff(cid: string, path: string): Promise<WorktreeDiffPayload> {
  const q = new URLSearchParams({ path });
  return getJson<WorktreeDiffPayload>(
    "/api/containers/" + encodeURIComponent(cid) + "/code/worktree/diff?" + q.toString(),
  );
}

export function fetchFileHistory(
  cid: string,
  path: string,
  opts: { ref?: string; n?: number } = {},
): Promise<FileHistoryPayload> {
  const q = new URLSearchParams({ path });
  if (opts.ref) q.set("ref", opts.ref);
  if (opts.n != null) q.set("n", String(opts.n));
  return getJson<FileHistoryPayload>(
    "/api/containers/" + encodeURIComponent(cid) + "/code/file/history?" + q.toString(),
  );
}

/** The CHEAP mount-time probe — binding + git presence only, no `git status`
 *  (GET .../code/worktree/available). The page's edit/History gating used to
 *  probe /worktree/changes for this yes/no, which runs a full status + per-file
 *  untracked numstat: seconds on a large repo over a Docker-for-Mac bind mount. */
export async function fetchWorktreeAvailable(cid: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/containers/${encodeURIComponent(cid)}/code/worktree/available`);
    if (!res.ok) return false;
    const data = (await res.json()) as { available?: boolean };
    return !!data.available;
  } catch {
    return false;
  }
}
