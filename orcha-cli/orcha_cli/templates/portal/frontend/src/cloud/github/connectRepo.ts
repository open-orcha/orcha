/**
 * Connect-repo — shared wire types + helpers for the local-or-GitHub code
 * source picker (Orcha Cloud local run, Addendum 2:
 * docs/orcha-cloud-local-run.md "code source: local or GitHub").
 *
 * Endpoint contract (backend built in parallel on the same frozen doc —
 * every helper here degrades gracefully when a field/route isn't live yet):
 *   GET /api/github/repos
 *     -> {available, source?: "pat"|"app", repos: [...]}
 *     A LOCAL entry may be PREPENDED to `repos`:
 *       {full_name: "local", name: "<dirname>", source_kind: "local"}
 *   PUT /api/containers/{cid}/github  {"repo": "local" | "owner/name" | null}
 *   GET /api/containers/{cid}/github  -> {"repo": "local" | "owner/name" | null}
 *
 * The sentinel is the literal string "local" — never treat it as an
 * owner/name pair (no "/" in it, so github.com/<owner>/<name> links must
 * never be built from it; see repoDisplay()/isLocalRepo() below).
 */

export const LOCAL_REPO_SENTINEL = "local";

/** true for both the binding value ("local") and a repo-list entry's full_name. */
export function isLocalRepo(repo: string | null | undefined): boolean {
  return repo === LOCAL_REPO_SENTINEL;
}

export interface GhRepoEntry {
  full_name?: string | null;
  private?: boolean;
  description?: string | null;
  html_url?: string | null;
  // Present only on the prepended local entry (source_kind: "local"); a
  // plain GitHub row from the App/PAT listing omits this field entirely.
  name?: string | null;
  source_kind?: "local" | null;
}

export interface GhReposPayload {
  available?: boolean;
  source?: "pat" | "app" | null;
  repos?: GhRepoEntry[];
  detail?: string | null;
}

/** Split the raw /api/github/repos payload into its two picker sections. */
export function splitRepoEntries(repos: GhRepoEntry[] | undefined | null): {
  local: GhRepoEntry | null;
  github: GhRepoEntry[];
} {
  const list = repos || [];
  const local = list.find((r) => r.source_kind === "local" || r.full_name === LOCAL_REPO_SENTINEL) || null;
  const github = list.filter((r) => r !== local && r.full_name !== LOCAL_REPO_SENTINEL);
  return { local, github };
}

/** Display label for a bound repo string: the local dirname when known and
 * bound local, else the raw owner/name (or a neutral fallback). Never builds
 * a github.com link for the "local" sentinel — callers needing a link must
 * check isLocalRepo() first. */
export function repoDisplayName(repo: string | null | undefined, localDirName?: string | null): string {
  if (isLocalRepo(repo)) return localDirName || "This machine";
  return repo || "";
}

export async function fetchGithubRepos(cid: string | null): Promise<GhReposPayload> {
  const url = cid ? "/api/github/repos?cid=" + encodeURIComponent(cid) : "/api/github/repos";
  try {
    const r = await fetch(url);
    if (!r.ok) return { available: false, repos: [] };
    const body = (await r.json().catch(() => null)) as GhReposPayload | null;
    return body || { available: false, repos: [] };
  } catch {
    return { available: false, repos: [] };
  }
}

export interface PutBindingResult {
  ok: boolean;
  status: number;
  detail?: string | null;
}

export async function putRepoBinding(cid: string, repo: string | null): Promise<PutBindingResult> {
  try {
    const r = await fetch("/api/containers/" + encodeURIComponent(cid) + "/github", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo }),
    });
    let detail: string | null = null;
    try {
      const body = await r.json();
      detail = (body && body.detail) || null;
    } catch { /* empty body */ }
    return { ok: r.ok, status: r.status, detail };
  } catch (e) {
    return { ok: false, status: 0, detail: e instanceof Error ? e.message : String(e) };
  }
}
