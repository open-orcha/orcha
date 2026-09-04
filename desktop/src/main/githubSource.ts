import path from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import type { Exec } from './dockerExec'
import { sanitizeName } from './templates'
import type { GhRepo } from '../shared/types'

/** "Add project → From GitHub": listing the host's `gh`-authenticated repos, and picking a
 *  clone destination. Kept pure / exec-injected (mirrors dockerExec's Exec + installers.ts'
 *  style) so it's unit-testable without a real `gh` or `git` on the test machine. The actual
 *  `git clone` invocation lives in index.ts next to the provision engine's progress streaming
 *  (cloning is one more step in the SAME provisioning progress UI, not a separate pipeline). */

/** True iff `gh auth status` exits 0 — i.e. the host's gh CLI is installed AND logged in.
 *  Never assume; always probe. A missing gh binary or a logged-out session both resolve
 *  false (never throws) so callers can fall back to the plain URL field unconditionally. */
export async function ghIsAuthenticated(exec: Exec): Promise<boolean> {
  try {
    await exec('gh', ['auth', 'status'])
    return true
  } catch {
    return false
  }
}

/** `gh auth token` — the host's gh CLI's own OAuth token, when logged in. Used to give a
 *  freshly-provisioned stack's container the same GitHub access the desktop user already
 *  has (parity with the CLI's `orcha up`, which does the same host-side lookup), without
 *  ever asking the user to paste a PAT. null on any failure (gh missing, logged out, no
 *  token) — never throws; callers treat null as "nothing to inject". */
export async function ghAuthToken(exec: Exec): Promise<string | null> {
  try {
    const res = await exec('gh', ['auth', 'token'])
    const token = res.stdout.trim()
    return token || null
  } catch {
    return null
  }
}

/** The user's repos via `gh repo list --json nameWithOwner,description --limit 100`.
 *  Empty array (not a throw) on any failure — the renderer falls back to the URL field. */
export async function ghListRepos(exec: Exec): Promise<GhRepo[]> {
  try {
    const res = await exec('gh', ['repo', 'list', '--json', 'nameWithOwner,description', '--limit', '100'])
    const parsed = JSON.parse(res.stdout) as Array<{ nameWithOwner?: string; description?: string | null }>
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((r): r is { nameWithOwner: string; description?: string | null } => typeof r.nameWithOwner === 'string')
      .map((r) => ({ nameWithOwner: r.nameWithOwner, description: r.description ?? null }))
  } catch {
    return []
  }
}

/** Default parent directory for cloned projects: the directory containing the user's
 *  existing stacks, when one is derivable from discovery (all-or-mostly siblings share a
 *  parent); otherwise ~/orcha-projects. Doesn't create anything — callers mkdirp as needed. */
export function defaultClonesParent(stackFolders: Array<string | null>, home: string): string {
  const parents = stackFolders.filter((f): f is string => !!f).map((f) => path.dirname(f))
  if (parents.length > 0) {
    // Most common parent wins (a machine with stacks spread across folders shouldn't force
    // an outlier); ties break on first-seen for determinism.
    const counts = new Map<string, number>()
    for (const p of parents) counts.set(p, (counts.get(p) ?? 0) + 1)
    let best = parents[0]
    let bestCount = 0
    for (const [p, c] of counts) {
      if (c > bestCount) {
        best = p
        bestCount = c
      }
    }
    return best
  }
  return path.join(home, 'orcha-projects')
}

/** Resolve `<parent>/<repoName>`, refusing a non-empty existing destination (mirrors
 *  folderModes.createBlankFolder's guard) rather than letting `git clone` fail obscurely —
 *  `git clone` itself refuses to clone into a non-empty directory, but its error is a raw
 *  git message; this surfaces the same refusal as a typed, catchable error up front. */
export function resolveCloneDest(parent: string, repoName: string): string {
  const name = sanitizeName(repoName)
  const dest = path.join(parent, name)
  if (existsSync(dest) && readdirSync(dest).length > 0) {
    throw { code: 'DEST_NOT_EMPTY' } as const
  }
  return dest
}
