/** Validate + parse a git repository URL for the "Add project → From GitHub" flow.
 *  Shared between main (defense-in-depth before shelling out to `git clone`) and the
 *  renderer (instant inline feedback on the URL field) — pure, no I/O, easy to unit test.
 *
 *  Deliberately narrow: https:// only. We reject git@/ssh:// (no key-forwarding UI to
 *  reason about) and plain http:// (credentials would go over the wire in clear text).
 *  Private repos still work over https — the host's git credential helper / `gh` auth
 *  handles the prompt; Orcha never sees or stores a token. */

const ALLOWED_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org'])

export interface RepoUrlOk {
  ok: true
  /** Normalized URL (trailing .git kept as-is; that's what `git clone` expects). */
  url: string
  host: string
  /** Last path segment, .git stripped, sanitized — used as the default destination dir name. */
  repoName: string
}
export interface RepoUrlErr {
  ok: false
  reason: string
}

/** Mirror of the CLI's sanitize_name (folderModes/templates), duplicated here to keep
 *  this module dependency-free and usable from the renderer without a main-process import. */
function sanitizeSegment(s: string): string {
  const lowered = s.toLowerCase()
  let out = ''
  for (const c of lowered) out += /[a-z0-9\-_]/.test(c) ? c : '-'
  return out.replace(/^-+|-+$/g, '') || 'repo'
}

export function validateRepoUrl(raw: string): RepoUrlOk | RepoUrlErr {
  const input = raw.trim()
  if (!input) return { ok: false, reason: 'Enter a repository URL.' }

  // Reject scp-style ssh (git@host:owner/repo.git) before URL parsing — the URL parser
  // would otherwise happily treat "git@github.com:owner/repo.git" as an opaque non-URL.
  if (/^[\w.-]+@[\w.-]+:/.test(input)) {
    return { ok: false, reason: 'Use an https:// URL (SSH URLs aren’t supported).' }
  }

  let parsed: URL
  try {
    parsed = new URL(input)
  } catch {
    return { ok: false, reason: 'That doesn’t look like a valid URL.' }
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, reason: 'Use an https:// URL (SSH and http:// aren’t supported).' }
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'Don’t include credentials in the URL.' }
  }
  const host = parsed.hostname.toLowerCase()
  if (!ALLOWED_HOSTS.has(host)) {
    return { ok: false, reason: `Unsupported host “${host}”. Use GitHub, GitLab, or Bitbucket.` }
  }
  const segments = parsed.pathname.split('/').filter(Boolean)
  if (segments.length < 2) {
    return { ok: false, reason: 'That URL doesn’t point at a repository (expected /owner/repo).' }
  }
  const last = segments[segments.length - 1].replace(/\.git$/i, '')
  if (!last) return { ok: false, reason: 'That URL doesn’t point at a repository (expected /owner/repo).' }

  return { ok: true, url: input, host, repoName: sanitizeSegment(last) }
}
