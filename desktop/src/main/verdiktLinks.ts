// Verdikt hand-off links in the embedded portal. They are SAME-ORIGIN portal routes that
// 302 to Verdikt's own site (or to a task's running preview), so the generic "same origin
// stays in the view" rule used to follow the redirect and load Verdikt INSIDE Embodent.
// Route them out instead:
//   - "Open in Verdikt" / "Open Verdikt" → launch the installed Verdikt app (it has no URL
//     scheme, so it can't deep-link; launching brings its window forward), else the default
//     browser, which follows the portal's redirect to the exact run/project page;
//   - the run report and the branch preview → the default browser (an exact page the app
//     can't open).
import { execFile } from 'node:child_process'

export const VERDIKT_BUNDLE_ID = 'com.verdikt.app'

export type VerdiktLinkKind = 'open' | 'report' | 'preview'

const ROUTES: Array<[RegExp, VerdiktLinkKind]> = [
  [/^\/api\/tasks\/[^/]+\/verdikt\/open$/, 'open'],
  [/^\/api\/containers\/[^/]+\/verdikt\/open$/, 'open'],
  [/^\/api\/tasks\/[^/]+\/verdikt\/runs\/[^/]+\/report$/, 'report'],
  [/^\/api\/tasks\/[^/]+\/verdikt\/runs\/[^/]+\/preview$/, 'preview']
]

/** Which Verdikt hand-off a portal URL is, or null for anything else. Only URLs on the
 *  stack's own portal origin count (the routes are the portal's). */
export function classifyVerdiktLink(url: string, portalOrigin: string): VerdiktLinkKind | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.origin !== portalOrigin) return null
  for (const [re, kind] of ROUTES) if (re.test(u.pathname)) return kind
  return null
}

export interface VerdiktLinkDeps {
  openExternal(url: string): Promise<void>
  /** Launch an app by bundle id; resolves true when it launched (i.e. it is installed). */
  launchApp(bundleId: string): Promise<boolean>
  platform: NodeJS.Platform
}

/** Launch via macOS `open -b`: exits non-zero when no app has that bundle id. */
export function launchMacApp(bundleId: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('open', ['-b', bundleId], (err) => resolve(!err))
  })
}

/** Handle a Verdikt hand-off link; returns how it was opened. */
export async function openVerdiktLink(kind: VerdiktLinkKind, url: string, deps: VerdiktLinkDeps): Promise<'app' | 'browser'> {
  if (kind === 'open' && deps.platform === 'darwin' && (await deps.launchApp(VERDIKT_BUNDLE_ID))) return 'app'
  await deps.openExternal(url)
  return 'browser'
}
