/** Compose project names as discovery reports them (orcha-<suffix>). */
const PROJECT_RE = /^orcha-[A-Za-z0-9_-]+$/
/** Single leading slash only — no protocol-relative // and no /\ (URL parsers
 *  treat backslash as a segment separator too). Mirrors orcha:openPortal. */
const SAFE_PATH_RE = /^\/(?![/\\])/

/** Parse an orcha:// deep link into a validated portal target.
 *  orcha://open?project=orcha-foo&path=%2Fagents → { project: 'orcha-foo', path: '/agents' }
 *  Unknown hosts, bad projects, or unsafe paths → null / path fallback '/'. */
export function parseDeepLink(url: string): { project: string; path: string } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'orcha:' || parsed.host !== 'open') return null
  const project = parsed.searchParams.get('project')
  if (project === null || !PROJECT_RE.test(project)) return null
  const path = parsed.searchParams.get('path')
  return { project, path: path !== null && SAFE_PATH_RE.test(path) ? path : '/' }
}
