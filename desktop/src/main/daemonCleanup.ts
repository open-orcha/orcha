import { execFile } from 'node:child_process'

/** Belt-and-braces cleanup for the two host daemons a project's `.claude/` can leave
 *  behind: the orcha notifier (wake daemon) and the terminal bridge. `orcha down -v`
 *  already stops both via their OWN cwd-scoped pidfiles (see notifier.stop_daemon /
 *  terminal_bridge.stop_bridge) — this module is the safety net for when that CLI step
 *  didn't run (orcha missing) or didn't fully clean up (pidfile already gone/stale but
 *  the process itself survives under some other claim). It never trusts a pidfile; it
 *  matches live process argv/cwd instead, so it can only ever act on a process it can
 *  positively identify as belonging to THIS project. */

export interface ProcessCandidate {
  pid: number
  /** Full command line as `ps`/`pgrep -f` would report it (argv joined with spaces). */
  command: string
}

/** Pure: does this candidate's command line look like an orcha notifier daemon bound to
 *  `containerId`? The notifier's argv carries `--container <cid>` verbatim (see
 *  notifier_resident_spawn's spawn argv) — so this is a straight substring/regex match,
 *  no guessing. A notifier for a DIFFERENT container (or one with no --container token
 *  at all) never matches, however similar its other argv looks. */
export function matchesNotifier(candidate: ProcessCandidate, containerId: string): boolean {
  if (!containerId) return false
  if (!/(^|\/)orcha(\s|$)/.test(candidate.command) && !candidate.command.includes('orcha_cli')) return false
  if (!/\bnotifier\b/.test(candidate.command)) return false
  const cidPattern = new RegExp(`--container[= ]${escapeRegExp(containerId)}\\b`)
  return cidPattern.test(candidate.command)
}

/** Pure: does this candidate's command line look like a terminal-bridge process at all
 *  (the bridge carries no --container argv, so command shape is as far as argv alone can
 *  narrow it — the caller must additionally confirm the pid's cwd is this project's
 *  folder before treating it as a match; see matchesBridgeCwd). */
export function looksLikeBridgeCommand(candidate: ProcessCandidate): boolean {
  if (!/(^|\/)orcha(\s|$)/.test(candidate.command) && !candidate.command.includes('orcha_cli')) return false
  return /\bterminal-bridge\b/.test(candidate.command)
}

/** Pure: does a bridge candidate belong to `folder`? `cwd` is whatever the caller
 *  resolved for that pid (e.g. via `lsof -a -p <pid> -d cwd`); null/empty means
 *  "couldn't determine" and must never match (defensive default — an unknown cwd is
 *  never treated as "this project's"). Exact-equality only: a bridge running in a
 *  PARENT or CHILD directory of `folder` is a different project and must not match. */
export function matchesBridgeCwd(cwd: string | null, folder: string): boolean {
  if (!cwd || !folder) return false
  return normalizeDir(cwd) === normalizeDir(folder)
}

function normalizeDir(p: string): string {
  return p.replace(/\/+$/, '')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Injectable process-inspection surface (real implementation shells out to pgrep/lsof;
 *  tests supply canned candidates so the matching logic above can be exercised without a
 *  real process table). */
export interface ProcessDeps {
  /** List live processes whose command line matches `pattern` (like `pgrep -fl <pattern>`).
   *  Best-effort: an empty array on any failure (pgrep absent, no matches, etc). */
  findByCommand: (pattern: string) => Promise<ProcessCandidate[]>
  /** Resolve a live pid's current working directory, or null if it can't be determined
   *  (process exited, `lsof` absent/failed, permission denied). */
  cwdOf: (pid: number) => Promise<string | null>
  /** Send SIGTERM to a pid. Best-effort — swallow ESRCH/EPERM; never throws. */
  kill: (pid: number) => void
}

/** Best-effort: SIGTERM any live `orcha notifier` process bound to `containerId`, and any
 *  live `orcha terminal-bridge` process whose cwd is `folder`. Never throws — a failure at
 *  any step (pgrep missing, lsof missing, permission denied) just means that daemon is left
 *  alone rather than the reset failing. Matching is defensive by construction (see the pure
 *  functions above): a process is only ever killed when it's been positively identified as
 *  belonging to THIS project, never guessed at. */
export async function killLingeringDaemons(
  folder: string | null,
  containerId: string | null,
  deps: ProcessDeps
): Promise<void> {
  try {
    if (containerId) {
      const notifierCandidates = await deps.findByCommand('orcha notifier').catch(() => [])
      for (const c of notifierCandidates) {
        if (matchesNotifier(c, containerId)) deps.kill(c.pid)
      }
    }
  } catch {
    // best-effort — never let daemon cleanup fail the reset
  }

  try {
    if (folder) {
      const bridgeCandidates = await deps.findByCommand('orcha terminal-bridge').catch(() => [])
      for (const c of bridgeCandidates) {
        if (!looksLikeBridgeCommand(c)) continue
        const cwd = await deps.cwdOf(c.pid).catch(() => null)
        if (matchesBridgeCwd(cwd, folder)) deps.kill(c.pid)
      }
    }
  } catch {
    // best-effort — never let daemon cleanup fail the reset
  }
}

/** Production ProcessDeps: `pgrep -fl <pattern>` to enumerate candidates (macOS/BSD pgrep
 *  supports -fl: match against the full argv, list pid + command), `lsof -a -p <pid> -d cwd`
 *  to resolve a single pid's cwd (bounded — only ever called for pids `findByCommand` already
 *  narrowed down, never scanned across the whole process table), `kill -TERM` best-effort. */
export const nodeProcessDeps: ProcessDeps = {
  findByCommand: (pattern) =>
    new Promise((resolve) => {
      execFile('pgrep', ['-fl', pattern], { encoding: 'utf8' }, (err, stdout) => {
        if (err || !stdout) return resolve([])
        const candidates = stdout
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const m = line.match(/^(\d+)\s+(.*)$/)
            return m ? { pid: Number(m[1]), command: m[2] } : null
          })
          .filter((c): c is ProcessCandidate => c !== null)
        resolve(candidates)
      })
    }),
  cwdOf: (pid) =>
    new Promise((resolve) => {
      // -a ANDs the -p/-d selectors; -Fn emits just the field-n (name) line for cwd, one per fd.
      execFile('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' }, (err, stdout) => {
        if (err || !stdout) return resolve(null)
        const nameLine = stdout.split('\n').find((l) => l.startsWith('n'))
        resolve(nameLine ? nameLine.slice(1).trim() || null : null)
      })
    }),
  kill: (pid) => {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already gone / not killable — nothing to do
    }
  }
}
