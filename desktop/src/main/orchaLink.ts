import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** GH #258 plan D3: `~/.local/bin/orcha` → the runtime bundled in the app, so `orcha` works in
 *  Terminal with no Homebrew/pipx. Created on launch when no other `orcha` is installed, and
 *  re-pointed when the app moved (the old link points into another Embodent.app). Anything
 *  else at that path — a developer's own install, a real file — is never touched. */
export type OrchaLinkResult = 'created' | 'refreshed' | 'kept' | 'no-runtime' | 'other-orcha'

export interface OrchaLinkDeps {
  /** `<resources>/orcha-runtime/bin/orcha`, or null outside a packaged app. */
  sidecar: string | null
  home: string
  exists: (p: string) => boolean
  /** The symlink's target, or null when `p` is missing or not a symlink. */
  readLink: (p: string) => string | null
  /** True when `p` exists as a non-symlink (a real file / dir). */
  isRealFile: (p: string) => boolean
  /** An `orcha` on the host-tool PATH other than our link, or null. */
  otherOrcha: () => string | null
  link: (target: string, at: string) => void
  unlink: (p: string) => void
  mkdirp: (dir: string) => void
}

const BUNDLED_SUFFIX = path.join('Contents', 'Resources', 'orcha-runtime', 'bin', 'orcha')

export function ensureOrchaLink(deps: OrchaLinkDeps): OrchaLinkResult {
  if (!deps.sidecar || !deps.exists(deps.sidecar)) return 'no-runtime'
  const at = path.join(deps.home, '.local', 'bin', 'orcha')
  const current = deps.readLink(at)
  if (current === deps.sidecar) return 'kept'
  if (current !== null) {
    // Our own link from an app that moved (or a stale copy) → re-point; any other symlink stays.
    if (!current.endsWith(BUNDLED_SUFFIX)) return 'other-orcha'
    deps.unlink(at)
    deps.link(deps.sidecar, at)
    return 'refreshed'
  }
  if (deps.isRealFile(at)) return 'other-orcha'
  if (deps.otherOrcha()) return 'other-orcha'
  deps.mkdirp(path.dirname(at))
  deps.link(deps.sidecar, at)
  return 'created'
}

/** Production deps over the real filesystem. `whichOther` is the host-tool PATH lookup. */
export function nodeOrchaLinkDeps(resourcesPath: string | null, whichOther: () => string | null): OrchaLinkDeps {
  return {
    sidecar: resourcesPath ? path.join(resourcesPath, 'orcha-runtime', 'bin', 'orcha') : null,
    home: os.homedir(),
    exists: (p) => fs.existsSync(p),
    readLink: (p) => {
      try {
        return fs.readlinkSync(p)
      } catch {
        return null
      }
    },
    isRealFile: (p) => {
      try {
        return !fs.lstatSync(p).isSymbolicLink()
      } catch {
        return false
      }
    },
    otherOrcha: whichOther,
    link: (target, at) => fs.symlinkSync(target, at),
    unlink: (p) => fs.unlinkSync(p),
    mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true })
  }
}
