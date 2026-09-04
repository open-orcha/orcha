/**
 * GitHub-bound Code Space editing (Phase 4) — fetch wrappers over the
 * code/github/{editable,propose} CONTRACT (built in parallel; frozen here):
 *
 *   GET  /api/containers/{cid}/code/github/editable
 *        -> {available: boolean, reason?: string}
 *        (also {available:false, reason:"local_source"} on a local-binding
 *        container, mirroring worktreeApi.ts's honest-degrade convention —
 *        callers never need to special-case that reason string, just the
 *        boolean.)
 *
 *   POST /api/containers/{cid}/code/github/propose
 *        body {base_ref, message, files:[{path, content, base_hash|null}]}
 *        -> {available:true, ok:true, pr_number, pr_url, branch, commit_sha}
 *         | {ok:false, reason:"drift"|"exists", paths:[...]}
 *         | {ok:false, reason:"github_error", detail}
 *
 * Same fetch-wrapper idiom as worktreeApi.ts (getJson/sendJson) — no shared
 * import between the two files since each is self-contained per that file's
 * own convention, and this is a handful of lines either way.
 */

export interface GithubEditableFile {
  path: string;
  content: string;
  base_hash: string | null;
}

export interface ProposeChangesBody {
  base_ref: string;
  message: string;
  files: GithubEditableFile[];
}

export type ProposeChangesResult =
  | { available?: true; ok: true; pr_number: number; pr_url: string; branch: string; commit_sha: string }
  | { ok: false; reason: "drift" | "exists"; paths: string[] }
  | { ok: false; reason: "github_error"; detail?: string };

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  return (await r.json()) as T;
}

async function sendJson<T>(url: string, method: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await r.json()) as T;
}

// Any transport failure (offline, 5xx with a non-JSON body, etc.) degrades to
// available:false rather than throwing — callers treat this exactly like a
// local-binding container: the pencil just doesn't show up.
export async function fetchGithubEditable(cid: string): Promise<boolean> {
  try {
    const data = await getJson<{ available?: boolean }>(
      "/api/containers/" + encodeURIComponent(cid) + "/code/github/editable",
    );
    return !!data.available;
  } catch {
    return false;
  }
}

export function proposeChanges(cid: string, body: ProposeChangesBody): Promise<ProposeChangesResult> {
  return sendJson<ProposeChangesResult>(
    "/api/containers/" + encodeURIComponent(cid) + "/code/github/propose",
    "POST",
    body,
  );
}
