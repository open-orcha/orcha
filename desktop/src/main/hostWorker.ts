import { execFile } from 'node:child_process'
import os from 'node:os'
import { dockerPath } from './dockerExec'

/** What actually runs an agent is a host-side `claude -p` process spawned by the orcha
 *  CLI's notifier daemon (`orcha up`). The Docker stack only runs the portal + db, so
 *  without this the portal opens but assigned tasks never get a worker. This module
 *  starts that worker, best-effort, and reports missing prerequisites in plain English. */

const STDERR_TAIL = 400

/** PATH for locating the host CLIs (`orcha`, `claude`). Extends the Finder-safe docker
 *  PATH with the usual brew / npm-global / pipx / Claude-Code install locations, since a
 *  Finder-launched .app inherits a minimal PATH that omits all of them. Pure + testable. */
export function hostToolPath(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const extra = [
    `${home}/.local/bin`, // pipx (orcha), uv tools
    `${home}/.claude/local`, // Claude Code native installer
    `${home}/.npm-global/bin`, // npm global prefix override
    '/opt/homebrew/bin', // already in dockerPath, but harmless to re-list
    '/usr/local/bin'
  ]
  const base = dockerPath(env, home).split(':')
  return [...base, ...extra].filter((p, i, a) => p && a.indexOf(p) === i).join(':')
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

/** Production deps: real `which` + `orcha up` via execFile, with the host-tool PATH. */
export const nodeHostWorkerDeps: HostWorkerDeps = {
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
