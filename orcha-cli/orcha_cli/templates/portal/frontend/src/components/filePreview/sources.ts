/**
 * URL builders for the portal's raw-bytes routes (portal_backend/file_raw_routes.py)
 * — the `BlobSource`s each diff host hands FilesChanged, and the code viewer's
 * file URL.
 */
import type { BlobSource, DiffFileRef, DiffSide } from "./BinaryDiff";

const q = (o: Record<string, string>) => new URLSearchParams(o).toString();

/** A file at a ref in the project's bound repo (local or GitHub). */
export function browseRawUrl(cid: string, ref: string, path: string): string {
  return `/api/containers/${encodeURIComponent(cid)}/github/browse/raw?` + q({ ref: ref || "", path });
}

/** One side of a run's changed file: GET /api/agents/{aid}/runs/{rid}/changes/raw. */
export function runRawUrl(aid: string, rid: string, path: string, side: DiffSide): string {
  return `/api/agents/${encodeURIComponent(aid)}/runs/${encodeURIComponent(rid)}/changes/raw?` + q({ path, side });
}

/** A run's diff (live or captured) — null when the run lacks its ids. */
export function runBlobSource(run: { agent_id?: string | null; run_id?: string | null; id?: string | null } | null | undefined): BlobSource | null {
  const aid = run?.agent_id;
  const rid = run?.run_id || run?.id;
  if (!aid || !rid) return null;
  return (f: DiffFileRef, side: DiffSide) => runRawUrl(aid, rid, f.path, side);
}

/** The Code tab's uncommitted change: HEAD (old) vs the working tree (new). */
export function worktreeBlobSource(cid: string): BlobSource {
  return (f: DiffFileRef, side: DiffSide) =>
    `/api/containers/${encodeURIComponent(cid)}/code/worktree/raw?` +
    q({ path: side === "old" ? f.old || f.path : f.path, side: side === "old" ? "head" : "working" });
}

/** Two refs of the bound repo (e.g. a PR's base branch and `pr/<n>`). */
export function refBlobSource(cid: string, oldRef: string | null | undefined, newRef: string | null | undefined): BlobSource {
  return (f: DiffFileRef, side: DiffSide) => {
    const ref = side === "old" ? oldRef : newRef;
    return ref ? browseRawUrl(cid, ref, side === "old" ? f.old || f.path : f.path) : null;
  };
}
