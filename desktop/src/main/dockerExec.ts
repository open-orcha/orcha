import { execFile, type ChildProcess } from 'node:child_process'
import os from 'node:os'

export interface ExecResult {
  stdout: string
}
/** `extraEnv` merges (overrides) on top of the process env the exec already builds — used
 *  to pass a deliberate, unpersisted value (e.g. ORCHA_GITHUB_PAT for one compose-up call)
 *  without writing it to any file or the shell's real environment. */
export type Exec = (cmd: string, args: string[], extraEnv?: NodeJS.ProcessEnv) => Promise<ExecResult>

/** macOS apps launched from Finder (LaunchServices) inherit a minimal PATH that
 *  omits where Docker installs its CLI, so a bare `docker` call fails with ENOENT
 *  and looks like "Docker isn't running". Prepend the common install locations so
 *  `docker` resolves the same way it does in a login shell. */
export function dockerPath(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const candidates = [
    '/opt/homebrew/bin', // Apple Silicon Homebrew (docker CLI, colima)
    '/usr/local/bin', // Intel Homebrew + Docker Desktop symlink
    '/Applications/Docker.app/Contents/Resources/bin', // Docker Desktop
    `${home}/.orbstack/bin`, // OrbStack
    `${home}/.docker/bin` // Docker Desktop user bin
  ]
  const existing = env.PATH ? env.PATH.split(':') : []
  return [...candidates, ...existing].filter((p, i, a) => p && a.indexOf(p) === i).join(':')
}

/** Default ceiling for quick, read-only docker probes (`docker ps`, `docker info`). A hung
 *  Docker CLI (daemon wedged mid-start) otherwise never settles, which left the manager
 *  blank forever (desktop audit, BLOCKER). Long-running calls (compose up/down, clones) must
 *  NOT use this — they go through the un-timed `dockerExec`. */
export const DOCKER_PROBE_TIMEOUT_MS = 8000

/** In-flight timed probes, so quitting the app never orphans a wedged `docker ps`. */
const pendingProbes = new Set<ChildProcess>()

/** Kill every in-flight timed probe (call on app quit). */
export function killPendingProbes(): void {
  for (const child of pendingProbes) {
    try {
      child.kill('SIGKILL')
    } catch {
      // already gone
    }
  }
  pendingProbes.clear()
}

function run(cmd: string, args: string[], extraEnv: NodeJS.ProcessEnv | undefined, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: dockerPath(), ...extraEnv },
        // 0 = no timeout. On expiry node kills the child (SIGKILL: a wedged docker CLI can
        // ignore SIGTERM), so no orphaned `docker ps` processes pile up across polls.
        timeout: timeoutMs,
        killSignal: 'SIGKILL'
      },
      (err, stdout, stderr) => {
        pendingProbes.delete(child)
        if (err) {
          const timedOut = timeoutMs > 0 && (err as { killed?: boolean }).killed === true
          reject(Object.assign(err, { stderr, timedOut }))
        } else resolve({ stdout })
      }
    )
    if (timeoutMs > 0) pendingProbes.add(child)
  })
}

/** Shared docker invoker with a Finder-safe PATH. `err.stderr` is populated on failure.
 *  `extraEnv` (e.g. a one-shot ORCHA_GITHUB_PAT for a single compose-up) is merged in last,
 *  so it wins over both the inherited env and PATH. No timeout: used for long operations. */
export const dockerExec: Exec = (cmd, args, extraEnv) => run(cmd, args, extraEnv, 0)

/** Same as `dockerExec`, but the child is killed and the promise rejects (`timedOut: true`)
 *  after `timeoutMs`. For quick probes whose hang must read as "Docker unavailable". */
export function dockerExecWithTimeout(timeoutMs: number = DOCKER_PROBE_TIMEOUT_MS): Exec {
  return (cmd, args, extraEnv) => run(cmd, args, extraEnv, timeoutMs)
}
