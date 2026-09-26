/**
 * Repo file browser — fetch wrappers over the browse/{tree,file,search}
 * endpoints (CONTRACT, see the module doc in browseTypes.ts). Every call
 * classifies failures through the SAME ghlib.ts error ladder the rest of the
 * GitHub hub uses (not_connected/rate_limited/not_found/error) so RepoBrowser
 * can reuse the page's existing degrade components as-is.
 *
 *   GET /api/containers/{cid}/github/browse/tree?ref=&path=
 *   GET /api/containers/{cid}/github/browse/file?ref=&path=
 *   GET /api/containers/{cid}/github/browse/search?q=&mode=names|contents&ref=
 */
import { classifyDetailError, classifyError, type GhError } from "../ghlib";
import type { BrowseFilePayload, BrowseSearchMode, BrowseSearchPayload, BrowseTreePayload } from "./browseTypes";

export type BrowseResult<T> = { ok: true; data: T } | { ok: false; error: GhError };
type Classifier = (status: number, body: { reason?: string; detail?: string } | null) => GhError;

async function getBrowse<T>(url: string, classify: Classifier): Promise<BrowseResult<T>> {
  try {
    const r = await fetch(url);
    const body = await r.json().catch(() => null);
    if (!r.ok) return { ok: false, error: classify(r.status, body) };
    return { ok: true, data: body as T };
  } catch (e) {
    return { ok: false, error: { kind: "error", status: 0, detail: (e as Error).message } };
  }
}

function browsePrefix(cid: string): string {
  return "/api/containers/" + encodeURIComponent(cid) + "/github/browse";
}

// tree is repo-scoped like issues/pulls: a 404 means "no repo connected"
// (classifyError's reading), not "this particular dir is missing".
export function fetchTree(cid: string, ref: string, path: string): Promise<BrowseResult<BrowseTreePayload>> {
  const q = new URLSearchParams({ ref, path });
  return getBrowse<BrowseTreePayload>(browsePrefix(cid) + "/tree?" + q.toString(), classifyError);
}

// file is path-scoped like a PR/issue detail: a 404 (or reason:"not_found")
// means THIS file/ref doesn't exist, not that the repo is disconnected.
export function fetchFile(cid: string, ref: string, path: string): Promise<BrowseResult<BrowseFilePayload>> {
  const q = new URLSearchParams({ ref, path });
  return getBrowse<BrowseFilePayload>(browsePrefix(cid) + "/file?" + q.toString(), classifyDetailError);
}

export function fetchSearch(
  cid: string,
  ref: string,
  q: string,
  mode: BrowseSearchMode,
): Promise<BrowseResult<BrowseSearchPayload>> {
  const params = new URLSearchParams({ q, mode, ref });
  return getBrowse<BrowseSearchPayload>(browsePrefix(cid) + "/search?" + params.toString(), classifyError);
}
