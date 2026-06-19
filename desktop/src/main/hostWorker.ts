import { execFile, execFileSync } from 'node:child_process'
import os from 'node:os'
import { dockerPath } from './dockerExec'

/** What actually runs an agent is a host-side `claude -p` process spawned by the orcha
 *  CLI's notifier daemon (`orcha up`). The Docker stack only runs the portal + db, so
 *  without this the portal opens but assigned tasks never get a worker. This module
 *  starts that worker, best-effort, and reports missing prerequisites in plain English. */

const STDERR_TAIL = 400

/** PATH for locating the host CLIs (`orcha`, `claude`) AND the tools they in turn need
 *  (`node` for Claude Code, `git`, `npm`). Extends the Finder-safe docker PATH with the
 *  user's real login-shell PATH (`loginPath`) plus the usual brew / npm-global / pipx /
 *  Claude-Code locations as a fallback. A Finder-launched .app inherits a minimal PATH
 *  that omits all of these — and crucially, the `orcha up` we spawn passes THIS PATH to
 *  the notifier daemon, which freezes it for every agent worker it later spawns. If a
 *  worker can't find `claude`/`node` it dies silently ("no reaction at all"), so the
 *  login-shell PATH (where the user actually installed those tools) is what makes
 *  app-launched runs behave like a Terminal `orcha up`. Pure + testable. */
export function hostToolPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
  loginPath: string | null = null
): string {
  const extra = [
    `${home}/.local/bin`, // pipx (orcha), uv tools
    `${home}/.claude/local`, // Claude Code native installer
    `${home}/.npm-global/bin`, // npm global prefix override
    '/opt/homebrew/bin', // already in dockerPath, but harmless to re-list
    '/usr/local/bin'
  ]
  const login = loginPath ? loginPath.split(':') : []
  const base = dockerPath(env, home).split(':')
  // login-shell dirs first: a user who runs nvm/volta/asdf has node (and the npm-global
  // claude) under a versioned home dir none of the hardcoded fallbacks above can guess.
  return [...login, ...base, ...extra].filter((p, i, a) => p && a.indexOf(p) === i).join(':')
}

/** Impure: ask the user's LOGIN shell for the PATH a Terminal would have, so app-launched
 *  `orcha up` inherits the same tool locations (nvm/volta/asdf/custom) the user installed
 *  into. Best-effort — returns null on any failure (no shell, timeout, weird output) and
 *  the caller degrades to the hardcoded fallback list. `-ilc` runs the interactive+login
 *  rc files where PATH is actually exported; `printf %s` keeps the output free of newlines. */
export function loginShellPath(): string | null {
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const out = execFileSync(shell, ['-ilc', 'printf %s "$PATH"'], {
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const trimmed = out.trim()
    return trimmed && trimmed.includes('/') ? trimmed : null
  } catch {
    return null
  }
}

export interface WorkerProbe {
  orchaFound: boolean
  claudeFound: boolean
  /** stderr from `orcha up` when it ran and failed; undefined if it wasn't run or succeeded. */
  upError?: string
}

/** Pure: turn a probe into the {started, reason} the engine consumes. Kept separate from
 *  the exec so the (plain-language) messaging is unit-testable without spawning processes. */
export function workerStartResult(probe: WorkerProbe): { started: boolean; reason?: string } {
  if (!probe.orchaFound) {
    return {
      started: false,
      reason:
        'Your project is set up and the portal is open, but agents won’t run yet: the Orcha ' +
        'helper that launches them isn’t installed on this Mac. Once it’s installed, assigning ' +
        'a task will start the agent automatically.'
    }
  }
  if (probe.upError) {
    return {
      started: false,
      reason: `Couldn’t start the agent worker automatically: ${probe.upError.slice(-STDERR_TAIL).trim()}`
    }
  }
  if (!probe.claudeFound) {
    return {
      started: true,
      reason:
        'The agent worker is running, but Claude Code isn’t installed on this Mac yet — agents ' +
        'need it (plus an Anthropic API key) to actually do work. Install Claude Code and the ' +
        'next assigned task will run.'
    }
  }
  return { started: true }
}

/** Injectable surface for testing startHostWorker without touching the real machine. */
export interface HostWorkerDeps {
  /** Resolve a command to an absolute path, or null if not on PATH (like `which`). */
  which: (cmd: string, pathEnv: string) => Promise<string | null>
  /** Run `orcha up` in `folder`; resolve on success, reject with {stderr} on failure. */
  orchaUp: (folder: string, pathEnv: string) => Promise<void>
  pathEnv?: string
}

/** Start the host agent worker for a freshly-provisioned project. Never throws. */
export async function startHostWorker(folder: string, deps: HostWorkerDeps): Promise<{ started: boolean; reason?: string }> {
  const pathEnv = deps.pathEnv ?? hostToolPath()
  const orcha = await deps.which('orcha', pathEnv).catch(() => null)
  if (!orcha) return workerStartResult({ orchaFound: false, claudeFound: false })
  let upError: string | undefined
  try {
    await deps.orchaUp(folder, pathEnv)
  } catch (err) {
    upError = String((err as { stderr?: string }).stderr ?? (err as Error).message ?? err)
  }
  const claude = await deps.which('claude', pathEnv).catch(() => null)
  return workerStartResult({ orchaFound: true, claudeFound: !!claude, upError })
}

/** Production deps: real `which` + `orcha up` via execFile, with the host-tool PATH that
 *  includes the user's login-shell PATH. Resolved lazily (getter) so importing this module
 *  — e.g. in unit tests — never spawns a login shell; it runs once, when we actually start
 *  a worker. The notifier daemon `orcha up` launches inherits this PATH for its workers. */
export const nodeHostWorkerDeps: HostWorkerDeps = {
  get pathEnv() {
    return hostToolPath(process.env, os.homedir(), loginShellPath())
  },
  which: (cmd, pathEnv) =>
    new Promise((resolve) => {
      execFile('/usr/bin/which', [cmd], { env: { ...process.env, PATH: pathEnv } }, (err, stdout) =>
        resolve(err ? null : stdout.trim() || null)
      )
    }),
  orchaUp: (folder, pathEnv) =>
    new Promise((resolve, reject) => {
      execFile(
        'orcha',
        ['up'],
        { cwd: folder, env: { ...process.env, PATH: pathEnv }, encoding: 'utf8' },
        (err, _stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve())
      )
    })
}
